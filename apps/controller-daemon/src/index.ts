import {parseArgs} from "node:util";
import {fileURLToPath, pathToFileURL} from "node:url";
import {basename, dirname, resolve} from "node:path";
import {spawn} from "node:child_process";

import {LocalController} from "../../control-plane/src/controller.js";
import {
  ControllerIpcClient,
  ControllerIpcServer,
  assertSecureRuntimeDirectory,
  controllerRuntimePaths,
  processExists,
  readControllerDescriptor,
  validateDescriptorBinding,
  type ControllerDescriptor,
  type ControllerIpcServerOptions,
} from "../../../packages/ipc/src/index.js";

export const CONTROLLER_BUILD_VERSION = process.env.SOFTWARE_AGENT_BUILD_VERSION
  ?? process.env.AGENT_COMPANY_BUILD_VERSION // Legacy environment migration.
  ?? "0.5.0";

export interface StartedControllerDaemon {
  readonly controller: LocalController;
  readonly server: ControllerIpcServer;
  readonly descriptor: ControllerDescriptor;
  readonly closed: Promise<void>;
  close(): Promise<void>;
}

export interface StartControllerDaemonOptions {
  readonly workspace?: string;
  readonly runtimeRoot?: string;
  readonly buildVersion?: string;
  readonly maximumFrameBytes?: number;
  readonly handshakeTimeoutMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly shutdownGraceMs?: number;
}

export interface ControllerDaemonStatus {
  readonly running: boolean;
  readonly descriptor?: ControllerDescriptor;
  readonly reason?: string;
}

export async function startControllerDaemon(options: StartControllerDaemonOptions = {}): Promise<StartedControllerDaemon> {
  const controller = await LocalController.open(options.workspace);
  let closeDaemon: (() => Promise<void>) | undefined;
  const serverOptions: ControllerIpcServerOptions = {
    controller,
    buildVersion: options.buildVersion ?? CONTROLLER_BUILD_VERSION,
    ...(options.workspace === undefined ? {} : {workspace: options.workspace}),
    ...(options.runtimeRoot === undefined ? {} : {runtimeRoot: options.runtimeRoot}),
    ...(options.maximumFrameBytes === undefined ? {} : {maximumFrameBytes: options.maximumFrameBytes}),
    ...(options.handshakeTimeoutMs === undefined ? {} : {handshakeTimeoutMs: options.handshakeTimeoutMs}),
    ...(options.heartbeatIntervalMs === undefined ? {} : {heartbeatIntervalMs: options.heartbeatIntervalMs}),
    ...(options.shutdownGraceMs === undefined ? {} : {shutdownGraceMs: options.shutdownGraceMs}),
    onShutdownRequested: () => setImmediate(() => void closeDaemon?.()),
  };
  const server = new ControllerIpcServer(serverOptions);
  try {
    const descriptor = await server.start();
    let closing: Promise<void> | undefined;
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolvePromise) => {
      resolveClosed = resolvePromise;
    });
    closeDaemon = () => {
      closing ??= server.stop()
        .then(async () => await controller.shutdown(options.shutdownGraceMs ?? 2_000))
        .finally(resolveClosed);
      return closing;
    };
    return {
      controller,
      server,
      descriptor,
      closed,
      close: closeDaemon,
    };
  } catch (error) {
    await controller.shutdown(options.shutdownGraceMs ?? 2_000);
    throw error;
  }
}

export async function controllerDaemonStatus(options: StartControllerDaemonOptions = {}): Promise<ControllerDaemonStatus> {
  const paths = controllerRuntimePaths(options);
  try {
    await assertSecureRuntimeDirectory(paths.directory);
    const descriptor = await readControllerDescriptor(paths.descriptor);
    validateDescriptorBinding(descriptor, paths, 30_000);
    if (!processExists(descriptor.pid)) return {running: false, descriptor, reason: "controller process is not running"};
    return {running: true, descriptor};
  } catch (error) {
    return {running: false, reason: error instanceof Error ? error.message : String(error)};
  }
}

export async function spawnDetachedController(
  options: StartControllerDaemonOptions & {readonly startupTimeoutMs?: number} = {},
): Promise<ControllerDescriptor> {
  const existing = await controllerDaemonStatus(options);
  if (existing.running && existing.descriptor) return existing.descriptor;
  const paths = controllerRuntimePaths(options);
  const previousInstanceId = existing.descriptor?.instanceId;
  const {executable, arguments: arguments_} = daemonInvocation(options);
  const child = spawn(executable, arguments_, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: {
      ...process.env,
      SOFTWARE_AGENT_BUILD_VERSION: options.buildVersion ?? CONTROLLER_BUILD_VERSION,
    },
  });
  child.unref();
  const timeoutMs = options.startupTimeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
    throw new TypeError("startupTimeoutMs must be between 100 and 60000");
  }
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const descriptor = await readControllerDescriptor(paths.descriptor);
      validateDescriptorBinding(descriptor, paths, 30_000);
      if (descriptor.instanceId !== previousInstanceId && processExists(descriptor.pid)) {
        const client = await ControllerIpcClient.connect({...options, connectTimeoutMs: 500, handshakeTimeoutMs: 500});
        await client.close();
        return descriptor;
      }
    } catch (error) {
      lastError = error;
    }
    await delay(50);
  }
  throw new Error(`Software Agent controller did not become ready: ${lastError instanceof Error ? lastError.message : "startup timed out"}`);
}

export async function ensureControllerDaemon(
  options: StartControllerDaemonOptions & {readonly startupTimeoutMs?: number} = {},
): Promise<ControllerDescriptor> {
  const status = await controllerDaemonStatus(options);
  if (status.running && status.descriptor) {
    const client = await ControllerIpcClient.connect(options);
    await client.close();
    return status.descriptor;
  }
  return await spawnDetachedController(options);
}

export async function requestControllerDaemonStop(options: StartControllerDaemonOptions = {}): Promise<boolean> {
  const status = await controllerDaemonStatus(options);
  if (!status.running) return false;
  const client = await ControllerIpcClient.connect(options);
  try {
    await client.request("daemon.stop", {});
  } finally {
    await client.close();
  }
  return true;
}

export async function runControllerDaemonCli(): Promise<void> {
  const parsed = parseArgs({
    options: {
      workspace: {type: "string", short: "w"},
      runtime: {type: "string"},
      "build-version": {type: "string"},
      "heartbeat-ms": {type: "string"},
    },
    allowPositionals: false,
    strict: true,
  });
  const heartbeat = parsed.values["heartbeat-ms"];
  const heartbeatIntervalMs = heartbeat === undefined ? undefined : Number.parseInt(heartbeat, 10);
  if (heartbeatIntervalMs !== undefined && (!Number.isSafeInteger(heartbeatIntervalMs) || heartbeatIntervalMs < 100)) {
    throw new TypeError("--heartbeat-ms must be an integer of at least 100");
  }
  const daemon = await startControllerDaemon({
    ...(parsed.values.workspace === undefined ? {} : {workspace: parsed.values.workspace}),
    ...(parsed.values.runtime === undefined ? {} : {runtimeRoot: parsed.values.runtime}),
    ...(parsed.values["build-version"] === undefined ? {} : {buildVersion: parsed.values["build-version"]}),
    ...(heartbeatIntervalMs === undefined ? {} : {heartbeatIntervalMs}),
  });
  process.stdout.write(`${JSON.stringify({
    schema: daemon.descriptor.schema,
    pid: daemon.descriptor.pid,
    instanceId: daemon.descriptor.instanceId,
    descriptor: daemon.server.paths.descriptor,
  })}\n`);

  await Promise.race([daemon.closed, new Promise<void>((resolve) => {
    const finish = (): void => resolve();
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
  })]);
  await daemon.close();
}

function daemonInvocation(options: StartControllerDaemonOptions): {readonly executable: string; readonly arguments: readonly string[]} {
  const modulePath = fileURLToPath(import.meta.url);
  const builtController = resolve(dirname(modulePath), "controller.js");
  const isSource = modulePath.replaceAll("\\", "/").endsWith("/apps/controller-daemon/src/index.ts");
  const entrypoint = isSource ? modulePath : builtController;
  const arguments_: string[] = isSource ? ["--import", "tsx", entrypoint] : [entrypoint];
  if (options.workspace !== undefined) arguments_.push("--workspace", resolve(options.workspace));
  if (options.runtimeRoot !== undefined) arguments_.push("--runtime", resolve(options.runtimeRoot));
  if (options.buildVersion !== undefined) arguments_.push("--build-version", options.buildVersion);
  if (options.heartbeatIntervalMs !== undefined) arguments_.push("--heartbeat-ms", String(options.heartbeatIntervalMs));
  return {executable: process.execPath, arguments: arguments_};
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function isControllerEntrypoint(): boolean {
  const invoked = process.argv[1];
  if (invoked === undefined) return false;
  const resolved = resolve(invoked);
  if (import.meta.url !== pathToFileURL(resolved).href) return false;
  const normalized = resolved.replaceAll("\\", "/");
  return basename(resolved).toLowerCase() === "controller.js"
    || normalized.endsWith("/apps/controller-daemon/src/index.ts");
}

if (isControllerEntrypoint()) {
  runControllerDaemonCli().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`software-agent controller: ${message}\n`);
    process.exitCode = 1;
  });
}
