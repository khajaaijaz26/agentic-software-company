import {createHash} from "node:crypto";

const SECRET_KEY = /(?:^|_)(?:api_key|authorization|credential|password|private_key|secret|token|access_token|refresh_token|id_token)(?:$|_)/u;
const SECRET_VALUE = /(?:\b(?:gh[oprsu]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|sbp_[A-Za-z0-9]{16,}|AKIA[A-Z0-9]{16}|Bearer\s+[A-Za-z0-9._~+/-]+=*)\b|\b(?:api[_-]?key|password|secret|token)\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{8,})/giu;
const CONTROL = new RegExp(String.raw`[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]`, "gu");

export function sha256(value: string | Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function sanitizeTerminal(value: string, maxLength = 16_384): string {
  const normalized = value
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\\r")
    .replace(CONTROL, (character) => {
      const point = character.codePointAt(0);
      return `\\u${point === undefined ? "0000" : point.toString(16).padStart(4, "0")}`;
    })
    .replace(SECRET_VALUE, "[REDACTED]");
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, maxLength)}\n…[output truncated]`;
}

export function redact<T>(value: T): T {
  return redactValue(value, new WeakSet<object>()) as T;
}

function redactValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") {
    return sanitizeTerminal(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, seen));
  }
  if (value !== null && typeof value === "object") {
    if (seen.has(value)) {
      return "[CIRCULAR]";
    }
    seen.add(value);
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        isSecretKey(key) ? "[REDACTED]" : redactValue(item, seen),
      ]),
    );
  }
  return value;
}

function isSecretKey(key: string): boolean {
  const normalized = key.replace(/([a-z0-9])([A-Z])/gu, "$1_$2").replaceAll("-", "_").toLowerCase();
  if (/(?:^|_)(?:input|output|total)_tokens$|(?:^|_)token_count$/u.test(normalized)) return false;
  return SECRET_KEY.test(normalized);
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  return typeof encoded === "string" ? encoded : "null";
}
