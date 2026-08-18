import {
  CONTRACT_SCHEMA_VERSION,
  type ContractSchemaVersion,
} from "../../contracts/src/index.js";

export const RUN_STATUSES = [
  "DRAFT",
  "PLANNING",
  "WAITING_INPUT",
  "WAITING_APPROVAL",
  "RUNNING",
  "PAUSING",
  "PAUSED",
  "RECOVERING",
  "NEEDS_RECONCILIATION",
  "SUCCEEDED",
  "PARTIAL",
  "FAILED",
  "CANCELED",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const TASK_STATUSES = [
  "PROPOSED",
  "BLOCKED",
  "READY",
  "CLAIMED",
  "RUNNING",
  "WAITING_TOOL",
  "WAITING_INPUT",
  "WAITING_APPROVAL",
  "REVIEW",
  "REWORK",
  "PASSED",
  "FAILED",
  "SKIPPED",
  "CANCELED",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const AGENT_STATUSES = [
  "ACTIVATING",
  "PLANNING",
  "RUNNING",
  "WAITING_TOOL",
  "WAITING_INPUT",
  "WAITING_APPROVAL",
  "BLOCKED",
  "REVIEWING",
  "PAUSED",
  "SUCCEEDED",
  "FAILED",
  "STOPPED",
] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

export interface RunState {
  readonly schemaVersion: ContractSchemaVersion;
  readonly runId: string;
  readonly status: RunStatus;
  readonly revision: number;
  readonly updatedAt: string;
}

export interface TaskState {
  readonly schemaVersion: ContractSchemaVersion;
  readonly taskId: string;
  readonly runId: string;
  readonly status: TaskStatus;
  readonly revision: number;
  readonly updatedAt: string;
}

export class StateTransitionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "StateTransitionError";
  }
}

export class RevisionConflictError extends Error {
  public constructor(
    public readonly expected: number,
    public readonly actual: number,
  ) {
    super(`state revision conflict: expected ${expected}, found ${actual}`);
    this.name = "RevisionConflictError";
  }
}

const RUN_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  DRAFT: ["PLANNING", "CANCELED"],
  PLANNING: ["WAITING_INPUT", "WAITING_APPROVAL", "RUNNING", "FAILED", "CANCELED"],
  WAITING_INPUT: ["PLANNING", "CANCELED"],
  WAITING_APPROVAL: ["RUNNING", "PLANNING", "FAILED", "CANCELED"],
  RUNNING: [
    "WAITING_INPUT",
    "WAITING_APPROVAL",
    "PAUSING",
    "RECOVERING",
    "NEEDS_RECONCILIATION",
    "SUCCEEDED",
    "PARTIAL",
    "FAILED",
    "CANCELED",
  ],
  PAUSING: ["PAUSED", "NEEDS_RECONCILIATION", "FAILED"],
  PAUSED: ["RUNNING", "RECOVERING", "CANCELED"],
  RECOVERING: ["RUNNING", "PAUSED", "NEEDS_RECONCILIATION", "PARTIAL", "FAILED"],
  NEEDS_RECONCILIATION: ["RECOVERING", "PARTIAL", "FAILED"],
  SUCCEEDED: [],
  PARTIAL: [],
  FAILED: [],
  CANCELED: [],
};

const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  PROPOSED: ["BLOCKED", "READY", "SKIPPED", "CANCELED"],
  BLOCKED: ["READY", "SKIPPED", "CANCELED"],
  READY: ["CLAIMED", "BLOCKED", "CANCELED"],
  CLAIMED: ["RUNNING", "READY", "FAILED", "CANCELED"],
  RUNNING: ["WAITING_TOOL", "WAITING_INPUT", "WAITING_APPROVAL", "REVIEW", "FAILED", "CANCELED"],
  WAITING_TOOL: ["RUNNING", "FAILED", "CANCELED"],
  WAITING_INPUT: ["RUNNING", "FAILED", "CANCELED"],
  WAITING_APPROVAL: ["RUNNING", "REWORK", "FAILED", "CANCELED"],
  REVIEW: ["REWORK", "PASSED", "FAILED"],
  REWORK: ["READY", "BLOCKED", "CANCELED"],
  PASSED: [],
  FAILED: [],
  SKIPPED: [],
  CANCELED: [],
};

function assertIdentifier(value: string, field: string): void {
  if (value.length === 0 || value.trim() !== value) {
    throw new TypeError(`${field} must be non-empty and have no surrounding whitespace`);
  }
}

function assertTimestamp(value: string): void {
  if (!Number.isFinite(Date.parse(value))) {
    throw new TypeError(`invalid ISO timestamp: ${value}`);
  }
}

function assertRevision(actual: number, expected: number): void {
  if (!Number.isSafeInteger(expected) || expected < 0) {
    throw new TypeError("expected revision must be a non-negative safe integer");
  }
  if (actual !== expected) {
    throw new RevisionConflictError(expected, actual);
  }
}

export function createRunState(runId: string, at: string): RunState {
  assertIdentifier(runId, "runId");
  assertTimestamp(at);
  return Object.freeze({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    runId,
    status: "DRAFT",
    revision: 0,
    updatedAt: at,
  });
}

export function createTaskState(taskId: string, runId: string, at: string): TaskState {
  assertIdentifier(taskId, "taskId");
  assertIdentifier(runId, "runId");
  assertTimestamp(at);
  return Object.freeze({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    taskId,
    runId,
    status: "PROPOSED",
    revision: 0,
    updatedAt: at,
  });
}

export function canTransitionRun(from: RunStatus, to: RunStatus): boolean {
  return RUN_TRANSITIONS[from].includes(to);
}

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

export function transitionRun(
  current: RunState,
  next: RunStatus,
  at: string,
  expectedRevision: number = current.revision,
): RunState {
  assertRevision(current.revision, expectedRevision);
  assertTimestamp(at);
  if (!canTransitionRun(current.status, next)) {
    throw new StateTransitionError(`invalid run transition: ${current.status} -> ${next}`);
  }
  return Object.freeze({ ...current, status: next, revision: current.revision + 1, updatedAt: at });
}

export function transitionTask(
  current: TaskState,
  next: TaskStatus,
  at: string,
  expectedRevision: number = current.revision,
): TaskState {
  assertRevision(current.revision, expectedRevision);
  assertTimestamp(at);
  if (!canTransitionTask(current.status, next)) {
    throw new StateTransitionError(`invalid task transition: ${current.status} -> ${next}`);
  }
  return Object.freeze({ ...current, status: next, revision: current.revision + 1, updatedAt: at });
}
