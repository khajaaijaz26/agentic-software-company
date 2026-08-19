import {createHmac, randomUUID, timingSafeEqual} from "node:crypto";

import type {ApprovalRecord} from "../../approval-service/src/index.js";
import type {
  ControllerSnapshot,
  MutationLeaseView,
  InstructionCommandResult,
  QuestionCommandResult,
  RunView,
  SoftwareAgentCommandReceipt,
  SoftwareAgentEventsPage,
  SoftwareAgentRunView,
  SoftwareAgentSnapshot,
} from "../../../apps/control-plane/src/controller.js";

export const IPC_PROTOCOL_MIN = 1;
export const IPC_PROTOCOL_MAX = 2;
export const SOFTWARE_AGENT_IPC_SCHEMA = "software-agent.ipc/v2" as const;
export const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;

export const CONTROLLER_METHODS = [
  "snapshot",
  "createRun",
  "listApprovals",
  "approve",
  "deny",
  "resume",
  "pause",
  "cancel",
  "snapshot.get",
  "events.poll",
  "events.history",
  "mutation.acquire",
  "mutation.renew",
  "mutation.release",
  "run.create",
  "run.resume",
  "run.pause",
  "run.cancel",
  "question.ask",
  "question.answer",
  "instruction.submit",
  "daemon.stop",
] as const;

export type ControllerMethod = (typeof CONTROLLER_METHODS)[number];

export interface ControllerRpcParams {
  readonly snapshot: Readonly<Record<string, never>>;
  readonly createRun: {readonly objective: string};
  readonly listApprovals: {readonly runId?: string};
  readonly approve: {readonly approvalId: string; readonly reason?: string};
  readonly deny: {readonly approvalId: string; readonly reason?: string};
  readonly resume: {readonly runId: string};
  readonly pause: {readonly runId: string};
  readonly cancel: {readonly runId: string};
  readonly "snapshot.get": {readonly recentEventLimit?: number};
  readonly "events.poll": {readonly afterCursor: number; readonly limit?: number; readonly waitMs?: number};
  readonly "events.history": {readonly runId?: string; readonly afterCursor: number; readonly limit?: number};
  readonly "mutation.acquire": {readonly commandId: string; readonly attachmentId: string; readonly correlationId: string};
  readonly "mutation.renew": {
    readonly commandId: string; readonly attachmentId: string; readonly correlationId: string;
    readonly leaseId: string; readonly fence: number;
  };
  readonly "mutation.release": {
    readonly commandId: string; readonly attachmentId: string; readonly correlationId: string;
    readonly leaseId: string; readonly fence: number;
  };
  readonly "run.create": SoftwareAgentRunCommandParams & {
    readonly objective: string;
    readonly maxParallel: number;
    readonly tokenMode?: "economy" | "balanced" | "quality";
  };
  readonly "run.resume": SoftwareAgentRunCommandParams & {readonly runId: string};
  readonly "run.pause": SoftwareAgentRunCommandParams & {readonly runId: string};
  readonly "run.cancel": SoftwareAgentRunCommandParams & {readonly runId: string};
  readonly "question.ask": SoftwareAgentRunCommandParams & {readonly runId: string; readonly sessionId: string; readonly prompt: string};
  readonly "question.answer": SoftwareAgentRunCommandParams & {readonly runId: string; readonly questionId: string; readonly answer: string};
  readonly "instruction.submit": SoftwareAgentRunCommandParams & {
    readonly runId: string;
    readonly target: {readonly kind: "agent" | "task" | "run"; readonly id: string};
    readonly text: string;
  };
  readonly "daemon.stop": Readonly<Record<string, never>>;
}

export interface SoftwareAgentRunCommandParams {
  readonly schema: "software-agent.command/v2";
  readonly commandId: string;
  readonly actor: {readonly type: "human" | "agent" | "system"; readonly id: string};
  readonly expectedRunRevision: number;
  readonly correlationId: string;
  readonly causationId: string;
  readonly uiAttachmentId: string;
  readonly mutationLease: {readonly leaseId: string; readonly fence: number};
}

export interface ControllerRpcResults {
  readonly snapshot: ControllerSnapshot;
  readonly createRun: RunView;
  readonly listApprovals: readonly ApprovalRecord[];
  readonly approve: ApprovalRecord;
  readonly deny: ApprovalRecord;
  readonly resume: RunView;
  readonly pause: RunView;
  readonly cancel: RunView;
  readonly "snapshot.get": SoftwareAgentSnapshot;
  readonly "events.poll": SoftwareAgentEventsPage;
  readonly "events.history": SoftwareAgentEventsPage;
  readonly "mutation.acquire": MutationLeaseView;
  readonly "mutation.renew": MutationLeaseView;
  readonly "mutation.release": MutationLeaseView;
  readonly "run.create": SoftwareAgentRunView;
  readonly "run.resume": SoftwareAgentCommandReceipt;
  readonly "run.pause": SoftwareAgentCommandReceipt;
  readonly "run.cancel": SoftwareAgentCommandReceipt;
  readonly "question.ask": QuestionCommandResult;
  readonly "question.answer": QuestionCommandResult;
  readonly "instruction.submit": InstructionCommandResult;
  readonly "daemon.stop": {readonly schema: "software-agent.daemon-stop/v1"; readonly accepted: true};
}

export interface RpcErrorShape {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export interface ClientHello {
  readonly kind: "hello";
  readonly requestId: string;
  readonly protocolMin: number;
  readonly protocolMax: number;
  readonly instanceId: string;
  readonly userBinding: string;
  readonly nonceProof: string;
}

export interface ServerWelcome {
  readonly kind: "welcome";
  readonly requestId: string;
  readonly protocolVersion: number;
  readonly instanceId: string;
  readonly buildVersion: string;
  readonly serverTime: string;
}

export interface HandshakeError {
  readonly kind: "handshake_error";
  readonly requestId: string;
  readonly error: RpcErrorShape;
}

export interface RpcRequest<M extends ControllerMethod = ControllerMethod> {
  readonly kind: "request";
  readonly requestId: string;
  readonly protocolVersion: number;
  readonly method: M;
  readonly params: ControllerRpcParams[M];
}

export interface RpcSuccessResponse<M extends ControllerMethod = ControllerMethod> {
  readonly kind: "response";
  readonly requestId: string;
  readonly ok: true;
  readonly result: ControllerRpcResults[M];
}

export interface RpcFailureResponse {
  readonly kind: "response";
  readonly requestId: string;
  readonly ok: false;
  readonly error: RpcErrorShape;
}

export type WireMessage = ClientHello | ServerWelcome | HandshakeError | RpcRequest | RpcSuccessResponse | RpcFailureResponse;

export class FrameProtocolError extends Error {
  public constructor(public readonly code: "FRAME_EMPTY" | "FRAME_TOO_LARGE" | "FRAME_JSON_INVALID", message: string) {
    super(message);
    this.name = "FrameProtocolError";
  }
}

export class JsonFrameDecoder {
  readonly #maximumBytes: number;
  readonly #textDecoder = new TextDecoder("utf-8", {fatal: true});
  #buffer: Buffer = Buffer.alloc(0);

  public constructor(maximumBytes = DEFAULT_MAX_FRAME_BYTES) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 64) {
      throw new RangeError("maximum frame size must be an integer of at least 64 bytes");
    }
    this.#maximumBytes = maximumBytes;
  }

  public push(chunk: Buffer): readonly unknown[] {
    if (chunk.length === 0) return [];
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    const messages: unknown[] = [];
    while (this.#buffer.length >= 4) {
      const length = this.#buffer.readUInt32BE(0);
      if (length === 0) throw new FrameProtocolError("FRAME_EMPTY", "zero-length JSON frames are forbidden");
      if (length > this.#maximumBytes) {
        throw new FrameProtocolError("FRAME_TOO_LARGE", `frame declares ${length} bytes; maximum is ${this.#maximumBytes}`);
      }
      if (this.#buffer.length < length + 4) return messages;
      const payload = this.#buffer.subarray(4, length + 4);
      this.#buffer = this.#buffer.subarray(length + 4);
      let json: string;
      try {
        json = this.#textDecoder.decode(payload);
      } catch {
        throw new FrameProtocolError("FRAME_JSON_INVALID", "frame is not valid UTF-8");
      }
      try {
        messages.push(JSON.parse(json) as unknown);
      } catch {
        throw new FrameProtocolError("FRAME_JSON_INVALID", "frame is not valid JSON");
      }
    }
    return messages;
  }
}

export function encodeJsonFrame(message: unknown, maximumBytes = DEFAULT_MAX_FRAME_BYTES): Buffer {
  if (message === undefined || typeof message === "function" || typeof message === "symbol") {
    throw new FrameProtocolError("FRAME_JSON_INVALID", "message is not JSON serializable");
  }
  let encoded: string;
  try {
    encoded = JSON.stringify(message);
  } catch {
    throw new FrameProtocolError("FRAME_JSON_INVALID", "message is not JSON serializable");
  }
  const payload = Buffer.from(encoded, "utf8");
  if (payload.length === 0) throw new FrameProtocolError("FRAME_EMPTY", "zero-length JSON frames are forbidden");
  if (payload.length > maximumBytes) {
    throw new FrameProtocolError("FRAME_TOO_LARGE", `encoded frame is ${payload.length} bytes; maximum is ${maximumBytes}`);
  }
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

export function createRequestId(): string {
  return `rpc_${randomUUID().replaceAll("-", "")}`;
}

export function createNonceProof(
  nonceHex: string,
  input: Omit<ClientHello, "kind" | "nonceProof">,
): string {
  if (!/^[a-f0-9]{64}$/u.test(nonceHex)) throw new Error("invalid controller nonce");
  return createHmac("sha256", Buffer.from(nonceHex, "hex"))
    .update(handshakeProofPayload(input), "utf8")
    .digest("hex");
}

export function verifyNonceProof(nonceHex: string, hello: ClientHello): boolean {
  if (!/^[a-f0-9]{64}$/u.test(hello.nonceProof)) return false;
  const expected = createNonceProof(nonceHex, {
    requestId: hello.requestId,
    protocolMin: hello.protocolMin,
    protocolMax: hello.protocolMax,
    instanceId: hello.instanceId,
    userBinding: hello.userBinding,
  });
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(hello.nonceProof, "hex"));
}

export function negotiateProtocol(clientMin: number, clientMax: number): number | undefined {
  if (!Number.isSafeInteger(clientMin) || !Number.isSafeInteger(clientMax) || clientMin > clientMax) return undefined;
  const upper = Math.min(clientMax, IPC_PROTOCOL_MAX);
  return upper >= Math.max(clientMin, IPC_PROTOCOL_MIN) ? upper : undefined;
}

export function isControllerMethod(value: unknown): value is ControllerMethod {
  return typeof value === "string" && (CONTROLLER_METHODS as readonly string[]).includes(value);
}

export function parseControllerParams<M extends ControllerMethod>(method: M, value: unknown): ControllerRpcParams[M] {
  const params = plainObject(value, "params");
  switch (method) {
    case "snapshot":
      assertKeys(params, []);
      return params as ControllerRpcParams[M];
    case "createRun":
      assertKeys(params, ["objective"]);
      requiredString(params, "objective", 32_768);
      return params as unknown as ControllerRpcParams[M];
    case "listApprovals":
      assertKeys(params, [], ["runId"]);
      optionalString(params, "runId", 512);
      return params as ControllerRpcParams[M];
    case "approve":
    case "deny":
      assertKeys(params, ["approvalId"], ["reason"]);
      requiredString(params, "approvalId", 512);
      optionalString(params, "reason", 4096);
      return params as unknown as ControllerRpcParams[M];
    case "resume":
    case "pause":
    case "cancel":
      assertKeys(params, ["runId"]);
      requiredString(params, "runId", 512);
      return params as unknown as ControllerRpcParams[M];
    case "snapshot.get":
      assertKeys(params, [], ["recentEventLimit"]);
      optionalInteger(params, "recentEventLimit", 0, 250);
      return params as unknown as ControllerRpcParams[M];
    case "events.poll":
      assertKeys(params, ["afterCursor"], ["limit", "waitMs"]);
      requiredInteger(params, "afterCursor", 0, Number.MAX_SAFE_INTEGER);
      optionalInteger(params, "limit", 1, 250);
      optionalInteger(params, "waitMs", 0, 30_000);
      return params as unknown as ControllerRpcParams[M];
    case "events.history":
      assertKeys(params, ["afterCursor"], ["runId", "limit"]);
      requiredInteger(params, "afterCursor", 0, Number.MAX_SAFE_INTEGER);
      optionalString(params, "runId", 512);
      optionalInteger(params, "limit", 1, 250);
      return params as unknown as ControllerRpcParams[M];
    case "mutation.acquire":
      assertKeys(params, ["commandId", "attachmentId", "correlationId"]);
      requiredString(params, "commandId", 256);
      requiredString(params, "attachmentId", 256);
      requiredString(params, "correlationId", 256);
      return params as unknown as ControllerRpcParams[M];
    case "mutation.renew":
    case "mutation.release":
      assertKeys(params, ["commandId", "attachmentId", "correlationId", "leaseId", "fence"]);
      requiredString(params, "commandId", 256);
      requiredString(params, "attachmentId", 256);
      requiredString(params, "correlationId", 256);
      requiredString(params, "leaseId", 256);
      requiredInteger(params, "fence", 1, Number.MAX_SAFE_INTEGER);
      return params as unknown as ControllerRpcParams[M];
    case "run.create":
      parseSoftwareAgentRunCommand(params, ["objective", "maxParallel"], ["tokenMode"]);
      requiredString(params, "objective", 32_768);
      requiredInteger(params, "maxParallel", 1, 3);
      if (params.tokenMode !== undefined && params.tokenMode !== "economy" && params.tokenMode !== "balanced" && params.tokenMode !== "quality") {
        throw new TypeError("tokenMode is invalid");
      }
      return params as unknown as ControllerRpcParams[M];
    case "run.resume":
    case "run.pause":
    case "run.cancel":
      parseSoftwareAgentRunCommand(params, ["runId"]);
      requiredString(params, "runId", 512);
      return params as unknown as ControllerRpcParams[M];
    case "question.ask":
      parseSoftwareAgentRunCommand(params, ["runId", "sessionId", "prompt"]);
      requiredString(params, "runId", 512);
      requiredString(params, "sessionId", 512);
      requiredString(params, "prompt", 4096);
      return params as unknown as ControllerRpcParams[M];
    case "question.answer":
      parseSoftwareAgentRunCommand(params, ["runId", "questionId", "answer"]);
      requiredString(params, "runId", 512);
      requiredString(params, "questionId", 512);
      requiredString(params, "answer", 4096);
      return params as unknown as ControllerRpcParams[M];
    case "instruction.submit": {
      parseSoftwareAgentRunCommand(params, ["runId", "target", "text"]);
      requiredString(params, "runId", 512);
      requiredString(params, "text", 4096);
      const target = plainObject(params.target, "target");
      assertKeys(target, ["kind", "id"]);
      if (target.kind !== "agent" && target.kind !== "task" && target.kind !== "run") throw new TypeError("target.kind is invalid");
      requiredString(target, "id", 512);
      return params as unknown as ControllerRpcParams[M];
    }
    case "daemon.stop":
      assertKeys(params, []);
      return params as ControllerRpcParams[M];
  }
}

function parseSoftwareAgentRunCommand(
  params: Record<string, unknown>,
  operationKeys: readonly string[],
  optionalOperationKeys: readonly string[] = [],
): void {
  const common = ["schema", "commandId", "actor", "expectedRunRevision", "correlationId", "causationId", "uiAttachmentId", "mutationLease"];
  assertKeys(params, [...common, ...operationKeys], optionalOperationKeys);
  if (params.schema !== "software-agent.command/v2") throw new TypeError("unsupported Software Agent command schema");
  requiredString(params, "commandId", 256);
  requiredInteger(params, "expectedRunRevision", 0, Number.MAX_SAFE_INTEGER);
  requiredString(params, "correlationId", 256);
  requiredString(params, "causationId", 256);
  requiredString(params, "uiAttachmentId", 256);
  const actor = plainObject(params.actor, "actor");
  assertKeys(actor, ["type", "id"]);
  if (!(["human", "agent", "system"] as readonly unknown[]).includes(actor.type)) throw new TypeError("actor.type is invalid");
  requiredString(actor, "id", 256);
  const lease = plainObject(params.mutationLease, "mutationLease");
  assertKeys(lease, ["leaseId", "fence"]);
  requiredString(lease, "leaseId", 256);
  requiredInteger(lease, "fence", 1, Number.MAX_SAFE_INTEGER);
}

function handshakeProofPayload(input: Omit<ClientHello, "kind" | "nonceProof">): string {
  return JSON.stringify({
    requestId: input.requestId,
    protocolMin: input.protocolMin,
    protocolMax: input.protocolMax,
    instanceId: input.instanceId,
    userBinding: input.userBinding,
  });
}

function plainObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${label} must be a JSON object`);
  return value as Record<string, unknown>;
}

function assertKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  const accepted = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!accepted.has(key)) throw new TypeError(`unknown parameter: ${key}`);
  }
  for (const key of required) {
    if (!(key in value)) throw new TypeError(`missing parameter: ${key}`);
  }
}

function requiredString(value: Record<string, unknown>, key: string, maximumLength: number): string {
  const result = value[key];
  if (typeof result !== "string" || result.trim().length === 0 || result.length > maximumLength) {
    throw new TypeError(`${key} must be a non-empty string of at most ${maximumLength} characters`);
  }
  return result;
}

function optionalString(value: Record<string, unknown>, key: string, maximumLength: number): string | undefined {
  const result = value[key];
  if (result === undefined) return undefined;
  if (typeof result !== "string" || result.trim().length === 0 || result.length > maximumLength) {
    throw new TypeError(`${key} must be a non-empty string of at most ${maximumLength} characters`);
  }
  return result;
}

function requiredInteger(value: Record<string, unknown>, key: string, minimum: number, maximum: number): number {
  const result = value[key];
  if (typeof result !== "number" || !Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw new TypeError(`${key} must be an integer between ${minimum} and ${maximum}`);
  }
  return result;
}

function optionalInteger(value: Record<string, unknown>, key: string, minimum: number, maximum: number): number | undefined {
  if (value[key] === undefined) return undefined;
  return requiredInteger(value, key, minimum, maximum);
}
