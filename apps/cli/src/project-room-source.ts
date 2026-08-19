import {randomUUID} from "node:crypto";

import type {ApprovalRecord} from "../../../packages/approval-service/src/index.js";
import type {JsonValue, StoredEvent} from "../../../packages/contracts/src/index.js";
import {
  ControllerIpcError,
  type ControllerMethod,
  type ControllerRpcParams,
  type ControllerRpcResults,
  type RpcRequestOptions,
} from "../../../packages/ipc/src/index.js";
import {sanitizeTerminal} from "../../../packages/observability/src/index.js";
import type {
  MutationLeaseView,
  SoftwareAgentRunView,
  SoftwareAgentSnapshot,
} from "../../control-plane/src/controller.js";
import type {
  ProjectRoomAgent,
  ProjectRoomApproval,
  ProjectRoomCommand,
  ProjectRoomCommittedUpdate,
  ProjectRoomEvent,
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
  readonly branch?: string;
  readonly maxParallel?: number;
  readonly tokenMode?: "economy" | "balanced" | "quality";
  readonly actorId?: string;
  readonly attachmentId?: string;
  readonly pollWaitMs?: number;
  readonly runId?: string;
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
  readonly #maxParallel: number;
  readonly #tokenMode: "economy" | "balanced" | "quality" | undefined;
  readonly #pollWaitMs: number;
  #lease: MutationLeaseView | null = null;
  #renewal: Promise<void> | null = null;
  #selectedRunId: string | undefined;

  public constructor(client: ProjectRoomRpcClient, options: IpcProjectRoomSourceOptions = {}) {
    this.#client = client;
    this.#branch = cleanText(options.branch ?? "current workspace", 256);
    this.#maxParallel = boundedInteger(options.maxParallel ?? 3, 1, 3, "maxParallel");
    this.#tokenMode = options.tokenMode;
    this.#actorId = exactId(options.actorId ?? "local-user", "actorId");
    this.#attachmentId = exactId(options.attachmentId ?? `ui_${randomUUID().replaceAll("-", "")}`, "attachmentId");
    this.#pollWaitMs = boundedInteger(options.pollWaitMs ?? 4_000, 100, 10_000, "pollWaitMs");
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
    const [snapshot, approvals] = await Promise.all([
      this.#client.request("snapshot.get", {recentEventLimit: 250}, {signal}),
      this.#client.request("listApprovals", {}, {signal}),
    ]);
    return softwareAgentSnapshotToProjectRoom(snapshot, approvals, {
      branch: this.#branch,
      control: this.#lease !== null,
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

  public async execute(command: ProjectRoomCommand, signal: AbortSignal): Promise<void> {
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
      return;
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
      return;
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
      return;
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

export function softwareAgentSnapshotToProjectRoom(
  snapshot: SoftwareAgentSnapshot,
  approvals: readonly ApprovalRecord[],
  options: {readonly branch: string; readonly control: boolean; readonly runId?: string},
): ProjectRoomSnapshot {
  const run = (options.runId === undefined ? undefined : snapshot.runs.find((candidate) => candidate.id === options.runId))
    ?? [...snapshot.runs].sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))[0]
    ?? null;
  const runEvents = run === null ? [] : snapshot.recentEvents.filter((event) => event.streamId === run.id);
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
    return {
      id: session.id,
      role: session.role,
      displayName: DISPLAY_NAMES[session.role] ?? session.role,
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
  return {
    schema: "software-agent.project-room/v1",
    projectId: snapshot.projectId,
    projectName: snapshot.projectName,
    branch: options.branch,
    generatedAt: snapshot.generatedAt,
    cursor: snapshot.cursor,
    controller: {state: "CONNECTED", mode: options.control ? "CONTROL" : "READ_ONLY"},
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
    importantEvents: snapshot.recentEvents.map(toProjectRoomEvent),
  };
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
    ?? event.eventType.replace(/^software-agent\./u, "").replaceAll("_", " ");
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
