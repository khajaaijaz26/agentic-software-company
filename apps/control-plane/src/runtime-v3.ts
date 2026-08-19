import {createHash, randomUUID} from "node:crypto";

import {
  SOFTWARE_AGENT_EVENT_SCHEMA,
  SOFTWARE_AGENT_EVENTS_SCHEMA,
  SOFTWARE_AGENT_SNAPSHOT_SCHEMA,
  assertSoftwareAgentCommandContext,
  type AgentSessionState,
  type AssignmentState,
  type AttemptState,
  type HandoffState,
  type QuestionState,
  type SoftwareAgentCommandContext,
  type SoftwareAgentRole,
} from "../../../packages/domain/src/index.js";
import {
  sha256Canonical,
  type ActorRef,
  type CommandReceipt,
  type JsonObject,
  type StoredEvent,
} from "../../../packages/contracts/src/index.js";
import type {SqliteEventStore, EventToAppend} from "../../../packages/event-store-sqlite/src/index.js";
import {ChildWorkerSupervisor, WorkerSupervisorError} from "../../../packages/worker-supervisor/src/index.js";
import {StepManifestSchema, type StepFrame, type StepManifest} from "../../worker-runtime/src/index.js";
import {sanitizeTerminal} from "../../../packages/observability/src/index.js";

export type {SoftwareAgentCommandContext} from "../../../packages/domain/src/index.js";

export type SoftwareAgentRunState = "PAUSED" | "RUNNING" | "PAUSING" | "RECOVERING" | "SUCCEEDED" | "FAILED" | "CANCELED";
export type SoftwareAgentTaskState = "BLOCKED" | "READY" | "RUNNING" | "PASSED" | "FAILED" | "CANCELED";

export interface MutationLeaseView {
  readonly leaseId: string;
  readonly attachmentId: string;
  readonly fence: number;
  readonly acquiredAt: string;
  readonly expiresAt: string;
  readonly state: "ACTIVE" | "RELEASED" | "EXPIRED";
}

export interface SoftwareAgentTaskView {
  readonly id: string;
  readonly title: string;
  readonly role: SoftwareAgentRole;
  readonly dependsOn: readonly string[];
  readonly mutatesWorkspace: boolean;
  readonly state: SoftwareAgentTaskState;
  readonly revision: number;
  readonly sessionId: string;
  readonly activeTurnId?: string | undefined;
  readonly summary: string;
}

export interface AgentSessionViewV2 {
  readonly id: string;
  readonly role: SoftwareAgentRole;
  readonly state: AgentSessionState;
  readonly revision: number;
  readonly currentTaskId?: string | undefined;
  readonly currentTurnId?: string | undefined;
  readonly lastHeartbeatAt?: string | undefined;
  readonly leaseExpiresAt?: string | undefined;
}

export interface AssignmentView {
  readonly id: string;
  readonly taskId: string;
  readonly sessionId: string;
  readonly taskRevision: number;
  readonly state: AssignmentState;
}

export interface AttemptView {
  readonly id: string;
  readonly taskId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly taskRevision: number;
  readonly turnRevision: number;
  readonly leaseId: string;
  readonly leaseExpiresAt: string;
  readonly fencingEpoch: number;
  readonly state: AttemptState;
  readonly startedAt: string;
  readonly lastHeartbeatAt: string;
  readonly completedAt?: string | undefined;
}

export interface HandoffView {
  readonly id: string;
  readonly fromSessionId: string;
  readonly toSessionId: string;
  readonly taskId: string;
  readonly state: HandoffState;
  readonly offeredAt: string;
  readonly decidedAt?: string;
}

export interface QuestionView {
  readonly id: string;
  readonly sessionId: string;
  readonly prompt: string;
  readonly state: QuestionState;
  readonly askedAt: string;
  readonly answer?: string;
  readonly answeredAt?: string;
}

export interface MailboxMessageView {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly kind: "ASSIGNMENT" | "QUESTION" | "ANSWER" | "HANDOFF" | "INSTRUCTION";
  readonly payload: string;
  readonly createdAt: string;
}

export interface SoftwareAgentRunView {
  readonly id: string;
  readonly projectId: string;
  readonly objective: string;
  readonly state: SoftwareAgentRunState;
  readonly revision: number;
  readonly maxParallel: number;
  readonly createdAt: string;
  readonly tasks: readonly SoftwareAgentTaskView[];
  readonly sessions: readonly AgentSessionViewV2[];
  readonly assignments: readonly AssignmentView[];
  readonly attempts: readonly AttemptView[];
  readonly handoffs: readonly HandoffView[];
  readonly questions: readonly QuestionView[];
  readonly mailbox: readonly MailboxMessageView[];
}

export interface SoftwareAgentSnapshot {
  readonly schema: typeof SOFTWARE_AGENT_SNAPSHOT_SCHEMA;
  readonly cursor: number;
  readonly projectId: string;
  readonly projectName: string;
  readonly generatedAt: string;
  readonly mutationLease: MutationLeaseView | null;
  readonly runs: readonly SoftwareAgentRunView[];
  readonly recentEvents: readonly StoredEvent[];
  readonly tokenBudgets: readonly SoftwareAgentTokenBudgetView[];
}

export interface SoftwareAgentTokenBudgetView {
  readonly runId: string;
  readonly mode: "economy" | "balanced" | "quality";
  readonly fullLimitTokens: number;
  readonly effectiveLimitTokens: number;
  readonly spentTokens: number;
  readonly reservedTokens: number;
  readonly uncertainTokens: number;
  readonly remainingTokens: number;
  readonly warning: boolean;
  readonly blocked: boolean;
  readonly agents: readonly {
    readonly agentId: string;
    readonly allocatedTokens: number;
    readonly spentTokens: number;
    readonly reservedTokens: number;
    readonly remainingTokens: number;
  }[];
}

export interface SoftwareAgentEventsPage {
  readonly schema: typeof SOFTWARE_AGENT_EVENTS_SCHEMA;
  readonly events: readonly StoredEvent[];
  readonly cursor: number;
  readonly hasMore: boolean;
  readonly resyncRequired: boolean;
}

export interface SoftwareAgentCommandReceipt {
  readonly schema: "software-agent.command-receipt/v2";
  readonly accepted: true;
  readonly runId: string;
  readonly revision: number;
}

export interface MutationLeaseCommand {
  readonly commandId: string;
  readonly attachmentId: string;
  readonly actor: ActorRef;
  readonly correlationId: string;
}

export interface ReleaseMutationLeaseCommand extends MutationLeaseCommand {
  readonly leaseId: string;
  readonly fence: number;
}

export interface CreateSoftwareAgentRunCommand extends SoftwareAgentCommandContext {
  readonly objective: string;
  readonly maxParallel: number;
  readonly tokenMode?: "economy" | "balanced" | "quality";
}

export interface RunSoftwareAgentCommand extends SoftwareAgentCommandContext {
  readonly runId: string;
}

export interface AskQuestionCommand extends RunSoftwareAgentCommand {
  readonly sessionId: string;
  readonly prompt: string;
}

export interface AnswerQuestionCommand extends RunSoftwareAgentCommand {
  readonly questionId: string;
  readonly answer: string;
}

export interface InstructionTarget {
  readonly kind: "agent" | "task" | "run";
  readonly id: string;
}

export interface SubmitInstructionCommand extends RunSoftwareAgentCommand {
  readonly target: InstructionTarget;
  readonly text: string;
}

export interface QuestionCommandResult {
  readonly question: QuestionView;
  readonly runRevision: number;
}

export interface InstructionCommandResult {
  readonly message: MailboxMessageView;
  readonly runRevision: number;
}

export type CompletedSoftwareAgentStepFrame = Extract<StepFrame, {readonly kind: "worker.completed"}>;

export interface SoftwareAgentStepExecutionRequest {
  readonly manifest: StepManifest;
  readonly signal: AbortSignal;
  readonly onFrame: (frame: StepFrame) => void;
}

/** Controller-owned execution boundary. Provider and tool credentials must not be copied into worker manifests. */
export type SoftwareAgentStepExecutor = (
  request: SoftwareAgentStepExecutionRequest,
) => Promise<CompletedSoftwareAgentStepFrame>;

interface MutableRun {
  id: string;
  projectId: string;
  objective: string;
  state: SoftwareAgentRunState;
  revision: number;
  maxParallel: number;
  createdAt: string;
  tasks: Map<string, SoftwareAgentTaskView>;
  sessions: Map<string, AgentSessionViewV2>;
  assignments: Map<string, AssignmentView>;
  attempts: Map<string, AttemptView>;
  handoffs: Map<string, HandoffView>;
  questions: Map<string, QuestionView>;
  mailbox: Map<string, MailboxMessageView>;
}

interface RuntimeOptions {
  readonly workspace: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly events: SqliteEventStore;
  readonly workers?: ChildWorkerSupervisor;
  readonly stepExecutor?: SoftwareAgentStepExecutor;
  readonly mutationLeaseTtlMs?: number;
}

const SYSTEM_ACTOR: ActorRef = {type: "system", id: "software-agent-controller"};
const MAX_RECENT_EVENTS = 250;
const MAX_POLL_BACKLOG = 512;
const MAX_POLL_BYTES = 512 * 1024;

export class SoftwareAgentRuntime {
  readonly #workspace: string;
  readonly #projectId: string;
  readonly #projectName: string;
  readonly #events: SqliteEventStore;
  readonly #executeStep: SoftwareAgentStepExecutor;
  readonly #mutationLeaseTtlMs: number;
  readonly #running = new Map<string, Promise<void>>();
  readonly #abort = new Map<string, AbortController>();
  #workspaceMutationAttempt: string | undefined;
  #closing = false;

  public constructor(options: RuntimeOptions) {
    this.#workspace = options.workspace;
    this.#projectId = options.projectId;
    this.#projectName = options.projectName;
    this.#events = options.events;
    const workers = options.workers ?? new ChildWorkerSupervisor();
    this.#executeStep = options.stepExecutor ?? (async ({manifest, signal, onFrame}) => {
      const execution = await workers.executeStep(manifest, {signal, onFrame});
      return execution.result;
    });
    this.#mutationLeaseTtlMs = options.mutationLeaseTtlMs ?? 15_000;
  }

  public recover(): Promise<void> {
    const runs = this.#runs();
    for (const run of runs) {
      if (run.state !== "RUNNING" && run.state !== "RECOVERING" && run.state !== "PAUSING") continue;
      const now = new Date().toISOString();
      const recoveryEvents: EventToAppend[] = [];
      for (const attempt of run.attempts.filter((candidate) => candidate.state === "RUNNING" || candidate.state === "LEASED")) {
        recoveryEvents.push(runtimeEvent("software-agent.attempt.fenced", SYSTEM_ACTOR, now, {
          runId: run.id,
          attemptId: attempt.id,
          taskId: attempt.taskId,
          sessionId: attempt.sessionId,
          fencingEpoch: attempt.fencingEpoch,
          reason: "controller restart fenced the stale worker",
        }));
        const task = run.tasks.find((candidate) => candidate.id === attempt.taskId);
        if (task && task.state === "RUNNING") {
          recoveryEvents.push(runtimeEvent("software-agent.task.ready", SYSTEM_ACTOR, now, {runId: run.id, taskId: task.id}));
        }
        const assignment = run.assignments.find((candidate) => candidate.taskId === attempt.taskId && candidate.state === "ACTIVE");
        if (assignment) {
          recoveryEvents.push(runtimeEvent("software-agent.assignment.released", SYSTEM_ACTOR, now, {
            runId: run.id,
            assignmentId: assignment.id,
            reason: "controller restart released the stale assignment",
          }));
        }
        recoveryEvents.push(runtimeEvent("software-agent.session.state_changed", SYSTEM_ACTOR, now, {
          runId: run.id,
          sessionId: attempt.sessionId,
          state: "IDLE",
        }));
      }
      const target = this.#cancelWasRequested(run.id) ? "CANCELED" : run.state === "PAUSING" ? "PAUSED" : "RECOVERING";
      recoveryEvents.push(runtimeEvent("software-agent.run.state_changed", SYSTEM_ACTOR, now, {runId: run.id, state: target}));
      if (target === "RECOVERING") {
        recoveryEvents.push(runtimeEvent("software-agent.run.state_changed", SYSTEM_ACTOR, now, {runId: run.id, state: "RUNNING"}));
      }
      this.#appendInternal(run.id, `recovery:${run.id}:${run.revision}`, recoveryEvents, {runId: run.id, state: target});
      if (target === "RECOVERING") queueMicrotask(() => this.#ensureScheduled(run.id));
    }
    return Promise.resolve();
  }

  public acquireMutationLease(input: MutationLeaseCommand): MutationLeaseView {
    validateMutationLeaseCommand(input);
    const streamId = this.#controlStream();
    const operationHash = sha256Canonical({
      action: "mutation.acquire",
      attachmentId: input.attachmentId,
      actor: {type: input.actor.type, id: input.actor.id},
      correlationId: input.correlationId,
    });
    const existingReceipt = this.#events.getCommandReceipt<JsonObject>(input.commandId);
    if (existingReceipt) {
      if (existingReceipt.operationHash !== operationHash || existingReceipt.streamId !== streamId) {
        throw new SoftwareAgentRuntimeError("IDEMPOTENCY_CONFLICT", `command ${input.commandId} was reused with different input`);
      }
      return mutationLeaseFromJson(existingReceipt.response);
    }
    const current = this.#currentMutationLease();
    if (current?.state === "ACTIVE" && Date.parse(current.expiresAt) > Date.now()) {
      throw new SoftwareAgentRuntimeError("MUTATION_LEASE_HELD", `attachment ${current.attachmentId} holds the mutation lease`);
    }
    const fence = this.#maximumMutationFence() + 1;
    const acquiredAt = new Date().toISOString();
    const lease: MutationLeaseView = {
      leaseId: deterministicId("mut", input.commandId),
      attachmentId: input.attachmentId,
      fence,
      acquiredAt,
      expiresAt: new Date(Date.now() + this.#mutationLeaseTtlMs).toISOString(),
      state: "ACTIVE",
    };
    this.#events.append({
      commandId: input.commandId,
      operationHash,
      streamId,
      expectedVersion: this.#events.latestStreamVersion(streamId),
      events: [runtimeEvent("software-agent.mutation.acquired", input.actor, acquiredAt, {
        projectId: this.#projectId,
        ...mutationLeaseJson(lease),
      }, input.correlationId, input.commandId)],
      response: mutationLeaseJson(lease),
      createdAt: acquiredAt,
    });
    return lease;
  }

  public renewMutationLease(input: ReleaseMutationLeaseCommand): MutationLeaseView {
    validateMutationLeaseCommand(input);
    const operationHash = mutationCommandHash("mutation.renew", input);
    const existingReceipt = this.#events.getCommandReceipt<JsonObject>(input.commandId);
    if (existingReceipt) return replayMutationReceipt(existingReceipt, operationHash, this.#controlStream(), input.commandId);
    const current = this.#requireMutationLease(input.attachmentId, input.leaseId, input.fence);
    const renewedAt = new Date().toISOString();
    const renewed: MutationLeaseView = {...current, expiresAt: new Date(Date.now() + this.#mutationLeaseTtlMs).toISOString()};
    const result = this.#events.append({
      commandId: input.commandId,
      operationHash,
      streamId: this.#controlStream(),
      expectedVersion: this.#events.latestStreamVersion(this.#controlStream()),
      events: [runtimeEvent("software-agent.mutation.renewed", input.actor, renewedAt, {
        projectId: this.#projectId,
        ...mutationLeaseJson(renewed),
      }, input.correlationId, input.commandId)],
      response: mutationLeaseJson(renewed),
      createdAt: renewedAt,
    });
    return mutationLeaseFromJson(result.receipt.response);
  }

  public releaseMutationLease(input: ReleaseMutationLeaseCommand): MutationLeaseView {
    validateMutationLeaseCommand(input);
    const operationHash = mutationCommandHash("mutation.release", input);
    const existingReceipt = this.#events.getCommandReceipt<JsonObject>(input.commandId);
    if (existingReceipt) return replayMutationReceipt(existingReceipt, operationHash, this.#controlStream(), input.commandId);
    const current = this.#requireMutationLease(input.attachmentId, input.leaseId, input.fence);
    const releasedAt = new Date().toISOString();
    const released: MutationLeaseView = {...current, expiresAt: releasedAt, state: "RELEASED"};
    const result = this.#events.append({
      commandId: input.commandId,
      operationHash,
      streamId: this.#controlStream(),
      expectedVersion: this.#events.latestStreamVersion(this.#controlStream()),
      events: [runtimeEvent("software-agent.mutation.released", input.actor, releasedAt, {
        projectId: this.#projectId,
        ...mutationLeaseJson(released),
      }, input.correlationId, input.commandId)],
      response: mutationLeaseJson(released),
      createdAt: releasedAt,
    });
    return mutationLeaseFromJson(result.receipt.response);
  }

  public createRun(input: CreateSoftwareAgentRunCommand): SoftwareAgentRunView {
    assertSoftwareAgentCommandContext(input);
    const objective = sanitizeTerminal(input.objective.trim(), 32_768);
    if (objective.length === 0) throw new SoftwareAgentRuntimeError("OBJECTIVE_REQUIRED", "objective is required");
    if (!Number.isSafeInteger(input.maxParallel) || input.maxParallel < 1 || input.maxParallel > 3) {
      throw new SoftwareAgentRuntimeError("MAX_PARALLEL_INVALID", "maxParallel must be between 1 and 3");
    }
    if (input.tokenMode !== undefined && !["economy", "balanced", "quality"].includes(input.tokenMode)) {
      throw new SoftwareAgentRuntimeError("TOKEN_MODE_INVALID", "tokenMode must be economy, balanced, or quality");
    }
    const runId = deterministicId("run", input.commandId);
    const streamId = runId;
    const operationHash = runCommandHash(input, "run.create", {
      objective,
      maxParallel: input.maxParallel,
      tokenMode: input.tokenMode ?? "balanced",
    }, runId);
    const existingReceipt = this.#events.getCommandReceipt<JsonObject>(input.commandId);
    if (existingReceipt) {
      assertReplayReceipt(existingReceipt, operationHash, streamId, input.commandId);
      return this.getRun(runId);
    }
    this.#assertCommandLease(input);
    if (input.expectedRunRevision !== 0) throw new SoftwareAgentRuntimeError("RUN_REVISION_CONFLICT", "new runs require expected revision 0");
    const tasks = initialTasks(runId);
    const sessions = initialSessions(runId);
    const now = new Date().toISOString();
    const events: EventToAppend[] = [
      runtimeEvent("software-agent.run.created", input.actor, now, {
        runId,
        projectId: this.#projectId,
        objective,
        state: "PAUSED",
        maxParallel: input.maxParallel,
        tokenMode: input.tokenMode ?? "balanced",
        createdAt: now,
      }, input.correlationId, input.causationId),
      ...sessions.map((session) => runtimeEvent("software-agent.session.created", SYSTEM_ACTOR, now, {
        runId,
        sessionId: session.id,
        role: session.role,
        state: session.state,
      }, input.correlationId, input.commandId)),
      ...tasks.map((task) => runtimeEvent("software-agent.task.created", SYSTEM_ACTOR, now, {
        runId,
        taskId: task.id,
        title: task.title,
        role: task.role,
        dependsOn: [...task.dependsOn],
        mutatesWorkspace: task.mutatesWorkspace,
        state: task.state,
        sessionId: task.sessionId,
      }, input.correlationId, input.commandId)),
    ];
    this.#events.append({
      commandId: input.commandId,
      operationHash,
      streamId,
      expectedVersion: 0,
      events,
      response: {runId},
      createdAt: now,
    });
    return this.getRun(runId);
  }

  public resumeRun(input: RunSoftwareAgentCommand): SoftwareAgentCommandReceipt {
    return this.#changeRunState(input, "RUNNING", "run.resume", () => queueMicrotask(() => this.#ensureScheduled(input.runId)));
  }

  public pauseRun(input: RunSoftwareAgentCommand): SoftwareAgentCommandReceipt {
    return this.#changeRunState(input, "PAUSING", "run.pause", () => {
      this.#abort.get(input.runId)?.abort(new Error("run pause requested"));
      if (!this.#running.has(input.runId)) this.#finishInterruption(input.runId, "PAUSED");
    });
  }

  public cancelRun(input: RunSoftwareAgentCommand): SoftwareAgentCommandReceipt {
    assertSoftwareAgentCommandContext(input);
    const operation: JsonObject = {intent: "cancel"};
    const operationHash = runCommandHash(input, "run.cancel", operation, input.runId);
    const replay = this.#events.getCommandReceipt<JsonObject>(input.commandId);
    if (replay) {
      assertReplayReceipt(replay, operationHash, input.runId, input.commandId);
      return commandReceiptFromJson(replay.response);
    }
    this.#assertCommandLease(input);
    const run = this.getRun(input.runId);
    this.#assertRunRevision(run, input.expectedRunRevision);
    if (["SUCCEEDED", "FAILED", "CANCELED"].includes(run.state)) {
      throw new SoftwareAgentRuntimeError("RUN_NOT_CANCELABLE", `run ${run.id} is ${run.state}`);
    }
    const receipt = commandReceipt(run.id, input.expectedRunRevision + 1);
    const result = this.#appendCommand(input, "run.cancel", operation, [
      runtimeEvent("software-agent.run.cancel_requested", input.actor, new Date().toISOString(), {
        runId: run.id,
        requestedAtRevision: input.expectedRunRevision,
      }, input.correlationId, input.causationId),
    ], commandReceiptJson(receipt));
    this.#abort.get(input.runId)?.abort(new Error("run cancel requested"));
    if (!this.#running.has(input.runId)) this.#finishInterruption(input.runId, "CANCELED");
    return commandReceiptFromJson(result.receipt.response);
  }

  public askQuestion(input: AskQuestionCommand): QuestionCommandResult {
    assertSoftwareAgentCommandContext(input);
    const prompt = sanitizeTerminal(input.prompt.trim(), 4096);
    if (!prompt) throw new SoftwareAgentRuntimeError("QUESTION_REQUIRED", "question prompt is required");
    const operation: JsonObject = {sessionId: input.sessionId, prompt};
    const operationHash = runCommandHash(input, "question.ask", operation, input.runId);
    const replay = this.#events.getCommandReceipt<JsonObject>(input.commandId);
    if (replay) {
      assertReplayReceipt(replay, operationHash, input.runId, input.commandId);
      return questionCommandResultFromJson(replay.response);
    }
    this.#assertCommandLease(input);
    const run = this.getRun(input.runId);
    this.#assertRunRevision(run, input.expectedRunRevision);
    if (!run.sessions.some((session) => session.id === input.sessionId)) throw new SoftwareAgentRuntimeError("SESSION_NOT_FOUND", `unknown session ${input.sessionId}`);
    const questionId = deterministicId("qst", input.commandId);
    const messageId = deterministicId("msg", `${input.commandId}:question`);
    const now = new Date().toISOString();
    const question: QuestionView = {id: questionId, sessionId: input.sessionId, prompt, state: "OPEN", askedAt: now};
    const response = questionCommandResultJson({question, runRevision: input.expectedRunRevision + 2});
    const result = this.#appendCommand(input, "question.ask", operation, [
      runtimeEvent("software-agent.question.opened", input.actor, now, {
        runId: run.id, questionId, sessionId: input.sessionId, prompt, askedAt: now,
      }, input.correlationId, input.causationId),
      runtimeEvent("software-agent.mailbox.message_queued", input.actor, now, {
        runId: run.id, messageId, from: input.actor.id, to: input.sessionId, kind: "QUESTION", payload: prompt, createdAt: now,
      }, input.correlationId, questionId),
    ], response);
    return questionCommandResultFromJson(result.receipt.response);
  }

  public answerQuestion(input: AnswerQuestionCommand): QuestionCommandResult {
    assertSoftwareAgentCommandContext(input);
    const answer = sanitizeTerminal(input.answer.trim(), 4096);
    if (!answer) throw new SoftwareAgentRuntimeError("ANSWER_REQUIRED", "answer is required");
    const operation: JsonObject = {questionId: input.questionId, answer};
    const operationHash = runCommandHash(input, "question.answer", operation, input.runId);
    const replay = this.#events.getCommandReceipt<JsonObject>(input.commandId);
    if (replay) {
      assertReplayReceipt(replay, operationHash, input.runId, input.commandId);
      return questionCommandResultFromJson(replay.response);
    }
    this.#assertCommandLease(input);
    const run = this.getRun(input.runId);
    this.#assertRunRevision(run, input.expectedRunRevision);
    const question = run.questions.find((candidate) => candidate.id === input.questionId);
    if (!question) throw new SoftwareAgentRuntimeError("QUESTION_NOT_FOUND", `unknown question ${input.questionId}`);
    if (question.state !== "OPEN") throw new SoftwareAgentRuntimeError("QUESTION_ALREADY_ANSWERED", `question ${input.questionId} is ${question.state}`);
    const messageId = deterministicId("msg", `${input.commandId}:answer`);
    const now = new Date().toISOString();
    const answered: QuestionView = {...question, state: "ANSWERED", answer, answeredAt: now};
    const response = questionCommandResultJson({question: answered, runRevision: input.expectedRunRevision + 2});
    const result = this.#appendCommand(input, "question.answer", operation, [
      runtimeEvent("software-agent.question.answered", input.actor, now, {
        runId: run.id, questionId: question.id, answer, answeredAt: now,
      }, input.correlationId, input.causationId),
      runtimeEvent("software-agent.mailbox.message_queued", input.actor, now, {
        runId: run.id, messageId, from: input.actor.id, to: question.sessionId, kind: "ANSWER", payload: answer, createdAt: now,
      }, input.correlationId, question.id),
    ], response);
    return questionCommandResultFromJson(result.receipt.response);
  }

  public submitInstruction(input: SubmitInstructionCommand): InstructionCommandResult {
    assertSoftwareAgentCommandContext(input);
    const text = sanitizeTerminal(input.text.trim(), 4096);
    if (!text) throw new SoftwareAgentRuntimeError("INSTRUCTION_REQUIRED", "instruction text is required");
    if (!["agent", "task", "run"].includes(input.target.kind) || input.target.id.length === 0 || input.target.id.length > 512) {
      throw new SoftwareAgentRuntimeError("INSTRUCTION_TARGET_INVALID", "instruction target is invalid");
    }
    const operation: JsonObject = {target: {kind: input.target.kind, id: input.target.id}, text};
    const operationHash = runCommandHash(input, "instruction.submit", operation, input.runId);
    const replay = this.#events.getCommandReceipt<JsonObject>(input.commandId);
    if (replay) {
      assertReplayReceipt(replay, operationHash, input.runId, input.commandId);
      return instructionCommandResultFromJson(replay.response);
    }
    this.#assertCommandLease(input);
    const run = this.getRun(input.runId);
    this.#assertRunRevision(run, input.expectedRunRevision);
    const recipient = instructionRecipient(run, input.target);
    const now = new Date().toISOString();
    const instructionId = deterministicId("ins", input.commandId);
    const message: MailboxMessageView = {
      id: deterministicId("msg", `${input.commandId}:instruction`),
      from: input.actor.id,
      to: recipient,
      kind: "INSTRUCTION",
      payload: text,
      createdAt: now,
    };
    const response = instructionCommandResultJson({message, runRevision: input.expectedRunRevision + 2});
    const result = this.#appendCommand(input, "instruction.submit", operation, [
      runtimeEvent("software-agent.instruction.submitted", input.actor, now, {
        runId: run.id,
        instructionId,
        target: {kind: input.target.kind, id: input.target.id},
        text,
        submittedAt: now,
      }, input.correlationId, input.causationId),
      runtimeEvent("software-agent.mailbox.message_queued", input.actor, now, {
        runId: run.id,
        messageId: message.id,
        from: message.from,
        to: message.to,
        kind: message.kind,
        payload: message.payload,
        createdAt: message.createdAt,
      }, input.correlationId, instructionId),
    ], response);
    return instructionCommandResultFromJson(result.receipt.response);
  }

  public snapshot(options: {readonly recentEventLimit?: number} = {}): SoftwareAgentSnapshot {
    const limit = options.recentEventLimit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > MAX_RECENT_EVENTS) throw new TypeError("recentEventLimit must be between 0 and 250");
    const cursor = this.#events.latestSequence();
    const recentEvents = limit === 0 ? [] : this.#events.recent(limit);
    return {
      schema: SOFTWARE_AGENT_SNAPSHOT_SCHEMA,
      cursor,
      projectId: this.#projectId,
      projectName: this.#projectName,
      generatedAt: new Date().toISOString(),
      mutationLease: this.#currentMutationLease(),
      runs: this.#runs(),
      recentEvents,
      tokenBudgets: [],
    };
  }

  public history(input: {readonly runId?: string; readonly afterCursor: number; readonly limit?: number}): SoftwareAgentEventsPage {
    const limit = input.limit ?? 250;
    validateEventQuery(input.afterCursor, limit, 0);
    const scanned = this.#events.replay(input.afterCursor, limit);
    const events = input.runId === undefined ? scanned : scanned.filter((event) => event.streamId === input.runId);
    const cursor = scanned.at(-1)?.sequence ?? input.afterCursor;
    return {
      schema: SOFTWARE_AGENT_EVENTS_SCHEMA,
      events,
      cursor,
      hasMore: this.#events.latestSequence() > cursor,
      resyncRequired: false,
    };
  }

  public async poll(input: {readonly afterCursor: number; readonly limit?: number; readonly waitMs?: number}, signal?: AbortSignal): Promise<SoftwareAgentEventsPage> {
    const limit = input.limit ?? 250;
    const waitMs = input.waitMs ?? 30_000;
    validateEventQuery(input.afterCursor, limit, waitMs);
    let backlog = this.#events.replay(input.afterCursor, MAX_POLL_BACKLOG + 1);
    if (backlog.length === 0 && waitMs > 0) {
      backlog = await this.#events.waitForEvents(input.afterCursor, {limit: MAX_POLL_BACKLOG + 1, timeoutMs: waitMs, ...(signal ? {signal} : {})});
    }
    const bytes = backlog.reduce((total, event) => total + Buffer.byteLength(JSON.stringify(event), "utf8"), 0);
    if (backlog.length > MAX_POLL_BACKLOG || bytes > MAX_POLL_BYTES) {
      return {schema: SOFTWARE_AGENT_EVENTS_SCHEMA, events: [], cursor: input.afterCursor, hasMore: true, resyncRequired: true};
    }
    const events = backlog.slice(0, limit);
    const cursor = events.at(-1)?.sequence ?? input.afterCursor;
    return {
      schema: SOFTWARE_AGENT_EVENTS_SCHEMA,
      events,
      cursor,
      hasMore: backlog.length > events.length || this.#events.latestSequence() > cursor,
      resyncRequired: false,
    };
  }

  public getRun(runId: string): SoftwareAgentRunView {
    const run = this.#runs().find((candidate) => candidate.id === runId);
    if (!run) throw new SoftwareAgentRuntimeError("RUN_NOT_FOUND", `unknown v0.3 run ${runId}`);
    return run;
  }

  public async waitForRun(runId: string, states: readonly SoftwareAgentRunState[], timeoutMs: number): Promise<SoftwareAgentRunView> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError("timeoutMs must be positive");
    const deadline = Date.now() + timeoutMs;
    let cursor = this.#events.latestSequence();
    while (Date.now() < deadline) {
      const run = this.getRun(runId);
      if (states.includes(run.state)) return run;
      await this.#events.waitForEvents(cursor, {limit: 250, timeoutMs: Math.min(250, Math.max(1, deadline - Date.now()))});
      cursor = this.#events.latestSequence();
    }
    throw new SoftwareAgentRuntimeError("RUN_WAIT_TIMEOUT", `run ${runId} did not reach ${states.join(" or ")}`);
  }

  public async shutdown(graceMs = 2_000): Promise<void> {
    this.#closing = true;
    for (const controller of this.#abort.values()) controller.abort(new Error("controller shutdown"));
    const active = [...this.#running.values()];
    if (active.length === 0) return;
    await Promise.race([
      Promise.allSettled(active).then(() => undefined),
      new Promise<void>((resolvePromise) => {
        const timer = setTimeout(resolvePromise, graceMs);
        timer.unref();
      }),
    ]);
  }

  #changeRunState(
    input: RunSoftwareAgentCommand,
    state: SoftwareAgentRunState,
    action: string,
    afterCommit: () => void,
  ): SoftwareAgentCommandReceipt {
    assertSoftwareAgentCommandContext(input);
    const operation: JsonObject = {state};
    const operationHash = runCommandHash(input, action, operation, input.runId);
    const replay = this.#events.getCommandReceipt<JsonObject>(input.commandId);
    if (replay) {
      assertReplayReceipt(replay, operationHash, input.runId, input.commandId);
      return commandReceiptFromJson(replay.response);
    }
    this.#assertCommandLease(input);
    const run = this.getRun(input.runId);
    this.#assertRunRevision(run, input.expectedRunRevision);
    if (state === "RUNNING" && run.state !== "PAUSED" && run.state !== "RECOVERING") {
      throw new SoftwareAgentRuntimeError("RUN_NOT_RESUMABLE", `run ${run.id} is ${run.state}`);
    }
    if (state === "PAUSING" && run.state !== "RUNNING") throw new SoftwareAgentRuntimeError("RUN_NOT_PAUSABLE", `run ${run.id} is ${run.state}`);
    const receipt = commandReceipt(run.id, input.expectedRunRevision + 1);
    const result = this.#appendCommand(input, action, operation, [runtimeEvent("software-agent.run.state_changed", input.actor, new Date().toISOString(), {
      runId: run.id,
      state,
    }, input.correlationId, input.causationId)], commandReceiptJson(receipt));
    afterCommit();
    return commandReceiptFromJson(result.receipt.response);
  }

  #appendCommand(
    input: RunSoftwareAgentCommand,
    action: string,
    operation: JsonObject,
    events: readonly EventToAppend[],
    response: JsonObject,
  ): ReturnType<SqliteEventStore["append"]> {
    const operationHash = runCommandHash(input, action, operation, input.runId);
    try {
      return this.#events.append({
        commandId: input.commandId,
        operationHash,
        streamId: input.runId,
        expectedVersion: input.expectedRunRevision,
        events,
        response,
        createdAt: new Date().toISOString(),
      });
    } catch (error) {
      if (error instanceof Error && error.name === "StreamVersionConflictError") {
        throw new SoftwareAgentRuntimeError("RUN_REVISION_CONFLICT", error.message);
      }
      throw error;
    }
  }

  #appendInternal(runId: string, key: string, events: readonly EventToAppend[], response: JsonObject): void {
    if (events.length === 0) return;
    const expectedVersion = this.#events.latestStreamVersion(runId);
    this.#events.append({
      commandId: `internal:${key}`,
      operationHash: sha256Canonical({runId, key, expectedVersion, events: events.map((event) => ({type: event.eventType, data: event.data}))}),
      streamId: runId,
      expectedVersion,
      events,
      response,
      createdAt: new Date().toISOString(),
    });
  }

  #assertCommandLease(input: SoftwareAgentCommandContext): void {
    this.#requireMutationLease(input.uiAttachmentId, input.mutationLease.leaseId, input.mutationLease.fence);
  }

  #requireMutationLease(attachmentId: string, leaseId: string, fence: number): MutationLeaseView {
    const current = this.#currentMutationLease();
    if (!current || current.state !== "ACTIVE" || Date.parse(current.expiresAt) <= Date.now()) {
      throw new SoftwareAgentRuntimeError("MUTATION_LEASE_EXPIRED", "the mutation lease is absent or expired");
    }
    if (current.attachmentId !== attachmentId || current.leaseId !== leaseId || current.fence !== fence) {
      throw new SoftwareAgentRuntimeError("MUTATION_LEASE_STALE", "the mutation lease binding is stale");
    }
    return current;
  }

  #currentMutationLease(): MutationLeaseView | null {
    let current: MutationLeaseView | null = null;
    for (const envelope of this.#events.load(this.#controlStream())) {
      if (!envelope.eventType.startsWith("software-agent.mutation.")) continue;
      current = mutationLeaseFromJson(envelope.data);
    }
    if (current && current.state === "ACTIVE" && Date.parse(current.expiresAt) <= Date.now()) return {...current, state: "EXPIRED"};
    return current;
  }

  #maximumMutationFence(): number {
    return this.#events.load(this.#controlStream()).reduce((maximum, event) => {
      const fence = typeof event.data.fence === "number" ? event.data.fence : 0;
      return Math.max(maximum, fence);
    }, 0);
  }

  #controlStream(): string {
    return `software-agent:control:${this.#projectId}`;
  }

  #assertRunRevision(run: SoftwareAgentRunView, expected: number): void {
    if (run.revision !== expected) throw new SoftwareAgentRuntimeError("RUN_REVISION_CONFLICT", `expected run revision ${expected}, found ${run.revision}`);
  }

  #ensureScheduled(runId: string): void {
    if (this.#closing || this.#running.has(runId)) return;
    const cancellation = new AbortController();
    this.#abort.set(runId, cancellation);
    const promise = this.#schedule(runId, cancellation.signal)
      .catch((error: unknown) => this.#recordSchedulerFailure(runId, error))
      .finally(() => {
        this.#running.delete(runId);
        this.#abort.delete(runId);
      });
    this.#running.set(runId, promise);
  }

  async #schedule(runId: string, signal: AbortSignal): Promise<void> {
    while (!signal.aborted && !this.#closing) {
      let run = this.getRun(runId);
      if (run.state !== "RUNNING") return;
      if (run.tasks.every((task) => task.state === "PASSED")) {
        this.#appendInternal(run.id, `run-succeeded:${run.revision}`, [runtimeEvent("software-agent.run.state_changed", SYSTEM_ACTOR, new Date().toISOString(), {
          runId: run.id,
          state: "SUCCEEDED",
        })], {runId: run.id, state: "SUCCEEDED"});
        return;
      }
      const newlyReady = run.tasks.filter((task) => task.state === "BLOCKED" && task.dependsOn.every((dependency) => run.tasks.find((candidate) => candidate.id === dependency)?.state === "PASSED"));
      if (newlyReady.length > 0) {
        const now = new Date().toISOString();
        this.#appendInternal(run.id, `tasks-ready:${run.revision}`, newlyReady.map((task) => runtimeEvent("software-agent.task.ready", SYSTEM_ACTOR, now, {
          runId: run.id,
          taskId: task.id,
        })), {runId: run.id, ready: newlyReady.map((task) => task.id)});
        run = this.getRun(runId);
      }
      const ready: SoftwareAgentTaskView[] = [];
      const selectedSessions = new Set<string>();
      let selectedMutation = false;
      for (const task of run.tasks.filter((candidate) => candidate.state === "READY")) {
        if (ready.length >= run.maxParallel) break;
        if (selectedSessions.has(task.sessionId)) continue;
        if (task.mutatesWorkspace && (selectedMutation || this.#workspaceMutationAttempt !== undefined)) continue;
        ready.push(task);
        selectedSessions.add(task.sessionId);
        if (task.mutatesWorkspace) selectedMutation = true;
      }
      if (ready.length === 0) {
        const failed = run.tasks.find((task) => task.state === "FAILED");
        if (failed) {
          this.#appendInternal(run.id, `run-failed:${run.revision}`, [runtimeEvent("software-agent.run.state_changed", SYSTEM_ACTOR, new Date().toISOString(), {
            runId: run.id,
            state: "FAILED",
          })], {runId: run.id, state: "FAILED"});
          return;
        }
        if (run.tasks.some((task) => task.state === "READY" && task.mutatesWorkspace) && this.#workspaceMutationAttempt !== undefined) {
          const cursor = this.#events.latestSequence();
          await this.#events.waitForEvents(cursor, {limit: 1, timeoutMs: 100});
          continue;
        }
        throw new SoftwareAgentRuntimeError("SCHEDULER_DEADLOCK", `run ${run.id} has no ready or active task`);
      }
      await Promise.all(ready.map(async (task) => await this.#executeTask(runId, task.id, signal)));
    }
    if (this.#cancelWasRequested(runId)) this.#finishInterruption(runId, "CANCELED");
    else if (this.#closing) this.#markRecovering(runId);
    else this.#finishRequestedInterruption(runId);
  }

  async #executeTask(runId: string, taskId: string, signal: AbortSignal): Promise<void> {
    const run = this.getRun(runId);
    const task = run.tasks.find((candidate) => candidate.id === taskId);
    if (!task || task.state !== "READY") return;
    const session = run.sessions.find((candidate) => candidate.id === task.sessionId);
    if (!session || session.state === "RUNNING") throw new SoftwareAgentRuntimeError("SESSION_BUSY", `session ${task.sessionId} already has an active turn`);
    const turnNumber = run.attempts.filter((attempt) => attempt.sessionId === session.id).length + 1;
    const turnId = deterministicId("trn", `${run.id}:${task.id}:${turnNumber}`);
    const attemptNumber = run.attempts.filter((attempt) => attempt.taskId === task.id).length + 1;
    const attemptId = deterministicId("att", `${run.id}:${task.id}:${attemptNumber}`);
    const assignmentId = deterministicId("asn", `${run.id}:${task.id}:${attemptNumber}`);
    const leaseId = deterministicId("lease", `${attemptId}:${attemptNumber}`);
    if (task.mutatesWorkspace) {
      if (this.#workspaceMutationAttempt !== undefined) return;
      this.#workspaceMutationAttempt = attemptId;
    }
    const now = new Date().toISOString();
    const leaseExpiresAt = new Date(Date.now() + 15 * 60 * 1_000 + 30_000).toISOString();
    const acceptedHandoffs = run.handoffs.filter((handoff) => handoff.toSessionId === session.id && handoff.state === "OFFERED");
    const startEvents: EventToAppend[] = [
      ...acceptedHandoffs.flatMap((handoff) => [
        runtimeEvent("software-agent.handoff.accepted", {type: "agent", id: session.id}, now, {
          runId, handoffId: handoff.id, decidedAt: now,
        }),
        runtimeEvent("software-agent.mailbox.message_queued", SYSTEM_ACTOR, now, {
          runId,
          messageId: deterministicId("msg", `${handoff.id}:accepted`),
          from: session.id,
          to: handoff.fromSessionId,
          kind: "HANDOFF",
          payload: `accepted ${handoff.id}`,
          createdAt: now,
        }),
      ]),
      runtimeEvent("software-agent.assignment.created", SYSTEM_ACTOR, now, {
        runId, assignmentId, taskId: task.id, sessionId: session.id, taskRevision: task.revision, state: "ACTIVE",
      }),
      runtimeEvent("software-agent.mailbox.message_queued", SYSTEM_ACTOR, now, {
        runId,
        messageId: deterministicId("msg", `${assignmentId}:offered`),
        from: "software-agent-controller",
        to: session.id,
        kind: "ASSIGNMENT",
        payload: task.title,
        createdAt: now,
      }),
      runtimeEvent("software-agent.turn.started", {type: "agent", id: session.id}, now, {
        runId, turnId, sessionId: session.id, taskId: task.id, turnRevision: turnNumber,
      }),
      runtimeEvent("software-agent.attempt.started", SYSTEM_ACTOR, now, {
        runId,
        taskId: task.id,
        taskRevision: task.revision,
        sessionId: session.id,
        turnId,
        turnRevision: turnNumber,
        attemptId,
        leaseId,
        leaseExpiresAt,
        fencingEpoch: attemptNumber,
        startedAt: now,
      }),
      runtimeEvent("software-agent.task.started", SYSTEM_ACTOR, now, {runId, taskId: task.id, turnId}),
      runtimeEvent("software-agent.session.state_changed", SYSTEM_ACTOR, now, {
        runId, sessionId: session.id, state: "RUNNING", taskId: task.id, turnId, leaseExpiresAt,
      }),
      ...(task.mutatesWorkspace ? [runtimeEvent("software-agent.workspace-mutation.acquired", SYSTEM_ACTOR, now, {
        runId, taskId: task.id, attemptId, leaseId,
      })] : []),
    ];
    this.#appendInternal(runId, `attempt-start:${attemptId}`, startEvents, {runId, taskId, attemptId});
    const manifest = StepManifestSchema.parse({
      schema: "software-agent.step/v1",
      runId,
      taskId: task.id,
      taskRevision: task.revision,
      sessionId: session.id,
      turnId,
      turnRevision: turnNumber,
      attemptId,
      leaseId,
      fencingEpoch: attemptNumber,
      leaseExpiresAt,
      role: task.role,
      taskTitle: task.title,
      objective: run.objective,
      workspaceRevision: `workspace:${createHash("sha256").update(this.#workspace, "utf8").digest("hex").slice(0, 24)}:v1`,
      simulatedWorkMs: task.id.endsWith(":implementation") || task.id.endsWith(":test-plan-risk") ? 180 : 70,
      heartbeatIntervalMs: 5_000,
      limits: {wallTimeMs: 15 * 60 * 1_000, maxOutputBytes: 1_048_576},
    } satisfies StepManifest);
    try {
      const result = await this.#executeStep({
        manifest,
        signal,
        onFrame: (frame) => this.#recordStepFrame(frame),
      });
      this.#completeTask(result);
    } catch (error) {
      this.#failOrInterruptTask(manifest, error);
    } finally {
      if (this.#workspaceMutationAttempt === attemptId) this.#workspaceMutationAttempt = undefined;
    }
  }

  #recordStepFrame(frame: StepFrame): void {
    if (frame.kind !== "worker.heartbeat" && frame.kind !== "worker.activity") return;
    const run = this.getRun(frame.runId);
    const attempt = run.attempts.find((candidate) => candidate.id === frame.attemptId);
    if (
      !attempt || attempt.state !== "RUNNING"
      || attempt.fencingEpoch !== frame.fencingEpoch
      || attempt.leaseId !== frame.leaseId
      || attempt.taskRevision !== frame.taskRevision
      || attempt.turnRevision !== frame.turnRevision
      || attempt.turnId !== frame.turnId
    ) return;
    if (frame.kind === "worker.activity") {
      const activity = frame.activity;
      this.#appendInternal(frame.runId, `activity:${frame.attemptId}:${frame.at}:${activity.type}:${randomUUID()}`, [runtimeEvent(
        `software-agent.${activity.type}`,
        {type: "agent", id: frame.sessionId},
        frame.at,
        {
          runId: frame.runId,
          taskId: frame.taskId,
          sessionId: frame.sessionId,
          attemptId: frame.attemptId,
          summary: activity.summary,
          ...(activity.providerId === undefined ? {} : {providerId: activity.providerId}),
          ...(activity.modelId === undefined ? {} : {modelId: activity.modelId, model: `${activity.providerId ?? "UNKNOWN"}/${activity.modelId}`}),
          ...(activity.tool === undefined ? {} : {tool: activity.tool}),
          ...(activity.path === undefined ? {} : {path: activity.path}),
          ...(activity.usage === undefined ? {} : {...activity.usage}),
          ...(activity.costUsd === undefined ? {} : {costUsd: activity.costUsd}),
        },
      )], {runId: frame.runId, attemptId: frame.attemptId, activity: activity.type});
      return;
    }
    this.#appendInternal(frame.runId, `heartbeat:${frame.attemptId}:${frame.at}`, [
      runtimeEvent("software-agent.attempt.heartbeat", {type: "agent", id: frame.sessionId}, frame.at, {
        runId: frame.runId, attemptId: frame.attemptId, sessionId: frame.sessionId, at: frame.at,
      }),
      runtimeEvent("software-agent.attempt.checkpointed", {type: "agent", id: frame.sessionId}, frame.at, {
        runId: frame.runId,
        attemptId: frame.attemptId,
        turnId: frame.turnId,
        checkpoint: `checkpoint:${frame.turnId}:${frame.at}`,
      }),
    ], {runId: frame.runId, attemptId: frame.attemptId, heartbeatAt: frame.at});
  }

  #completeTask(frame: Extract<StepFrame, {readonly kind: "worker.completed"}>): void {
    const run = this.getRun(frame.runId);
    const attempt = run.attempts.find((candidate) => candidate.id === frame.attemptId);
    const task = run.tasks.find((candidate) => candidate.id === frame.taskId);
    const session = run.sessions.find((candidate) => candidate.id === frame.sessionId);
    if (
      !attempt || !task || !session
      || attempt.state !== "RUNNING"
      || attempt.fencingEpoch !== frame.fencingEpoch
      || attempt.leaseId !== frame.leaseId
      || attempt.taskRevision !== frame.taskRevision
      || attempt.turnRevision !== frame.turnRevision
      || attempt.turnId !== frame.turnId
      || task.revision !== frame.taskRevision + 1
      || task.state !== "RUNNING"
    ) {
      this.#appendInternal(frame.runId, `late-result:${frame.attemptId}:${randomUUID()}`, [runtimeEvent("software-agent.attempt.late_result", SYSTEM_ACTOR, new Date().toISOString(), {
        runId: frame.runId, attemptId: frame.attemptId, taskId: frame.taskId, fencingEpoch: frame.fencingEpoch,
      })], {runId: frame.runId, attemptId: frame.attemptId, accepted: false});
      return;
    }
    const now = frame.at;
    const dependentTasks = run.tasks.filter((candidate) => candidate.dependsOn.includes(task.id));
    const events: EventToAppend[] = [
      runtimeEvent("software-agent.attempt.completed", SYSTEM_ACTOR, now, {runId: run.id, attemptId: attempt.id, taskId: task.id, completedAt: now}),
      runtimeEvent("software-agent.turn.completed", {type: "agent", id: session.id}, now, {
        runId: run.id, turnId: frame.turnId, sessionId: session.id, taskId: task.id, summary: frame.summary,
      }),
      runtimeEvent("software-agent.evidence.recorded", {type: "agent", id: session.id}, now, {
        runId: run.id,
        taskId: task.id,
        sessionId: session.id,
        turnId: frame.turnId,
        attemptId: attempt.id,
        summary: frame.summary,
        ...(frame.providerId === undefined ? {} : {providerId: frame.providerId}),
        ...(frame.modelId === undefined ? {} : {modelId: frame.modelId, model: `${frame.providerId ?? "UNKNOWN"}/${frame.modelId}`}),
        ...(frame.usage === undefined ? {} : {...frame.usage}),
        ...(frame.costUsd === undefined ? {} : {costUsd: frame.costUsd}),
        ...(frame.toolsUsed === undefined ? {} : {toolsUsed: [...frame.toolsUsed]}),
        ...(frame.filesChanged === undefined ? {} : {filesChanged: [...frame.filesChanged]}),
      }),
      runtimeEvent("software-agent.task.passed", SYSTEM_ACTOR, now, {runId: run.id, taskId: task.id, summary: frame.summary}),
      runtimeEvent("software-agent.assignment.completed", SYSTEM_ACTOR, now, {
        runId: run.id,
        assignmentId: run.assignments.find((assignment) => assignment.taskId === task.id && assignment.state === "ACTIVE")?.id ?? "",
      }),
      runtimeEvent("software-agent.session.state_changed", SYSTEM_ACTOR, now, {runId: run.id, sessionId: session.id, state: "IDLE"}),
      ...(task.mutatesWorkspace ? [runtimeEvent("software-agent.workspace-mutation.released", SYSTEM_ACTOR, now, {
        runId: run.id, taskId: task.id, attemptId: attempt.id,
      })] : []),
    ];
    for (const dependent of dependentTasks) {
      const handoffId = deterministicId("hnd", `${run.id}:${task.id}:${dependent.id}`);
      events.push(
        runtimeEvent("software-agent.handoff.offered", {type: "agent", id: session.id}, now, {
          runId: run.id,
          handoffId,
          fromSessionId: session.id,
          toSessionId: dependent.sessionId,
          taskId: dependent.id,
          offeredAt: now,
        }),
        runtimeEvent("software-agent.mailbox.message_queued", {type: "agent", id: session.id}, now, {
          runId: run.id,
          messageId: deterministicId("msg", `${handoffId}:offer`),
          from: session.id,
          to: dependent.sessionId,
          kind: "HANDOFF",
          payload: `handoff ${task.id} -> ${dependent.id}`,
          createdAt: now,
        }),
      );
    }
    this.#appendInternal(run.id, `attempt-complete:${attempt.id}`, events, {runId: run.id, taskId: task.id, state: "PASSED"});
  }

  #failOrInterruptTask(manifest: StepManifest, error: unknown): void {
    const run = this.getRun(manifest.runId);
    const attempt = run.attempts.find((candidate) => candidate.id === manifest.attemptId);
    const task = run.tasks.find((candidate) => candidate.id === manifest.taskId);
    if (!attempt || attempt.state !== "RUNNING") return;
    const interrupted = error instanceof WorkerSupervisorError && error.code === "WORKER_CANCELED";
    const now = new Date().toISOString();
    const targetTaskState = interrupted ? "READY" : "FAILED";
    this.#appendInternal(run.id, `attempt-${interrupted ? "interrupted" : "failed"}:${attempt.id}`, [
      runtimeEvent(interrupted ? "software-agent.attempt.interrupted" : "software-agent.attempt.failed", SYSTEM_ACTOR, now, {
        runId: run.id,
        attemptId: attempt.id,
        taskId: attempt.taskId,
        code: error instanceof WorkerSupervisorError ? error.code : "WORKER_FAILURE",
        message: sanitizeTerminal(error instanceof Error ? error.message : String(error), 4096),
      }),
      runtimeEvent(interrupted ? "software-agent.turn.interrupted" : "software-agent.turn.failed", SYSTEM_ACTOR, now, {
        runId: run.id, turnId: attempt.turnId, sessionId: attempt.sessionId, taskId: attempt.taskId,
      }),
      runtimeEvent(interrupted ? "software-agent.task.ready" : "software-agent.task.failed", SYSTEM_ACTOR, now, {
        runId: run.id, taskId: attempt.taskId, state: targetTaskState,
      }),
      runtimeEvent("software-agent.session.state_changed", SYSTEM_ACTOR, now, {runId: run.id, sessionId: attempt.sessionId, state: "IDLE"}),
      ...(task?.mutatesWorkspace ? [runtimeEvent("software-agent.workspace-mutation.released", SYSTEM_ACTOR, now, {
        runId: run.id, taskId: task.id, attemptId: attempt.id,
      })] : []),
    ], {runId: run.id, taskId: attempt.taskId, state: targetTaskState});
  }

  #finishRequestedInterruption(runId: string): void {
    const run = this.getRun(runId);
    if (run.state === "PAUSING") this.#finishInterruption(runId, "PAUSED");
  }

  #cancelWasRequested(runId: string): boolean {
    const events = this.#events.load(runId);
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event === undefined) continue;
      if (event.eventType === "software-agent.run.cancel_requested") return true;
      if (event.eventType === "software-agent.run.state_changed" && event.data.state === "CANCELED") return false;
    }
    return false;
  }

  #finishInterruption(runId: string, state: "PAUSED" | "CANCELED"): void {
    const run = this.getRun(runId);
    if (run.state === state) return;
    this.#appendInternal(run.id, `interruption-finished:${run.revision}:${state}`, [runtimeEvent("software-agent.run.state_changed", SYSTEM_ACTOR, new Date().toISOString(), {
      runId: run.id, state,
    })], {runId: run.id, state});
  }

  #markRecovering(runId: string): void {
    const run = this.getRun(runId);
    if (run.state !== "RUNNING") return;
    this.#appendInternal(run.id, `shutdown-recovering:${run.revision}`, [runtimeEvent("software-agent.run.state_changed", SYSTEM_ACTOR, new Date().toISOString(), {
      runId: run.id, state: "RECOVERING",
    })], {runId: run.id, state: "RECOVERING"});
  }

  #recordSchedulerFailure(runId: string, error: unknown): void {
    if (this.#closing) return;
    const run = this.getRun(runId);
    if (["SUCCEEDED", "FAILED", "CANCELED", "PAUSED"].includes(run.state)) return;
    this.#appendInternal(run.id, `scheduler-failed:${run.revision}`, [runtimeEvent("software-agent.run.failed", SYSTEM_ACTOR, new Date().toISOString(), {
      runId,
      state: "FAILED",
      code: error instanceof SoftwareAgentRuntimeError ? error.code : "SCHEDULER_FAILURE",
      message: sanitizeTerminal(error instanceof Error ? error.message : String(error), 4096),
    })], {runId, state: "FAILED"});
  }

  #runs(): readonly SoftwareAgentRunView[] {
    return reduceRuntime(this.#events.replay()).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }
}

export class SoftwareAgentRuntimeError extends Error {
  public constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "SoftwareAgentRuntimeError";
  }
}

function initialSessions(runId: string): readonly AgentSessionViewV2[] {
  return (["master-orchestrator", "software-engineer", "reviewer-qa"] as const).map((role) => ({
    id: deterministicId("ags", `${runId}:${role}`),
    role,
    state: "IDLE" as const,
    revision: 1,
  }));
}

function initialTasks(runId: string): readonly SoftwareAgentTaskView[] {
  const sessions = new Map(initialSessions(runId).map((session) => [session.role, session.id]));
  const id = (suffix: string): string => `${runId}:${suffix}`;
  return [
    task(id("intake-plan"), "Propose and validate the bounded plan", "master-orchestrator", [], false, "READY", sessions),
    task(id("implementation"), "Produce deterministic implementation evidence", "software-engineer", [id("intake-plan")], true, "BLOCKED", sessions),
    task(id("test-plan-risk"), "Prepare an independent test and risk review", "reviewer-qa", [id("intake-plan")], false, "BLOCKED", sessions),
    task(id("final-review"), "Independently review implementation evidence", "reviewer-qa", [id("implementation"), id("test-plan-risk")], false, "BLOCKED", sessions),
    task(id("evidence-handoff"), "Produce the final evidence handoff", "master-orchestrator", [id("final-review")], false, "BLOCKED", sessions),
  ];
}

function task(
  id: string,
  title: string,
  role: SoftwareAgentRole,
  dependsOn: readonly string[],
  mutatesWorkspace: boolean,
  state: SoftwareAgentTaskState,
  sessions: ReadonlyMap<SoftwareAgentRole, string>,
): SoftwareAgentTaskView {
  const sessionId = sessions.get(role);
  if (sessionId === undefined) throw new SoftwareAgentRuntimeError("CORRUPT_RUNTIME", `no session exists for role ${role}`);
  return {id, title, role, dependsOn, mutatesWorkspace, state, revision: 1, sessionId, summary: ""};
}

function reduceRuntime(events: readonly StoredEvent[]): SoftwareAgentRunView[] {
  const runs = new Map<string, MutableRun>();
  for (const envelope of events) {
    if (!envelope.eventType.startsWith("software-agent.")) continue;
    const data = envelope.data as Record<string, unknown>;
    const runId = typeof data.runId === "string" ? data.runId : undefined;
    if (envelope.eventType === "software-agent.run.created" && runId) {
      runs.set(runId, {
        id: runId,
        projectId: String(data.projectId),
        objective: String(data.objective),
        state: String(data.state) as SoftwareAgentRunState,
        revision: envelope.streamVersion,
        maxParallel: Number(data.maxParallel),
        createdAt: String(data.createdAt),
        tasks: new Map(), sessions: new Map(), assignments: new Map(), attempts: new Map(),
        handoffs: new Map(), questions: new Map(), mailbox: new Map(),
      });
      continue;
    }
    if (!runId) continue;
    const run = runs.get(runId);
    if (!run) continue;
    run.revision = envelope.streamVersion;
    switch (envelope.eventType) {
      case "software-agent.run.state_changed":
      case "software-agent.run.failed":
        run.state = String(data.state) as SoftwareAgentRunState;
        break;
      case "software-agent.session.created":
        run.sessions.set(String(data.sessionId), {id: String(data.sessionId), role: String(data.role) as SoftwareAgentRole, state: String(data.state) as AgentSessionState, revision: 1});
        break;
      case "software-agent.session.state_changed": {
        const session = run.sessions.get(String(data.sessionId));
        if (session) run.sessions.set(session.id, withOptionalSession({...session, state: String(data.state) as AgentSessionState, revision: session.revision + 1}, data));
        break;
      }
      case "software-agent.task.created":
        run.tasks.set(String(data.taskId), {
          id: String(data.taskId), title: String(data.title), role: String(data.role) as SoftwareAgentRole,
          dependsOn: Array.isArray(data.dependsOn) ? data.dependsOn.map(String) : [],
          mutatesWorkspace: data.mutatesWorkspace === true,
          state: String(data.state) as SoftwareAgentTaskState,
          revision: 1, sessionId: String(data.sessionId), summary: "",
        });
        break;
      case "software-agent.task.ready":
      case "software-agent.task.started":
      case "software-agent.task.passed":
      case "software-agent.task.failed": {
        const taskView = run.tasks.get(String(data.taskId));
        if (taskView) {
          const state = envelope.eventType.endsWith(".ready") ? "READY" : envelope.eventType.endsWith(".started") ? "RUNNING" : envelope.eventType.endsWith(".passed") ? "PASSED" : "FAILED";
          run.tasks.set(taskView.id, {
            ...taskView,
            state,
            revision: taskView.revision + 1,
            ...(typeof data.turnId === "string" ? {activeTurnId: data.turnId} : state !== "RUNNING" ? {activeTurnId: undefined} : {}),
            ...(typeof data.summary === "string" ? {summary: data.summary} : {}),
          });
        }
        break;
      }
      case "software-agent.assignment.created":
        run.assignments.set(String(data.assignmentId), {
          id: String(data.assignmentId), taskId: String(data.taskId), sessionId: String(data.sessionId),
          taskRevision: Number(data.taskRevision), state: String(data.state) as AssignmentState,
        });
        break;
      case "software-agent.assignment.completed": {
        const assignment = run.assignments.get(String(data.assignmentId));
        if (assignment) run.assignments.set(assignment.id, {...assignment, state: "COMPLETED"});
        break;
      }
      case "software-agent.assignment.released": {
        const assignment = run.assignments.get(String(data.assignmentId));
        if (assignment) run.assignments.set(assignment.id, {...assignment, state: "RELEASED"});
        break;
      }
      case "software-agent.attempt.started":
        run.attempts.set(String(data.attemptId), {
          id: String(data.attemptId), taskId: String(data.taskId), sessionId: String(data.sessionId), turnId: String(data.turnId),
          taskRevision: Number(data.taskRevision), turnRevision: Number(data.turnRevision),
          leaseId: String(data.leaseId), leaseExpiresAt: String(data.leaseExpiresAt), fencingEpoch: Number(data.fencingEpoch),
          state: "RUNNING", startedAt: String(data.startedAt), lastHeartbeatAt: String(data.startedAt),
        });
        break;
      case "software-agent.attempt.heartbeat": {
        const attempt = run.attempts.get(String(data.attemptId));
        if (attempt) run.attempts.set(attempt.id, {...attempt, lastHeartbeatAt: String(data.at)});
        const session = run.sessions.get(String(data.sessionId));
        if (session) run.sessions.set(session.id, {...session, lastHeartbeatAt: String(data.at)});
        break;
      }
      case "software-agent.attempt.completed":
      case "software-agent.attempt.failed":
      case "software-agent.attempt.interrupted":
      case "software-agent.attempt.fenced": {
        const attempt = run.attempts.get(String(data.attemptId));
        if (attempt) {
          const state: AttemptState = envelope.eventType.endsWith(".completed") ? "COMPLETED" : envelope.eventType.endsWith(".failed") ? "FAILED" : envelope.eventType.endsWith(".fenced") ? "FENCED" : "INTERRUPTED";
          run.attempts.set(attempt.id, {...attempt, state, completedAt: envelope.occurredAt});
        }
        break;
      }
      case "software-agent.handoff.offered":
        run.handoffs.set(String(data.handoffId), {
          id: String(data.handoffId), fromSessionId: String(data.fromSessionId), toSessionId: String(data.toSessionId),
          taskId: String(data.taskId), state: "OFFERED", offeredAt: String(data.offeredAt),
        });
        break;
      case "software-agent.handoff.accepted": {
        const handoff = run.handoffs.get(String(data.handoffId));
        if (handoff) run.handoffs.set(handoff.id, {...handoff, state: "ACCEPTED", decidedAt: String(data.decidedAt)});
        break;
      }
      case "software-agent.question.opened":
        run.questions.set(String(data.questionId), {
          id: String(data.questionId), sessionId: String(data.sessionId), prompt: String(data.prompt), state: "OPEN", askedAt: String(data.askedAt),
        });
        break;
      case "software-agent.question.answered": {
        const question = run.questions.get(String(data.questionId));
        if (question) run.questions.set(question.id, {...question, state: "ANSWERED", answer: String(data.answer), answeredAt: String(data.answeredAt)});
        break;
      }
      case "software-agent.mailbox.message_queued":
        run.mailbox.set(String(data.messageId), {
          id: String(data.messageId), from: String(data.from), to: String(data.to), kind: String(data.kind) as MailboxMessageView["kind"],
          payload: String(data.payload), createdAt: String(data.createdAt),
        });
        break;
    }
  }
  return [...runs.values()].map(freezeRun);
}

function freezeRun(run: MutableRun): SoftwareAgentRunView {
  return {
    id: run.id, projectId: run.projectId, objective: run.objective, state: run.state, revision: run.revision,
    maxParallel: run.maxParallel, createdAt: run.createdAt, tasks: [...run.tasks.values()], sessions: [...run.sessions.values()],
    assignments: [...run.assignments.values()], attempts: [...run.attempts.values()], handoffs: [...run.handoffs.values()],
    questions: [...run.questions.values()], mailbox: [...run.mailbox.values()],
  };
}

function withOptionalSession(session: AgentSessionViewV2, data: Record<string, unknown>): AgentSessionViewV2 {
  if (data.state === "IDLE" || data.state === "STOPPED") {
    return {...session, currentTaskId: undefined, currentTurnId: undefined, leaseExpiresAt: undefined};
  }
  const currentTaskId = typeof data.taskId === "string" ? data.taskId : undefined;
  const currentTurnId = typeof data.turnId === "string" ? data.turnId : undefined;
  const leaseExpiresAt = typeof data.leaseExpiresAt === "string" ? data.leaseExpiresAt : undefined;
  return {
    ...session,
    ...(currentTaskId ? {currentTaskId} : {}),
    ...(currentTurnId ? {currentTurnId} : {}),
    ...(leaseExpiresAt ? {leaseExpiresAt} : {}),
  };
}

function runtimeEvent(
  eventType: string,
  actor: ActorRef,
  occurredAt: string,
  data: JsonObject,
  correlationId = "internal",
  causationId = "internal",
): EventToAppend {
  return {eventType, actor, occurredAt, data, metadata: {schema: SOFTWARE_AGENT_EVENT_SCHEMA, correlationId, causationId}};
}

function mutationLeaseJson(lease: MutationLeaseView): JsonObject {
  return {
    leaseId: lease.leaseId, attachmentId: lease.attachmentId, fence: lease.fence,
    acquiredAt: lease.acquiredAt, expiresAt: lease.expiresAt, state: lease.state,
  };
}

function mutationLeaseFromJson(value: JsonObject): MutationLeaseView {
  if (
    typeof value.leaseId !== "string"
    || typeof value.attachmentId !== "string"
    || !Number.isSafeInteger(value.fence)
    || typeof value.acquiredAt !== "string"
    || typeof value.expiresAt !== "string"
    || (value.state !== "ACTIVE" && value.state !== "RELEASED" && value.state !== "EXPIRED")
  ) {
    throw new SoftwareAgentRuntimeError("CORRUPT_MUTATION_LEASE", "stored mutation lease is invalid");
  }
  return {
    leaseId: value.leaseId, attachmentId: value.attachmentId, fence: Number(value.fence),
    acquiredAt: value.acquiredAt, expiresAt: value.expiresAt, state: value.state,
  };
}

function mutationCommandHash(action: "mutation.renew" | "mutation.release", input: ReleaseMutationLeaseCommand): string {
  return sha256Canonical({
    action,
    attachmentId: input.attachmentId,
    leaseId: input.leaseId,
    fence: input.fence,
    actor: {type: input.actor.type, id: input.actor.id},
    correlationId: input.correlationId,
  });
}

function runCommandHash(input: SoftwareAgentCommandContext, action: string, operation: JsonObject, runId: string): string {
  return sha256Canonical({
    action,
    operation,
    runId,
    expectedRunRevision: input.expectedRunRevision,
    actor: {type: input.actor.type, id: input.actor.id},
    correlationId: input.correlationId,
    causationId: input.causationId,
    uiAttachmentId: input.uiAttachmentId,
    mutationLease: {leaseId: input.mutationLease.leaseId, fence: input.mutationLease.fence},
  });
}

function assertReplayReceipt(
  receipt: CommandReceipt<JsonObject>,
  operationHash: string,
  streamId: string,
  commandId: string,
): void {
  if (receipt.operationHash !== operationHash || receipt.streamId !== streamId) {
    throw new SoftwareAgentRuntimeError("IDEMPOTENCY_CONFLICT", `command ${commandId} was reused with different input`);
  }
}

function replayMutationReceipt(
  receipt: CommandReceipt<JsonObject>,
  operationHash: string,
  streamId: string,
  commandId: string,
): MutationLeaseView {
  assertReplayReceipt(receipt, operationHash, streamId, commandId);
  return mutationLeaseFromJson(receipt.response);
}

function commandReceipt(runId: string, revision: number): SoftwareAgentCommandReceipt {
  return {schema: "software-agent.command-receipt/v2", accepted: true, runId, revision};
}

function commandReceiptJson(receipt: SoftwareAgentCommandReceipt): JsonObject {
  return {schema: receipt.schema, accepted: receipt.accepted, runId: receipt.runId, revision: receipt.revision};
}

function commandReceiptFromJson(value: unknown): SoftwareAgentCommandReceipt {
  if (
    !isJsonObject(value)
    || value.schema !== "software-agent.command-receipt/v2"
    || value.accepted !== true
    || typeof value.runId !== "string"
    || !Number.isSafeInteger(value.revision)
  ) {
    throw new SoftwareAgentRuntimeError("CORRUPT_COMMAND_RECEIPT", "stored Software Agent command receipt is invalid");
  }
  return commandReceipt(value.runId, Number(value.revision));
}

function questionCommandResultJson(result: QuestionCommandResult): JsonObject {
  return {
    question: {
      id: result.question.id,
      sessionId: result.question.sessionId,
      prompt: result.question.prompt,
      state: result.question.state,
      askedAt: result.question.askedAt,
      ...(result.question.answer === undefined ? {} : {answer: result.question.answer}),
      ...(result.question.answeredAt === undefined ? {} : {answeredAt: result.question.answeredAt}),
    },
    runRevision: result.runRevision,
  };
}

function questionCommandResultFromJson(value: unknown): QuestionCommandResult {
  if (!isJsonObject(value)) {
    throw new SoftwareAgentRuntimeError("CORRUPT_COMMAND_RECEIPT", "stored question command receipt is invalid");
  }
  const question = value.question;
  if (
    !isJsonObject(question)
    || typeof question.id !== "string"
    || typeof question.sessionId !== "string"
    || typeof question.prompt !== "string"
    || (question.state !== "OPEN" && question.state !== "ANSWERED" && question.state !== "CANCELED")
    || typeof question.askedAt !== "string"
    || !Number.isSafeInteger(value.runRevision)
  ) {
    throw new SoftwareAgentRuntimeError("CORRUPT_COMMAND_RECEIPT", "stored question command receipt is invalid");
  }
  return {
    question: {
      id: question.id,
      sessionId: question.sessionId,
      prompt: question.prompt,
      state: question.state,
      askedAt: question.askedAt,
      ...(typeof question.answer === "string" ? {answer: question.answer} : {}),
      ...(typeof question.answeredAt === "string" ? {answeredAt: question.answeredAt} : {}),
    },
    runRevision: Number(value.runRevision),
  };
}

function instructionRecipient(run: SoftwareAgentRunView, target: InstructionTarget): string {
  if (target.kind === "agent") {
    if (!run.sessions.some((session) => session.id === target.id)) {
      throw new SoftwareAgentRuntimeError("SESSION_NOT_FOUND", `unknown instruction target agent ${target.id}`);
    }
    return target.id;
  }
  if (target.kind === "task") {
    const task = run.tasks.find((candidate) => candidate.id === target.id);
    if (!task) throw new SoftwareAgentRuntimeError("TASK_NOT_FOUND", `unknown instruction target task ${target.id}`);
    return task.sessionId;
  }
  if (target.id !== run.id) throw new SoftwareAgentRuntimeError("RUN_NOT_FOUND", `instruction target ${target.id} is not run ${run.id}`);
  const orchestrator = run.sessions.find((session) => session.role === "master-orchestrator");
  if (!orchestrator) throw new SoftwareAgentRuntimeError("CORRUPT_RUNTIME", "run has no orchestrator session");
  return orchestrator.id;
}

function instructionCommandResultJson(result: InstructionCommandResult): JsonObject {
  return {
    message: {
      id: result.message.id,
      from: result.message.from,
      to: result.message.to,
      kind: result.message.kind,
      payload: result.message.payload,
      createdAt: result.message.createdAt,
    },
    runRevision: result.runRevision,
  };
}

function instructionCommandResultFromJson(value: unknown): InstructionCommandResult {
  if (!isJsonObject(value)) {
    throw new SoftwareAgentRuntimeError("CORRUPT_COMMAND_RECEIPT", "stored instruction command receipt is invalid");
  }
  const message = value.message;
  if (
    !isJsonObject(message)
    || typeof message.id !== "string"
    || typeof message.from !== "string"
    || typeof message.to !== "string"
    || message.kind !== "INSTRUCTION"
    || typeof message.payload !== "string"
    || typeof message.createdAt !== "string"
    || !Number.isSafeInteger(value.runRevision)
  ) {
    throw new SoftwareAgentRuntimeError("CORRUPT_COMMAND_RECEIPT", "stored instruction command receipt is invalid");
  }
  return {
    message: {
      id: message.id,
      from: message.from,
      to: message.to,
      kind: message.kind,
      payload: message.payload,
      createdAt: message.createdAt,
    },
    runRevision: Number(value.runRevision),
  };
}

function validateMutationLeaseCommand(input: MutationLeaseCommand): void {
  for (const [field, value] of [["commandId", input.commandId], ["attachmentId", input.attachmentId], ["correlationId", input.correlationId], ["actor.id", input.actor.id]] as const) {
    if (value.length === 0 || value.trim() !== value || value.length > 256) throw new TypeError(`${field} is invalid`);
  }
  if (isReleaseMutationLeaseCommand(input)) {
    if (input.leaseId.length === 0 || input.leaseId.length > 256) throw new TypeError("leaseId is invalid");
    if (!Number.isSafeInteger(input.fence) || input.fence <= 0) throw new TypeError("fence is invalid");
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isReleaseMutationLeaseCommand(input: MutationLeaseCommand): input is ReleaseMutationLeaseCommand {
  return "leaseId" in input && "fence" in input && typeof input.leaseId === "string" && typeof input.fence === "number";
}

function validateEventQuery(afterCursor: number, limit: number, waitMs: number): void {
  if (!Number.isSafeInteger(afterCursor) || afterCursor < 0) throw new TypeError("afterCursor must be non-negative");
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 250) throw new TypeError("limit must be between 1 and 250");
  if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 30_000) throw new TypeError("waitMs must be between 0 and 30000");
}

function deterministicId(prefix: string, seed: string): string {
  return `${prefix}_${createHash("sha256").update(seed, "utf8").digest("hex").slice(0, 32)}`;
}
