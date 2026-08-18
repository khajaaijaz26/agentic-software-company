import {randomUUID} from "node:crypto";
import {realpath} from "node:fs/promises";
import {isAbsolute, relative, resolve, sep} from "node:path";
import type {ZodType} from "zod";
import {sanitizeTerminal} from "../../observability/src/index.js";
import type {ConnectorRiskClass} from "../../connectors/src/index.js";

export interface ToolContext {
  readonly actorId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly workspace: string;
  readonly environment: string;
  readonly allowedHosts: readonly string[];
}

export interface ToolManifest<TInput, TOutput> {
  readonly name: string;
  readonly operation: string;
  readonly risk: ConnectorRiskClass;
  readonly input: ZodType<TInput>;
  readonly execute: (input: TInput, context: ToolContext, signal: AbortSignal) => Promise<TOutput>;
}

export interface ToolApproval {
  readonly approvalId: string;
  readonly token: string;
  readonly operationHash: string;
}

export interface ToolApprovalConsumer {
  consume(input: {
    readonly approval: ToolApproval;
    readonly actorId: string;
    readonly operation: string;
    readonly resource: string;
    readonly environment: string;
    readonly operationHash: string;
  }): Promise<void>;
}

export interface ToolAuditEvent {
  readonly eventId: string;
  readonly type: "tool.started" | "tool.completed" | "tool.denied" | "tool.failed";
  readonly tool: string;
  readonly operation: string;
  readonly actorId: string;
  readonly taskId: string;
  readonly at: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export class ToolGateway {
  readonly #tools = new Map<string, ToolManifest<unknown, unknown>>();

  public constructor(
    private readonly approvals?: ToolApprovalConsumer,
    private readonly audit: (event: ToolAuditEvent) => Promise<void> = () => Promise.resolve(),
  ) {}

  public register<TInput, TOutput>(manifest: ToolManifest<TInput, TOutput>): void {
    if (this.#tools.has(manifest.name)) throw new Error(`tool ${manifest.name} is already registered`);
    this.#tools.set(manifest.name, manifest as ToolManifest<unknown, unknown>);
  }

  public async call<TOutput>(input: {
    readonly name: string;
    readonly arguments: unknown;
    readonly context: ToolContext;
    readonly operationHash: string;
    readonly resource: string;
    readonly approval?: ToolApproval;
    readonly signal?: AbortSignal;
  }): Promise<TOutput> {
    const tool = this.#tools.get(input.name);
    if (!tool) throw new ToolGatewayError("UNKNOWN_TOOL", `unknown tool: ${input.name}`);
    const parsed = tool.input.safeParse(input.arguments);
    if (!parsed.success) throw new ToolGatewayError("INVALID_TOOL_INPUT", parsed.error.message);
    const policyFailure = deterministicGuard(tool, parsed.data, input.context);
    if (policyFailure) {
      await this.#record("tool.denied", tool, input.context, {code: policyFailure.code, reason: policyFailure.message});
      throw policyFailure;
    }
    if (requiresApproval(tool.risk)) {
      if (!input.approval || !this.approvals) {
        await this.#record("tool.denied", tool, input.context, {code: "APPROVAL_REQUIRED"});
        throw new ToolGatewayError("APPROVAL_REQUIRED", `${tool.operation} requires an exact approval`);
      }
      await this.approvals.consume({
        approval: input.approval,
        actorId: input.context.actorId,
        operation: tool.operation,
        resource: input.resource,
        environment: input.context.environment,
        operationHash: input.operationHash,
      });
    }
    await this.#record("tool.started", tool, input.context, {resource: sanitizeTerminal(input.resource)});
    try {
      const output = await tool.execute(parsed.data, input.context, input.signal ?? new AbortController().signal);
      await this.#record("tool.completed", tool, input.context, {resource: sanitizeTerminal(input.resource)});
      return output as TOutput;
    } catch (error) {
      await this.#record("tool.failed", tool, input.context, {error: sanitizeTerminal(String(error))});
      throw error;
    }
  }

  async #record(
    type: ToolAuditEvent["type"],
    tool: ToolManifest<unknown, unknown>,
    context: ToolContext,
    data: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await this.audit({
      eventId: `evt_${randomUUID().replaceAll("-", "")}`,
      type,
      tool: tool.name,
      operation: tool.operation,
      actorId: context.actorId,
      taskId: context.taskId,
      at: new Date().toISOString(),
      data,
    });
  }
}

export class ToolGatewayError extends Error {
  public constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "ToolGatewayError";
  }
}

export async function enforceWorkspacePath(path: string, workspace: string): Promise<string> {
  const root = await realpath(resolve(workspace));
  const candidate = await realpath(resolve(isAbsolute(path) ? path : resolve(root, path)));
  const distance = relative(root, candidate);
  if (distance === "" || (!distance.startsWith(`..${sep}`) && distance !== ".." && !isAbsolute(distance))) return candidate;
  throw new ToolGatewayError("PATH_OUTSIDE_WORKSPACE", `${path} escapes the authorized workspace`);
}

export function classifyShell(command: string): {readonly decision: "allow" | "ask" | "deny"; readonly reason: string} {
  const normalized = command.trim();
  if (normalized === "") return {decision: "deny", reason: "empty command"};
  if (normalized.includes(String.fromCodePoint(0))) return {decision: "deny", reason: "NUL byte in command"};
  if (/\brm\s+-[^\n]*r[^\n]*f\s+(?:\/|~|\$HOME)\b/iu.test(normalized)) return {decision: "deny", reason: "recursive deletion of a broad path"};
  if (/\bRemove-Item\b[^\n]*(?:-Recurse|-Force)[^\n]*(?:\$HOME|~|[A-Za-z]:\\\s*$)/iu.test(normalized)) return {decision: "deny", reason: "recursive deletion of a broad path"};
  if (/\b(?:git\s+push\s+--force|kubectl\s+delete|terraform\s+(?:apply|destroy)|vercel\s+--prod|supabase\s+db\s+(?:push|reset))\b/iu.test(normalized)) {
    return {decision: "ask", reason: "command has a shared, production, or destructive side effect"};
  }
  if (/\b(?:curl|wget|Invoke-WebRequest|Invoke-RestMethod|npm\s+(?:install|publish)|pip\s+install)\b/iu.test(normalized)) {
    return {decision: "ask", reason: "command performs network access or dependency mutation"};
  }
  return {decision: "allow", reason: "command is not classified as materially risky"};
}

function deterministicGuard(
  tool: ToolManifest<unknown, unknown>,
  data: unknown,
  context: ToolContext,
): ToolGatewayError | undefined {
  const serialized = JSON.stringify(data);
  if (/(?:-----BEGIN .*PRIVATE KEY-----|\bgh[oprsu]_[A-Za-z0-9_]{20,}|\bsk-[A-Za-z0-9_-]{16,})/u.test(serialized)) {
    return new ToolGatewayError("SECRET_IN_TOOL_ARGUMENT", "tool arguments contain secret-like material");
  }
  if (/shell|command|terminal/u.test(tool.operation) && typeof data === "object" && data !== null && "command" in data) {
    if (typeof data.command !== "string") return new ToolGatewayError("INVALID_TOOL_INPUT", "tool command must be a string");
    const command = data.command;
    const classification = classifyShell(command);
    if (classification.decision === "deny") return new ToolGatewayError("COMMAND_HARD_DENIED", classification.reason);
    if (classification.decision === "ask" && tool.risk === "A0_OBSERVE") {
      return new ToolGatewayError("RISK_MISCLASSIFIED", "risky command cannot be registered as observe-only");
    }
  }
  if (typeof data === "object" && data !== null && "url" in data) {
    try {
      if (typeof data.url !== "string") return new ToolGatewayError("INVALID_NETWORK_URL", "tool URL must be a string");
      const url = new URL(data.url);
      if (!context.allowedHosts.includes(url.hostname)) return new ToolGatewayError("NETWORK_HOST_DENIED", `${url.hostname} is not allowlisted`);
    } catch (error) {
      if (error instanceof ToolGatewayError) return error;
      return new ToolGatewayError("INVALID_NETWORK_URL", "tool URL is invalid");
    }
  }
  return undefined;
}

function requiresApproval(risk: ConnectorRiskClass): boolean {
  return [
    "A2_REMOTE_REVERSIBLE",
    "A3_SHARED_MUTATION",
    "A4_PRODUCTION_OR_SECURITY",
    "A5_DESTRUCTIVE_OR_IRREVERSIBLE",
  ].includes(risk);
}
