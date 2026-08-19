import {basename} from "node:path";
import {randomUUID} from "node:crypto";

import {
  StepFrameSchema,
  type StepFrame,
  type StepManifest,
} from "../../../apps/worker-runtime/src/index.js";
import type {
  SoftwareAgentStepExecutionRequest,
  SoftwareAgentStepExecutor,
} from "../../../apps/control-plane/src/runtime-v3.js";
import {
  loadProjectConfig,
  loadUserProviderConfig,
  resolvePlatformPaths,
} from "../../config/src/index.js";
import {
  AnthropicMessagesAdapter,
  DeterministicModelAdapter,
  estimateModelRequestInputTokens,
  ModelBroker,
  ModelGateway,
  OpenAIResponsesAdapter,
  parseModelIdentifier,
  type ModelMessage,
  type ModelRequest,
  type ModelResult,
  type ModelToolCall,
  type ModelToolDefinition,
  type ModelToolResult,
  type NormalizedModelUsage,
} from "../../model-gateway/src/index.js";
import {
  EnvironmentCredentialBackend,
  SecretBackendBroker,
  createPlatformCredentialBackend,
  parseSecretReference,
} from "../../secret-broker/src/index.js";
import {sanitizeTerminal} from "../../observability/src/index.js";
import {
  WorkspaceEnvironment,
  WorkspaceEnvironmentError,
  type CommandPlan,
  type MutationAuthority,
} from "../../workspace-environment/src/index.js";
import type {BudgetLedger, TokenBudgetReservation} from "../../budgets/src/index.js";

const MAX_MODEL_TURNS = 10;
const MAX_TOOL_RESULT_CHARS = 64 * 1024;
const FULL_TOKEN_LIMIT = 100_000;

export interface AgentModelRoute {
  readonly providerId: string;
  readonly modelId: string;
  readonly routingRevision: number;
}

export interface AgentModelInvocation {
  readonly manifest: StepManifest;
  readonly route: AgentModelRoute;
  readonly request: ModelRequest;
}

export interface SoftwareAgentExecutionOptions {
  readonly workspace: string;
  readonly invokeModel: (input: AgentModelInvocation, signal: AbortSignal) => Promise<ModelResult>;
  readonly resolveModel: (manifest: StepManifest) => Promise<AgentModelRoute>;
  readonly budgets?: Pick<BudgetLedger, "reserveTokens" | "reconcileTokens" | "releaseTokens">;
  readonly authorizeCommand?: (input: AgentCommandApprovalRequest, signal: AbortSignal) => Promise<void>;
  readonly maximumTurns?: number;
}

export interface ConfiguredSoftwareAgentExecutionOptions {
  readonly workspace: string;
  readonly budgets?: BudgetLedger;
  readonly environment?: NodeJS.ProcessEnv;
  readonly fetch?: typeof fetch;
  readonly authorizeCommand?: (input: AgentCommandApprovalRequest, signal: AbortSignal) => Promise<void>;
}

export interface AgentCommandApprovalRequest {
  readonly manifest: StepManifest;
  readonly authority: MutationAuthority;
  readonly plan: CommandPlan;
}

interface ToolExecution {
  readonly result: ModelToolResult;
  readonly path?: string;
}

const TOOL_DEFINITIONS: readonly ModelToolDefinition[] = Object.freeze([
  Object.freeze({
    name: "list_files",
    description: "List visible repository files. Generated state, dependencies, symlinks, and likely secret files are excluded.",
    inputSchema: Object.freeze({type: "object", properties: Object.freeze({}), required: Object.freeze([]), additionalProperties: false}),
  }),
  Object.freeze({
    name: "read_file",
    description: "Read one UTF-8 repository file and receive its exact SHA-256 revision.",
    inputSchema: Object.freeze({
      type: "object",
      properties: Object.freeze({path: Object.freeze({type: "string", minLength: 1})}),
      required: Object.freeze(["path"]),
      additionalProperties: false,
    }),
  }),
  Object.freeze({
    name: "search_code",
    description: "Search visible repository text using a bounded literal query and return matching files and lines. Use this before reading many files.",
    inputSchema: Object.freeze({
      type: "object",
      properties: Object.freeze({
        query: Object.freeze({type: "string", minLength: 1, maxLength: 256}),
        path: Object.freeze({type: "string", minLength: 1, maxLength: 4096}),
        max_results: Object.freeze({type: "integer", minimum: 1, maximum: 200}),
        case_sensitive: Object.freeze({type: "boolean"}),
      }),
      required: Object.freeze(["query"]),
      additionalProperties: false,
    }),
  }),
  Object.freeze({
    name: "write_file",
    description: "Atomically create or replace one UTF-8 repository file. Supply null only for a new file; otherwise use the SHA-256 returned by read_file.",
    inputSchema: Object.freeze({
      type: "object",
      properties: Object.freeze({
        path: Object.freeze({type: "string", minLength: 1}),
        content: Object.freeze({type: "string"}),
        expected_sha256: Object.freeze({type: ["string", "null"], pattern: "^[a-f0-9]{64}$"}),
      }),
      required: Object.freeze(["path", "content", "expected_sha256"]),
      additionalProperties: false,
    }),
  }),
  Object.freeze({
    name: "run_command",
    description: "Run one bounded verification command without a shell. Only a small test/build/read-only-git allowlist is accepted.",
    inputSchema: Object.freeze({
      type: "object",
      properties: Object.freeze({
        executable: Object.freeze({type: "string", minLength: 1}),
        args: Object.freeze({type: "array", items: Object.freeze({type: "string"}), maxItems: 128}),
        cwd: Object.freeze({type: "string", minLength: 1}),
      }),
      required: Object.freeze(["executable", "args", "cwd"]),
      additionalProperties: false,
    }),
  }),
]);

export function createConfiguredSoftwareAgentStepExecutor(
  options: ConfiguredSoftwareAgentExecutionOptions,
): SoftwareAgentStepExecutor {
  const environment = options.environment ?? process.env;
  const platformPaths = resolvePlatformPaths(environment);
  const secrets = new SecretBackendBroker([
    new EnvironmentCredentialBackend(environment, true),
    createPlatformCredentialBackend(),
  ]);
  const invokeModel = async (input: AgentModelInvocation, signal: AbortSignal): Promise<ModelResult> => {
    const providers = await loadUserProviderConfig(platformPaths);
    const gateway = new ModelGateway();
    gateway.register(new DeterministicModelAdapter());
    if (input.route.providerId !== "deterministic") {
      const provider = providers.providers[input.route.providerId];
      if (!provider?.enabled) throw new AgentExecutionError("PROVIDER_DISABLED", `provider ${input.route.providerId} is not enabled`);
      const credential = parseSecretReference(provider.credential);
      if (input.route.providerId === "openai") {
        gateway.register(new OpenAIResponsesAdapter({secretBroker: secrets, credential, ...(options.fetch === undefined ? {} : {fetch: options.fetch})}));
      } else if (input.route.providerId === "anthropic") {
        gateway.register(new AnthropicMessagesAdapter({secretBroker: secrets, credential, ...(options.fetch === undefined ? {} : {fetch: options.fetch})}));
      } else {
        throw new AgentExecutionError("PROVIDER_UNSUPPORTED", `provider ${input.route.providerId} is not supported by the native runtime`);
      }
    }
    const broker = new ModelBroker(gateway);
    const estimatedInput = estimateModelRequestInputTokens(input.request);
    const grant = broker.issueGrant({
      runId: input.manifest.runId,
      taskId: input.manifest.taskId,
      agentId: input.manifest.sessionId,
      attemptId: `${input.manifest.attemptId}:${input.request.requestId}`,
      providerId: input.route.providerId,
      modelId: input.route.modelId,
      routingRevision: input.route.routingRevision,
      maxInputTokens: estimatedInput,
      maxOutputTokens: input.request.maxOutputTokens,
      expiresAt: new Date(Date.now() + 15 * 60 * 1_000).toISOString(),
    });
    return await broker.complete(grant, input.request, signal);
  };
  const resolveModel = async (manifest: StepManifest): Promise<AgentModelRoute> => {
    const [project, providers] = await Promise.all([
      loadProjectConfig(options.workspace),
      loadUserProviderConfig(platformPaths),
    ]);
    const projectSelection = project.models.routes[manifest.role] ?? project.models.default;
    const userSelection = providers.defaults.roles[manifest.role] ?? providers.defaults.model;
    const selected = projectSelection === "deterministic/local" && userSelection !== "deterministic/local"
      ? userSelection
      : projectSelection;
    return Object.freeze({...parseModelIdentifier(selected), routingRevision: Math.max(project.mapping_revision, providers.revision)});
  };
  const executionOptions: SoftwareAgentExecutionOptions = {
    workspace: options.workspace,
    invokeModel,
    resolveModel,
    ...(options.budgets === undefined ? {} : {budgets: options.budgets}),
    ...(options.authorizeCommand === undefined ? {} : {authorizeCommand: options.authorizeCommand}),
  };
  return async (request) => await executeSoftwareAgentStep(request, executionOptions);
}

export async function executeSoftwareAgentStep(
  execution: SoftwareAgentStepExecutionRequest,
  options: SoftwareAgentExecutionOptions,
): Promise<Extract<StepFrame, {readonly kind: "worker.completed"}>> {
  const {manifest, signal, onFrame} = execution;
  const maximumTurns = boundedInteger(options.maximumTurns ?? MAX_MODEL_TURNS, 1, 32, "maximumTurns");
  const exactAuthority = (authority: MutationAuthority): void => {
    if (authority.leaseId !== manifest.leaseId || authority.fencingEpoch !== manifest.fencingEpoch) {
      throw new WorkspaceEnvironmentError("MUTATION_LEASE_STALE", "tool authority does not match the active Software Agent attempt");
    }
  };
  const workspace = await WorkspaceEnvironment.open(options.workspace, {
    authorizeMutation: (authority) => exactAuthority(authority),
    authorizeCommand: async (authority, plan) => {
      exactAuthority(authority);
      if (!isAllowedVerificationCommand(plan)) {
        throw new WorkspaceEnvironmentError("COMMAND_APPROVAL_REQUIRED", "the requested command is outside the bounded verification allowlist");
      }
      const rawPreview = [plan.executable, ...plan.args].join(" ");
      if (sanitizeTerminal(rawPreview, rawPreview.length + 1) !== rawPreview) {
        throw new WorkspaceEnvironmentError("COMMAND_SECRET_ARGUMENT_DENIED", "command arguments appear to contain a credential and cannot be placed on the process command line");
      }
      if (options.authorizeCommand === undefined) {
        throw new WorkspaceEnvironmentError("COMMAND_APPROVAL_REQUIRED", "command execution requires an exact controller approval");
      }
      await options.authorizeCommand({manifest, authority, plan}, signal);
    },
  });
  const route = await options.resolveModel(manifest);
  const files = await workspace.listFiles();
  const conversational = manifest.interaction === "conversation";
  const currentPrompt = manifest.prompt ?? manifest.taskTitle;
  const initialInput = [
    `Objective: ${manifest.objective}`,
    conversational ? `Current user message: ${currentPrompt}` : `Assigned task: ${manifest.taskTitle}`,
    `Role: ${manifest.role}`,
    `Workspace revision: ${manifest.workspaceRevision}`,
    conversational ? "Reply directly to the current user message after completing any necessary bounded repository work." : "",
    "Visible files (bounded):",
    files.slice(0, 400).join("\n") || "(empty workspace)",
    files.length > 400 ? `... ${files.length - 400} additional files omitted; use list_files.` : "",
  ].filter((value) => value !== "").join("\n\n");
  const system = rolePrompt(manifest.role, conversational);
  const tools = manifest.role === "software-engineer"
    ? TOOL_DEFINITIONS
    : TOOL_DEFINITIONS.filter((tool) => tool.name !== "write_file");
  const messages: ModelMessage[] = [
    ...(manifest.conversation ?? []).map((message): ModelMessage => ({
      role: message.role,
      content: message.speaker === undefined ? message.content : `[${message.speaker}]\n${message.content}`,
    })),
    {role: "user", content: initialInput},
  ];
  let pendingToolResults: readonly ModelToolResult[] = [];
  let providerContinuationId: string | undefined;
  let finalText = "";
  let aggregateUsage: NormalizedModelUsage = unknownUsage();
  let aggregateCost: number | "UNKNOWN" = 0;
  const toolsUsed = new Set<string>();
  const filesChanged = new Set<string>();
  const heartbeat = setInterval(() => {
    if (!signal.aborted) onFrame(stepFrame(manifest, "worker.heartbeat", {at: new Date().toISOString()}));
  }, Math.max(1_000, manifest.heartbeatIntervalMs));
  heartbeat.unref();
  try {
    for (let turn = 1; turn <= maximumTurns; turn += 1) {
      if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new AgentExecutionError("STEP_CANCELED", "step execution was canceled");
      const maxOutputTokens = maxOutputForRole(manifest.role);
      const request: ModelRequest = {
        requestId: `mdl_${randomUUID().replaceAll("-", "")}`,
        modelId: route.modelId,
        system,
        input: turn === 1 ? initialInput : "Continue from the tool results. Complete the assigned task and report only verified evidence.",
        maxOutputTokens,
        messages: route.providerId === "openai" && providerContinuationId !== undefined ? [] : [...messages],
        tools,
        ...(pendingToolResults.length === 0 ? {} : {toolResults: pendingToolResults}),
        ...(route.providerId === "openai" && providerContinuationId !== undefined ? {providerContinuationId} : {}),
        reasoningEffort: manifest.role === "master-orchestrator" ? "medium" : "low",
      };
      const reservation = reserve(options.budgets, manifest, request);
      onFrame(activityFrame(manifest, {
        type: "model.started",
        summary: `${manifest.role} is using ${route.providerId}/${route.modelId} (turn ${turn}).`,
        providerId: route.providerId,
        modelId: route.modelId,
      }));
      let result: ModelResult;
      try {
        result = await options.invokeModel({manifest, route, request}, signal);
      } catch (error) {
        reconcileUnknown(options.budgets, reservation);
        throw error;
      }
      reconcileKnown(options.budgets, reservation, result.usage);
      aggregateUsage = addUsage(aggregateUsage, result.usage);
      aggregateCost = addCost(aggregateCost, result.cost);
      onFrame(activityFrame(manifest, {
        type: "model.completed",
        summary: `${route.providerId}/${result.modelId} completed turn ${turn}.`,
        providerId: route.providerId,
        modelId: result.modelId,
        usage: result.usage,
        costUsd: result.cost,
      }));
      if (pendingToolResults.length > 0 && route.providerId !== "openai") {
        for (const toolResult of pendingToolResults) {
          messages.push({role: "tool", content: toolResult.content, toolCallId: toolResult.callId});
        }
      }
      messages.push({role: "assistant", content: result.text, toolCalls: result.toolCalls});
      finalText = result.text.trim() || finalText;
      providerContinuationId = result.providerRequestId === "UNKNOWN" ? undefined : result.providerRequestId;
      if (result.toolCalls.length === 0) {
        const summary = sanitizeTerminal(finalText || `${manifest.role} completed ${manifest.taskTitle}.`, 16_384);
        return StepFrameSchema.parse({
          ...stepBinding(manifest),
          schema: "software-agent.step-frame/v1",
          kind: "worker.completed",
          at: new Date().toISOString(),
          summary,
          providerId: route.providerId,
          modelId: result.modelId,
          usage: aggregateUsage,
          costUsd: aggregateCost,
          toolsUsed: [...toolsUsed],
          filesChanged: [...filesChanged],
        }) as Extract<StepFrame, {readonly kind: "worker.completed"}>;
      }
      const outputs: ModelToolResult[] = [];
      for (const call of result.toolCalls) {
        toolsUsed.add(call.name);
        const path = toolPath(call);
        onFrame(activityFrame(manifest, {
          type: "tool.started",
          summary: `${manifest.role} requested ${call.name}${path === undefined ? "" : ` for ${path}`}.`,
          tool: call.name,
          ...(path === undefined ? {} : {path}),
        }));
        const output = await executeTool(workspace, manifest, call);
        outputs.push(output.result);
        if (call.name === "write_file" && output.path !== undefined && output.result.isError !== true) filesChanged.add(output.path);
        onFrame(activityFrame(manifest, {
          type: output.result.isError === true ? "tool.failed" : "tool.completed",
          summary: `${call.name} ${output.result.isError === true ? "failed" : "completed"}${output.path === undefined ? "" : ` for ${output.path}`}.`,
          tool: call.name,
          ...(output.path === undefined ? {} : {path: output.path}),
        }));
      }
      pendingToolResults = outputs;
    }
    throw new AgentExecutionError("MODEL_TURN_LIMIT", `${manifest.role} exceeded the ${maximumTurns}-turn tool loop limit`);
  } finally {
    clearInterval(heartbeat);
  }
}

export class AgentExecutionError extends Error {
  public constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "AgentExecutionError";
  }
}

async function executeTool(
  workspace: WorkspaceEnvironment,
  manifest: StepManifest,
  call: ModelToolCall,
): Promise<ToolExecution> {
  const authority: MutationAuthority = {
    leaseId: manifest.leaseId,
    fencingEpoch: manifest.fencingEpoch,
    operationId: call.callId,
  };
  const path = toolPath(call);
  try {
    const input = recordArguments(call.arguments);
    if (call.name === "list_files") {
      exactKeys(input, []);
      const files = await workspace.listFiles();
      return {result: toolResult(call, files.join("\n"))};
    }
    if (call.name === "read_file") {
      exactKeys(input, ["path"]);
      const target = requiredString(input, "path", 4096);
      const file = await workspace.readText(target);
      return {path: target, result: toolResult(call, JSON.stringify(file))};
    }
    if (call.name === "search_code") {
      exactKeys(input, ["query"], ["path", "max_results", "case_sensitive"]);
      const query = requiredString(input, "query", 256);
      const path = optionalStringValue(input.path, "path", 4096);
      const maxResults = optionalIntegerValue(input.max_results, "max_results", 1, 200);
      const caseSensitive = optionalBooleanValue(input.case_sensitive, "case_sensitive");
      const hits = await workspace.searchText({
        query,
        ...(path === undefined ? {} : {path}),
        ...(maxResults === undefined ? {} : {maxResults}),
        ...(caseSensitive === undefined ? {} : {caseSensitive}),
      });
      return {result: toolResult(call, JSON.stringify(hits)), ...(path === undefined ? {} : {path})};
    }
    if (call.name === "write_file") {
      exactKeys(input, ["path", "content", "expected_sha256"]);
      if (manifest.role !== "software-engineer") throw new AgentExecutionError("TOOL_ROLE_DENIED", `${manifest.role} cannot write repository files`);
      const target = requiredString(input, "path", 4096);
      const content = stringValue(input.content, "content", 4_194_304, true);
      const expected = input.expected_sha256;
      if (expected !== null && (typeof expected !== "string" || !/^[a-f0-9]{64}$/u.test(expected))) {
        throw new AgentExecutionError("TOOL_ARGUMENT_INVALID", "expected_sha256 must be null or a lowercase SHA-256 digest");
      }
      const receipt = await workspace.writeText({path: target, content, expectedSha256: expected, authority});
      return {path: target, result: toolResult(call, JSON.stringify(receipt))};
    }
    if (call.name === "run_command") {
      exactKeys(input, ["executable", "args", "cwd"]);
      const executable = requiredString(input, "executable", 4096);
      const args = stringArray(input.args, "args", 128);
      const cwd = requiredString(input, "cwd", 4096);
      const receipt = await workspace.runCommand({
        executable,
        args,
        ...(cwd === "." ? {} : {cwd}),
        authority,
        timeoutMs: 10 * 60 * 1_000,
      });
      return {result: toolResult(call, JSON.stringify(receipt))};
    }
    throw new AgentExecutionError("TOOL_UNKNOWN", `unknown tool ${call.name}`);
  } catch (error) {
    const message = sanitizeTerminal(error instanceof Error ? error.message : String(error), 8_192);
    return {result: toolResult(call, message, true), ...(path === undefined ? {} : {path})};
  }
}

function rolePrompt(role: StepManifest["role"], conversational: boolean): string {
  const shared = [
    "You are one logical specialist inside Software Agent, a visible multi-agent coding platform.",
    "Use the provided repository tools; never invent file contents, commands, test results, or completed work.",
    "Inspect before acting, keep changes narrowly scoped, conserve tokens, and finish with concise verified evidence.",
    "Never request or reveal credentials. Never access generated state, dependencies, or paths outside the workspace.",
  ].join(" ");
  const conversation = conversational
    ? " This is a continuous terminal conversation. Use the supplied conversation history, answer the user's current message directly in natural language, and do not merely restate internal workflow events."
    : "";
  if (role === "master-orchestrator") return `${shared}${conversation} You are the Master Orchestrator. Analyze the objective, repository shape, dependencies, and acceptance checks. Give a clear direct answer or coordinate through a precise implementation plan; do not edit files.`;
  if (role === "software-engineer") return `${shared}${conversation} You are the Software Engineer. When the user requests a change, implement it completely. Read exact revisions before writes, make atomic edits, run the smallest relevant verification commands, then explain the result directly.`;
  return `${shared}${conversation} You are Reviewer & QA. Independently inspect the repository, run bounded verification when needed, identify concrete defects and risks, and answer with evidence. Do not edit files.`;
}

function reserve(
  budgets: SoftwareAgentExecutionOptions["budgets"],
  manifest: StepManifest,
  request: ModelRequest,
): TokenBudgetReservation | undefined {
  return budgets?.reserveTokens(`run:${manifest.runId}`, {
    agentId: manifest.role,
    estimatedInputTokens: estimateModelRequestInputTokens(request),
    maxOutputTokens: request.maxOutputTokens,
    toolResultReserveTokens: request.tools === undefined ? 0 : 1_024,
  });
}

function reconcileKnown(
  budgets: SoftwareAgentExecutionOptions["budgets"],
  reservation: TokenBudgetReservation | undefined,
  usage: NormalizedModelUsage,
): void {
  if (!budgets || !reservation) return;
  budgets.reconcileTokens(reservation.id, {
    ...(usage.inputTokens === "UNKNOWN" ? {} : {inputTokens: usage.inputTokens}),
    ...(usage.outputTokens === "UNKNOWN" ? {} : {outputTokens: usage.outputTokens}),
    ...(usage.cachedInputTokens === "UNKNOWN" ? {} : {cachedInputTokens: usage.cachedInputTokens}),
    ...(usage.reasoningTokens === "UNKNOWN" ? {} : {reasoningTokens: usage.reasoningTokens}),
    ...(usage.totalTokens === "UNKNOWN" ? {} : {totalTokens: usage.totalTokens}),
  });
}

function reconcileUnknown(
  budgets: SoftwareAgentExecutionOptions["budgets"],
  reservation: TokenBudgetReservation | undefined,
): void {
  if (budgets && reservation) budgets.reconcileTokens(reservation.id, {});
}

function maxOutputForRole(role: StepManifest["role"]): number {
  if (role === "software-engineer") return 2_048;
  if (role === "master-orchestrator") return 1_024;
  return 1_536;
}

function isAllowedVerificationCommand(plan: CommandPlan): boolean {
  const executable = basename(plan.executable).toLowerCase().replace(/\.(?:cmd|exe)$/u, "");
  const args = plan.args.map((argument) => argument.toLowerCase());
  if (executable === "git") return ["status", "diff", "show", "log"].includes(args[0] ?? "");
  if (["npm", "pnpm", "yarn"].includes(executable)) {
    if (args[0] === "test") return true;
    if (args[0] !== "run") return false;
    return ["test", "typecheck", "lint", "build", "check"].includes(args[1] ?? "");
  }
  if (["pytest", "vitest", "ruff"].includes(executable)) return true;
  if (["python", "python3"].includes(executable)) return args[0] === "-m" && ["pytest", "unittest", "compileall"].includes(args[1] ?? "");
  if (executable === "uv") {
    if (args[0] !== "run") return false;
    if (["pytest", "ruff"].includes(args[1] ?? "")) return true;
    return args[1] === "python" && args[2] === "-m" && args[3] === "compileall";
  }
  return false;
}

function toolResult(call: ModelToolCall, content: string, isError = false): ModelToolResult {
  const bounded = content.length <= MAX_TOOL_RESULT_CHARS ? content : `${content.slice(0, MAX_TOOL_RESULT_CHARS)}\n[truncated]`;
  return Object.freeze({callId: call.callId, name: call.name, content: bounded, ...(isError ? {isError: true} : {})});
}

function toolPath(call: ModelToolCall): string | undefined {
  if (typeof call.arguments !== "object" || call.arguments === null || Array.isArray(call.arguments)) return undefined;
  const path = (call.arguments as Record<string, unknown>).path;
  return typeof path === "string" ? sanitizeTerminal(path, 4096) : undefined;
}

function activityFrame(
  manifest: StepManifest,
  activity: Extract<StepFrame, {readonly kind: "worker.activity"}>["activity"],
): Extract<StepFrame, {readonly kind: "worker.activity"}> {
  return StepFrameSchema.parse({
    ...stepBinding(manifest),
    schema: "software-agent.step-frame/v1",
    kind: "worker.activity",
    at: new Date().toISOString(),
    activity,
  }) as Extract<StepFrame, {readonly kind: "worker.activity"}>;
}

function stepFrame(
  manifest: StepManifest,
  kind: "worker.heartbeat",
  value: {readonly at: string},
): Extract<StepFrame, {readonly kind: "worker.heartbeat"}> {
  return StepFrameSchema.parse({...stepBinding(manifest), schema: "software-agent.step-frame/v1", kind, ...value}) as Extract<StepFrame, {readonly kind: "worker.heartbeat"}>;
}

function stepBinding(manifest: StepManifest) {
  return {
    runId: manifest.runId,
    taskId: manifest.taskId,
    taskRevision: manifest.taskRevision,
    sessionId: manifest.sessionId,
    turnId: manifest.turnId,
    turnRevision: manifest.turnRevision,
    attemptId: manifest.attemptId,
    leaseId: manifest.leaseId,
    fencingEpoch: manifest.fencingEpoch,
  };
}

function addUsage(left: NormalizedModelUsage, right: NormalizedModelUsage): NormalizedModelUsage {
  return Object.freeze({
    inputTokens: addCount(left.inputTokens, right.inputTokens),
    outputTokens: addCount(left.outputTokens, right.outputTokens),
    cachedInputTokens: addCount(left.cachedInputTokens, right.cachedInputTokens),
    reasoningTokens: addCount(left.reasoningTokens, right.reasoningTokens),
    totalTokens: addCount(left.totalTokens, right.totalTokens),
    source: left.source === "UNKNOWN" || right.source === "UNKNOWN" ? "UNKNOWN" : "PROVIDER",
  });
}

function unknownUsage(): NormalizedModelUsage {
  return {inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0, totalTokens: 0, source: "PROVIDER"};
}

function addCount(left: number | "UNKNOWN", right: number | "UNKNOWN"): number | "UNKNOWN" {
  return left === "UNKNOWN" || right === "UNKNOWN" ? "UNKNOWN" : left + right;
}

function addCost(left: number | "UNKNOWN", right: number | "UNKNOWN"): number | "UNKNOWN" {
  return left === "UNKNOWN" || right === "UNKNOWN" ? "UNKNOWN" : left + right;
}

function recordArguments(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new AgentExecutionError("TOOL_ARGUMENT_INVALID", "tool arguments must be an object");
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  const accepted = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) if (!accepted.has(key)) throw new AgentExecutionError("TOOL_ARGUMENT_INVALID", `unknown tool argument ${key}`);
  for (const key of required) if (!(key in value)) throw new AgentExecutionError("TOOL_ARGUMENT_INVALID", `missing tool argument ${key}`);
}

function optionalStringValue(value: unknown, key: string, maximum: number): string | undefined {
  return value === undefined ? undefined : stringValue(value, key, maximum, false);
}

function optionalIntegerValue(value: unknown, key: string, minimum: number, maximum: number): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || typeof value !== "number" || value < minimum || value > maximum) {
    throw new AgentExecutionError("TOOL_ARGUMENT_INVALID", `${key} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function optionalBooleanValue(value: unknown, key: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new AgentExecutionError("TOOL_ARGUMENT_INVALID", `${key} must be a boolean`);
  return value;
}

function requiredString(value: Record<string, unknown>, key: string, maximum: number): string {
  return stringValue(value[key], key, maximum, false);
}

function stringValue(value: unknown, key: string, maximum: number, allowEmpty: boolean): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0) || value.length > maximum || value.includes("\0")) {
    throw new AgentExecutionError("TOOL_ARGUMENT_INVALID", `${key} is invalid or exceeds ${maximum} characters`);
  }
  return value;
}

function stringArray(value: unknown, key: string, maximum: number): readonly string[] {
  if (!Array.isArray(value) || value.length > maximum || value.some((item) => typeof item !== "string" || item.length > 32_768 || item.includes("\0"))) {
    throw new AgentExecutionError("TOOL_ARGUMENT_INVALID", `${key} must contain at most ${maximum} bounded strings`);
  }
  return value as string[];
}

function boundedInteger(value: number, minimum: number, maximum: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new TypeError(`${field} must be from ${minimum} through ${maximum}`);
  return value;
}

export {FULL_TOKEN_LIMIT};
