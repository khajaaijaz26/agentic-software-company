import {spawn} from "node:child_process";
import {randomUUID} from "node:crypto";
import {fileURLToPath, pathToFileURL} from "node:url";
import {createRequire} from "node:module";
import {resolve as resolvePath} from "node:path";

import {
  WorkerResultSchema,
  type WorkerManifest,
  type WorkerResult,
} from "../../../apps/worker-runtime/src/index.js";
import {sanitizeTerminal} from "../../observability/src/index.js";

export interface WorkerTask {
  readonly runId: string;
  readonly taskId: string;
  readonly role: string;
  readonly workspace: string;
  readonly objective: string;
  readonly modelId: string;
  readonly wallTimeMs?: number;
  readonly maxOutputBytes?: number;
}

export interface WorkerExecution {
  readonly manifest: WorkerManifest;
  readonly result: WorkerResult;
  readonly pid: number;
}

export class WorkerSupervisorError extends Error {
  public constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "WorkerSupervisorError";
  }
}

export class ChildWorkerSupervisor {
  public async execute(task: WorkerTask, signal: AbortSignal = new AbortController().signal): Promise<WorkerExecution> {
    return this.executeManifest(createWorkerManifest(task), signal);
  }

  public async executeManifest(manifest: WorkerManifest, signal: AbortSignal = new AbortController().signal): Promise<WorkerExecution> {
    const {wallTimeMs, maxOutputBytes} = manifest.limits;
    const command = workerCommand();
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, command, {
        cwd: manifest.workspace,
        env: minimalWorkerEnvironment(process.env),
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      let settled = false;
      const finish = (error?: Error, result?: WorkerExecution): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        if (error) reject(error);
        else if (result) resolve(result);
      };
      const abort = (): void => {
        child.kill("SIGTERM");
        finish(new WorkerSupervisorError("WORKER_CANCELED", "worker execution was canceled"));
      };
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        finish(new WorkerSupervisorError("WORKER_TIMEOUT", `worker exceeded ${wallTimeMs} ms`));
      }, wallTimeMs);
      signal.addEventListener("abort", abort, {once: true});
      child.stdout.on("data", (chunk: Buffer) => {
        outputBytes += chunk.byteLength;
        if (outputBytes > maxOutputBytes) {
          child.kill("SIGTERM");
          finish(new WorkerSupervisorError("WORKER_OUTPUT_LIMIT", `worker output exceeded ${maxOutputBytes} bytes`));
          return;
        }
        stdout.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (Buffer.concat(stderr).byteLength < 65_536) stderr.push(chunk);
      });
      child.once("error", (error) => finish(new WorkerSupervisorError("WORKER_START_FAILED", sanitizeTerminal(error.message))));
      child.once("close", (code) => {
        if (settled) return;
        const diagnostic = sanitizeTerminal(Buffer.concat(stderr).toString("utf8"), 4096);
        if (code !== 0) return finish(new WorkerSupervisorError("WORKER_FAILED", `worker exited ${String(code)}${diagnostic ? `: ${diagnostic}` : ""}`));
        const lines = Buffer.concat(stdout).toString("utf8").split(/\r?\n/u).filter((line) => line.trim() !== "");
        if (lines.length !== 1) return finish(new WorkerSupervisorError("WORKER_PROTOCOL", "worker must emit exactly one result frame"));
        try {
          const line = lines[0];
          if (line === undefined) throw new WorkerSupervisorError("WORKER_PROTOCOL", "worker result frame is missing");
          const decoded = JSON.parse(line) as Record<string, unknown>;
          if (decoded.schema === "agent-company.error/v1") {
            const message = typeof decoded.message === "string" ? decoded.message : "worker failed";
            throw new WorkerSupervisorError(typeof decoded.code === "string" ? decoded.code : "WORKER_FAILURE", sanitizeTerminal(message));
          }
          const result = WorkerResultSchema.parse(decoded);
          if (result.attemptId !== manifest.attemptId || result.leaseId !== manifest.leaseId || result.taskId !== manifest.taskId) {
            throw new WorkerSupervisorError("WORKER_BINDING_MISMATCH", "worker result does not match its attempt and lease");
          }
          finish(undefined, {manifest, result, pid: child.pid ?? -1});
        } catch (error) {
          finish(error instanceof WorkerSupervisorError ? error : new WorkerSupervisorError("WORKER_PROTOCOL", sanitizeTerminal(String(error))));
        }
      });
      if (signal.aborted) {
        abort();
        return;
      }
      child.stdin.end(`${JSON.stringify(manifest)}\n`);
    });
  }
}

export function createWorkerManifest(task: WorkerTask): WorkerManifest {
    const wallTimeMs = task.wallTimeMs ?? 30_000;
    const maxOutputBytes = task.maxOutputBytes ?? 1_048_576;
    if (!Number.isSafeInteger(wallTimeMs) || wallTimeMs <= 0 || wallTimeMs > 3_600_000) throw new TypeError("invalid worker wall-time limit");
    if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0 || maxOutputBytes > 16_777_216) throw new TypeError("invalid worker output limit");
    return Object.freeze({
      schema: "agent-company.run-manifest/v1",
      attemptId: `attm_${randomUUID().replaceAll("-", "")}`,
      leaseId: `lease_${randomUUID().replaceAll("-", "")}`,
      leaseExpiresAt: new Date(Date.now() + wallTimeMs).toISOString(),
      runId: exact(task.runId, "runId"),
      taskId: exact(task.taskId, "taskId"),
      role: exact(task.role, "role"),
      workspace: resolvePath(exact(task.workspace, "workspace")),
      objective: exact(task.objective, "objective"),
      modelId: exact(task.modelId, "modelId"),
      limits: {wallTimeMs, maxOutputBytes},
    });
}

function workerCommand(): string[] {
  if (import.meta.url.endsWith(".ts")) {
    const source = fileURLToPath(new URL("../../../apps/worker-runtime/src/index.ts", import.meta.url));
    return ["--import", pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href, source];
  }
  return [fileURLToPath(new URL("./worker.js", import.meta.url))];
}

function exact(value: string, field: string): string {
  if (value === "" || value.trim() !== value) throw new TypeError(`${field} must be exact and non-empty`);
  return value;
}

function minimalWorkerEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = ["PATH", "Path", "PATHEXT", "SystemRoot", "COMSPEC", "HOME", "USERPROFILE", "TMP", "TEMP", "NO_COLOR", "TERM"];
  return Object.fromEntries(allowed.flatMap((key) => source[key] === undefined ? [] : [[key, source[key]]]));
}
