import type {SecretBroker, SecretReference} from "../../secret-broker/src/index.js";

export type Unknown = "UNKNOWN";

export interface ModelCapabilities {
  readonly tools: boolean | Unknown;
  readonly structuredOutput: boolean | Unknown;
  readonly vision: boolean | Unknown;
  readonly streaming: boolean | Unknown;
  readonly contextTokens: number | Unknown;
}

export interface ModelPricing {
  readonly currency: "USD";
  readonly inputUsdPerMillionTokens: number | Unknown;
  readonly cachedInputUsdPerMillionTokens: number | Unknown;
  readonly outputUsdPerMillionTokens: number | Unknown;
}

export interface ModelCapabilityCatalogEntry {
  readonly modelId: string;
  readonly capabilities: ModelCapabilities;
  readonly pricing: ModelPricing | Unknown;
}

export interface ModelCapabilityCatalog {
  readonly schema: "software-agent.model-catalog/v1";
  readonly providerId: string;
  readonly version: string;
  readonly source: string;
  readonly observedAt: string;
  readonly models: readonly ModelCapabilityCatalogEntry[];
}

export interface ModelDescriptor {
  readonly providerId: string;
  readonly modelId: string;
  readonly capabilities: ModelCapabilities;
  readonly pricing: ModelPricing | Unknown;
  readonly catalog: {
    readonly version: string;
    readonly source: string;
    readonly observedAt: string;
  } | Unknown;
}

export interface ModelMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
  readonly toolCallId?: string;
  readonly toolCalls?: readonly ModelToolCall[];
}

export interface ModelToolResult {
  readonly callId: string;
  readonly name?: string;
  readonly content: string;
  readonly isError?: boolean;
}

export interface ModelToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export interface StructuredOutputDefinition {
  readonly name?: string;
  readonly schema: Readonly<Record<string, unknown>>;
  readonly strict?: boolean;
}

export interface ModelRequest {
  readonly requestId: string;
  readonly modelId: string;
  readonly system: string;
  readonly input: string;
  readonly maxOutputTokens: number;
  /** Provider-owned response identity used for a same-provider continuation. */
  readonly providerContinuationId?: string;
  readonly messages?: readonly ModelMessage[];
  readonly tools?: readonly ModelToolDefinition[];
  readonly toolResults?: readonly ModelToolResult[];
  readonly structuredOutput?: StructuredOutputDefinition;
  readonly reasoningEffort?: "minimal" | "low" | "medium" | "high";
}

export interface NormalizedModelUsage {
  readonly inputTokens: number | Unknown;
  readonly outputTokens: number | Unknown;
  readonly cachedInputTokens: number | Unknown;
  readonly reasoningTokens: number | Unknown;
  readonly totalTokens: number | Unknown;
  readonly source: "PROVIDER" | "UNKNOWN";
}

export interface ModelToolCall {
  readonly callId: string;
  readonly name: string;
  readonly arguments: unknown;
}

export type NormalizedModelFrame =
  | {readonly type: "text-delta"; readonly text: string}
  | ({readonly type: "tool-call"} & ModelToolCall)
  | {readonly type: "usage"; readonly usage: NormalizedModelUsage}
  | {
    readonly type: "completed";
    readonly providerRequestId: string;
    readonly resolvedModel: string;
    readonly stopReason: string;
  };

export interface ModelResult {
  readonly requestId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly providerRequestId: string;
  readonly stopReason: string;
  readonly text: string;
  readonly toolCalls: readonly ModelToolCall[];
  readonly usage: NormalizedModelUsage;
  readonly inputTokens: number | Unknown;
  readonly outputTokens: number | Unknown;
  readonly cost: number | Unknown;
  readonly currency: "USD";
}

export interface ModelAdapter {
  readonly id: string;
  discover(signal?: AbortSignal): Promise<readonly ModelDescriptor[]>;
  stream?(request: ModelRequest, signal: AbortSignal): AsyncIterable<NormalizedModelFrame>;
  complete(request: ModelRequest, signal: AbortSignal): Promise<ModelResult>;
}

export interface NativeProviderAdapterOptions {
  readonly secretBroker: SecretBroker;
  readonly credential: SecretReference;
  readonly fetch?: FetchLike;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly maxFrameBytes?: number;
  readonly maxRequestBytes?: number;
  readonly catalog?: ModelCapabilityCatalog;
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export const UNKNOWN_USAGE: NormalizedModelUsage = Object.freeze({
  inputTokens: "UNKNOWN",
  outputTokens: "UNKNOWN",
  cachedInputTokens: "UNKNOWN",
  reasoningTokens: "UNKNOWN",
  totalTokens: "UNKNOWN",
  source: "UNKNOWN",
});

export async function collectModelFrames(
  providerId: string,
  request: ModelRequest,
  source: AsyncIterable<NormalizedModelFrame>,
): Promise<ModelResult> {
  let text = "";
  const toolCalls: ModelToolCall[] = [];
  let usage = UNKNOWN_USAGE;
  let completion: Extract<NormalizedModelFrame, {type: "completed"}> | undefined;
  for await (const frame of source) {
    if (frame.type === "text-delta") text += frame.text;
    else if (frame.type === "tool-call") toolCalls.push(Object.freeze({callId: frame.callId, name: frame.name, arguments: frame.arguments}));
    else if (frame.type === "usage") usage = frame.usage;
    else completion = frame;
  }
  if (!completion) throw new Error(`provider ${providerId} stream ended without a completion frame`);
  return Object.freeze({
    requestId: request.requestId,
    providerId,
    modelId: completion.resolvedModel,
    providerRequestId: completion.providerRequestId,
    stopReason: completion.stopReason,
    text,
    toolCalls: Object.freeze(toolCalls),
    usage,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cost: "UNKNOWN",
    currency: "USD",
  });
}

export function descriptorFromCatalog(
  providerId: string,
  modelId: string,
  catalog: ModelCapabilityCatalog | undefined,
): ModelDescriptor {
  const entry = catalog?.providerId === providerId
    ? catalog.models.find((candidate) => candidate.modelId === modelId)
    : undefined;
  if (!entry || !catalog) {
    return Object.freeze({
      providerId,
      modelId,
      capabilities: Object.freeze({
        tools: "UNKNOWN",
        structuredOutput: "UNKNOWN",
        vision: "UNKNOWN",
        streaming: "UNKNOWN",
        contextTokens: "UNKNOWN",
      }),
      pricing: "UNKNOWN",
      catalog: "UNKNOWN",
    });
  }
  return Object.freeze({
    providerId,
    modelId,
    capabilities: Object.freeze({...entry.capabilities}),
    pricing: entry.pricing === "UNKNOWN" ? "UNKNOWN" : Object.freeze({...entry.pricing}),
    catalog: Object.freeze({version: catalog.version, source: catalog.source, observedAt: catalog.observedAt}),
  });
}

export function hasControlCharacters(value: string, allowTextWhitespace = false): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code === 127 || code < 32 && !(allowTextWhitespace && (code === 9 || code === 10 || code === 13))) return true;
  }
  return false;
}
