import {createInterface} from "node:readline";
import {createHash} from "node:crypto";
import {basename, resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {z} from "zod";
import {DeterministicModelAdapter} from "../../../packages/model-gateway/src/index.js";
import {redact, sanitizeTerminal} from "../../../packages/observability/src/index.js";

export const WorkerManifestSchema = z.object({
  schema: z.literal("software-agent.run-manifest/v1"),
  attemptId: z.string().min(1),
  leaseId: z.string().min(1),
  leaseExpiresAt: z.iso.datetime(),
  runId: z.string().min(1),
  taskId: z.string().min(1),
  role: z.string().min(1),
  workspace: z.string().min(1),
  objective: z.string().min(1).max(256_000),
  modelId: z.string().min(1),
  limits: z.object({wallTimeMs: z.number().int().positive().max(3_600_000), maxOutputBytes: z.number().int().positive().max(16_777_216)}),
}).strict();

export type WorkerManifest = z.infer<typeof WorkerManifestSchema>;

export const WorkerResultSchema = z.object({
  schema: z.literal("software-agent.result/v1"),
  attemptId: z.string(),
  leaseId: z.string(),
  runId: z.string(),
  taskId: z.string(),
  status: z.literal("completed"),
  summary: z.string(),
  usage: z.object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cost: z.union([z.number().nonnegative(), z.literal("UNKNOWN")]),
    currency: z.literal("USD"),
  }),
}).strict();

export type WorkerResult = z.infer<typeof WorkerResultSchema>;

export const StepManifestSchema = z.object({
  schema: z.literal("software-agent.step/v1"),
  runId: z.string().min(1),
  taskId: z.string().min(1),
  taskRevision: z.number().int().positive(),
  sessionId: z.string().min(1),
  turnId: z.string().min(1),
  turnRevision: z.number().int().positive(),
  attemptId: z.string().min(1),
  leaseId: z.string().min(1),
  fencingEpoch: z.number().int().positive(),
  leaseExpiresAt: z.iso.datetime(),
  role: z.enum(["master-orchestrator", "software-engineer", "reviewer-qa"]),
  taskTitle: z.string().min(1).max(4096),
  objective: z.string().min(1).max(256_000),
  interaction: z.enum(["workflow", "conversation"]).optional(),
  prompt: z.string().min(1).max(4096).optional(),
  conversation: z.array(z.object({
    role: z.enum(["user", "assistant"]),
    content: z.string().min(1).max(16_384),
    speaker: z.string().min(1).max(128).optional(),
  }).strict()).max(12).optional(),
  workspaceRevision: z.string().min(1).max(512),
  simulatedWorkMs: z.number().int().min(10).max(30_000),
  heartbeatIntervalMs: z.number().int().min(10).max(10_000),
  limits: z.object({wallTimeMs: z.number().int().positive().max(3_600_000), maxOutputBytes: z.number().int().positive().max(16_777_216)}),
}).strict();

export type StepManifest = z.infer<typeof StepManifestSchema>;

const StepBindingSchema = StepManifestSchema.pick({
  runId: true,
  taskId: true,
  taskRevision: true,
  sessionId: true,
  turnId: true,
  turnRevision: true,
  attemptId: true,
  leaseId: true,
  fencingEpoch: true,
});

const StepUsageSchema = z.object({
  inputTokens: z.union([z.number().int().nonnegative(), z.literal("UNKNOWN")]),
  outputTokens: z.union([z.number().int().nonnegative(), z.literal("UNKNOWN")]),
  cachedInputTokens: z.union([z.number().int().nonnegative(), z.literal("UNKNOWN")]),
  reasoningTokens: z.union([z.number().int().nonnegative(), z.literal("UNKNOWN")]),
  totalTokens: z.union([z.number().int().nonnegative(), z.literal("UNKNOWN")]),
  source: z.enum(["PROVIDER", "UNKNOWN"]),
}).strict();

const StepActivitySchema = z.object({
  type: z.enum(["model.started", "model.completed", "tool.started", "tool.completed", "tool.failed"]),
  summary: z.string().min(1).max(16_384),
  providerId: z.string().min(1).max(64).optional(),
  modelId: z.string().min(1).max(256).optional(),
  tool: z.string().min(1).max(128).optional(),
  path: z.string().min(1).max(4096).optional(),
  usage: StepUsageSchema.optional(),
  costUsd: z.union([z.number().nonnegative(), z.literal("UNKNOWN")]).optional(),
}).strict();

export const StepFrameSchema = z.discriminatedUnion("kind", [
  StepBindingSchema.extend({schema: z.literal("software-agent.step-frame/v1"), kind: z.literal("worker.hello"), pid: z.number().int().positive()}).strict(),
  StepBindingSchema.extend({schema: z.literal("software-agent.step-frame/v1"), kind: z.literal("worker.accepted"), at: z.iso.datetime()}).strict(),
  StepBindingSchema.extend({schema: z.literal("software-agent.step-frame/v1"), kind: z.literal("worker.heartbeat"), at: z.iso.datetime()}).strict(),
  StepBindingSchema.extend({
    schema: z.literal("software-agent.step-frame/v1"),
    kind: z.literal("worker.activity"),
    at: z.iso.datetime(),
    activity: StepActivitySchema,
  }).strict(),
  StepBindingSchema.extend({
    schema: z.literal("software-agent.step-frame/v1"),
    kind: z.literal("worker.intent"),
    intent: z.object({type: z.literal("evidence"), summary: z.string().min(1).max(16_384)}).strict(),
  }).strict(),
  StepBindingSchema.extend({
    schema: z.literal("software-agent.step-frame/v1"),
    kind: z.literal("worker.completed"),
    at: z.iso.datetime(),
    summary: z.string().min(1).max(16_384),
    providerId: z.string().min(1).max(64).optional(),
    modelId: z.string().min(1).max(256).optional(),
    usage: StepUsageSchema.optional(),
    costUsd: z.union([z.number().nonnegative(), z.literal("UNKNOWN")]).optional(),
    toolsUsed: z.array(z.string().min(1).max(128)).max(128).optional(),
    filesChanged: z.array(z.string().min(1).max(4096)).max(512).optional(),
  }).strict(),
]);

export type StepFrame = z.infer<typeof StepFrameSchema>;

export async function executeManifest(manifest: WorkerManifest): Promise<WorkerResult> {
  const validated = WorkerManifestSchema.parse(manifest);
  if (Date.now() >= Date.parse(validated.leaseExpiresAt)) throw new Error("worker lease expired before execution");
  const adapter = new DeterministicModelAdapter();
  const result = await adapter.complete({
    requestId: validated.attemptId,
    modelId: validated.modelId,
    system: `Act as ${validated.role}. Return evidence, not authority.`,
    input: validated.objective,
    maxOutputTokens: 512,
  }, new AbortController().signal);
  return WorkerResultSchema.parse(redact({
    schema: "software-agent.result/v1",
    attemptId: validated.attemptId,
    leaseId: validated.leaseId,
    runId: validated.runId,
    taskId: validated.taskId,
    status: "completed",
    summary: sanitizeTerminal(result.text),
    usage: {inputTokens: result.inputTokens, outputTokens: result.outputTokens, cost: result.cost, currency: "USD"},
  }));
}

export async function executeStepManifest(
  manifest: StepManifest,
  emit: (frame: StepFrame) => void,
): Promise<StepFrame> {
  const validated = StepManifestSchema.parse(manifest);
  if (Date.now() >= Date.parse(validated.leaseExpiresAt)) throw new Error("worker lease expired before execution");
  const binding = stepBinding(validated);
  emit(StepFrameSchema.parse({schema: "software-agent.step-frame/v1", kind: "worker.hello", ...binding, pid: process.pid}));
  emit(StepFrameSchema.parse({schema: "software-agent.step-frame/v1", kind: "worker.accepted", ...binding, at: new Date().toISOString()}));
  const started = Date.now();
  while (Date.now() - started < validated.simulatedWorkMs) {
    await wait(Math.min(validated.heartbeatIntervalMs, validated.simulatedWorkMs - (Date.now() - started)));
    if (Date.now() >= Date.parse(validated.leaseExpiresAt)) throw new Error("worker lease expired during execution");
    emit(StepFrameSchema.parse({schema: "software-agent.step-frame/v1", kind: "worker.heartbeat", ...binding, at: new Date().toISOString()}));
  }
  const digest = createHash("sha256")
    .update(`${validated.role}\0${validated.taskTitle}\0${validated.objective}`, "utf8")
    .digest("hex")
    .slice(0, 12);
  const summary = sanitizeTerminal(`${validated.role} completed ${validated.taskTitle} with deterministic evidence ${digest}`);
  emit(StepFrameSchema.parse({
    schema: "software-agent.step-frame/v1",
    kind: "worker.intent",
    ...binding,
    intent: {type: "evidence", summary},
  }));
  const completed = StepFrameSchema.parse({
    schema: "software-agent.step-frame/v1",
    kind: "worker.completed",
    ...binding,
    at: new Date().toISOString(),
    summary,
  });
  emit(completed);
  return completed;
}

export async function runWorkerRuntime(): Promise<void> {
  const input = createInterface({input: process.stdin, crlfDelay: Infinity});
  for await (const line of input) {
    if (!line.trim()) continue;
    if (Buffer.byteLength(line, "utf8") > 1_048_576) {
      process.stdout.write(`${JSON.stringify({schema: "software-agent.error/v1", code: "WORKER_INPUT_TOO_LARGE", message: "worker input exceeded 1 MiB"})}\n`);
      continue;
    }
    try {
      const manifest = JSON.parse(line) as unknown;
      if (typeof manifest === "object" && manifest !== null && "schema" in manifest && manifest.schema === "software-agent.step/v1") {
        await executeStepManifest(StepManifestSchema.parse(manifest), (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`));
      } else {
        process.stdout.write(`${JSON.stringify(await executeManifest(manifest as WorkerManifest))}\n`);
      }
    } catch (error) {
      process.stdout.write(`${JSON.stringify({schema: "software-agent.error/v1", code: "WORKER_FAILURE", message: sanitizeTerminal(String(error))})}\n`);
    }
  }
}

function stepBinding(manifest: StepManifest): z.infer<typeof StepBindingSchema> {
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

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, Math.max(0, milliseconds)));
}

function isWorkerEntrypoint(): boolean {
  const invoked = process.argv[1];
  if (invoked === undefined) return false;
  const resolved = resolve(invoked);
  if (import.meta.url !== pathToFileURL(resolved).href) return false;
  const normalized = resolved.replaceAll("\\", "/");
  return basename(resolved).toLowerCase() === "worker.js"
    || normalized.endsWith("/apps/worker-runtime/src/index.ts");
}

if (isWorkerEntrypoint()) {
  void runWorkerRuntime();
}
