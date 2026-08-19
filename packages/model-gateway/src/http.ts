import {hasControlCharacters, type FetchLike} from "./types.js";

export type ProviderErrorCode =
  | "PROVIDER_CANCELED"
  | "PROVIDER_HTTP_ERROR"
  | "PROVIDER_PROTOCOL_ERROR"
  | "PROVIDER_REDIRECT_REJECTED"
  | "PROVIDER_RESPONSE_TOO_LARGE"
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_TRANSPORT_ERROR";

export class ProviderGatewayError extends Error {
  public constructor(
    public readonly code: ProviderErrorCode,
    public readonly providerId: string,
    message: string,
    public readonly status?: number,
    public readonly requestId?: string,
    public readonly retryAfter?: string,
  ) {
    super(message);
    this.name = "ProviderGatewayError";
  }
}

export interface ProviderHttpLimits {
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  readonly maxFrameBytes: number;
  readonly maxRequestBytes: number;
}

export const DEFAULT_HTTP_LIMITS: ProviderHttpLimits = Object.freeze({
  timeoutMs: 60_000,
  maxResponseBytes: 2 * 1024 * 1024,
  maxFrameBytes: 256 * 1024,
  maxRequestBytes: 2 * 1024 * 1024,
});

export interface OpenProviderResponseOptions {
  readonly providerId: string;
  readonly url: URL;
  readonly fetch: FetchLike;
  readonly init: RequestInit;
  readonly signal: AbortSignal;
  readonly limits: ProviderHttpLimits;
}

export interface ProviderResponseHandle {
  readonly response: Response;
  readonly signal: AbortSignal;
  readonly close: () => void;
  readonly abortCode: () => "PROVIDER_CANCELED" | "PROVIDER_TIMEOUT" | undefined;
}

export interface SseEvent {
  readonly event: string | undefined;
  readonly data: string;
}

export function providerHttpLimits(options: {
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly maxFrameBytes?: number;
  readonly maxRequestBytes?: number;
}): ProviderHttpLimits {
  return Object.freeze({
    timeoutMs: positiveLimit(options.timeoutMs ?? DEFAULT_HTTP_LIMITS.timeoutMs, "provider timeout", 10 * 60_000),
    maxResponseBytes: positiveLimit(options.maxResponseBytes ?? DEFAULT_HTTP_LIMITS.maxResponseBytes, "provider response limit", 64 * 1024 * 1024),
    maxFrameBytes: positiveLimit(options.maxFrameBytes ?? DEFAULT_HTTP_LIMITS.maxFrameBytes, "provider frame limit", 8 * 1024 * 1024),
    maxRequestBytes: positiveLimit(options.maxRequestBytes ?? DEFAULT_HTTP_LIMITS.maxRequestBytes, "provider request limit", 64 * 1024 * 1024),
  });
}

export async function openProviderResponse(options: OpenProviderResponseOptions): Promise<ProviderResponseHandle> {
  if (options.signal.aborted) {
    throw new ProviderGatewayError("PROVIDER_CANCELED", options.providerId, `provider ${options.providerId} request was canceled`);
  }
  const bodyBytes = typeof options.init.body === "string" ? Buffer.byteLength(options.init.body) : 0;
  if (bodyBytes > options.limits.maxRequestBytes) {
    throw new ProviderGatewayError("PROVIDER_PROTOCOL_ERROR", options.providerId, `provider ${options.providerId} request exceeds its size limit`);
  }
  const controller = new AbortController();
  const state = {timedOut: false};
  const cancel = () => controller.abort();
  options.signal.addEventListener("abort", cancel, {once: true});
  const timeout = setTimeout(() => {
    state.timedOut = true;
    controller.abort();
  }, options.limits.timeoutMs);
  timeout.unref();
  const close = () => {
    clearTimeout(timeout);
    options.signal.removeEventListener("abort", cancel);
  };
  let response: Response;
  try {
    response = await options.fetch(options.url, {...options.init, redirect: "error", signal: controller.signal});
  } catch {
    close();
    if (state.timedOut) throw new ProviderGatewayError("PROVIDER_TIMEOUT", options.providerId, `provider ${options.providerId} request timed out`);
    if (isSignalAborted(options.signal)) throw new ProviderGatewayError("PROVIDER_CANCELED", options.providerId, `provider ${options.providerId} request was canceled`);
    throw new ProviderGatewayError("PROVIDER_TRANSPORT_ERROR", options.providerId, `provider ${options.providerId} transport failed`);
  }
  const requestId = boundedHeader(response.headers.get("x-request-id") ?? response.headers.get("request-id"));
  if (response.redirected || (response.url !== "" && new URL(response.url).origin !== options.url.origin) || response.status >= 300 && response.status < 400) {
    close();
    throw new ProviderGatewayError(
      "PROVIDER_REDIRECT_REJECTED",
      options.providerId,
      `provider ${options.providerId} redirect was rejected`,
      response.status,
      requestId,
    );
  }
  if (!response.ok) {
    close();
    throw new ProviderGatewayError(
      "PROVIDER_HTTP_ERROR",
      options.providerId,
      `provider ${options.providerId} returned HTTP ${response.status}`,
      response.status,
      requestId,
      boundedHeader(response.headers.get("retry-after")),
    );
  }
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && /^\d+$/u.test(contentLength) && Number(contentLength) > options.limits.maxResponseBytes) {
    close();
    throw new ProviderGatewayError(
      "PROVIDER_RESPONSE_TOO_LARGE",
      options.providerId,
      `provider ${options.providerId} response exceeds its size limit`,
      response.status,
      requestId,
    );
  }
  return {
    response,
    signal: controller.signal,
    close,
    abortCode: () => state.timedOut ? "PROVIDER_TIMEOUT" : isSignalAborted(options.signal) ? "PROVIDER_CANCELED" : undefined,
  };
}

export async function readBoundedJson(
  providerId: string,
  response: Response,
  maxBytes: number,
): Promise<Record<string, unknown>> {
  const text = await readBoundedText(providerId, response, maxBytes);
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) throw new Error("not an object");
    return parsed;
  } catch {
    throw new ProviderGatewayError("PROVIDER_PROTOCOL_ERROR", providerId, `provider ${providerId} returned malformed JSON`);
  }
}

export async function* parseSse(
  providerId: string,
  response: Response,
  limits: ProviderHttpLimits,
): AsyncGenerator<SseEvent> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("text/event-stream")) {
    throw new ProviderGatewayError("PROVIDER_PROTOCOL_ERROR", providerId, `provider ${providerId} did not return an event stream`);
  }
  if (!response.body) throw new ProviderGatewayError("PROVIDER_PROTOCOL_ERROR", providerId, `provider ${providerId} returned an empty stream`);
  const reader: ReadableStreamDefaultReader<Uint8Array> = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder("utf8", {fatal: true});
  let buffered = "";
  let totalBytes = 0;
  try {
    let streamDone = false;
    while (!streamDone) {
      const next = await reader.read();
      if (next.done) {
        streamDone = true;
        continue;
      }
      const value = next.value;
      totalBytes += value.byteLength;
      if (totalBytes > limits.maxResponseBytes) {
        throw new ProviderGatewayError("PROVIDER_RESPONSE_TOO_LARGE", providerId, `provider ${providerId} response exceeds its size limit`);
      }
      try {
        buffered += decoder.decode(value, {stream: true});
      } catch {
        throw new ProviderGatewayError("PROVIDER_PROTOCOL_ERROR", providerId, `provider ${providerId} stream is not valid UTF-8`);
      }
      let boundary = eventBoundary(buffered);
      while (boundary) {
        const raw = buffered.slice(0, boundary.index);
        buffered = buffered.slice(boundary.index + boundary.length);
        yield parseSseEvent(providerId, raw, limits.maxFrameBytes);
        boundary = eventBoundary(buffered);
      }
      if (Buffer.byteLength(buffered) > limits.maxFrameBytes) {
        throw new ProviderGatewayError("PROVIDER_RESPONSE_TOO_LARGE", providerId, `provider ${providerId} stream frame exceeds its size limit`);
      }
    }
    try {
      buffered += decoder.decode();
    } catch {
      throw new ProviderGatewayError("PROVIDER_PROTOCOL_ERROR", providerId, `provider ${providerId} stream is not valid UTF-8`);
    }
    if (buffered.trim() !== "") yield parseSseEvent(providerId, buffered, limits.maxFrameBytes);
  } finally {
    reader.releaseLock();
  }
}

export function parseProviderEvent(providerId: string, data: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(data);
    if (!isRecord(value)) throw new Error("not an object");
    return value;
  } catch {
    throw new ProviderGatewayError("PROVIDER_PROTOCOL_ERROR", providerId, `provider ${providerId} returned a malformed stream event`);
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readBoundedText(providerId: string, response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader: ReadableStreamDefaultReader<Uint8Array> = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder("utf8", {fatal: true});
  let bytes = 0;
  let result = "";
  try {
    let streamDone = false;
    while (!streamDone) {
      const next = await reader.read();
      if (next.done) {
        streamDone = true;
        continue;
      }
      const value = next.value;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        throw new ProviderGatewayError("PROVIDER_RESPONSE_TOO_LARGE", providerId, `provider ${providerId} response exceeds its size limit`);
      }
      try {
        result += decoder.decode(value, {stream: true});
      } catch {
        throw new ProviderGatewayError("PROVIDER_PROTOCOL_ERROR", providerId, `provider ${providerId} response is not valid UTF-8`);
      }
    }
    return result + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function parseSseEvent(providerId: string, raw: string, maxFrameBytes: number): SseEvent {
  if (Buffer.byteLength(raw) > maxFrameBytes) {
    throw new ProviderGatewayError("PROVIDER_RESPONSE_TOO_LARGE", providerId, `provider ${providerId} stream frame exceeds its size limit`);
  }
  let event: string | undefined;
  const data: string[] = [];
  for (const line of raw.split(/\r?\n/u)) {
    if (line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  return Object.freeze({event, data: data.join("\n")});
}

function eventBoundary(value: string): {index: number; length: number} | undefined {
  const unix = value.indexOf("\n\n");
  const windows = value.indexOf("\r\n\r\n");
  if (unix < 0 && windows < 0) return undefined;
  if (windows >= 0 && (unix < 0 || windows < unix)) return {index: windows, length: 4};
  return {index: unix, length: 2};
}

function boundedHeader(value: string | null): string | undefined {
  if (value === null) return undefined;
  let sanitized = "";
  for (const character of value) {
    if (!hasControlCharacters(character)) sanitized += character;
    if (sanitized.length >= 256) break;
  }
  return sanitized === "" ? undefined : sanitized;
}

function positiveLimit(value: number, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`${name} is out of range`);
  return value;
}

function isSignalAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}
