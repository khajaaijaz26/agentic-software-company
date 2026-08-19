import {randomUUID} from "node:crypto";
import {resolve} from "node:path";

import type {ApprovalRecord} from "../../../packages/approval-service/src/index.js";
import {AgentRegistry, softwareAgentRoster} from "../../../packages/agent-registry/src/index.js";
import {
  loadProjectConfig,
  loadUserProviderConfig,
  resolvePlatformPaths,
  saveProjectConfig,
  saveUserProviderConfig,
  setProjectModel,
  setProjectTokenMode,
} from "../../../packages/config/src/index.js";
import type {JsonValue, StoredEvent} from "../../../packages/contracts/src/index.js";
import {
  ControllerIpcError,
  type ControllerMethod,
  type ControllerRpcParams,
  type ControllerRpcResults,
  type RpcRequestOptions,
} from "../../../packages/ipc/src/index.js";
import {sanitizeTerminal} from "../../../packages/observability/src/index.js";
import {
  AnthropicMessagesAdapter,
  ModelGateway,
  OpenAIResponsesAdapter,
  parseModelIdentifier,
} from "../../../packages/model-gateway/src/index.js";
import {
  EnvironmentCredentialBackend,
  SecretBackendBroker,
  createPlatformCredentialBackend,
  parseSecretReference,
  type CredentialBackend,
  type SecretReference,
} from "../../../packages/secret-broker/src/index.js";
import type {PlatformPaths} from "../../../packages/config/src/index.js";
import type {
  MutationLeaseView,
  SoftwareAgentRunView,
  SoftwareAgentSnapshot,
} from "../../control-plane/src/controller.js";
import type {
  ProjectRoomAgent,
  ProjectRoomApproval,
  ProjectRoomCommand,
  ProjectRoomCommandResult,
  ProjectRoomCommittedUpdate,
  ProjectRoomEvent,
  ProjectRoomRosterAgent,
  ProjectRoomSettings,
  ProjectRoomSnapshot,
  ProjectRoomSource,
} from "../../operator-console/src/dashboard.js";
import type {ProjectRoomTokenUsage} from "../../operator-console/src/project-room-state.js";

export interface ProjectRoomRpcClient {
  request<M extends ControllerMethod>(
    method: M,
    params: ControllerRpcParams[M],
    options?: RpcRequestOptions,
  ): Promise<ControllerRpcResults[M]>;
}

export interface IpcProjectRoomSourceOptions {
  readonly workspace?: string;
  readonly branch?: string;
  readonly maxParallel?: number;
  readonly tokenMode?: "economy" | "balanced" | "quality";
  readonly actorId?: string;
  readonly attachmentId?: string;
  readonly pollWaitMs?: number;
  readonly runId?: string;
  /** Test/embedding override. Production uses the operating-system credential store. */
  readonly credentialBackend?: CredentialBackend;
  /** Test/embedding override. Production uses the platform-standard Software Agent directories. */
  readonly platformPaths?: PlatformPaths;
}

const DISPLAY_NAMES: Readonly<Record<string, string>> = Object.freeze({
  "master-orchestrator": "Master Orchestrator",
  "software-engineer": "Software Engineer",
  "reviewer-qa": "Reviewer & QA",
});

/**
 * Cursor-safe adapter between the authenticated local controller and the Ink UI.
 * A failed control-lease acquisition intentionally produces a read-only room.
 */
export class IpcProjectRoomSource implements ProjectRoomSource {
  readonly #attachmentId: string;
  readonly #actorId: string;
  readonly #branch: string;
  readonly #client: ProjectRoomRpcClient;
  readonly #credentialBackend: CredentialBackend;
  readonly #maxParallel: number;
  readonly #tokenMode: "economy" | "balanced" | "quality" | undefined;
  readonly #workspace: string;
  readonly #pollWaitMs: number;
  readonly #platformPaths: PlatformPaths;
  #lease: MutationLeaseView | null = null;
  #renewal: Promise<void> | null = null;
  #selectedRunId: string | undefined;

  public constructor(client: ProjectRoomRpcClient, options: IpcProjectRoomSourceOptions = {}) {
    this.#client = client;
    this.#credentialBackend = options.credentialBackend ?? createPlatformCredentialBackend();
    this.#workspace = resolve(options.workspace ?? process.cwd());
    this.#branch = cleanText(options.branch ?? "current workspace", 256);
    this.#maxParallel = boundedInteger(options.maxParallel ?? 3, 1, 3, "maxParallel");
    this.#tokenMode = options.tokenMode;
    this.#actorId = exactId(options.actorId ?? "local-user", "actorId");
    this.#attachmentId = exactId(options.attachmentId ?? `ui_${randomUUID().replaceAll("-", "")}`, "attachmentId");
    this.#pollWaitMs = boundedInteger(options.pollWaitMs ?? 4_000, 100, 10_000, "pollWaitMs");
    this.#platformPaths = options.platformPaths ?? resolvePlatformPaths();
    this.#selectedRunId = options.runId;
  }

  public async initialize(): Promise<void> {
    try {
      const commandId = identifier("cmd");
      this.#lease = await this.#client.request("mutation.acquire", {
        commandId,
        attachmentId: this.#attachmentId,
        correlationId: commandId,
      });
    } catch (error) {
      if (!(error instanceof ControllerIpcError) || !["MUTATION_LEASE_HELD", "MUTATION_LEASE_EXPIRED"].includes(error.code)) throw error;
      this.#lease = null;
    }
  }

  public async load(signal: AbortSignal): Promise<ProjectRoomSnapshot> {
    await this.#maintainLease();
    const [snapshot, approvals, project, providers] = await Promise.all([
      this.#client.request("snapshot.get", {recentEventLimit: 250}, {signal}),
      this.#client.request("listApprovals", {}, {signal}),
      loadProjectConfig(this.#workspace),
      loadUserProviderConfig(this.#platformPaths),
    ]);
    return softwareAgentSnapshotToProjectRoom(snapshot, approvals, {
      branch: this.#branch,
      control: this.#lease !== null,
      settings: {
        workspace: this.#workspace,
        defaultModel: project.models.default,
        tokenMode: project.project.default_profile,
        providers: Object.entries(providers.providers).map(([providerId, provider]) => ({
          providerId,
          enabled: provider.enabled,
          model: `${providerId}/${provider.defaultModel}`,
          credentialReference: provider.credential,
        })),
      },
      ...(this.#selectedRunId === undefined ? {} : {runId: this.#selectedRunId}),
    });
  }

  public async nextCommitted(cursor: number, signal: AbortSignal): Promise<ProjectRoomCommittedUpdate> {
    await this.#maintainLease();
    const firstPage = await this.#client.request("events.poll", {
      afterCursor: cursor,
      limit: 250,
      waitMs: this.#pollWaitMs,
    }, {signal, timeoutMs: this.#pollWaitMs + 5_000});
    let events = [...firstPage.events];
    let committedCursor = firstPage.cursor;
    let snapshot = await this.load(signal);
    if (firstPage.resyncRequired) return {cursor: snapshot.cursor, events: [], snapshot};
    for (let catchup = 0; catchup < 8 && committedCursor < snapshot.cursor; catchup += 1) {
      const page = await this.#client.request("events.history", {afterCursor: committedCursor, limit: 250}, {signal});
      if (page.resyncRequired || page.events.length === 0) return {cursor: snapshot.cursor, events: [], snapshot};
      events = [...events, ...page.events];
      committedCursor = page.cursor;
      snapshot = await this.load(signal);
    }
    return {cursor: committedCursor, events: events.map(toProjectRoomEvent), snapshot};
  }

  public async execute(command: ProjectRoomCommand, signal: AbortSignal): Promise<ProjectRoomCommandResult> {
    if (command.type === "provider.test") return await testProviderConnection(command.providerId, signal, this.#platformPaths, this.#credentialBackend);
    if (command.type === "provider.connect") {
      await this.#requireControl();
      return await connectProvider(this.#workspace, command.providerId, command.model, command.secret, this.#platformPaths, this.#credentialBackend);
    }
    if (command.type === "provider.remove") {
      await this.#requireControl();
      return await removeProvider(this.#workspace, command.providerId, this.#platformPaths, this.#credentialBackend);
    }
    if (command.type === "model.select") {
      await this.#requireControl();
      return await selectProjectModel(this.#workspace, command.model, this.#platformPaths);
    }
    if (command.type === "tokens.mode") {
      await this.#requireControl();
      await setProjectTokenMode(this.#workspace, command.mode);
      return {message: `Token mode is now ${command.mode} (${tokenModePercent(command.mode)}% allowance) for new runs.`};
    }

    const snapshot = await this.#client.request("snapshot.get", {recentEventLimit: 0}, {signal});
    if (snapshot.cursor !== command.expectedCursor) {
      throw new ControllerIpcError("CURSOR_CONFLICT", `expected committed cursor ${command.expectedCursor}, found ${snapshot.cursor}`, true);
    }
    const lease = await this.#requireControl();
    if (command.type === "objective.create") {
      const created = await this.#client.request("run.create", {
        ...commandContext(0, this.#actorId, this.#attachmentId, lease),
        objective: command.text,
        maxParallel: this.#maxParallel,
        ...(this.#tokenMode === undefined ? {} : {tokenMode: this.#tokenMode}),
      }, {signal});
      this.#selectedRunId = created.id;
      await this.#client.request("run.resume", {
        ...commandContext(created.revision, this.#actorId, this.#attachmentId, lease),
        runId: created.id,
      }, {signal});
      return {message: "Objective committed. The scheduler is assigning the minimum relevant specialist team."};
    }

    const run = requireRun(snapshot, command.type === "instruction.submit" ? command.runId : undefined);
    if (command.type === "instruction.submit") {
      this.#selectedRunId = run.id;
      await this.#client.request("instruction.submit", {
        ...commandContext(run.revision, this.#actorId, this.#attachmentId, lease),
        runId: run.id,
        target: {kind: command.target.kind, id: command.target.id},
        text: command.text,
      }, {signal});
      return {message: `Instruction committed to ${command.target.label}. Watch CHAT & WORK for the next controller event.`};
    }
    if (command.type === "approval.decide") {
      if (command.decision === "APPROVED") {
        await this.#client.request("approve", {approvalId: command.approvalId, reason: "approved in the Software Agent project room"}, {signal});
      } else {
        const reason = command.decision === "CHANGES_REQUESTED"
          ? "changes requested in the Software Agent project room"
          : "denied in the Software Agent project room";
        await this.#client.request("deny", {approvalId: command.approvalId, reason}, {signal});
      }
      return {message: `Approval ${command.decision.toLowerCase().replaceAll("_", " ")} and committed.`};
    }
    if (command.disposition === "pause" && run.state === "RUNNING") {
      await this.#client.request("run.pause", {
        ...commandContext(run.revision, this.#actorId, this.#attachmentId, lease),
        runId: run.id,
      }, {signal});
    } else if (command.disposition === "cancel" && !["SUCCEEDED", "FAILED", "CANCELED"].includes(run.state)) {
      await this.#client.request("run.cancel", {
        ...commandContext(run.revision, this.#actorId, this.#attachmentId, lease),
        runId: run.id,
      }, {signal});
    }
    await this.dispose();
    return {message: `Session disposition committed: ${command.disposition}.`};
  }

  public async changeRunState(
    runId: string,
    action: "resume" | "pause" | "cancel",
    expectedCursor: number,
    signal: AbortSignal,
  ): Promise<void> {
    const snapshot = await this.#client.request("snapshot.get", {recentEventLimit: 0}, {signal});
    if (snapshot.cursor !== expectedCursor) {
      throw new ControllerIpcError("CURSOR_CONFLICT", `expected committed cursor ${expectedCursor}, found ${snapshot.cursor}`, true);
    }
    const run = requireRun(snapshot, runId);
    this.#selectedRunId = run.id;
    const lease = await this.#requireControl();
    const params = {...commandContext(run.revision, this.#actorId, this.#attachmentId, lease), runId};
    if (action === "resume") await this.#client.request("run.resume", params, {signal});
    else if (action === "pause") await this.#client.request("run.pause", params, {signal});
    else await this.#client.request("run.cancel", params, {signal});
  }

  public async dispose(): Promise<void> {
    const lease = this.#lease;
    this.#lease = null;
    if (lease === null || lease.state !== "ACTIVE") return;
    const commandId = identifier("cmd");
    await this.#client.request("mutation.release", {
      commandId,
      attachmentId: this.#attachmentId,
      correlationId: commandId,
      leaseId: lease.leaseId,
      fence: lease.fence,
    }).catch(() => undefined);
  }

  async #maintainLease(): Promise<void> {
    const lease = this.#lease;
    if (lease === null || Date.parse(lease.expiresAt) - Date.now() > 7_000) return;
    if (this.#renewal !== null) return this.#renewal;
    this.#renewal = (async () => {
      const current = this.#lease;
      if (current === null) return;
      const commandId = identifier("cmd");
      try {
        this.#lease = await this.#client.request("mutation.renew", {
          commandId,
          attachmentId: this.#attachmentId,
          correlationId: commandId,
          leaseId: current.leaseId,
          fence: current.fence,
        });
      } catch (error) {
        if (error instanceof ControllerIpcError && ["MUTATION_LEASE_EXPIRED", "MUTATION_LEASE_STALE"].includes(error.code)) {
          this.#lease = null;
          return;
        }
        throw error;
      }
    })().finally(() => { this.#renewal = null; });
    return this.#renewal;
  }

  async #requireControl(): Promise<MutationLeaseView> {
    await this.#maintainLease();
    if (this.#lease === null) throw new ControllerIpcError("READ_ONLY_SESSION", "another project-room session owns mutation control");
    return this.#lease;
  }
}

async function connectProvider(
  workspace: string,
  providerId: "openai" | "anthropic",
  requestedModel: string,
  secret: string,
  paths: PlatformPaths,
  backend: CredentialBackend,
): Promise<ProjectRoomCommandResult> {
  if (secret.length < 8 || secret.length > 4_096 || /[\r\n\0]/u.test(secret)) {
    throw new Error("the API key is malformed; nothing was stored");
  }
  const fullModel = normalizeProviderModel(providerId, requestedModel);
  const parsed = parseModelIdentifier(fullModel);
  const current = await loadUserProviderConfig(paths);
  const currentProject = await loadProjectConfig(workspace);
  const reference: SecretReference = {scheme: backend.scheme, reference: `provider/${providerId}/${randomUUID()}`};
  const broker = new SecretBackendBroker([backend]);
  await broker.set(reference, secret);
  let providerConfigChanged = false;
  try {
    await saveUserProviderConfig({
      ...current,
      revision: current.revision + 1,
      providers: {
        ...current.providers,
        [providerId]: {
          enabled: true,
          credential: `${reference.scheme}://${reference.reference}`,
          defaultModel: parsed.modelId,
        },
      },
      defaults: {...current.defaults, model: fullModel},
    }, paths);
    providerConfigChanged = true;
    await saveProjectConfig(workspace, {
      ...currentProject,
      mapping_revision: currentProject.mapping_revision + 1,
      models: {...currentProject.models, default: fullModel},
    });
  } catch (error) {
    if (providerConfigChanged) await saveUserProviderConfig(current, paths).catch(() => undefined);
    await saveProjectConfig(workspace, currentProject).catch(() => undefined);
    await broker.delete(reference).catch(() => false);
    throw error;
  }
  const previous = current.providers[providerId];
  if (previous !== undefined) {
    const previousReference = parseSecretReference(previous.credential);
    if (previousReference.scheme !== "env" && `${previousReference.scheme}://${previousReference.reference}` !== `${reference.scheme}://${reference.reference}`) {
      await providerSecretBroker(backend).delete(previousReference).catch(() => false);
    }
  }
  return {
    message: `${providerId} connected with ${fullModel}. The key is in the OS credential store; project files contain only ${reference.scheme}://${reference.reference}.`,
  };
}

async function testProviderConnection(
  providerId: "openai" | "anthropic",
  signal: AbortSignal,
  paths: PlatformPaths,
  backend: CredentialBackend,
): Promise<ProjectRoomCommandResult> {
  const config = await loadUserProviderConfig(paths);
  const provider = config.providers[providerId];
  if (!provider?.enabled) throw new Error(`${providerId} is not configured and enabled`);
  const gateway = new ModelGateway();
  const broker = providerSecretBroker(backend);
  const credential = parseSecretReference(provider.credential);
  if (providerId === "openai") gateway.register(new OpenAIResponsesAdapter({secretBroker: broker, credential}));
  else gateway.register(new AnthropicMessagesAdapter({secretBroker: broker, credential}));
  const models = await gateway.discover(signal);
  const configured = `${providerId}/${provider.defaultModel}`;
  const available = models.some((model) => `${model.providerId}/${model.modelId}` === configured);
  return {
    message: `${providerId} verified: ${models.length} model${models.length === 1 ? "" : "s"} discovered; ${configured} is ${available ? "available" : "not present in the returned catalog"}.`,
  };
}

async function removeProvider(
  workspace: string,
  providerId: "openai" | "anthropic",
  paths: PlatformPaths,
  backend: CredentialBackend,
): Promise<ProjectRoomCommandResult> {
  const current = await loadUserProviderConfig(paths);
  const provider = current.providers[providerId];
  if (provider === undefined) throw new Error(`${providerId} is not configured`);
  const reference = parseSecretReference(provider.credential);
  const providers = Object.fromEntries(Object.entries(current.providers).filter(([id]) => id !== providerId));
  const roles = Object.fromEntries(Object.entries(current.defaults.roles).filter(([, model]) => !model.startsWith(`${providerId}/`)));
  const nextProviders = {
    ...current,
    revision: current.revision + 1,
    providers,
    defaults: {
      model: current.defaults.model.startsWith(`${providerId}/`) ? "deterministic/local" : current.defaults.model,
      roles,
    },
  };
  const project = await loadProjectConfig(workspace);
  await saveUserProviderConfig(nextProviders, paths);
  try {
    if (project.models.default.startsWith(`${providerId}/`)) {
      await saveProjectConfig(workspace, {
        ...project,
        mapping_revision: project.mapping_revision + 1,
        models: {...project.models, default: "deterministic/local"},
      });
    }
  } catch (error) {
    await saveUserProviderConfig(current, paths).catch(() => undefined);
    throw error;
  }
  let deleted = false;
  if (reference.scheme !== "env") deleted = await providerSecretBroker(backend).delete(reference).catch(() => false);
  return {message: `${providerId} removed. ${reference.scheme === "env" ? "The environment variable was not changed." : deleted ? "The OS credential was deleted." : "The saved credential reference was removed; deletion from the OS store could not be confirmed."}`};
}

async function selectProjectModel(workspace: string, model: string, paths: PlatformPaths): Promise<ProjectRoomCommandResult> {
  const parsed = parseModelIdentifier(model);
  if (parsed.providerId !== "deterministic") {
    const provider = (await loadUserProviderConfig(paths)).providers[parsed.providerId];
    if (provider === undefined) throw new Error(`configure ${parsed.providerId} with /api connect before selecting ${model}`);
    if (!provider.enabled) throw new Error(`${parsed.providerId} is disabled`);
  }
  await setProjectModel(workspace, model);
  return {message: `Project model changed to ${model}. In-flight turns keep their existing grant; new turns use this route.`};
}

function providerSecretBroker(backend: CredentialBackend = createPlatformCredentialBackend()): SecretBackendBroker {
  return new SecretBackendBroker([
    new EnvironmentCredentialBackend(process.env, false),
    backend,
  ]);
}

function normalizeProviderModel(providerId: "openai" | "anthropic", value: string): string {
  const full = value.includes("/") ? value : `${providerId}/${value}`;
  const parsed = parseModelIdentifier(full);
  if (parsed.providerId !== providerId) throw new Error(`model ${full} does not belong to ${providerId}`);
  return `${parsed.providerId}/${parsed.modelId}`;
}

function tokenModePercent(mode: "economy" | "balanced" | "quality"): number {
  return mode === "economy" ? 25 : mode === "balanced" ? 50 : 100;
}

export function softwareAgentSnapshotToProjectRoom(
  snapshot: SoftwareAgentSnapshot,
  approvals: readonly ApprovalRecord[],
  options: {readonly branch: string; readonly control: boolean; readonly runId?: string; readonly settings?: ProjectRoomSettings},
): ProjectRoomSnapshot {
  const run = (options.runId === undefined ? undefined : snapshot.runs.find((candidate) => candidate.id === options.runId))
    ?? [...snapshot.runs].sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))[0]
    ?? null;
  const runEvents = run === null ? [] : snapshot.recentEvents.filter((event) => event.streamId === run.id);
  const catalogAssignments = catalogAssignmentsForRun(run);
  const agents = run?.sessions.map((session): ProjectRoomAgent => {
    const activeTask = run.tasks.find((task) => task.id === session.currentTaskId)
      ?? run.tasks.find((task) => task.sessionId === session.id && ["READY", "RUNNING"].includes(task.state))
      ?? run.tasks.find((task) => task.sessionId === session.id)
      ?? null;
    const events = runEvents.filter((event) => event.data.sessionId === session.id || event.actor.id === session.id);
    const last = events.at(-1);
    const evidence = runEvents.filter((event) => event.eventType === "software-agent.evidence.recorded" && event.data.taskId === activeTask?.id);
    const modelEvent = events.findLast((event) => typeof event.data.model === "string");
    const modelRoute = textValue(modelEvent?.data.model) ?? "deterministic/local";
    const split = modelRoute.indexOf("/");
    const definition = catalogAssignments.get(session.id);
    return {
      id: session.id,
      role: definition?.id ?? session.role,
      displayName: definition?.displayName ?? DISPLAY_NAMES[session.role] ?? session.role,
      state: session.state,
      taskId: activeTask?.id ?? "",
      taskTitle: activeTask?.title ?? "Waiting for assignment",
      activity: eventSummary(last) ?? (activeTask?.summary || `Session is ${session.state.toLowerCase()}.`),
      activitySince: session.currentTurnId === undefined ? null : session.lastHeartbeatAt ?? null,
      lastEventAt: last?.occurredAt ?? null,
      provider: split < 0 ? modelRoute : modelRoute.slice(0, split),
      model: split < 0 ? "UNKNOWN" : modelRoute.slice(split + 1),
      tokens: usageFromEvents(events),
      costUsd: costFromEvents(events),
      blocker: /WAITING|FAILED|PAUSED/u.test(session.state) ? eventSummary(last) ?? `Session is ${session.state}.` : null,
      approvalId: approvalForAgent(approvals, session.id)?.approvalId ?? null,
      requestedFiles: uniqueText(events, "path"),
      requestedTools: uniqueText(events, "tool"),
      evidence: evidence.map((event) => textValue(event.data.summary)).filter(isText).slice(-4),
    };
  }) ?? [];
  const mappedApprovals = approvals
    .filter((approval) => run === null || approval.binding.resource === run.id || runEvents.some((event) => event.data.approvalId === approval.approvalId))
    .filter((approval) => approval.status === "PENDING" || approval.status === "APPROVED")
    .map(toProjectRoomApproval);
  const tokenBudget = run === null ? undefined : snapshot.tokenBudgets.find((candidate) => candidate.runId === run.id);
  const roster = buildProjectRoomRoster(agents, run?.tasks ?? [], run?.state ?? null);
  const meaningfulEvents = (run === null ? snapshot.recentEvents : runEvents)
    .filter((event) => !/software-agent\.(?:mutation\.renewed|lease\.heartbeat|worker\.heartbeat)/u.test(event.eventType));
  return {
    schema: "software-agent.project-room/v1",
    projectId: snapshot.projectId,
    projectName: snapshot.projectName,
    branch: options.branch,
    generatedAt: snapshot.generatedAt,
    cursor: snapshot.cursor,
    controller: {state: "CONNECTED", mode: options.control ? "CONTROL" : "READ_ONLY"},
    roster,
    settings: options.settings ?? {
      workspace: "UNKNOWN",
      defaultModel: "deterministic/local",
      tokenMode: "balanced",
      providers: [],
    },
    run: run === null ? null : {
      id: run.id,
      objective: run.objective,
      state: run.state,
      startedAt: run.createdAt,
      agents,
      tasks: run.tasks.map((task) => ({id: task.id, title: task.title, state: task.state, agentId: task.sessionId})),
      tokens: usageFromEvents(runEvents),
      costUsd: costFromEvents(runEvents),
      tokenBudget: tokenBudget === undefined
        ? {used: knownTokenTotal(usageFromEvents(runEvents)), limit: "UNKNOWN"}
        : {used: tokenBudget.spentTokens, limit: tokenBudget.effectiveLimitTokens},
    },
    approvals: mappedApprovals,
    importantEvents: meaningfulEvents.map(toProjectRoomEvent),
  };
}

function catalogAssignmentsForRun(run: SoftwareAgentRunView | null): ReadonlyMap<string, ReturnType<AgentRegistry["get"]>> {
  const assignments = new Map<string, ReturnType<AgentRegistry["get"]>>();
  if (run === null) return assignments;
  const registry = new AgentRegistry();
  const activated = new Set(registry.activateFor(run.objective).map((definition) => definition.id));
  const objective = run.objective.toLowerCase();
  for (const session of run.sessions) {
    if (session.role === "master-orchestrator") {
      assignments.set(session.id, registry.get("orchestrator"));
      continue;
    }
    if (session.role === "reviewer-qa") {
      const task = run.tasks.find((candidate) => candidate.id === session.currentTaskId)
        ?? run.tasks.find((candidate) => candidate.sessionId === session.id && candidate.state !== "PASSED");
      assignments.set(session.id, registry.get(/final|independent review|code review/iu.test(task?.title ?? "") ? "code-reviewer" : "qa-strategist"));
      continue;
    }
    const keywordChoice = /frontend|react|terminal|screen|ui|ux/iu.test(objective)
      ? "frontend-engineer"
      : /github|vercel|supabase|integration|webhook/iu.test(objective)
        ? "integration-engineer"
        : /database|sql|migration|schema/iu.test(objective)
          ? "data-database-engineer"
          : /deploy|docker|infrastructure|ci|release/iu.test(objective)
            ? "devops-platform"
            : /security|auth|secret|permission/iu.test(objective)
              ? "security-engineer"
              : /documentation|readme|docs/iu.test(objective)
                ? "technical-writer"
                : "backend-engineer";
    const roleId = activated.has(keywordChoice) ? keywordChoice : activated.has("backend-engineer") ? "backend-engineer" : keywordChoice;
    assignments.set(session.id, registry.get(roleId));
  }
  return assignments;
}

function buildProjectRoomRoster(
  agents: readonly ProjectRoomAgent[],
  tasks: readonly SoftwareAgentRunView["tasks"][number][],
  runState: string | null,
): readonly ProjectRoomRosterAgent[] {
  return softwareAgentRoster().map((definition): ProjectRoomRosterAgent => {
    const agent = agents.find((candidate) => candidate.role === definition.id);
    if (agent === undefined) {
      return {
        id: definition.id,
        displayName: definition.displayName,
        capabilities: definition.capabilities,
        state: "WAITING",
        status: "WAITING FOR WORK",
        activity: "Available; no task is assigned, so no model tokens are being used.",
        taskTitle: "No assigned task",
        sessionId: null,
        model: "Not allocated",
      };
    }
    const assignedTasks = tasks.filter((task) => task.sessionId === agent.id);
    const failed = agent.state === "FAILED" || assignedTasks.some((task) => task.state === "FAILED");
    const done = runState === "SUCCEEDED" || (assignedTasks.length > 0 && assignedTasks.every((task) => task.state === "PASSED"));
    const working = /RUNNING|PLANNING/u.test(agent.state) || assignedTasks.some((task) => task.state === "RUNNING");
    const blocked = /WAITING|PAUSED/u.test(agent.state) || assignedTasks.some((task) => task.state === "BLOCKED") || agent.approvalId !== null;
    const state: ProjectRoomRosterAgent["state"] = failed ? "FAILED" : done ? "DONE" : working ? "WORKING" : blocked ? "BLOCKED" : "WAITING";
    return {
      id: definition.id,
      displayName: definition.displayName,
      capabilities: definition.capabilities,
      state,
      status: state === "WORKING" ? "WORKING NOW" : state === "DONE" ? "DONE" : state === "FAILED" ? "FAILED" : state === "BLOCKED" ? "WAITING ON DEPENDENCY" : "WAITING FOR WORK",
      activity: agent.activity,
      taskTitle: agent.taskTitle,
      sessionId: agent.id,
      model: `${agent.provider}/${agent.model}`,
    };
  });
}

function commandContext(expectedRunRevision: number, actorId: string, attachmentId: string, lease: MutationLeaseView) {
  const commandId = identifier("cmd");
  return {
    schema: "software-agent.command/v2" as const,
    commandId,
    actor: {type: "human" as const, id: actorId},
    expectedRunRevision,
    correlationId: commandId,
    causationId: commandId,
    uiAttachmentId: attachmentId,
    mutationLease: {leaseId: lease.leaseId, fence: lease.fence},
  };
}

function requireRun(snapshot: SoftwareAgentSnapshot, requestedId?: string): SoftwareAgentRunView {
  const run = requestedId === undefined ? snapshot.runs[0] : snapshot.runs.find((candidate) => candidate.id === requestedId);
  if (run === undefined) throw new ControllerIpcError("RUN_NOT_FOUND", requestedId === undefined ? "there is no active run" : `unknown run ${requestedId}`);
  return run;
}

function toProjectRoomApproval(approval: ApprovalRecord): ProjectRoomApproval {
  const action = approval.binding.action;
  return {
    id: approval.approvalId,
    status: approval.status,
    risk: riskForAction(action),
    title: `Review ${action}`,
    purpose: "A Software Agent requested exact human authorization.",
    action,
    resource: approval.binding.resource,
    exactPreview: `${action} on ${approval.binding.resource} (${approval.binding.operationHash.slice(0, 12)})`,
    impact: approval.binding.environment === "production" ? "This action targets production." : `This action targets ${approval.binding.environment}.`,
    expiresAt: approval.expiresAt,
    agentId: approval.binding.actor.type === "agent" ? approval.binding.actor.id : null,
    taskId: null,
    evidence: approval.binding.artifactSha256 === null ? [] : [approval.binding.artifactSha256],
  };
}

function toProjectRoomEvent(event: StoredEvent): ProjectRoomEvent {
  return {
    sequence: event.sequence,
    eventId: event.eventId,
    occurredAt: event.occurredAt,
    type: event.eventType,
    severity: eventSeverity(event.eventType),
    summary: eventSummary(event) ?? event.eventType,
    agentId: textValue(event.data.sessionId) ?? (event.actor.type === "agent" ? event.actor.id : null),
    taskId: textValue(event.data.taskId),
    approvalId: textValue(event.data.approvalId),
  };
}

function usageFromEvents(events: readonly StoredEvent[]): ProjectRoomTokenUsage {
  return {
    input: sumKnown(events, "inputTokens"),
    output: sumKnown(events, "outputTokens"),
    cached: sumKnown(events, "cachedInputTokens"),
    reasoning: sumKnown(events, "reasoningTokens"),
  };
}

function sumKnown(events: readonly StoredEvent[], key: string): number | "UNKNOWN" {
  const values = events.map((event) => event.data[key]).filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0);
  return values.length === 0 ? "UNKNOWN" : values.reduce((total, value) => total + value, 0);
}

function costFromEvents(events: readonly StoredEvent[]): number | "UNKNOWN" {
  const values = events.map((event) => event.data.costUsd).filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0);
  return values.length === 0 ? "UNKNOWN" : values.reduce((total, value) => total + value, 0);
}

function knownTokenTotal(usage: ProjectRoomTokenUsage): number {
  return usage.input === "UNKNOWN" || usage.output === "UNKNOWN" ? 0 : usage.input + usage.output;
}

function eventSummary(event: StoredEvent | undefined): string | null {
  if (event === undefined) return null;
  return textValue(event.data.summary)
    ?? textValue(event.data.message)
    ?? textValue(event.data.prompt)
    ?? textValue(event.data.text)
    ?? textValue(event.data.objective)
    ?? textValue(event.data.payload)
    ?? toolEventSummary(event)
    ?? event.eventType.replace(/^software-agent\./u, "").replaceAll("_", " ");
}

function toolEventSummary(event: StoredEvent): string | null {
  const tool = textValue(event.data.tool);
  const path = textValue(event.data.path);
  if (tool !== null && path !== null) return `${tool}: ${path}`;
  if (path !== null) return path;
  if (tool !== null) return tool;
  return null;
}

function uniqueText(events: readonly StoredEvent[], field: string): readonly string[] {
  return [...new Set(events.map((event) => textValue(event.data[field])).filter(isText))].slice(-8);
}

function approvalForAgent(approvals: readonly ApprovalRecord[], agentId: string): ApprovalRecord | undefined {
  return approvals.find((approval) => approval.status === "PENDING" && approval.binding.actor.type === "agent" && approval.binding.actor.id === agentId);
}

function textValue(value: JsonValue | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function isText(value: string | null): value is string {
  return value !== null && value !== "";
}

function eventSeverity(type: string): ProjectRoomEvent["severity"] {
  if (/failed|error|denied|fenced|canceled/u.test(type)) return "ERROR";
  if (/approval|required|waiting|paused|expired/u.test(type)) return "WARN";
  if (/security|corrupt/u.test(type)) return "CRITICAL";
  return "INFO";
}

function riskForAction(action: string): string {
  if (/production|delete|destroy|rollback|force/u.test(action)) return "A5_DESTRUCTIVE_OR_IRREVERSIBLE";
  if (/deploy|push|publish|migrate/u.test(action)) return "A4_EXTERNAL_WRITE";
  if (/command|shell/u.test(action)) return "A3_PROCESS_EXECUTION";
  if (/write|patch|edit/u.test(action)) return "A2_WORKSPACE_MUTATION";
  return "A1_LOCAL_SAFE";
}

function identifier(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

function exactId(value: string, field: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value)) throw new TypeError(`${field} is invalid`);
  return value;
}

function cleanText(value: string, maximum: number): string {
  const clean = sanitizeTerminal(value, maximum).replaceAll("\n", " ").trim();
  return clean === "" ? "UNKNOWN" : clean.slice(0, maximum);
}

function boundedInteger(value: number, minimum: number, maximum: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new TypeError(`${field} must be from ${minimum} through ${maximum}`);
  return value;
}
