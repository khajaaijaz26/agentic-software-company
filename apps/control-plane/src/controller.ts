import {randomUUID} from "node:crypto";
import {mkdir} from "node:fs/promises";
import {join, resolve} from "node:path";
import {
  CONTRACT_SCHEMA_VERSION,
  sha256Canonical,
  type ActorRef,
  type ApprovalBinding,
  type JsonObject,
  type StoredEvent,
} from "../../../packages/contracts/src/index.js";
import {SqliteEventStore, type EventToAppend} from "../../../packages/event-store-sqlite/src/index.js";
import {ApprovalService, type ApprovalRecord} from "../../../packages/approval-service/src/index.js";
import {AGENT_STATUSES, canTransitionRun, canTransitionTask, topologicalOrder, type AgentStatus, type DagNode} from "../../../packages/domain/src/index.js";
import {AgentRegistry} from "../../../packages/agent-registry/src/index.js";
import {BudgetLedger} from "../../../packages/budgets/src/index.js";
import {loadProjectConfig, projectFiles} from "../../../packages/config/src/index.js";
import {ChildWorkerSupervisor, WorkerSupervisorError, createWorkerManifest} from "../../../packages/worker-supervisor/src/index.js";
import {sanitizeTerminal} from "../../../packages/observability/src/index.js";

export const RUN_STATES = [
  "DRAFT", "PLANNING", "WAITING_INPUT", "WAITING_APPROVAL", "RUNNING", "PAUSING", "PAUSED",
  "RECOVERING", "NEEDS_RECONCILIATION", "SUCCEEDED", "PARTIAL", "FAILED", "CANCELED",
] as const;
export type RunState = (typeof RUN_STATES)[number];

export const TASK_STATES = [
  "PROPOSED", "BLOCKED", "READY", "CLAIMED", "RUNNING", "WAITING_TOOL", "WAITING_INPUT",
  "WAITING_APPROVAL", "REVIEW", "REWORK", "PASSED", "FAILED", "SKIPPED", "CANCELED",
] as const;
export type TaskState = (typeof TASK_STATES)[number];

export interface TaskView extends DagNode {
  readonly title: string;
  readonly role: string;
  readonly state: TaskState;
  readonly summary: string;
}

export interface AgentView {
  readonly id: string;
  readonly role: string;
  readonly displayName: string;
  readonly state: AgentStatus;
  readonly taskId: string;
  readonly model: string;
  readonly modelClass: "reasoning" | "coding" | "fast";
  readonly why: string;
  readonly scopes: readonly string[];
  readonly estimatedCostUsd: number | "UNKNOWN";
  readonly deactivateWhen: string;
}

export interface RunView {
  readonly id: string;
  readonly projectId: string;
  readonly objective: string;
  readonly state: RunState;
  readonly createdAt: string;
  readonly tasks: readonly TaskView[];
  readonly agents: readonly AgentView[];
  readonly approvalIds: readonly string[];
  readonly costUsd: number;
}

export interface ControllerSnapshot {
  readonly schema: "agent-company.snapshot/v1";
  readonly projectId: string;
  readonly projectName: string;
  readonly runs: readonly RunView[];
  readonly events: readonly StoredEvent[];
  readonly generatedAt: string;
}

const SYSTEM_ACTOR: ActorRef = {type: "system", id: "controller"};

export class LocalController {
  readonly #workspace: string;
  readonly #events: SqliteEventStore;
  readonly #approvals: ApprovalService;
  readonly #budgets: BudgetLedger;
  readonly #registry = new AgentRegistry();
  readonly #workers = new ChildWorkerSupervisor();
  readonly #activeRuns = new Map<string, AbortController>();
  #projectId = "";
  #projectName = "";

  private constructor(workspace: string, database: string) {
    this.#workspace = workspace;
    this.#events = new SqliteEventStore(database);
    this.#approvals = new ApprovalService(database);
    this.#budgets = new BudgetLedger(database);
  }

  public static async open(workspace = process.cwd()): Promise<LocalController> {
    const root = resolve(workspace);
    const files = projectFiles(root);
    await mkdir(files.directory, {recursive: true, mode: 0o700});
    const controller = new LocalController(root, join(files.directory, "state.sqlite"));
    await controller.#loadProject();
    return controller;
  }

  public close(): void {
    for (const controller of this.#activeRuns.values()) controller.abort(new Error("controller is shutting down"));
    this.#activeRuns.clear();
    this.#budgets.close();
    this.#approvals.close();
    this.#events.close();
  }

  public createRun(objective: string, actor: ActorRef = {type: "human", id: "local-user"}): Promise<RunView> {
    const rawObjective = objective.trim();
    if (!rawObjective) throw new ControllerError("OBJECTIVE_REQUIRED", "a non-empty objective is required");
    if (rawObjective.length > 32_768) throw new ControllerError("OBJECTIVE_TOO_LARGE", "objective exceeds 32,768 characters");
    const trimmed = sanitizeTerminal(rawObjective, 32_768);
    const runId = `run_${randomUUID().replaceAll("-", "")}`;
    const now = new Date().toISOString();
    const activationPlan = this.#registry.activationPlan(trimmed);
    const activated = activationPlan.map((decision) => decision.definition);
    const tasks = buildVerticalSlice(runId, activated.map((role) => role.id));
    topologicalOrder(tasks);
    const operationHash = sha256Canonical({objective: trimmed, tasks: tasks.map(taskJson)});
    const planArtifact = sha256Canonical({objective: trimmed, roles: activated.map((role) => role.id), tasks: tasks.map(taskJson)});
    const binding: ApprovalBinding = {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      actor,
      connector: "local",
      action: "plan:accept",
      resource: runId,
      environment: "local",
      artifactSha256: planArtifact,
      operationHash,
    };
    const approval = this.#approvals.request({
      binding,
      requestedAt: now,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    this.#budgets.setLimit(`run:${runId}`, 25);
    const events: EventToAppend[] = [
      event("run.created", actor, now, {runId, projectId: this.#projectId, objective: trimmed, state: "DRAFT", createdAt: now}),
      event("run.state_changed", SYSTEM_ACTOR, now, {runId, from: "DRAFT", to: "PLANNING"}),
      ...activationPlan.map(({definition, why, modelClass, scopes, estimatedCostUsd, deactivateWhen}) => event("agent.activated", SYSTEM_ACTOR, now, {
        runId,
        agentId: `agi_${definition.id}_${runId.slice(-8)}`,
        role: definition.id,
        displayName: definition.displayName,
        state: "PLANNING",
        taskId: tasks.find((task) => task.role === definition.id)?.id ?? "",
        model: "deterministic/local",
        modelClass,
        why,
        scopes: [...scopes],
        estimatedCostUsd,
        deactivateWhen,
      })),
      ...tasks.map((task) => event("task.proposed", SYSTEM_ACTOR, now, {runId, ...taskJson(task), state: "PROPOSED"})),
      event("approval.requested", SYSTEM_ACTOR, now, {
        runId,
        approvalId: approval.approvalId,
        action: binding.action,
        resource: binding.resource,
        artifactSha256: binding.artifactSha256,
        operationHash: binding.operationHash,
        expiresAt: approval.expiresAt,
      }),
      event("run.state_changed", SYSTEM_ACTOR, now, {runId, from: "PLANNING", to: "WAITING_APPROVAL"}),
    ];
    this.#append(runId, `create:${runId}`, operationHash, events, {runId, approvalId: approval.approvalId});
    return Promise.resolve(this.getRun(runId));
  }

  public getRun(runId: string): RunView {
    const run = this.snapshot().runs.find((candidate) => candidate.id === runId);
    if (!run) throw new ControllerError("RUN_NOT_FOUND", `unknown run: ${runId}`);
    return run;
  }

  public listApprovals(runId?: string): readonly ApprovalRecord[] {
    const ids = this.snapshot().runs
      .filter((run) => runId === undefined || run.id === runId)
      .flatMap((run) => run.approvalIds);
    return ids.flatMap((id) => {
      const approval = this.#approvals.get(id);
      return approval ? [approval] : [];
    });
  }

  public approve(approvalId: string, actor: ActorRef = {type: "human", id: "local-user"}, reason = "approved in Agent Company CLI"): ApprovalRecord {
    const now = new Date().toISOString();
    const safeReason = sanitizeTerminal(reason, 4_096);
    const approval = this.#approvals.decide({approvalId, approver: actor, decision: "APPROVED", decidedAt: now, reason: safeReason});
    const runId = approval.binding.resource;
    this.#append(runId, `approve:${approvalId}`, sha256Canonical({approvalId, actor: {type: actor.type, id: actor.id}, reason: safeReason}), [
      event("approval.approved", actor, now, {runId, approvalId, decidedBy: actor.id, reason: safeReason}),
    ], {approvalId});
    return approval;
  }

  public deny(approvalId: string, actor: ActorRef = {type: "human", id: "local-user"}, reason = "denied in Agent Company CLI"): ApprovalRecord {
    const now = new Date().toISOString();
    const safeReason = sanitizeTerminal(reason, 4_096);
    const approval = this.#approvals.decide({approvalId, approver: actor, decision: "DENIED", decidedAt: now, reason: safeReason});
    const runId = approval.binding.resource;
    this.#append(runId, `deny:${approvalId}`, sha256Canonical({approvalId, actor: {type: actor.type, id: actor.id}, reason: safeReason}), [
      event("approval.denied", actor, now, {runId, approvalId, decidedBy: actor.id, reason: safeReason}),
      event("run.state_changed", SYSTEM_ACTOR, now, {runId, from: "WAITING_APPROVAL", to: "CANCELED"}),
    ], {approvalId});
    return approval;
  }

  public async resume(runId: string): Promise<RunView> {
    let run = this.getRun(runId);
    if (!["WAITING_APPROVAL", "PAUSED", "RECOVERING", "RUNNING"].includes(run.state)) {
      throw new ControllerError("RUN_NOT_RESUMABLE", `run ${runId} is ${run.state}`);
    }
    if (this.#activeRuns.has(runId)) throw new ControllerError("RUN_ALREADY_ACTIVE", `run ${runId} already has an active worker`);
    const cancellation = new AbortController();
    this.#activeRuns.set(runId, cancellation);
    try {
      if (run.state === "WAITING_APPROVAL") {
        const approvalId = run.approvalIds.at(-1);
        if (!approvalId) throw new ControllerError("APPROVAL_REQUIRED", `run ${runId} has no plan approval`);
        const approval = this.#approvals.get(approvalId);
        if (!approval || !["APPROVED", "CONSUMED"].includes(approval.status)) {
          throw new ControllerError("APPROVAL_REQUIRED", `approval ${approvalId} is not approved`);
        }
        const now = new Date().toISOString();
        if (approval.status === "APPROVED") {
          const authorization = this.#approvals.issueAuthorization(approvalId, now);
          this.#approvals.consumeAuthorization(authorization, approval.binding, now);
        }
        this.#append(runId, `resume-start:${runId}:${approvalId}`, sha256Canonical({runId, approvalId}), [
          event("approval.consumed", SYSTEM_ACTOR, now, {runId, approvalId}),
          event("run.state_changed", SYSTEM_ACTOR, now, {runId, from: "WAITING_APPROVAL", to: "RUNNING"}),
        ], {runId, state: "RUNNING"});
      } else if (run.state !== "RUNNING") {
        const now = new Date().toISOString();
        this.#append(runId, `resume-start:${runId}:${this.#events.latestStreamVersion(runId)}`, sha256Canonical({runId, from: run.state}), [
          event("run.state_changed", SYSTEM_ACTOR, now, {runId, from: run.state, to: "RUNNING"}),
        ], {runId, state: "RUNNING"});
      }

      run = this.getRun(runId);
      const order = topologicalOrder(run.tasks);
      for (const taskId of order) {
        const task = this.getRun(runId).tasks.find((candidate) => candidate.id === taskId);
        if (!task || task.state === "PASSED" || task.state === "SKIPPED") continue;
        if (["FAILED", "CANCELED"].includes(task.state)) throw new ControllerError("TASK_TERMINAL", `task ${taskId} is ${task.state}`);
        const manifest = createWorkerManifest({
          runId,
          taskId,
          role: task.role,
          workspace: this.#workspace,
          objective: `${run.objective}\nTask: ${task.title}`,
          modelId: "local",
        });
        const claimedAt = new Date().toISOString();
        this.#append(runId, `worker-claim:${manifest.attemptId}`, sha256Canonical(manifestJson(manifest)), [
          ...taskStartEvents(runId, task, claimedAt),
          event("worker.lease_granted", SYSTEM_ACTOR, claimedAt, {
            runId,
            taskId,
            attemptId: manifest.attemptId,
            leaseId: manifest.leaseId,
            leaseExpiresAt: manifest.leaseExpiresAt,
          }),
        ], {runId, taskId, attemptId: manifest.attemptId, state: "RUNNING"});
        try {
          const execution = await this.#workers.executeManifest(manifest, cancellation.signal);
          const completedAt = new Date().toISOString();
          this.#append(runId, `worker-complete:${manifest.attemptId}`, sha256Canonical({attemptId: manifest.attemptId, leaseId: manifest.leaseId}), [
            event("worker.completed", SYSTEM_ACTOR, completedAt, {runId, taskId, attemptId: manifest.attemptId, leaseId: manifest.leaseId, pid: execution.pid}),
            event("task.evidence_recorded", {type: "agent", id: task.role}, completedAt, {
              runId,
              taskId,
              attemptId: manifest.attemptId,
              summary: execution.result.summary,
              model: "deterministic/local",
              inputTokens: execution.result.usage.inputTokens,
              outputTokens: execution.result.usage.outputTokens,
              costUsd: execution.result.usage.cost,
            }),
            event("task.state_changed", SYSTEM_ACTOR, completedAt, {runId, taskId, from: "RUNNING", to: "REVIEW"}),
            event("task.state_changed", SYSTEM_ACTOR, completedAt, {runId, taskId, from: "REVIEW", to: "PASSED"}),
          ], {runId, taskId, attemptId: manifest.attemptId, state: "PASSED"});
        } catch (error) {
          const current = this.getRun(runId);
          if (["PAUSED", "CANCELED"].includes(current.state)) throw new ControllerError("RUN_INTERRUPTED", `run ${runId} is ${current.state}`);
          const failedAt = new Date().toISOString();
          this.#append(runId, `worker-failed:${manifest.attemptId}`, sha256Canonical({attemptId: manifest.attemptId, error: String(error)}), [
            event("worker.failed", SYSTEM_ACTOR, failedAt, {runId, taskId, attemptId: manifest.attemptId, code: error instanceof WorkerSupervisorError ? error.code : "WORKER_FAILURE"}),
            event("task.state_changed", SYSTEM_ACTOR, failedAt, {runId, taskId, from: "RUNNING", to: "FAILED"}),
            event("run.state_changed", SYSTEM_ACTOR, failedAt, {runId, from: "RUNNING", to: "FAILED"}),
          ], {runId, taskId, state: "FAILED"});
          throw new ControllerError("WORKER_FAILED", error instanceof Error ? error.message : String(error));
        }
      }
      const completedAt = new Date().toISOString();
      this.#append(runId, `resume-complete:${runId}:${this.#events.latestStreamVersion(runId)}`, sha256Canonical({runId, tasks: this.getRun(runId).tasks.map((task) => ({id: task.id, state: task.state}))}), [
        event("run.state_changed", SYSTEM_ACTOR, completedAt, {runId, from: "RUNNING", to: "SUCCEEDED"}),
      ], {runId, state: "SUCCEEDED"});
      return this.getRun(runId);
    } finally {
      this.#activeRuns.delete(runId);
    }
  }

  public pause(runId: string): RunView {
    const run = this.getRun(runId);
    if (run.state !== "RUNNING") throw new ControllerError("RUN_NOT_PAUSABLE", `run ${runId} is ${run.state}`);
    this.#activeRuns.get(runId)?.abort(new Error("run paused by operator"));
    const now = new Date().toISOString();
    this.#append(runId, `pause:${runId}:${this.#events.latestStreamVersion(runId)}`, sha256Canonical({runId, state: run.state}), [
      event("run.state_changed", SYSTEM_ACTOR, now, {runId, from: "RUNNING", to: "PAUSING"}),
      event("run.state_changed", SYSTEM_ACTOR, now, {runId, from: "PAUSING", to: "PAUSED"}),
    ], {runId, state: "PAUSED"});
    return this.getRun(runId);
  }

  public cancel(runId: string): RunView {
    const run = this.getRun(runId);
    if (!canTransitionRun(run.state, "CANCELED")) throw new ControllerError("RUN_NOT_CANCELABLE", `run ${runId} cannot be canceled from ${run.state}`);
    this.#activeRuns.get(runId)?.abort(new Error("run canceled by operator"));
    const now = new Date().toISOString();
    this.#append(runId, `cancel:${runId}:${this.#events.latestStreamVersion(runId)}`, sha256Canonical({runId, state: run.state}), [
      event("run.state_changed", SYSTEM_ACTOR, now, {runId, from: run.state, to: "CANCELED"}),
    ], {runId, state: "CANCELED"});
    return this.getRun(runId);
  }

  public snapshot(): ControllerSnapshot {
    const events = this.#events.replay();
    return {
      schema: "agent-company.snapshot/v1",
      projectId: this.#projectId,
      projectName: this.#projectName,
      runs: reduceRuns(events),
      events,
      generatedAt: new Date().toISOString(),
    };
  }

  async #loadProject(): Promise<void> {
    const config = await loadProjectConfig(this.#workspace);
    this.#projectId = config.mapping_id;
    this.#projectName = sanitizeTerminal(config.project.name, 256);
    const stream = `project:${this.#projectId}`;
    if (this.#events.latestStreamVersion(stream) === 0) {
      const now = new Date().toISOString();
      this.#append(stream, `project:${this.#projectId}:create`, sha256Canonical({id: this.#projectId, name: this.#projectName}), [
        event("project.created", {type: "human", id: "local-user"}, now, {projectId: this.#projectId, name: this.#projectName}),
      ], {projectId: this.#projectId});
    }
  }

  #append(streamId: string, commandId: string, operationHash: string, events: readonly EventToAppend[], response: JsonObject): void {
    this.#events.append({
      commandId,
      operationHash,
      streamId,
      expectedVersion: this.#events.latestStreamVersion(streamId),
      events,
      response,
      createdAt: new Date().toISOString(),
    });
  }
}

export class ControllerError extends Error {
  public constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "ControllerError";
  }
}

interface ProposedTask extends DagNode {
  readonly title: string;
  readonly role: string;
}

function buildVerticalSlice(runId: string, activeRoles: readonly string[]): readonly ProposedTask[] {
  const choose = (preferred: string, fallback: string): string => activeRoles.includes(preferred) ? preferred : fallback;
  return [
    {id: `${runId}:intake`, title: "Interpret objective and constraints", role: "client-intake-account", dependsOn: []},
    {id: `${runId}:plan`, title: "Create bounded delivery plan", role: "product-manager", dependsOn: [`${runId}:intake`]},
    {id: `${runId}:implement`, title: "Implement the approved slice", role: choose("frontend-engineer", "backend-engineer"), dependsOn: [`${runId}:plan`]},
    {id: `${runId}:review`, title: "Independently review the candidate", role: "code-reviewer", dependsOn: [`${runId}:implement`]},
    {id: `${runId}:verify`, title: "Verify acceptance evidence", role: choose("test-automation-engineer", "qa-strategist"), dependsOn: [`${runId}:review`]},
  ];
}

function taskJson(task: ProposedTask): JsonObject {
  return {id: task.id, title: task.title, role: task.role, dependsOn: [...task.dependsOn]};
}

function event(eventType: string, actor: ActorRef, occurredAt: string, data: JsonObject): EventToAppend {
  return {eventType, actor, occurredAt, data};
}

function manifestJson(manifest: ReturnType<typeof createWorkerManifest>): JsonObject {
  return {
    schema: manifest.schema,
    attemptId: manifest.attemptId,
    leaseId: manifest.leaseId,
    leaseExpiresAt: manifest.leaseExpiresAt,
    runId: manifest.runId,
    taskId: manifest.taskId,
    role: manifest.role,
    workspace: manifest.workspace,
    objective: manifest.objective,
    modelId: manifest.modelId,
    limits: {wallTimeMs: manifest.limits.wallTimeMs, maxOutputBytes: manifest.limits.maxOutputBytes},
  };
}

function taskStartEvents(runId: string, task: TaskView, occurredAt: string): readonly EventToAppend[] {
  const result: EventToAppend[] = [];
  let state = task.state;
  const transition = (to: TaskState): void => {
    if (!canTransitionTask(state, to)) throw new ControllerError("TASK_NOT_EXECUTABLE", `task ${task.id} cannot transition ${state} -> ${to}`);
    result.push(event("task.state_changed", SYSTEM_ACTOR, occurredAt, {runId, taskId: task.id, from: state, to}));
    state = to;
  };
  if (state === "REVIEW") transition("REWORK");
  if (state === "PROPOSED" || state === "BLOCKED" || state === "REWORK") transition("READY");
  if (state === "READY") transition("CLAIMED");
  if (["CLAIMED", "WAITING_TOOL", "WAITING_INPUT", "WAITING_APPROVAL"].includes(state)) transition("RUNNING");
  if (state !== "RUNNING") throw new ControllerError("TASK_NOT_EXECUTABLE", `task ${task.id} cannot execute from ${state}`);
  return result;
}

function reduceRuns(events: readonly StoredEvent[]): readonly RunView[] {
  const runs = new Map<string, {
    id: string; projectId: string; objective: string; state: RunState; createdAt: string;
    tasks: Map<string, TaskView>; agents: Map<string, AgentView>; approvalIds: string[]; costUsd: number;
  }>();
  for (const envelope of events) {
    const data = envelope.data as Record<string, unknown>;
    const runId = typeof data.runId === "string" ? data.runId : undefined;
    if (envelope.eventType === "run.created" && runId) {
      runs.set(runId, {
        id: runId,
        projectId: String(data.projectId),
        objective: String(data.objective),
        state: String(data.state) as RunState,
        createdAt: String(data.createdAt),
        tasks: new Map(), agents: new Map(), approvalIds: [], costUsd: 0,
      });
      continue;
    }
    if (!runId) continue;
    const run = runs.get(runId);
    if (!run) continue;
    if (envelope.eventType === "run.state_changed") {
      const from = String(data.from) as RunState;
      const to = String(data.to) as RunState;
      if (from !== run.state || !canTransitionRun(from, to)) {
        throw new ControllerError("CORRUPT_EVENT_STREAM", `invalid replayed run transition ${from} -> ${to}`);
      }
      run.state = to;
    }
    if (envelope.eventType === "task.proposed") {
      run.tasks.set(String(data.id), {
        id: String(data.id),
        title: String(data.title),
        role: String(data.role),
        dependsOn: Array.isArray(data.dependsOn) ? data.dependsOn.map(String) : [],
        state: "PROPOSED",
        summary: "",
      });
    }
    if (envelope.eventType === "task.state_changed") {
      const task = run.tasks.get(String(data.taskId));
      if (task) {
        const from = String(data.from) as TaskState;
        const to = String(data.to) as TaskState;
        if (from !== task.state || !canTransitionTask(from, to)) {
          throw new ControllerError("CORRUPT_EVENT_STREAM", `invalid replayed task transition ${from} -> ${to}`);
        }
        run.tasks.set(task.id, {...task, state: to});
      }
    }
    if (envelope.eventType === "task.evidence_recorded") {
      const task = run.tasks.get(String(data.taskId));
      if (task) run.tasks.set(task.id, {...task, summary: String(data.summary)});
      if (typeof data.costUsd === "number") run.costUsd += data.costUsd;
    }
    if (envelope.eventType === "agent.activated") {
      const state = String(data.state);
      if (!(AGENT_STATUSES as readonly string[]).includes(state)) throw new ControllerError("CORRUPT_EVENT_STREAM", `invalid replayed agent state ${state}`);
      run.agents.set(String(data.agentId), {
        id: String(data.agentId), role: String(data.role), displayName: String(data.displayName),
        state: state as AgentStatus, taskId: String(data.taskId), model: String(data.model),
        modelClass: ["reasoning", "coding", "fast"].includes(String(data.modelClass))
          ? String(data.modelClass) as AgentView["modelClass"]
          : "fast",
        why: typeof data.why === "string" ? data.why : "activated by a legacy run event",
        scopes: Array.isArray(data.scopes) ? data.scopes.map(String) : [],
        estimatedCostUsd: typeof data.estimatedCostUsd === "number" ? data.estimatedCostUsd : "UNKNOWN",
        deactivateWhen: typeof data.deactivateWhen === "string" ? data.deactivateWhen : "task is terminal",
      });
    }
    if (envelope.eventType === "approval.requested") run.approvalIds.push(String(data.approvalId));
  }
  return [...runs.values()].map((run) => ({
    id: run.id,
    projectId: run.projectId,
    objective: run.objective,
    state: run.state,
    createdAt: run.createdAt,
    tasks: [...run.tasks.values()],
    agents: [...run.agents.values()],
    approvalIds: run.approvalIds,
    costUsd: run.costUsd,
  })).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}
