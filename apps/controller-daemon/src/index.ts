import {parseArgs} from "node:util";
import {pathToFileURL} from "node:url";
import {basename, resolve} from "node:path";

import {LocalController} from "../../control-plane/src/controller.js";
import {
  ControllerIpcServer,
  type ControllerDescriptor,
  type ControllerIpcServerOptions,
} from "../../../packages/ipc/src/index.js";

export const CONTROLLER_BUILD_VERSION = process.env.AGENT_COMPANY_BUILD_VERSION ?? "0.2.0";

export interface StartedControllerDaemon {
  readonly controller: LocalController;
  readonly server: ControllerIpcServer;
  readonly descriptor: ControllerDescriptor;
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

export async function startControllerDaemon(options: StartControllerDaemonOptions = {}): Promise<StartedControllerDaemon> {
  const controller = await LocalController.open(options.workspace);
  const serverOptions: ControllerIpcServerOptions = {
    controller,
    buildVersion: options.buildVersion ?? CONTROLLER_BUILD_VERSION,
    ...(options.workspace === undefined ? {} : {workspace: options.workspace}),
    ...(options.runtimeRoot === undefined ? {} : {runtimeRoot: options.runtimeRoot}),
    ...(options.maximumFrameBytes === undefined ? {} : {maximumFrameBytes: options.maximumFrameBytes}),
    ...(options.handshakeTimeoutMs === undefined ? {} : {handshakeTimeoutMs: options.handshakeTimeoutMs}),
    ...(options.heartbeatIntervalMs === undefined ? {} : {heartbeatIntervalMs: options.heartbeatIntervalMs}),
    ...(options.shutdownGraceMs === undefined ? {} : {shutdownGraceMs: options.shutdownGraceMs}),
  };
  const server = new ControllerIpcServer(serverOptions);
  try {
    const descriptor = await server.start();
    let closing: Promise<void> | undefined;
    return {
      controller,
      server,
      descriptor,
      close: () => {
        closing ??= server.stop().finally(() => controller.close());
        return closing;
      },
    };
  } catch (error) {
    controller.close();
    throw error;
  }
}

async function main(): Promise<void> {
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

  await new Promise<void>((resolve) => {
    const finish = (): void => resolve();
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
  });
  await daemon.close();
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
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`agent-company controller: ${message}\n`);
    process.exitCode = 1;
  });
}
