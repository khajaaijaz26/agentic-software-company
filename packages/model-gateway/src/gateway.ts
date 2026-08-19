import {randomUUID} from "node:crypto";

import {
  hasControlCharacters,
  type ModelAdapter,
  type ModelDescriptor,
  type ModelRequest,
  type ModelResult,
  type NormalizedModelFrame,
} from "./types.js";

export class ModelGateway {
  readonly #adapters = new Map<string, ModelAdapter>();

  public register(adapter: ModelAdapter): void {
    validateId(adapter.id, "model adapter ID");
    if (this.#adapters.has(adapter.id)) throw new Error(`model adapter ${adapter.id} is already registered`);
    this.#adapters.set(adapter.id, adapter);
  }

  public async discover(signal?: AbortSignal): Promise<readonly ModelDescriptor[]> {
    return Object.freeze((await Promise.all([...this.#adapters.values()].map((adapter) => adapter.discover(signal)))).flat());
  }

  public stream(providerId: string, request: ModelRequest, signal: AbortSignal): AsyncIterable<NormalizedModelFrame> {
    const adapter = this.#adapter(providerId);
    if (adapter.stream) return adapter.stream(request, signal);
    return framesFromCompletion(adapter.complete(request, signal));
  }

  public complete(providerId: string, request: ModelRequest, signal: AbortSignal): Promise<ModelResult> {
    return this.#adapter(providerId).complete(request, signal);
  }

  #adapter(providerId: string): ModelAdapter {
    const adapter = this.#adapters.get(providerId);
    if (!adapter) throw new Error(`unknown model provider: ${providerId}`);
    return adapter;
  }
}

export interface ModelBrokerGrant {
  readonly schema: "software-agent.model-grant/v1";
  readonly grantId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly agentId: string;
  readonly attemptId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly routingRevision: number;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly expiresAt: string;
}

export type ModelBrokerGrantInput = Omit<ModelBrokerGrant, "schema" | "grantId">;

export class ModelGrantError extends Error {
  public constructor(public readonly code: "MODEL_GRANT_CONSUMED" | "MODEL_GRANT_EXPIRED" | "MODEL_GRANT_MISMATCH" | "MODEL_GRANT_UNKNOWN", message: string) {
    super(message);
    this.name = "ModelGrantError";
  }
}

interface StoredGrant {
  readonly grant: ModelBrokerGrant;
  consumed: boolean;
}

export class ModelBroker {
  readonly #grants = new Map<string, StoredGrant>();
  readonly #now: () => Date;

  public constructor(private readonly gateway: ModelGateway, options: {readonly now?: () => Date} = {}) {
    this.#now = options.now ?? (() => new Date());
  }

  public issueGrant(input: ModelBrokerGrantInput): ModelBrokerGrant {
    validateId(input.runId, "run ID");
    validateId(input.taskId, "task ID");
    validateId(input.agentId, "Software Agent ID");
    validateId(input.attemptId, "attempt ID");
    validateId(input.providerId, "provider ID");
    if (input.modelId.length < 1 || input.modelId.length > 256 || hasControlCharacters(input.modelId)) throw new Error("invalid grant model ID");
    if (!Number.isSafeInteger(input.routingRevision) || input.routingRevision < 1) throw new Error("invalid routing revision");
    validateTokenLimit(input.maxInputTokens, "grant input token limit");
    validateTokenLimit(input.maxOutputTokens, "grant output token limit");
    const expiry = Date.parse(input.expiresAt);
    if (!Number.isFinite(expiry) || expiry <= this.#now().getTime()) throw new ModelGrantError("MODEL_GRANT_EXPIRED", "model grant expiry is invalid or elapsed");
    const grant = Object.freeze({
      schema: "software-agent.model-grant/v1" as const,
      grantId: `mgrant_${randomUUID().replaceAll("-", "")}`,
      ...input,
    });
    this.#grants.set(grant.grantId, {grant, consumed: false});
    return grant;
  }

  public async complete(grant: ModelBrokerGrant, request: ModelRequest, signal: AbortSignal): Promise<ModelResult> {
    const stored = this.#consume(grant, request);
    return this.gateway.complete(stored.providerId, request, signal);
  }

  public async *stream(
    grant: ModelBrokerGrant,
    request: ModelRequest,
    signal: AbortSignal,
  ): AsyncGenerator<NormalizedModelFrame> {
    const stored = this.#consume(grant, request);
    for await (const frame of this.gateway.stream(stored.providerId, request, signal)) yield frame;
  }

  public revoke(grantId: string): boolean {
    return this.#grants.delete(grantId);
  }

  #consume(candidate: ModelBrokerGrant, request: ModelRequest): ModelBrokerGrant {
    const stored = this.#grants.get(candidate.grantId);
    if (!stored) throw new ModelGrantError("MODEL_GRANT_UNKNOWN", "model grant is unknown or revoked");
    if (!sameGrant(stored.grant, candidate)) throw new ModelGrantError("MODEL_GRANT_MISMATCH", "model grant binding does not match");
    if (stored.consumed) throw new ModelGrantError("MODEL_GRANT_CONSUMED", "model grant was already consumed");
    if (Date.parse(stored.grant.expiresAt) <= this.#now().getTime()) throw new ModelGrantError("MODEL_GRANT_EXPIRED", "model grant has expired");
    if (request.modelId !== stored.grant.modelId || request.maxOutputTokens > stored.grant.maxOutputTokens) {
      throw new ModelGrantError("MODEL_GRANT_MISMATCH", "model request exceeds its grant binding");
    }
    const estimatedInput = estimateModelRequestInputTokens(request);
    if (estimatedInput > stored.grant.maxInputTokens) {
      throw new ModelGrantError("MODEL_GRANT_MISMATCH", "model request input exceeds its grant binding");
    }
    stored.consumed = true;
    return stored.grant;
  }
}

async function* framesFromCompletion(completion: Promise<ModelResult>): AsyncGenerator<NormalizedModelFrame> {
  const result = await completion;
  if (result.text !== "") yield Object.freeze({type: "text-delta", text: result.text});
  for (const call of result.toolCalls) yield Object.freeze({type: "tool-call", ...call});
  yield Object.freeze({type: "usage", usage: result.usage});
  yield Object.freeze({
    type: "completed",
    providerRequestId: result.providerRequestId,
    resolvedModel: result.modelId,
    stopReason: result.stopReason,
  });
}

function sameGrant(left: ModelBrokerGrant, right: ModelBrokerGrant): boolean {
  return left.grantId === right.grantId
    && left.runId === right.runId
    && left.taskId === right.taskId
    && left.agentId === right.agentId
    && left.attemptId === right.attemptId
    && left.providerId === right.providerId
    && left.modelId === right.modelId
    && left.routingRevision === right.routingRevision
    && left.maxInputTokens === right.maxInputTokens
    && left.maxOutputTokens === right.maxOutputTokens
    && left.expiresAt === right.expiresAt;
}

function validateId(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value)) throw new Error(`invalid ${label}`);
}

function validateTokenLimit(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 10_000_000) throw new Error(`${label} is out of range`);
}

export function estimateModelRequestInputTokens(request: ModelRequest): number {
  const serialized = JSON.stringify({
    system: request.system,
    input: request.input,
    providerContinuationId: request.providerContinuationId ?? null,
    messages: request.messages ?? [],
    tools: request.tools ?? [],
    toolResults: request.toolResults ?? [],
    structuredOutput: request.structuredOutput ?? null,
  });
  return Math.ceil(Buffer.byteLength(serialized) / 4);
}
