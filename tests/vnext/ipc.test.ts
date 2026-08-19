import {once} from "node:events";
import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {createConnection} from "node:net";
import {tmpdir} from "node:os";
import {join} from "node:path";

import {afterEach, describe, expect, it} from "vitest";

import {startControllerDaemon} from "../../apps/controller-daemon/src/index.js";
import {initializeProject} from "../../packages/config/src/index.js";
import {
  ControllerIpcClient,
  ControllerIpcError,
  ControllerIpcServer,
  FrameProtocolError,
  JsonFrameDecoder,
  IPC_PROTOCOL_MAX,
  IPC_PROTOCOL_MIN,
  controllerRuntimePaths,
  createNonceProof,
  createRequestId,
  currentUserBinding,
  encodeJsonFrame,
  readControllerDescriptor,
  resolveNonceReference,
  type ControllerBackend,
  type ControllerMethod,
  type ControllerRpcParams,
  type ControllerRpcResults,
} from "../../packages/ipc/src/index.js";

const temporaryDirectories: string[] = [];
const cleanupCallbacks: Array<() => Promise<void>> = [];

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  for (const cleanup of cleanupCallbacks.splice(0).reverse()) await cleanup();
  for (const directory of temporaryDirectories.splice(0).reverse()) {
    rmSync(directory, {recursive: true, force: true});
  }
});

describe("bounded framed JSON", () => {
  it("decodes fragmented and coalesced length-prefixed messages", () => {
    const first = encodeJsonFrame({kind: "first", value: 1});
    const second = encodeJsonFrame({kind: "second", value: 2});
    const decoder = new JsonFrameDecoder();

    expect(decoder.push(first.subarray(0, 2))).toEqual([]);
    expect(decoder.push(Buffer.concat([first.subarray(2), second]))).toEqual([
      {kind: "first", value: 1},
      {kind: "second", value: 2},
    ]);
  });

  it("rejects declared and encoded payloads above the configured bound", () => {
    const decoder = new JsonFrameDecoder(128);
    const header = Buffer.alloc(4);
    header.writeUInt32BE(129);

    expect(() => decoder.push(header)).toThrow(FrameProtocolError);
    expect(() => encodeJsonFrame({payload: "x".repeat(256)}, 128)).toThrow(FrameProtocolError);
  });

  it("rejects malformed UTF-8 before JSON parsing", () => {
    const decoder = new JsonFrameDecoder();
    const invalid = Buffer.from([0, 0, 0, 2, 0xc3, 0x28]);
    let failure: unknown;
    try {
      decoder.push(invalid);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({code: "FRAME_JSON_INVALID"});
  });
});

describe("local controller IPC", () => {
  it("authenticates a daemon, correlates typed calls, rejects unknown methods, and cleans up", async () => {
    const workspace = temporaryDirectory("agent-company-ipc-workspace-");
    const runtimeRoot = temporaryDirectory("agent-company-ipc-runtime-");
    await initializeProject(workspace, "IPC integration", true);
    const daemon = await startControllerDaemon({
      workspace,
      runtimeRoot,
      buildVersion: "test-build",
      heartbeatIntervalMs: 100,
    });
    cleanupCallbacks.push(() => daemon.close());

    const paths = controllerRuntimePaths({workspace, runtimeRoot});
    const descriptorText = readFileSync(paths.descriptor, "utf8");
    const descriptor = await readControllerDescriptor(paths.descriptor);
    const noncePath = resolveNonceReference(paths.directory, descriptor.nonceRef);
    const nonce = readFileSync(noncePath, "utf8");
    expect(descriptorText).not.toContain(nonce);
    expect(descriptor.pid).toBe(process.pid);
    expect(descriptor.buildVersion).toBe("test-build");
    expect(descriptor.endpoint).not.toMatch(/^tcp:/u);
    if (process.platform === "win32") {
      expect(descriptor.transport).toBe("named-pipe");
      expect(descriptor.endpoint).toMatch(/^\\\\\.\\pipe\\software-agent-/u);
    } else {
      expect(descriptor.transport).toBe("unix");
      expect(descriptor.endpoint.startsWith(paths.directory)).toBe(true);
    }

    const client = await ControllerIpcClient.connect({workspace, runtimeRoot});
    cleanupCallbacks.push(() => client.close());
    const [initial, run] = await Promise.all([
      client.request("snapshot", {}),
      client.request("createRun", {objective: "Build a safe local IPC boundary"}),
    ]);
    expect(initial.schema).toBe("agent-company.snapshot/v1");
    expect(run.state).toBe("WAITING_APPROVAL");

    const approvals = await client.request("listApprovals", {runId: run.id});
    const approval = approvals[0];
    expect(approval?.status).toBe("PENDING");
    if (!approval) throw new Error("expected a plan approval");
    await client.request("approve", {approvalId: approval.approvalId, reason: "exact plan reviewed"});
    const completed = await client.request("resume", {runId: run.id});
    expect(completed.state).toBe("SUCCEEDED");

    const uncheckedRequest = client.request.bind(client) as unknown as (
      method: string,
      params: Record<string, unknown>,
    ) => Promise<unknown>;
    await expect(uncheckedRequest("destroyEverything", {})).rejects.toMatchObject({code: "METHOD_NOT_FOUND"});
    await expect(uncheckedRequest("snapshot", {unexpected: true})).rejects.toMatchObject({code: "INVALID_PARAMS"});

    await client.close();
    await daemon.close();
    expect(existsSync(paths.descriptor)).toBe(false);
    expect(existsSync(noncePath)).toBe(false);
    expect(existsSync(paths.lock)).toBe(false);
    if (descriptor.transport === "unix") expect(existsSync(descriptor.endpoint)).toBe(false);
  });

  it("serializes concurrent daemon discovery with one cross-process startup lock", async () => {
    const workspace = temporaryDirectory("agent-company-ipc-lock-");
    const runtimeRoot = temporaryDirectory("agent-company-ipc-lock-runtime-");
    const first = new ControllerIpcServer({
      workspace,
      runtimeRoot,
      controller: throwingBackend(),
      buildVersion: "test-build",
    });
    const second = new ControllerIpcServer({
      workspace,
      runtimeRoot,
      controller: throwingBackend(),
      buildVersion: "test-build",
    });
    cleanupCallbacks.push(() => first.stop(), () => second.stop());

    const results = await Promise.allSettled([first.start(), second.start()]);
    const started = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(started).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({reason: {code: "CONTROLLER_ALREADY_RUNNING"}});
    const paths = controllerRuntimePaths({workspace, runtimeRoot});
    expect(existsSync(paths.lock)).toBe(true);
    if (process.platform === "win32") {
      expect(controllerRuntimePaths({workspace: workspace.toUpperCase(), runtimeRoot}).workspaceHash).toBe(paths.workspaceHash);
    }

    await (first.descriptor ? first : second).stop();
    expect(existsSync(paths.lock)).toBe(false);
  });

  it("fails the nonce proof and times out slow correlated requests without closing the client", async () => {
    const workspace = temporaryDirectory("agent-company-ipc-security-");
    const runtimeRoot = temporaryDirectory("agent-company-ipc-security-runtime-");
    const paths = controllerRuntimePaths({workspace, runtimeRoot});
    const backend = throwingBackend();
    const server = new ControllerIpcServer({
      workspace,
      runtimeRoot,
      controller: backend,
      buildVersion: "test-build",
      heartbeatIntervalMs: 100,
    });
    const descriptor = await server.start();
    cleanupCallbacks.push(() => server.stop());

    const noncePath = resolveNonceReference(paths.directory, descriptor.nonceRef);
    const nonce = readFileSync(noncePath, "utf8");
    writeFileSync(noncePath, "0".repeat(64), {encoding: "utf8", mode: 0o600});
    await expect(ControllerIpcClient.connect({workspace, runtimeRoot})).rejects.toMatchObject({
      code: "HANDSHAKE_REJECTED",
    });
    writeFileSync(noncePath, nonce, {encoding: "utf8", mode: 0o600});

    const client = await ControllerIpcClient.connect({workspace, runtimeRoot, requestTimeoutMs: 25});
    cleanupCallbacks.push(() => client.close());
    await expect(client.request("createRun", {objective: "never completes"})).rejects.toMatchObject({
      code: "RPC_TIMEOUT",
    });
    await expect(client.request("snapshot", {})).rejects.toMatchObject({code: "BACKEND_DISABLED"});
  });

  it("makes a rejected handshake terminal even when a valid hello follows in the same frame batch", async () => {
    const workspace = temporaryDirectory("agent-company-ipc-terminal-handshake-");
    const runtimeRoot = temporaryDirectory("agent-company-ipc-terminal-handshake-runtime-");
    let snapshotCalls = 0;
    const disabled = throwingBackend();
    const backend: ControllerBackend = {
      ...disabled,
      snapshot: () => {
        snapshotCalls += 1;
        return disabled.snapshot();
      },
    };
    const server = new ControllerIpcServer({workspace, runtimeRoot, controller: backend, buildVersion: "test-build"});
    const descriptor = await server.start();
    cleanupCallbacks.push(() => server.stop());
    const paths = controllerRuntimePaths({workspace, runtimeRoot});
    const nonce = readFileSync(resolveNonceReference(paths.directory, descriptor.nonceRef), "utf8");
    const helloId = createRequestId();
    const proofInput = {
      requestId: helloId,
      protocolMin: IPC_PROTOCOL_MIN,
      protocolMax: IPC_PROTOCOL_MAX,
      instanceId: descriptor.instanceId,
      userBinding: currentUserBinding(),
    } as const;
    const validHello = {kind: "hello", ...proofInput, nonceProof: createNonceProof(nonce, proofInput)} as const;
    const invalidHello = {...validHello, requestId: createRequestId(), nonceProof: "0".repeat(64)};
    const request = {
      kind: "request",
      requestId: createRequestId(),
      protocolVersion: IPC_PROTOCOL_MAX,
      method: "snapshot",
      params: {},
    } as const;

    const socket = createConnection(descriptor.endpoint);
    cleanupCallbacks.push(() => {
      socket.destroy();
      return Promise.resolve();
    });
    await once(socket, "connect");
    socket.resume();
    let timedOut = false;
    socket.setTimeout(1000, () => {
      timedOut = true;
      socket.destroy();
    });
    socket.write(Buffer.concat([
      encodeJsonFrame(invalidHello),
      encodeJsonFrame(validHello),
      encodeJsonFrame(request),
    ]));
    await once(socket, "close");
    expect(timedOut).toBe(false);
    expect(snapshotCalls).toBe(0);
  });
});

function throwingBackend(): ControllerBackend {
  const disabled = (): never => {
    throw new ControllerIpcError("BACKEND_DISABLED", "test backend method disabled");
  };
  return {
    snapshot: disabled,
    createRun: async () => await new Promise<never>(() => undefined),
    listApprovals: disabled,
    approve: disabled,
    deny: disabled,
    resume: disabled,
    pause: disabled,
    cancel: disabled,
  };
}

// These references keep the public generic method contract covered by the
// compiler in addition to the runtime integration above.
type _MethodContract<M extends ControllerMethod> = (
  method: M,
  params: ControllerRpcParams[M],
) => Promise<ControllerRpcResults[M]>;
void (undefined as unknown as _MethodContract<"snapshot">);
