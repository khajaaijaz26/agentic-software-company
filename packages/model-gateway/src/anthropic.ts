import {
  ProviderGatewayError,
  isRecord,
  openProviderResponse,
  parseProviderEvent,
  parseSse,
  providerHttpLimits,
  readBoundedJson,
  type ProviderHttpLimits,
} from "./http.js";
import {
  collectModelFrames,
  descriptorFromCatalog,
  hasControlCharacters,
  type FetchLike,
  type ModelAdapter,
  type ModelCapabilityCatalog,
  type ModelDescriptor,
  type ModelRequest,
  type ModelResult,
  type NativeProviderAdapterOptions,
  type NormalizedModelFrame,
  type NormalizedModelUsage,
} from "./types.js";

const ANTHROPIC_MESSAGES_URL = new URL("https://api.anthropic.com/v1/messages");
const ANTHROPIC_MODELS_URL = new URL("https://api.anthropic.com/v1/models");
export const ANTHROPIC_API_VERSION = "2023-06-01";

interface AnthropicToolBlock {
  readonly callId: string;
  readonly name: string;
  readonly initialInput: unknown;
  argumentsText: string;
  emitted: boolean;
}

export class AnthropicMessagesAdapter implements ModelAdapter {
  public readonly id = "anthropic";
  readonly #secretBroker: NativeProviderAdapterOptions["secretBroker"];
  readonly #credential: NativeProviderAdapterOptions["credential"];
  readonly #fetch: FetchLike;
  readonly #limits: ProviderHttpLimits;
  readonly #catalog: ModelCapabilityCatalog | undefined;

  public constructor(options: NativeProviderAdapterOptions) {
    this.#secretBroker = options.secretBroker;
    this.#credential = options.credential;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#limits = providerHttpLimits(options);
    if (options.catalog && options.catalog.providerId !== this.id) throw new Error("catalog provider must be anthropic");
    this.#catalog = options.catalog;
  }

  public async discover(signal: AbortSignal = new AbortController().signal): Promise<readonly ModelDescriptor[]> {
    const lease = await this.#secretBroker.resolve(this.#credential, "Anthropic model identity discovery", 60);
    let close: (() => void) | undefined;
    let abortCode: (() => "PROVIDER_CANCELED" | "PROVIDER_TIMEOUT" | undefined) | undefined;
    try {
      const handle = await openProviderResponse({
        providerId: this.id,
        url: ANTHROPIC_MODELS_URL,
        fetch: this.#fetch,
        init: {method: "GET", headers: this.#headers(lease.value)},
        signal,
        limits: this.#limits,
      });
      close = handle.close;
      abortCode = handle.abortCode;
      const body = await readBoundedJson(this.id, handle.response, this.#limits.maxResponseBytes);
      if (!Array.isArray(body.data) || body.data.length > 10_000) throw protocolError("model list has invalid data");
      const modelIds = new Set<string>();
      for (const item of body.data) {
        if (!isRecord(item) || !validModelId(item.id)) throw protocolError("model list contains an invalid identity");
        modelIds.add(item.id);
      }
      return Object.freeze([...modelIds].sort().map((modelId) => descriptorFromCatalog(this.id, modelId, this.#catalog)));
    } catch (error) {
      throw normalizeFailure(signal, error, abortCode?.());
    } finally {
      close?.();
      lease.value = "";
    }
  }

  public async *stream(request: ModelRequest, signal: AbortSignal): AsyncGenerator<NormalizedModelFrame> {
    validateRequest(request);
    const lease = await this.#secretBroker.resolve(this.#credential, `Anthropic message ${request.requestId}`, 60);
    let close: (() => void) | undefined;
    let abortCode: (() => "PROVIDER_CANCELED" | "PROVIDER_TIMEOUT" | undefined) | undefined;
    try {
      const handle = await openProviderResponse({
        providerId: this.id,
        url: ANTHROPIC_MESSAGES_URL,
        fetch: this.#fetch,
        init: {
          method: "POST",
          headers: this.#headers(lease.value),
          body: JSON.stringify(anthropicRequestBody(request)),
        },
        signal,
        limits: this.#limits,
      });
      close = handle.close;
      abortCode = handle.abortCode;
      let providerRequestId = boundedString(handle.response.headers.get("request-id")) ?? "UNKNOWN";
      let resolvedModel = request.modelId;
      let stopReason = "UNKNOWN";
      let inputTokens: number | "UNKNOWN" = "UNKNOWN";
      let outputTokens: number | "UNKNOWN" = "UNKNOWN";
      let cachedInputTokens: number | "UNKNOWN" = "UNKNOWN";
      let completed = false;
      let messageStarted = false;
      let messageStopped = false;
      const tools = new Map<number, AnthropicToolBlock>();
      const blockTypes = new Map<number, string>();
      const activeBlocks = new Set<number>();

      for await (const envelope of parseSse(this.id, handle.response, this.#limits)) {
        if (envelope.data === "") continue;
        const event = parseProviderEvent(this.id, envelope.data);
        const type = boundedString(event.type);
        if (envelope.event === "error" || type === "error") throw protocolError("reported a stream failure");
        if (type === "ping") continue;
        if (type === "message_start") {
          if (messageStarted || messageStopped) throw protocolError("message_start is out of order");
          const message = recordField(event, "message");
          if (!message) throw protocolError("message_start is malformed");
          messageStarted = true;
          providerRequestId = boundedString(message.id) ?? providerRequestId;
          resolvedModel = boundedString(message.model) ?? resolvedModel;
          const usage = recordField(message, "usage");
          const uncachedInput = tokenField(usage, "input_tokens");
          cachedInputTokens = optionalTokenField(usage, "cache_read_input_tokens");
          const cacheCreationInput = optionalTokenField(usage, "cache_creation_input_tokens");
          inputTokens = uncachedInput === "UNKNOWN" || cachedInputTokens === "UNKNOWN" || cacheCreationInput === "UNKNOWN"
            ? "UNKNOWN"
            : uncachedInput + cachedInputTokens + cacheCreationInput;
          continue;
        }
        if (type === "content_block_start") {
          if (!messageStarted || messageStopped) throw protocolError("content block start is out of order");
          const index = integerField(event, "index");
          const block = recordField(event, "content_block");
          if (index === undefined || !block) throw protocolError("content block start is malformed");
          const blockType = boundedString(block.type);
          if (!blockType || activeBlocks.has(index) || blockTypes.has(index)) throw protocolError("content block start is malformed");
          activeBlocks.add(index);
          blockTypes.set(index, blockType);
          if (blockType === "text") {
            const initialText = boundedString(block.text, this.#limits.maxFrameBytes, true);
            if (initialText === undefined) throw protocolError("text block is malformed");
            if (initialText !== "") yield Object.freeze({type: "text-delta", text: initialText});
          } else if (blockType === "tool_use") {
            const callId = boundedString(block.id);
            const name = boundedString(block.name);
            if (!callId || !name) throw protocolError("tool block identity is malformed");
            try {
              validateToolCallId(callId);
              validateToolName(name);
            } catch {
              throw protocolError("tool block identity is malformed");
            }
            const initialInput = block.input ?? {};
            if (!isRecord(initialInput)) throw protocolError("tool block input is malformed");
            tools.set(index, {callId, name, initialInput, argumentsText: "", emitted: false});
          }
          continue;
        }
        if (type === "content_block_delta") {
          if (!messageStarted || messageStopped) throw protocolError("content block delta is out of order");
          const index = integerField(event, "index");
          const delta = recordField(event, "delta");
          if (index === undefined || !delta || !activeBlocks.has(index)) throw protocolError("content block delta is malformed");
          if (delta.type === "text_delta") {
            const text = boundedString(delta.text, this.#limits.maxFrameBytes, true);
            if (text === undefined || blockTypes.get(index) !== "text") throw protocolError("text delta is malformed");
            yield Object.freeze({type: "text-delta", text});
          } else if (delta.type === "input_json_delta") {
            const partial = boundedString(delta.partial_json, this.#limits.maxFrameBytes, true);
            const tool = tools.get(index);
            if (partial === undefined || !tool || blockTypes.get(index) !== "tool_use") throw protocolError("tool argument delta is malformed");
            tool.argumentsText += partial;
            if (Buffer.byteLength(tool.argumentsText) > this.#limits.maxFrameBytes) {
              throw new ProviderGatewayError("PROVIDER_RESPONSE_TOO_LARGE", this.id, "provider anthropic tool arguments exceed their size limit");
            }
          }
          continue;
        }
        if (type === "content_block_stop") {
          const index = integerField(event, "index");
          if (!messageStarted || messageStopped || index === undefined || !activeBlocks.delete(index)) {
            throw protocolError("content block stop is out of order");
          }
          const tool = tools.get(index);
          if (tool && !tool.emitted) {
            tool.emitted = true;
            yield Object.freeze({type: "tool-call", callId: tool.callId, name: tool.name, arguments: toolArguments(tool)});
          }
          continue;
        }
        if (type === "message_delta") {
          if (!messageStarted || messageStopped || activeBlocks.size > 0) throw protocolError("message delta is out of order");
          const delta = recordField(event, "delta");
          stopReason = boundedString(delta?.stop_reason) ?? stopReason;
          const usage = recordField(event, "usage");
          const cumulative = tokenField(usage, "output_tokens");
          if (cumulative !== "UNKNOWN") outputTokens = cumulative;
          continue;
        }
        if (type === "message_stop") {
          if (!messageStarted || messageStopped || activeBlocks.size > 0) throw protocolError("message_stop is out of order");
          messageStopped = true;
          for (const tool of tools.values()) {
            if (!tool.emitted) {
              tool.emitted = true;
              yield Object.freeze({type: "tool-call", callId: tool.callId, name: tool.name, arguments: toolArguments(tool)});
            }
          }
          yield Object.freeze({
            type: "usage",
            usage: anthropicUsage(inputTokens, outputTokens, cachedInputTokens),
          });
          yield Object.freeze({type: "completed", providerRequestId, resolvedModel, stopReason});
          completed = true;
          continue;
        }
        // Ping and future event types are deliberately ignored for forward compatibility.
      }
      if (!completed) throw protocolError("stream ended before message_stop");
    } catch (error) {
      throw normalizeFailure(signal, error, abortCode?.());
    } finally {
      close?.();
      lease.value = "";
    }
  }

  public complete(request: ModelRequest, signal: AbortSignal): Promise<ModelResult> {
    return collectModelFrames(this.id, request, this.stream(request, signal));
  }

  #headers(apiKey: string): Record<string, string> {
    return {
      "anthropic-version": ANTHROPIC_API_VERSION,
      "content-type": "application/json",
      "x-api-key": apiKey,
    };
  }
}

function anthropicRequestBody(request: ModelRequest): Record<string, unknown> {
  const supplied = request.messages ?? [{role: "user" as const, content: request.input}];
  const systemMessages = supplied.filter(({role}) => role === "system").map(({content}) => content);
  const messages: Array<{role: "user" | "assistant"; content: unknown}> = [];
  for (const message of supplied) {
    if (message.role === "system") continue;
    if (message.role === "tool") {
      if (!message.toolCallId) throw new Error("legacy tool messages require toolCallId");
      messages.push({role: "user", content: [{type: "tool_result", tool_use_id: message.toolCallId, content: message.content}]});
      continue;
    }
    const blocks: Record<string, unknown>[] = [];
    if (message.content !== "") blocks.push({type: "text", text: message.content});
    for (const call of message.toolCalls ?? []) {
      if (message.role !== "assistant") throw new Error("only assistant messages may contain tool calls");
      blocks.push({type: "tool_use", id: call.callId, name: call.name, input: call.arguments});
    }
    messages.push({role: message.role, content: blocks.length === 1 && blocks[0]?.type === "text" ? message.content : blocks});
  }
  if ((request.toolResults?.length ?? 0) > 0) {
    messages.push({
      role: "user",
      content: request.toolResults?.map((result) => {
        validateToolResult(result.callId, result.content);
        return {
          type: "tool_result",
          tool_use_id: result.callId,
          content: result.content,
          ...(result.isError === undefined ? {} : {is_error: result.isError}),
        };
      }) ?? [],
    });
  }
  return {
    model: request.modelId,
    system: [request.system, ...systemMessages].filter((value) => value !== "").join("\n\n"),
    messages,
    max_tokens: request.maxOutputTokens,
    stream: true,
    ...(request.tools === undefined ? {} : {
      tools: request.tools.map((tool) => ({name: tool.name, description: tool.description, input_schema: tool.inputSchema})),
    }),
    ...(request.structuredOutput === undefined ? {} : {
      output_config: {format: {type: "json_schema", schema: request.structuredOutput.schema}},
    }),
  };
}

function anthropicUsage(
  inputTokens: number | "UNKNOWN",
  outputTokens: number | "UNKNOWN",
  cachedInputTokens: number | "UNKNOWN",
): NormalizedModelUsage {
  return Object.freeze({
    inputTokens,
    outputTokens,
    cachedInputTokens,
    reasoningTokens: "UNKNOWN",
    totalTokens: inputTokens === "UNKNOWN" || outputTokens === "UNKNOWN" ? "UNKNOWN" : inputTokens + outputTokens,
    source: inputTokens === "UNKNOWN" && outputTokens === "UNKNOWN" ? "UNKNOWN" : "PROVIDER",
  });
}

function toolArguments(tool: AnthropicToolBlock): unknown {
  if (tool.argumentsText === "") return tool.initialInput;
  try {
    const value: unknown = JSON.parse(tool.argumentsText);
    if (!isRecord(value)) throw new Error("not an object");
    return value;
  } catch {
    throw protocolError("tool call arguments are malformed");
  }
}

function validModelId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 256 && !hasControlCharacters(value);
}

function validateRequest(request: ModelRequest): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(request.requestId)) throw new Error("invalid model request ID");
  if (!validModelId(request.modelId)) throw new Error("invalid model ID");
  validateProviderContinuationId(request.providerContinuationId);
  if (!Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens < 1 || request.maxOutputTokens > 10_000_000) {
    throw new Error("maximum output tokens are out of range");
  }
  for (const message of request.messages ?? []) {
    if (message.role === "tool" && message.toolCallId === undefined) throw new Error("legacy tool messages require toolCallId");
    if (message.toolCallId !== undefined) validateToolCallId(message.toolCallId);
    for (const call of message.toolCalls ?? []) {
      if (message.role !== "assistant") throw new Error("only assistant messages may contain tool calls");
      validateToolCallId(call.callId);
      validateToolName(call.name);
    }
  }
  for (const tool of request.tools ?? []) validateToolName(tool.name);
  for (const result of request.toolResults ?? []) {
    validateToolResult(result.callId, result.content);
    if (result.name !== undefined) validateToolName(result.name);
  }
}

function validateProviderContinuationId(value: string | undefined): void {
  if (value !== undefined && (value.length < 1 || value.length > 512 || hasControlCharacters(value))) {
    throw new Error("invalid provider continuation ID");
  }
}

function validateToolResult(callId: string, content: string): void {
  validateToolCallId(callId);
  if (Buffer.byteLength(content) > 1024 * 1024 || hasControlCharacters(content, true)) throw new Error("invalid tool-result content");
}

function validateToolCallId(callId: string): void {
  if (callId.length < 1 || callId.length > 256 || hasControlCharacters(callId)) throw new Error("invalid tool-result call ID");
}

function validateToolName(name: string): void {
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(name)) throw new Error("invalid model tool name");
}

function normalizeFailure(
  signal: AbortSignal,
  error: unknown,
  abortCode: "PROVIDER_CANCELED" | "PROVIDER_TIMEOUT" | undefined,
): Error {
  if (error instanceof ProviderGatewayError) return error;
  if (abortCode === "PROVIDER_TIMEOUT") return new ProviderGatewayError(abortCode, "anthropic", "provider anthropic request timed out");
  if (abortCode === "PROVIDER_CANCELED") return new ProviderGatewayError(abortCode, "anthropic", "provider anthropic request was canceled");
  if (signal.aborted) return new ProviderGatewayError("PROVIDER_CANCELED", "anthropic", "provider anthropic request was canceled");
  return new ProviderGatewayError("PROVIDER_PROTOCOL_ERROR", "anthropic", "provider anthropic stream failed validation");
}

function protocolError(detail: string): ProviderGatewayError {
  return new ProviderGatewayError("PROVIDER_PROTOCOL_ERROR", "anthropic", `provider anthropic ${detail}`);
}

function boundedString(value: unknown, maximum = 512, allowTextWhitespace = false): string | undefined {
  return typeof value === "string" && value.length <= maximum && !hasControlCharacters(value, allowTextWhitespace)
    ? value
    : undefined;
}

function recordField(value: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
  const candidate = value?.[key];
  return isRecord(candidate) ? candidate : undefined;
}

function integerField(value: Record<string, unknown>, key: string): number | undefined {
  const candidate = value[key];
  return typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0 ? candidate : undefined;
}

function tokenField(value: Record<string, unknown> | undefined, key: string): number | "UNKNOWN" {
  const candidate = value?.[key];
  return typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0 ? candidate : "UNKNOWN";
}

function optionalTokenField(value: Record<string, unknown> | undefined, key: string): number | "UNKNOWN" {
  const candidate = value?.[key];
  if (candidate === undefined) return 0;
  return typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0 ? candidate : "UNKNOWN";
}
