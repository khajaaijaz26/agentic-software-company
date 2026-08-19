import type {SecretLease} from "../../secret-broker/src/index.js";

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
  type ModelToolCall,
  type NativeProviderAdapterOptions,
  type NormalizedModelFrame,
  type NormalizedModelUsage,
} from "./types.js";

const OPENAI_RESPONSES_URL = new URL("https://api.openai.com/v1/responses");
const OPENAI_MODELS_URL = new URL("https://api.openai.com/v1/models");

interface PendingFunctionCall {
  callId: string;
  name: string;
  argumentsText: string;
}

export class OpenAIResponsesAdapter implements ModelAdapter {
  public readonly id = "openai";
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
    this.#catalog = validateCatalog(options.catalog, this.id);
  }

  public async discover(signal: AbortSignal = new AbortController().signal): Promise<readonly ModelDescriptor[]> {
    const lease = await this.#secretBroker.resolve(this.#credential, "OpenAI model identity discovery", 60);
    let close: (() => void) | undefined;
    let abortCode: (() => "PROVIDER_CANCELED" | "PROVIDER_TIMEOUT" | undefined) | undefined;
    try {
      const handle = await openProviderResponse({
        providerId: this.id,
        url: OPENAI_MODELS_URL,
        fetch: this.#fetch,
        init: {method: "GET", headers: {authorization: `Bearer ${lease.value}`}},
        signal,
        limits: this.#limits,
      });
      close = handle.close;
      abortCode = handle.abortCode;
      const body = await readBoundedJson(this.id, handle.response, this.#limits.maxResponseBytes);
      const data = body.data;
      if (!Array.isArray(data) || data.length > 10_000) throw protocolError(this.id, "model list has invalid data");
      const modelIds = new Set<string>();
      for (const item of data) {
        if (!isRecord(item) || !validModelId(item.id)) throw protocolError(this.id, "model list contains an invalid identity");
        modelIds.add(item.id);
      }
      return Object.freeze([...modelIds].sort().map((modelId) => descriptorFromCatalog(this.id, modelId, this.#catalog)));
    } catch (error) {
      throw normalizeProviderFailure(this.id, signal, error, abortCode?.());
    } finally {
      close?.();
      lease.value = "";
    }
  }

  public async *stream(request: ModelRequest, signal: AbortSignal): AsyncGenerator<NormalizedModelFrame> {
    validateModelRequest(request);
    const lease = await this.#secretBroker.resolve(this.#credential, `OpenAI response ${request.requestId}`, 60);
    let close: (() => void) | undefined;
    let abortCode: (() => "PROVIDER_CANCELED" | "PROVIDER_TIMEOUT" | undefined) | undefined;
    try {
      const body = JSON.stringify(openAiRequestBody(request));
      const handle = await openProviderResponse({
        providerId: this.id,
        url: OPENAI_RESPONSES_URL,
        fetch: this.#fetch,
        init: {
          method: "POST",
          headers: {"content-type": "application/json", authorization: `Bearer ${lease.value}`},
          body,
        },
        signal,
        limits: this.#limits,
      });
      close = handle.close;
      abortCode = handle.abortCode;
      let providerRequestId = boundedString(handle.response.headers.get("x-request-id")) ?? "UNKNOWN";
      let resolvedModel = request.modelId;
      let completed = false;
      const pending = new Map<string, PendingFunctionCall>();
      const emitted = new Set<string>();

      for await (const envelope of parseSse(this.id, handle.response, this.#limits)) {
        if (envelope.data === "" || envelope.data === "[DONE]") continue;
        const event = parseProviderEvent(this.id, envelope.data);
        const type = stringField(event, "type");
        if (envelope.event === "error" || type === "error" || type === "response.failed" || type === "response.incomplete") {
          throw protocolError(this.id, "provider reported a stream failure");
        }
        if (type === "response.created") {
          const response = recordField(event, "response");
          providerRequestId = boundedString(response?.id) ?? providerRequestId;
          resolvedModel = boundedString(response?.model) ?? resolvedModel;
          continue;
        }
        if (type === "response.output_text.delta") {
          const text = boundedString(event.delta, 256 * 1024, true);
          if (text === undefined) throw protocolError(this.id, "text delta is malformed");
          yield Object.freeze({type: "text-delta", text});
          continue;
        }
        if (type === "response.output_item.added") {
          const item = recordField(event, "item");
          if (item?.type === "function_call") rememberOpenAiToolCall(pending, item, event);
          continue;
        }
        if (type === "response.function_call_arguments.delta") {
          const key = toolEventKey(event);
          const delta = boundedString(event.delta, this.#limits.maxFrameBytes, true);
          if (!key || delta === undefined) throw protocolError(this.id, "function argument delta is malformed");
          const current = pending.get(key) ?? {
            callId: boundedString(event.call_id) ?? key,
            name: boundedString(event.name) ?? "UNKNOWN",
            argumentsText: "",
          };
          current.argumentsText += delta;
          if (Buffer.byteLength(current.argumentsText) > this.#limits.maxFrameBytes) {
            throw new ProviderGatewayError("PROVIDER_RESPONSE_TOO_LARGE", this.id, "provider openai tool arguments exceed their size limit");
          }
          pending.set(key, current);
          continue;
        }
        if (type === "response.function_call_arguments.done") {
          const key = toolEventKey(event);
          if (!key) throw protocolError(this.id, "completed function arguments have no identity");
          const current = pending.get(key) ?? {
            callId: boundedString(event.call_id) ?? key,
            name: boundedString(event.name) ?? "UNKNOWN",
            argumentsText: "",
          };
          current.argumentsText = boundedString(event.arguments, this.#limits.maxFrameBytes, true) ?? current.argumentsText;
          pending.set(key, current);
          const frame = finalizeToolCall(this.id, current);
          if (!emitted.has(frame.callId)) {
            emitted.add(frame.callId);
            yield Object.freeze({type: "tool-call", ...frame});
          }
          continue;
        }
        if (type === "response.output_item.done") {
          const item = recordField(event, "item");
          if (item?.type === "function_call") {
            const key = rememberOpenAiToolCall(pending, item, event);
            const current = pending.get(key);
            if (!current) throw protocolError(this.id, "function call is malformed");
            const frame = finalizeToolCall(this.id, current);
            if (!emitted.has(frame.callId)) {
              emitted.add(frame.callId);
              yield Object.freeze({type: "tool-call", ...frame});
            }
          }
          continue;
        }
        if (type === "response.completed") {
          const response = recordField(event, "response");
          if (!response) throw protocolError(this.id, "completed response is malformed");
          providerRequestId = boundedString(response.id) ?? providerRequestId;
          resolvedModel = boundedString(response.model) ?? resolvedModel;
          for (const current of pending.values()) {
            const frame = finalizeToolCall(this.id, current);
            if (!emitted.has(frame.callId)) {
              emitted.add(frame.callId);
              yield Object.freeze({type: "tool-call", ...frame});
            }
          }
          yield Object.freeze({type: "usage", usage: openAiUsage(recordField(response, "usage"))});
          yield Object.freeze({
            type: "completed",
            providerRequestId,
            resolvedModel,
            stopReason: boundedString(response.status) ?? "completed",
          });
          completed = true;
          continue;
        }
        // Forward compatibility: unknown event types do not mutate state.
      }
      if (!completed) throw protocolError(this.id, "stream ended before response.completed");
    } catch (error) {
      throw normalizeProviderFailure(this.id, signal, error, abortCode?.());
    } finally {
      close?.();
      lease.value = "";
    }
  }

  public complete(request: ModelRequest, signal: AbortSignal): Promise<ModelResult> {
    return collectModelFrames(this.id, request, this.stream(request, signal));
  }
}

function openAiRequestBody(request: ModelRequest): Record<string, unknown> {
  return {
    model: request.modelId,
    input: openAiInput(request),
    max_output_tokens: request.maxOutputTokens,
    stream: true,
    ...(request.providerContinuationId === undefined ? {} : {previous_response_id: request.providerContinuationId}),
    ...(request.tools === undefined ? {} : {
      tools: request.tools.map((tool) => ({
        type: "function",
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
        strict: true,
      })),
    }),
    ...(request.structuredOutput === undefined ? {} : {
      text: {format: {
        type: "json_schema",
        name: request.structuredOutput.name ?? "software_agent_output",
        schema: request.structuredOutput.schema,
        strict: request.structuredOutput.strict ?? true,
      }},
    }),
    ...(request.reasoningEffort === undefined ? {} : {reasoning: {effort: request.reasoningEffort}}),
  };
}

function openAiInput(request: ModelRequest): readonly Record<string, unknown>[] {
  const input: Record<string, unknown>[] = [];
  if (request.system !== "") input.push({role: "system", content: request.system});
  const messages = request.messages ?? [{role: "user" as const, content: request.input}];
  for (const message of messages) {
    if (message.role === "tool") {
      if (!message.toolCallId) throw new Error("legacy tool messages require toolCallId");
      input.push({type: "function_call_output", call_id: message.toolCallId, output: message.content});
      continue;
    }
    if (message.content !== "") input.push({role: message.role, content: message.content});
    for (const call of message.toolCalls ?? []) {
      if (message.role !== "assistant") throw new Error("only assistant messages may contain tool calls");
      input.push({
        type: "function_call",
        call_id: call.callId,
        name: call.name,
        arguments: typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments),
      });
    }
  }
  for (const result of request.toolResults ?? []) {
    validateToolResult(result.callId, result.content);
    input.push({
      type: "function_call_output",
      call_id: result.callId,
      output: result.isError === true ? `[tool_error]\n${result.content}` : result.content,
    });
  }
  return input;
}

function rememberOpenAiToolCall(
  pending: Map<string, PendingFunctionCall>,
  item: Record<string, unknown>,
  event: Record<string, unknown>,
): string {
  const key = boundedString(item.id) ?? boundedString(event.item_id) ?? boundedString(item.call_id) ?? boundedString(event.call_id);
  const callId = boundedString(item.call_id) ?? boundedString(event.call_id) ?? key;
  const name = boundedString(item.name) ?? boundedString(event.name);
  if (!key || !callId || !name) throw protocolError("openai", "function call identity is malformed");
  try {
    validateToolCallId(callId);
    validateToolName(name);
  } catch {
    throw protocolError("openai", "function call identity is malformed");
  }
  const current = pending.get(key) ?? {callId, name, argumentsText: ""};
  current.callId = callId;
  current.name = name;
  current.argumentsText = boundedString(item.arguments, 256 * 1024, true) ?? current.argumentsText;
  pending.set(key, current);
  return key;
}

function toolEventKey(event: Record<string, unknown>): string | undefined {
  return boundedString(event.item_id) ?? boundedString(event.call_id) ?? integerField(event, "output_index")?.toString();
}

function finalizeToolCall(providerId: string, pending: PendingFunctionCall): ModelToolCall {
  if (pending.name === "UNKNOWN") throw protocolError(providerId, "function call name is unavailable");
  let argumentsValue: unknown;
  try {
    argumentsValue = JSON.parse(pending.argumentsText === "" ? "{}" : pending.argumentsText);
  } catch {
    throw protocolError(providerId, "function call arguments are malformed");
  }
  if (!isRecord(argumentsValue)) throw protocolError(providerId, "function call arguments are malformed");
  return Object.freeze({callId: pending.callId, name: pending.name, arguments: argumentsValue});
}

function openAiUsage(usage: Record<string, unknown> | undefined): NormalizedModelUsage {
  const input = tokenField(usage, "input_tokens");
  const output = tokenField(usage, "output_tokens");
  const total = tokenField(usage, "total_tokens");
  return Object.freeze({
    inputTokens: input,
    outputTokens: output,
    cachedInputTokens: tokenField(recordField(usage, "input_tokens_details"), "cached_tokens"),
    reasoningTokens: tokenField(recordField(usage, "output_tokens_details"), "reasoning_tokens"),
    totalTokens: total,
    source: input === "UNKNOWN" && output === "UNKNOWN" && total === "UNKNOWN" ? "UNKNOWN" : "PROVIDER",
  });
}

function validateCatalog(catalog: ModelCapabilityCatalog | undefined, providerId: string): ModelCapabilityCatalog | undefined {
  if (catalog && catalog.providerId !== providerId) throw new Error(`catalog provider must be ${providerId}`);
  return catalog;
}

function validModelId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 256 && !hasControlCharacters(value);
}

function validateModelRequest(request: ModelRequest): void {
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

function normalizeProviderFailure(
  providerId: string,
  signal: AbortSignal,
  error: unknown,
  abortCode: "PROVIDER_CANCELED" | "PROVIDER_TIMEOUT" | undefined,
): Error {
  if (error instanceof ProviderGatewayError) return error;
  if (abortCode === "PROVIDER_TIMEOUT") return new ProviderGatewayError(abortCode, providerId, `provider ${providerId} request timed out`);
  if (abortCode === "PROVIDER_CANCELED") return new ProviderGatewayError(abortCode, providerId, `provider ${providerId} request was canceled`);
  if (signal.aborted) return new ProviderGatewayError("PROVIDER_CANCELED", providerId, `provider ${providerId} request was canceled`);
  return new ProviderGatewayError("PROVIDER_PROTOCOL_ERROR", providerId, `provider ${providerId} stream failed validation`);
}

function protocolError(providerId: string, detail: string): ProviderGatewayError {
  return new ProviderGatewayError("PROVIDER_PROTOCOL_ERROR", providerId, `provider ${providerId} ${detail}`);
}

function boundedString(value: unknown, maximum = 512, allowTextWhitespace = false): string | undefined {
  return typeof value === "string" && value.length <= maximum && !hasControlCharacters(value, allowTextWhitespace)
    ? value
    : undefined;
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  return boundedString(value[key]);
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

export function clearSecretLease(lease: SecretLease): void {
  lease.value = "";
}
