import {spawn} from "node:child_process";
import {randomUUID} from "node:crypto";
import {z} from "zod";
import {sanitizeTerminal, sha256, stableJson} from "../../observability/src/index.js";

export const ConnectorRiskClassSchema = z.enum([
  "A0_OBSERVE",
  "A1_LOCAL_REVERSIBLE",
  "A2_REMOTE_REVERSIBLE",
  "A3_SHARED_MUTATION",
  "A4_PRODUCTION_OR_SECURITY",
  "A5_DESTRUCTIVE_OR_IRREVERSIBLE",
]);

export type ConnectorRiskClass = z.infer<typeof ConnectorRiskClassSchema>;

export const NormalizedConnectorActionSchema = z.object({
  schema: z.literal("agent-company.connector-action/v1"),
  actionId: z.string(),
  operationId: z.string(),
  connectorId: z.string(),
  connectionId: z.string(),
  capability: z.string(),
  targetRef: z.string(),
  providerIds: z.record(z.string(), z.string()),
  environment: z.string(),
  arguments: z.record(z.string(), z.unknown()),
  preconditions: z.array(z.record(z.string(), z.unknown())),
  risk: z.object({class: ConnectorRiskClassSchema}),
  operationHash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  createdAt: z.iso.datetime(),
});

export type NormalizedConnectorAction = z.infer<typeof NormalizedConnectorActionSchema>;

export interface ConnectorManifest {
  readonly schema: "agent-company.connector-manifest/v1";
  readonly id: string;
  readonly displayName: string;
  readonly version: string;
  readonly executable: string;
  readonly capabilities: readonly string[];
  readonly authMethods: readonly string[];
  readonly testedVersions: string;
}

export interface ConnectorProbe {
  readonly connectorId: string;
  readonly state: "CONNECTED" | "AUTH_REQUIRED" | "UNAVAILABLE" | "DEGRADED";
  readonly version?: string;
  readonly account?: string;
  readonly details: readonly string[];
}

export interface ConnectorInventory {
  readonly connectorId: string;
  readonly resources: readonly Record<string, unknown>[];
  readonly observedAt: string;
}

export interface Connector {
  readonly manifest: ConnectorManifest;
  probe(): Promise<ConnectorProbe>;
  inventory(): Promise<ConnectorInventory>;
}

export function createAction(input: {
  readonly connectorId: string;
  readonly connectionId?: string;
  readonly capability: string;
  readonly targetRef: string;
  readonly providerIds?: Readonly<Record<string, string>>;
  readonly environment?: string;
  readonly arguments?: Readonly<Record<string, unknown>>;
  readonly preconditions?: ReadonlyArray<Readonly<Record<string, unknown>>>;
  readonly risk?: ConnectorRiskClass;
}): NormalizedConnectorAction {
  const environment = input.environment ?? "local";
  enforceHardDenials(input.connectorId, input.capability, environment);
  const classifiedRisk = classifyAction(input.connectorId, input.capability, environment);
  const risk = input.risk === undefined ? classifiedRisk : higherRisk(classifiedRisk, input.risk);
  const operationId = `op_${randomUUID().replaceAll("-", "")}`;
  const hashInput = {
    connectorId: input.connectorId,
    capability: input.capability,
    targetRef: input.targetRef,
    providerIds: input.providerIds ?? {},
    environment,
    arguments: input.arguments ?? {},
    preconditions: input.preconditions ?? [],
    risk,
  };
  return NormalizedConnectorActionSchema.parse({
    schema: "agent-company.connector-action/v1",
    actionId: `act_${randomUUID().replaceAll("-", "")}`,
    operationId,
    connectorId: input.connectorId,
    connectionId: input.connectionId ?? `${input.connectorId}:cli-session`,
    capability: input.capability,
    targetRef: input.targetRef,
    providerIds: input.providerIds ?? {},
    environment,
    arguments: input.arguments ?? {},
    preconditions: input.preconditions ?? [],
    risk: {class: risk},
    operationHash: sha256(stableJson(hashInput)),
    createdAt: new Date().toISOString(),
  });
}

export function classifyAction(connectorId: string, capability: string, environment: string): ConnectorRiskClass {
  const value = `${connectorId}:${capability}`.toLowerCase();
  if (/list|read|inspect|status|inventory|logs|diff|checks|compare|show|test/u.test(value)) return "A0_OBSERVE";
  if (/delete|reset|seed|force|destroy/u.test(value)) return "A5_DESTRUCTIVE_OR_IRREVERSIBLE";
  if (environment.toLowerCase() === "production" || /production|secret|domain|rollback|promote/u.test(value)) {
    return "A4_PRODUCTION_OR_SECURITY";
  }
  if (/local|branch:create|artifact:export/u.test(value)) return "A1_LOCAL_REVERSIBLE";
  if (/preview|comment|branch:push|webhook:test/u.test(value)) return "A2_REMOTE_REVERSIBLE";
  if (/pull-request|pr:|environment:set|edge:deploy|migration:staging/u.test(value)) return "A3_SHARED_MUTATION";
  return "A3_SHARED_MUTATION";
}

export function enforceHardDenials(connectorId: string, capability: string, environment: string): void {
  const value = `${connectorId}:${capability}:${environment}`.toLowerCase();
  if (connectorId.toLowerCase() === "supabase" && environment.toLowerCase() === "production" && /reset|seed/iu.test(capability)) {
    throw new ConnectorPolicyError("HARD_DENY_PRODUCTION_DATABASE_RESET", "production Supabase reset/seed is hard denied");
  }
  if (connectorId.toLowerCase() === "supabase" && environment.toLowerCase() === "production" && /secret.*copy|copy.*secret/iu.test(capability)) {
    throw new ConnectorPolicyError("HARD_DENY_PRODUCTION_SECRET_COPY", "copying secrets into production is hard denied");
  }
  if (/force-push.*protected|protected.*force-push/u.test(value)) {
    throw new ConnectorPolicyError("HARD_DENY_PROTECTED_FORCE_PUSH", "force pushing a protected branch is hard denied");
  }
}

function higherRisk(left: ConnectorRiskClass, right: ConnectorRiskClass): ConnectorRiskClass {
  const ordered: readonly ConnectorRiskClass[] = [
    "A0_OBSERVE",
    "A1_LOCAL_REVERSIBLE",
    "A2_REMOTE_REVERSIBLE",
    "A3_SHARED_MUTATION",
    "A4_PRODUCTION_OR_SECURITY",
    "A5_DESTRUCTIVE_OR_IRREVERSIBLE",
  ];
  const result = ordered[Math.max(ordered.indexOf(left), ordered.indexOf(right))];
  if (result === undefined) throw new TypeError("unknown connector risk class");
  return result;
}

export class ConnectorPolicyError extends Error {
  public constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "ConnectorPolicyError";
  }
}

export interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export async function runConnectorCli(
  executable: string,
  args: readonly string[],
  options: {readonly cwd?: string; readonly timeoutMs?: number; readonly maxBytes?: number} = {},
): Promise<CliResult> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxBytes = options.maxBytes ?? 1_048_576;
  const environment = minimalEnvironment(process.env);
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, [...args], {
      cwd: options.cwd,
      env: environment,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes <= maxBytes) stdout.push(chunk);
      if (bytes > maxBytes) child.kill("SIGTERM");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes <= maxBytes) stderr.push(chunk);
      if (bytes > maxBytes) child.kill("SIGTERM");
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (exitCode) => {
      clearTimeout(timer);
      resolvePromise({
        exitCode: exitCode ?? 1,
        stdout: sanitizeTerminal(Buffer.concat(stdout).toString("utf8")),
        stderr: sanitizeTerminal(Buffer.concat(stderr).toString("utf8")),
        timedOut,
      });
    });
  });
}

function minimalEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = [
    "PATH", "Path", "PATHEXT", "SystemRoot", "COMSPEC", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
    "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "TMP", "TEMP", "NO_COLOR", "TERM",
    "GH_CONFIG_DIR", "GH_HOST", "VERCEL_ORG_ID", "VERCEL_PROJECT_ID", "SUPABASE_ACCESS_TOKEN",
  ];
  return Object.fromEntries(allowed.flatMap((key) => source[key] === undefined ? [] : [[key, source[key]]]));
}
