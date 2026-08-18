import {createHmac, randomUUID, timingSafeEqual} from "node:crypto";

import type {ApprovalRecord} from "../../approval-service/src/index.js";
import type {ControllerSnapshot, RunView} from "../../../apps/control-plane/src/controller.js";

export const IPC_PROTOCOL_MIN = 1;
export const IPC_PROTOCOL_MAX = 1;
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
  }
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
