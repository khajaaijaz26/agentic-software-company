import type {SecretBroker, SecretReference} from "../../secret-broker/src/index.js";

import {isRecord, openProviderResponse, providerHttpLimits, readBoundedJson} from "./http.js";
import {
  descriptorFromCatalog,
  type ModelAdapter,
  type ModelDescriptor,
  type ModelRequest,
  type ModelResult,
  type NormalizedModelUsage,
} from "./types.js";

/** Legacy custom endpoint support retained only for v0.2 parsing compatibility. */
export class OpenAICompatibleAdapter implements ModelAdapter {
  public readonly id: string;

  public constructor(
    id: string,
    private readonly baseUrl: URL,
    private readonly apiKey: SecretReference,
    private readonly broker: SecretBroker,
    private readonly modelIds: readonly string[],
  ) {
    this.id = id;
    if (baseUrl.protocol !== "https:" && !(baseUrl.protocol === "http:" && isLoopback(baseUrl.hostname))) {
      throw new Error("legacy model endpoint must use HTTPS or explicit loopback HTTP");
    }
  }

  public discover(): Promise<readonly ModelDescriptor[]> {
    return Promise.resolve(Object.freeze(this.modelIds.map((modelId) => descriptorFromCatalog(this.id, modelId, undefined))));
  }

  public async complete(request: ModelRequest, signal: AbortSignal): Promise<ModelResult> {
    const lease = await this.broker.resolve(this.apiKey, `legacy model request ${request.requestId}`, 60);
    let close: (() => void) | undefined;
    try {
      const handle = await openProviderResponse({
        providerId: this.id,
        url: new URL("chat/completions", ensureTrailingSlash(this.baseUrl)),
        fetch: (input, init) => fetch(input, init),
        init: {
          method: "POST",
          headers: {"content-type": "application/json", authorization: `Bearer ${lease.value}`},
          body: JSON.stringify({
            model: request.modelId,
            messages: [{role: "system", content: request.system}, {role: "user", content: request.input}],
            max_tokens: request.maxOutputTokens,
            stream: false,
          }),
        },
        signal,
        limits: providerHttpLimits({}),
      });
      close = handle.close;
      const body = await readBoundedJson(this.id, handle.response, 2 * 1024 * 1024);
      const choices = Array.isArray(body.choices) ? body.choices : [];
      const first: unknown = choices[0];
      const messageCandidate = isRecord(first) ? first.message : undefined;
      const message = isRecord(messageCandidate) ? messageCandidate : undefined;
      const text = message?.content;
      if (typeof text !== "string") throw new Error("legacy model gateway response has no text result");
      const usageRecord = typeof body.usage === "object" && body.usage !== null ? body.usage as Record<string, unknown> : undefined;
      const inputTokens = token(usageRecord?.prompt_tokens);
      const outputTokens = token(usageRecord?.completion_tokens);
      const usage: NormalizedModelUsage = Object.freeze({
        inputTokens,
        outputTokens,
        cachedInputTokens: "UNKNOWN",
        reasoningTokens: "UNKNOWN",
        totalTokens: inputTokens === "UNKNOWN" || outputTokens === "UNKNOWN" ? "UNKNOWN" : inputTokens + outputTokens,
        source: inputTokens === "UNKNOWN" && outputTokens === "UNKNOWN" ? "UNKNOWN" : "PROVIDER",
      });
      return Object.freeze({
        requestId: request.requestId,
        providerId: this.id,
        modelId: typeof body.model === "string" ? body.model : request.modelId,
        providerRequestId: handle.response.headers.get("x-request-id") ?? "UNKNOWN",
        stopReason: "UNKNOWN",
        text,
        toolCalls: Object.freeze([]),
        usage,
        inputTokens,
        outputTokens,
        cost: "UNKNOWN",
        currency: "USD",
      });
    } finally {
      close?.();
      lease.value = "";
    }
  }
}

function token(value: unknown): number | "UNKNOWN" {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : "UNKNOWN";
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

function ensureTrailingSlash(url: URL): URL {
  return new URL(url.href.endsWith("/") ? url.href : `${url.href}/`);
}
