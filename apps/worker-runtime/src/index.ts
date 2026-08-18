import {createInterface} from "node:readline";
import {basename, resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {z} from "zod";
import {DeterministicModelAdapter} from "../../../packages/model-gateway/src/index.js";
import {redact, sanitizeTerminal} from "../../../packages/observability/src/index.js";

export const WorkerManifestSchema = z.object({
  schema: z.literal("agent-company.run-manifest/v1"),
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
  schema: z.literal("agent-company.result/v1"),
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
    schema: "agent-company.result/v1",
    attemptId: validated.attemptId,
    leaseId: validated.leaseId,
    runId: validated.runId,
    taskId: validated.taskId,
    status: "completed",
    summary: sanitizeTerminal(result.text),
    usage: {inputTokens: result.inputTokens, outputTokens: result.outputTokens, cost: result.cost, currency: "USD"},
  }));
}

async function main(): Promise<void> {
  const input = createInterface({input: process.stdin, crlfDelay: Infinity});
  for await (const line of input) {
    if (!line.trim()) continue;
    if (Buffer.byteLength(line, "utf8") > 1_048_576) {
      process.stdout.write(`${JSON.stringify({schema: "agent-company.error/v1", code: "WORKER_INPUT_TOO_LARGE", message: "worker input exceeded 1 MiB"})}\n`);
      continue;
    }
    try {
      const manifest = JSON.parse(line) as WorkerManifest;
      process.stdout.write(`${JSON.stringify(await executeManifest(manifest))}\n`);
    } catch (error) {
      process.stdout.write(`${JSON.stringify({schema: "agent-company.error/v1", code: "WORKER_FAILURE", message: sanitizeTerminal(String(error))})}\n`);
    }
  }
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
  void main();
}
