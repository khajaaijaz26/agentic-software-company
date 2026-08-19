import type {ActorRef} from "../../contracts/src/index.js";

export const SOFTWARE_AGENT_COMMAND_SCHEMA = "software-agent.command/v2" as const;
export const SOFTWARE_AGENT_EVENT_SCHEMA = "software-agent.event/v2" as const;
export const SOFTWARE_AGENT_SNAPSHOT_SCHEMA = "software-agent.snapshot/v2" as const;
export const SOFTWARE_AGENT_EVENTS_SCHEMA = "software-agent.events/v2" as const;
export const SOFTWARE_AGENT_STEP_SCHEMA = "software-agent.step/v1" as const;

export const SOFTWARE_AGENT_ROLES = [
  "master-orchestrator",
  "software-engineer",
  "reviewer-qa",
] as const;
export type SoftwareAgentRole = (typeof SOFTWARE_AGENT_ROLES)[number];

export const AGENT_SESSION_STATES = [
  "IDLE",
  "RUNNING",
  "WAITING_INPUT",
  "WAITING_HANDOFF",
  "PAUSED",
  "SUCCEEDED",
  "FAILED",
  "STOPPED",
] as const;
export type AgentSessionState = (typeof AGENT_SESSION_STATES)[number];

export const AGENT_TURN_STATES = [
  "QUEUED",
  "RUNNING",
  "COMPLETED",
  "FAILED",
  "INTERRUPTED",
] as const;
export type AgentTurnState = (typeof AGENT_TURN_STATES)[number];

export const ASSIGNMENT_STATES = ["OFFERED", "ACTIVE", "RELEASED", "COMPLETED", "CANCELED"] as const;
export type AssignmentState = (typeof ASSIGNMENT_STATES)[number];

export const ATTEMPT_STATES = [
  "LEASED",
  "RUNNING",
  "COMPLETED",
  "FAILED",
  "INTERRUPTED",
  "FENCED",
  "EXPIRED",
] as const;
export type AttemptState = (typeof ATTEMPT_STATES)[number];

export const HANDOFF_STATES = ["OFFERED", "ACCEPTED", "REJECTED", "EXPIRED"] as const;
export type HandoffState = (typeof HANDOFF_STATES)[number];

export const QUESTION_STATES = ["OPEN", "ANSWERED", "CANCELED"] as const;
export type QuestionState = (typeof QUESTION_STATES)[number];

export interface MutationLeaseBinding {
  readonly leaseId: string;
  readonly fence: number;
}

export interface SoftwareAgentCommandContext {
  readonly schema: typeof SOFTWARE_AGENT_COMMAND_SCHEMA;
  readonly commandId: string;
  readonly actor: ActorRef;
  readonly expectedRunRevision: number;
  readonly correlationId: string;
  readonly causationId: string;
  readonly uiAttachmentId: string;
  readonly mutationLease: MutationLeaseBinding;
}

export interface AttemptBinding {
  readonly runId: string;
  readonly taskId: string;
  readonly taskRevision: number;
  readonly sessionId: string;
  readonly turnId: string;
  readonly turnRevision: number;
  readonly attemptId: string;
  readonly leaseId: string;
  readonly fencingEpoch: number;
}

export function assertSoftwareAgentCommandContext(value: SoftwareAgentCommandContext): void {
  if ((value as {readonly schema: string}).schema !== SOFTWARE_AGENT_COMMAND_SCHEMA) throw new TypeError("unsupported command schema");
  exact(value.commandId, "commandId", 256);
  exact(value.actor.id, "actor.id", 256);
  if (!(["human", "agent", "system"] as const).includes(value.actor.type)) throw new TypeError("actor.type is invalid");
  if (!Number.isSafeInteger(value.expectedRunRevision) || value.expectedRunRevision < 0) {
    throw new TypeError("expectedRunRevision must be a non-negative safe integer");
  }
  exact(value.correlationId, "correlationId", 256);
  exact(value.causationId, "causationId", 256);
  exact(value.uiAttachmentId, "uiAttachmentId", 256);
  exact(value.mutationLease.leaseId, "mutationLease.leaseId", 256);
  if (!Number.isSafeInteger(value.mutationLease.fence) || value.mutationLease.fence <= 0) {
    throw new TypeError("mutationLease.fence must be a positive safe integer");
  }
}

export function assertAttemptBinding(value: AttemptBinding): void {
  for (const [field, item] of Object.entries(value)) {
    if (field === "taskRevision" || field === "turnRevision" || field === "fencingEpoch") {
      if (!Number.isSafeInteger(item) || Number(item) <= 0) throw new TypeError(`${field} must be a positive safe integer`);
    } else {
      exact(String(item), field, 512);
    }
  }
}

function exact(value: string, field: string, maximum: number): void {
  if (value.length === 0 || value.trim() !== value || value.length > maximum) {
    throw new TypeError(`${field} must be exact, non-empty, and at most ${maximum} characters`);
  }
}
