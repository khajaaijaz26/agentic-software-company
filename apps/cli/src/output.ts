import {sanitizeTerminal} from "../../../packages/observability/src/index.js";

export const EXIT_CODES = {
  SUCCESS: 0,
  USAGE: 2,
  POLICY_DENIED: 3,
  APPROVAL_REQUIRED: 4,
  AUTH_REQUIRED: 5,
  CAPABILITY_UNAVAILABLE: 6,
  TRANSIENT_FAILURE: 7,
  ACTION_FAILED: 8,
  PARTIAL: 9,
  RECONCILIATION_REQUIRED: 10,
  CANCELED: 11,
} as const;

export interface OutputMode {
  readonly json: boolean;
  readonly ndjson: boolean;
  readonly plain: boolean;
}

export interface Io {
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
}

export const processIo: Io = {
  stdout: (value) => process.stdout.write(value),
  stderr: (value) => process.stderr.write(value),
};

export function emit(io: Io, mode: OutputMode, type: string, data: unknown): void {
  if (mode.json || mode.ndjson) {
    io.stdout(`${JSON.stringify({schema: "agent-company.output/v1", type, data})}\n`);
    return;
  }
  if (typeof data === "string") {
    io.stdout(`${sanitizeTerminal(data)}\n`);
    return;
  }
  io.stdout(`${formatHuman(data)}\n`);
}

export function emitError(io: Io, mode: OutputMode, code: string, message: string, next?: string): void {
  const data = {code, message: sanitizeTerminal(message), ...(next ? {next} : {})};
  if (mode.json || mode.ndjson) {
    io.stdout(`${JSON.stringify({schema: "agent-company.error/v1", type: "error", data})}\n`);
  } else {
    io.stderr(`Error [${code}]: ${data.message}${next ? `\nNext: ${next}` : ""}\n`);
  }
}

function formatHuman(data: unknown, indent = 0): string {
  if (data === null || data === undefined) return String(data);
  if (typeof data !== "object") return sanitizeTerminal(formatScalar(data));
  if (Array.isArray(data)) return data.map((item) => formatHuman(item, indent)).join("\n");
  return Object.entries(data as Record<string, unknown>).map(([key, value]) => {
    if (value !== null && typeof value === "object") {
      const child = formatHuman(value, indent + 2).split("\n").map((line) => `${" ".repeat(indent + 2)}${line}`).join("\n");
      return `${" ".repeat(indent)}${key}:\n${child}`;
    }
    return `${" ".repeat(indent)}${key}: ${sanitizeTerminal(formatScalar(value))}`;
  }).join("\n");
}

function formatScalar(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return value.toString();
  if (typeof value === "symbol") return value.description ?? "symbol";
  const encoded = JSON.stringify(value);
  return typeof encoded === "string" ? encoded : "[unprintable]";
}
