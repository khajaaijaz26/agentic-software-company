import {createHash} from "node:crypto";

import {
  collectModelFrames,
  type ModelAdapter,
  type ModelDescriptor,
  type ModelRequest,
  type ModelResult,
  type NormalizedModelFrame,
} from "./types.js";

export class DeterministicModelAdapter implements ModelAdapter {
  public readonly id = "deterministic";

  public discover(): Promise<readonly ModelDescriptor[]> {
    return Promise.resolve([Object.freeze({
      providerId: this.id,
      modelId: "local",
      capabilities: Object.freeze({tools: false, structuredOutput: true, vision: false, streaming: true, contextTokens: 32_000}),
      pricing: Object.freeze({
        currency: "USD",
        inputUsdPerMillionTokens: 0,
        cachedInputUsdPerMillionTokens: 0,
        outputUsdPerMillionTokens: 0,
      }),
      catalog: Object.freeze({version: "builtin-1", source: "Software Agent deterministic adapter", observedAt: "2026-08-19T00:00:00.000Z"}),
    })]);
  }

  public async *stream(request: ModelRequest, signal: AbortSignal): AsyncGenerator<NormalizedModelFrame> {
    await Promise.resolve();
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("model request canceled");
    const digest = createHash("sha256").update(`${request.system}\0${request.input}`).digest("hex").slice(0, 12);
    const text = `Deterministic plan ${digest}: ${request.input.trim().slice(0, 240)}`;
    const inputTokens = estimateTokens(request.system) + estimateTokens(request.input);
    const outputTokens = estimateTokens(text);
    yield Object.freeze({type: "text-delta", text});
    yield Object.freeze({
      type: "usage",
      usage: Object.freeze({
        inputTokens,
        outputTokens,
        cachedInputTokens: 0,
        reasoningTokens: 0,
        totalTokens: inputTokens + outputTokens,
        source: "PROVIDER",
      }),
    });
    yield Object.freeze({type: "completed", providerRequestId: request.requestId, resolvedModel: "local", stopReason: "completed"});
  }

  public async complete(request: ModelRequest, signal: AbortSignal): Promise<ModelResult> {
    const result = await collectModelFrames(this.id, request, this.stream(request, signal));
    return Object.freeze({...result, cost: 0});
  }
}

function estimateTokens(value: string): number {
  return Math.ceil(value.length / 4);
}
