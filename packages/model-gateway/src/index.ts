import {createHash} from "node:crypto";
import type {SecretBroker, SecretReference} from "../../secret-broker/src/index.js";

export interface ModelCapabilities {
  readonly tools: boolean;
  readonly structuredOutput: boolean;
  readonly vision: boolean;
  readonly streaming: boolean;
  readonly contextTokens: number | "UNKNOWN";
  readonly pricing: "KNOWN" | "UNKNOWN";
}

export interface ModelDescriptor {
  readonly providerId: string;
  readonly modelId: string;
  readonly capabilities: ModelCapabilities;
}

export interface ModelRequest {
  readonly requestId: string;
  readonly modelId: string;
  readonly system: string;
  readonly input: string;
  readonly maxOutputTokens: number;
}

export interface ModelResult {
  readonly requestId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly text: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cost: number | "UNKNOWN";
  readonly currency: "USD";
}

export interface ModelAdapter {
  readonly id: string;
  discover(): Promise<readonly ModelDescriptor[]>;
  complete(request: ModelRequest, signal: AbortSignal): Promise<ModelResult>;
}

export class DeterministicModelAdapter implements ModelAdapter {
  public readonly id = "deterministic";

  public discover(): Promise<readonly ModelDescriptor[]> {
    return Promise.resolve([{
      providerId: this.id,
      modelId: "local",
      capabilities: {tools: false, structuredOutput: true, vision: false, streaming: false, contextTokens: 32_000, pricing: "KNOWN"},
    }]);
  }

  public complete(request: ModelRequest, signal: AbortSignal): Promise<ModelResult> {
    if (signal.aborted) {
      return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("model request canceled"));
    }
    const digest = createHash("sha256").update(`${request.system}\0${request.input}`).digest("hex").slice(0, 12);
    const text = `Deterministic plan ${digest}: ${request.input.trim().slice(0, 240)}`;
    return Promise.resolve({
      requestId: request.requestId,
      providerId: this.id,
      modelId: "local",
      text,
      inputTokens: estimateTokens(request.system) + estimateTokens(request.input),
      outputTokens: estimateTokens(text),
      cost: 0,
      currency: "USD",
    });
  }
}

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
    if (!/^https?:$/u.test(baseUrl.protocol)) throw new Error("model endpoint must use http or https");
  }

  public discover(): Promise<readonly ModelDescriptor[]> {
    return Promise.resolve(this.modelIds.map((modelId) => ({
      providerId: this.id,
      modelId,
      capabilities: {tools: true, structuredOutput: true, vision: false, streaming: false, contextTokens: "UNKNOWN", pricing: "UNKNOWN"},
    })));
  }

  public async complete(request: ModelRequest, signal: AbortSignal): Promise<ModelResult> {
    const lease = await this.broker.resolve(this.apiKey, `model request ${request.requestId}`, 60);
    try {
      const response = await fetch(new URL("chat/completions", ensureTrailingSlash(this.baseUrl)), {
        method: "POST",
        signal,
        headers: {"content-type": "application/json", authorization: `Bearer ${lease.value}`},
        body: JSON.stringify({
          model: request.modelId,
          messages: [{role: "system", content: request.system}, {role: "user", content: request.input}],
          max_tokens: request.maxOutputTokens,
          stream: false,
        }),
      });
      if (!response.ok) throw new Error(`model gateway returned HTTP ${response.status}`);
      const body = await response.json() as {
        choices?: {message?: {content?: string}}[];
        usage?: {prompt_tokens?: number; completion_tokens?: number};
      };
      const text = body.choices?.[0]?.message?.content;
      if (typeof text !== "string") throw new Error("model gateway response has no text result");
      return {
        requestId: request.requestId,
        providerId: this.id,
        modelId: request.modelId,
        text,
        inputTokens: body.usage?.prompt_tokens ?? estimateTokens(request.system + request.input),
        outputTokens: body.usage?.completion_tokens ?? estimateTokens(text),
        cost: "UNKNOWN",
        currency: "USD",
      };
    } finally {
      lease.value = "";
    }
  }
}

export class ModelGateway {
  readonly #adapters = new Map<string, ModelAdapter>();

  public register(adapter: ModelAdapter): void {
    if (this.#adapters.has(adapter.id)) throw new Error(`model adapter ${adapter.id} is already registered`);
    this.#adapters.set(adapter.id, adapter);
  }

  public async discover(): Promise<readonly ModelDescriptor[]> {
    return (await Promise.all([...this.#adapters.values()].map((adapter) => adapter.discover()))).flat();
  }

  public async complete(providerId: string, request: ModelRequest, signal: AbortSignal): Promise<ModelResult> {
    const adapter = this.#adapters.get(providerId);
    if (!adapter) throw new Error(`unknown model provider: ${providerId}`);
    return adapter.complete(request, signal);
  }
}

function estimateTokens(value: string): number {
  return Math.ceil(value.length / 4);
}

function ensureTrailingSlash(url: URL): URL {
  return new URL(url.href.endsWith("/") ? url.href : `${url.href}/`);
}
