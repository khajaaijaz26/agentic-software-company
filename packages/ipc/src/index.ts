import {once} from "node:events";
import {chmod, rm} from "node:fs/promises";
import {createConnection, createServer, type Server, type Socket} from "node:net";

import {
  DEFAULT_MAX_FRAME_BYTES,
  IPC_PROTOCOL_MAX,
  IPC_PROTOCOL_MIN,
  JsonFrameDecoder,
  createNonceProof,
  createRequestId,
  encodeJsonFrame,
  isControllerMethod,
  negotiateProtocol,
  parseControllerParams,
  verifyNonceProof,
  type ClientHello,
  type ControllerMethod,
  type ControllerRpcParams,
  type ControllerRpcResults,
  type RpcErrorShape,
  type RpcFailureResponse,
  type RpcRequest,
  type RpcSuccessResponse,
  type ServerWelcome,
} from "./protocol.js";
import {
  CONTROLLER_DESCRIPTOR_SCHEMA,
  acquireControllerLock,
  assertSecureRuntimeDirectory,
  controllerRuntimePaths,
  createControllerEndpoint,
  currentUserBinding,
  generateNonce,
  inspectExistingDescriptor,
  newInstanceId,
  processExists,
  readControllerDescriptor,
  readNonceFile,
  releaseControllerLock,
  removeOwnedRuntimeFiles,
  resolveNonceReference,
  secureRuntimeDirectory,
  validateDescriptorBinding,
  writeDescriptorAtomic,
  writeNonceFile,
  type ControllerDescriptor,
  type ControllerLock,
  type ControllerRuntimePaths,
  type RuntimePathOptions,
} from "./runtime.js";
import type {ActorRef} from "../../contracts/src/index.js";

export * from "./protocol.js";
export * from "./runtime.js";

export interface ControllerBackend {
  snapshot(): ControllerRpcResults["snapshot"];
  createRun(objective: string): Promise<ControllerRpcResults["createRun"]>;
  listApprovals(runId?: string): ControllerRpcResults["listApprovals"];
  approve(approvalId: string, actor?: ActorRef, reason?: string): ControllerRpcResults["approve"];
  deny(approvalId: string, actor?: ActorRef, reason?: string): ControllerRpcResults["deny"];
  resume(runId: string): Promise<ControllerRpcResults["resume"]>;
  pause(runId: string): ControllerRpcResults["pause"];
  cancel(runId: string): ControllerRpcResults["cancel"];
}

export interface ControllerIpcServerOptions extends RuntimePathOptions {
  readonly controller: ControllerBackend;
  readonly buildVersion: string;
  readonly maximumFrameBytes?: number;
  readonly handshakeTimeoutMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly shutdownGraceMs?: number;
}

export interface ControllerIpcClientOptions extends RuntimePathOptions {
  readonly maximumFrameBytes?: number;
  readonly connectTimeoutMs?: number;
  readonly handshakeTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly maximumHeartbeatAgeMs?: number;
}

export interface RpcRequestOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export class ControllerIpcError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "ControllerIpcError";
  }
}

interface PendingRequest {
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
  readonly removeAbortListener: () => void;
}

interface ConnectionState {
  readonly decoder: JsonFrameDecoder;
  authenticated: boolean;
  closing: boolean;
  protocolVersion?: number;
  handshakeTimer: NodeJS.Timeout;
}

export class ControllerIpcServer {
  readonly #options: ControllerIpcServerOptions;
  readonly #paths: ControllerRuntimePaths;
  readonly #sockets = new Set<Socket>();
  #server: Server | undefined;
  #descriptor: ControllerDescriptor | undefined;
  #nonce: string | undefined;
  #heartbeatTimer: NodeJS.Timeout | undefined;
  #lock: ControllerLock | undefined;
  #descriptorWrites: Promise<void> = Promise.resolve();
  #stopping: Promise<void> | undefined;

  public constructor(options: ControllerIpcServerOptions) {
    this.#options = options;
    this.#paths = controllerRuntimePaths(options);
    positiveInteger(options.maximumFrameBytes ?? DEFAULT_MAX_FRAME_BYTES, "maximumFrameBytes", 64);
    positiveInteger(options.handshakeTimeoutMs ?? 5000, "handshakeTimeoutMs");
    positiveInteger(options.heartbeatIntervalMs ?? 5000, "heartbeatIntervalMs", 100);
    positiveInteger(options.shutdownGraceMs ?? 2000, "shutdownGraceMs");
    if (options.buildVersion.trim().length === 0 || options.buildVersion.length > 128) throw new TypeError("buildVersion is invalid");
  }

  public get descriptor(): ControllerDescriptor | undefined {
    return this.#descriptor;
  }

  public get paths(): ControllerRuntimePaths {
    return this.#paths;
  }

  public async start(): Promise<ControllerDescriptor> {
    if (this.#server) throw new ControllerIpcError("SERVER_ALREADY_STARTED", "controller IPC server is already started");
    await secureRuntimeDirectory(this.#paths.directory);
    const instanceId = newInstanceId();
    let lock: ControllerLock;
    try {
      lock = await acquireControllerLock(this.#paths, instanceId);
    } catch (error) {
      if (isObject(error) && typeof error.code === "string") {
        throw new ControllerIpcError(error.code, errorMessage(error), error.code === "CONTROLLER_LOCK_BUSY");
      }
      throw error;
    }
    this.#lock = lock;
    try {
      await this.#removeStaleDescriptor();
    } catch (error) {
      await releaseControllerLock(this.#paths, lock);
      this.#lock = undefined;
      throw error;
    }

    let nonce: string;
    let userBinding: string;
    let endpoint: ReturnType<typeof createControllerEndpoint>;
    let nonceRef: string;
    try {
      nonce = generateNonce();
      userBinding = currentUserBinding();
      endpoint = createControllerEndpoint(this.#paths, instanceId, userBinding);
      nonceRef = await writeNonceFile(this.#paths.directory, instanceId, nonce);
    } catch (error) {
      await releaseControllerLock(this.#paths, lock);
      this.#lock = undefined;
      throw error;
    }
    const startedAt = new Date().toISOString();
    const descriptor: ControllerDescriptor = {
      schema: CONTROLLER_DESCRIPTOR_SCHEMA,
      pid: process.pid,
      startedAt,
      heartbeatAt: startedAt,
      endpoint: endpoint.endpoint,
      transport: endpoint.transport,
      instanceId,
      protocol: {min: IPC_PROTOCOL_MIN, max: IPC_PROTOCOL_MAX},
      buildVersion: this.#options.buildVersion,
      userBinding,
      nonceRef,
      workspaceHash: this.#paths.workspaceHash,
    };

    let server: Server | undefined;
    try {
      server = createServer((socket) => this.#accept(socket));
      server.on("error", () => undefined);
      this.#server = server;
      this.#nonce = nonce;
      await listen(server, descriptor.endpoint);
      if (descriptor.transport === "unix") await chmod(descriptor.endpoint, 0o600);
      await writeDescriptorAtomic(this.#paths.descriptor, descriptor);
      this.#descriptor = descriptor;
      const interval = this.#options.heartbeatIntervalMs ?? 5000;
      this.#heartbeatTimer = setInterval(() => this.#queueHeartbeat(), interval);
      this.#heartbeatTimer.unref();
      return descriptor;
    } catch (error) {
      if (server) await closeServer(server);
      this.#server = undefined;
      this.#nonce = undefined;
      await rm(resolveNonceReference(this.#paths.directory, nonceRef), {force: true});
      if (descriptor.transport === "unix") await rm(descriptor.endpoint, {force: true});
      await releaseControllerLock(this.#paths, lock);
      this.#lock = undefined;
      throw error;
    }
  }

  public async stop(): Promise<void> {
    this.#stopping ??= this.#stop();
    return this.#stopping;
  }

  async #stop(): Promise<void> {
    if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
    this.#heartbeatTimer = undefined;
    await this.#descriptorWrites.catch(() => undefined);
    const server = this.#server;
    const descriptor = this.#descriptor;
    const lock = this.#lock;
    this.#server = undefined;

    const close = server ? closeServer(server) : Promise.resolve();
    for (const socket of this.#sockets) socket.end();
    const grace = this.#options.shutdownGraceMs ?? 2000;
    await Promise.race([close, delay(grace)]);
    for (const socket of this.#sockets) socket.destroy();
    await close.catch(() => undefined);
    this.#sockets.clear();

    try {
      if (descriptor) await removeOwnedRuntimeFiles(this.#paths, descriptor);
    } finally {
      if (lock) await releaseControllerLock(this.#paths, lock);
      this.#descriptor = undefined;
      this.#nonce = undefined;
      this.#lock = undefined;
    }
  }

  #accept(socket: Socket): void {
    const descriptor = this.#descriptor;
    const nonce = this.#nonce;
    if (!descriptor || !nonce) {
      socket.destroy();
      return;
    }
    socket.setNoDelay(true);
    this.#sockets.add(socket);
    const state: ConnectionState = {
      decoder: new JsonFrameDecoder(this.#options.maximumFrameBytes),
      authenticated: false,
      closing: false,
      handshakeTimer: setTimeout(() => socket.destroy(), this.#options.handshakeTimeoutMs ?? 5000),
    };
    state.handshakeTimer.unref();
    socket.on("data", (chunk) => {
      try {
        for (const message of state.decoder.push(chunk)) this.#receive(socket, state, message, descriptor, nonce);
      } catch {
        socket.destroy();
      }
    });
    socket.on("error", () => undefined);
    socket.on("close", () => {
      clearTimeout(state.handshakeTimer);
      this.#sockets.delete(socket);
    });
  }

  #receive(socket: Socket, state: ConnectionState, message: unknown, descriptor: ControllerDescriptor, nonce: string): void {
    if (state.closing) return;
    if (!state.authenticated) {
      const hello = parseHello(message);
      if (!hello) {
        this.#rejectHandshake(socket, state, handshakeFailure(requestIdFrom(message), "HANDSHAKE_REJECTED", "controller handshake was rejected"));
        return;
      }
      const protocolVersion = negotiateProtocol(hello.protocolMin, hello.protocolMax);
      if (protocolVersion === undefined) {
        this.#rejectHandshake(socket, state, handshakeFailure(hello.requestId, "PROTOCOL_MISMATCH", "client and controller protocol ranges do not overlap"));
        return;
      }
      if (
        hello.instanceId !== descriptor.instanceId
        || hello.userBinding !== descriptor.userBinding
        || !verifyNonceProof(nonce, hello)
      ) {
        this.#rejectHandshake(socket, state, handshakeFailure(hello.requestId, "HANDSHAKE_REJECTED", "controller handshake was rejected"));
        return;
      }
      state.authenticated = true;
      state.protocolVersion = protocolVersion;
      clearTimeout(state.handshakeTimer);
      const welcome: ServerWelcome = {
        kind: "welcome",
        requestId: hello.requestId,
        protocolVersion,
        instanceId: descriptor.instanceId,
        buildVersion: descriptor.buildVersion,
        serverTime: new Date().toISOString(),
      };
      void writeFrame(socket, welcome, this.#options.maximumFrameBytes).catch(() => socket.destroy());
      return;
    }
    void this.#handleRequest(socket, state, message);
  }

  #rejectHandshake(socket: Socket, state: ConnectionState, failure: ReturnType<typeof handshakeFailure>): void {
    state.closing = true;
    clearTimeout(state.handshakeTimer);
    void sendAndEnd(socket, failure, this.#options.maximumFrameBytes).catch(() => socket.destroy());
  }

  async #handleRequest(socket: Socket, state: ConnectionState, message: unknown): Promise<void> {
    const requestId = requestIdFrom(message);
    try {
      if (!isObject(message) || message.kind !== "request") throw new ControllerIpcError("INVALID_REQUEST", "expected a request envelope");
      if (!validRequestId(requestId)) throw new ControllerIpcError("INVALID_REQUEST", "requestId is invalid");
      if (message.protocolVersion !== state.protocolVersion) throw new ControllerIpcError("PROTOCOL_MISMATCH", "request protocol does not match the negotiated version");
      if (!isControllerMethod(message.method)) throw new ControllerIpcError("METHOD_NOT_FOUND", `unknown controller method: ${String(message.method)}`);
      const method = message.method;
      const params = parseControllerParams(method, message.params);
      const result = await this.#dispatch(method, params);
      const response = {kind: "response", requestId, ok: true, result} as RpcSuccessResponse;
      await writeFrame(socket, response, this.#options.maximumFrameBytes);
    } catch (error) {
      if (!validRequestId(requestId)) {
        socket.destroy();
        return;
      }
      const response: RpcFailureResponse = {kind: "response", requestId, ok: false, error: errorShape(error)};
      await writeFrame(socket, response, this.#options.maximumFrameBytes).catch(() => socket.destroy());
    }
  }

  async #dispatch<M extends ControllerMethod>(method: M, params: ControllerRpcParams[M]): Promise<ControllerRpcResults[M]> {
    const controller = this.#options.controller;
    switch (method) {
      case "snapshot":
        return controller.snapshot() as ControllerRpcResults[M];
      case "createRun":
        return await controller.createRun((params as ControllerRpcParams["createRun"]).objective) as ControllerRpcResults[M];
      case "listApprovals":
        return controller.listApprovals((params as ControllerRpcParams["listApprovals"]).runId) as ControllerRpcResults[M];
      case "approve": {
        const input = params as ControllerRpcParams["approve"];
        return controller.approve(input.approvalId, undefined, input.reason) as ControllerRpcResults[M];
      }
      case "deny": {
        const input = params as ControllerRpcParams["deny"];
        return controller.deny(input.approvalId, undefined, input.reason) as ControllerRpcResults[M];
      }
      case "resume":
        return await controller.resume((params as ControllerRpcParams["resume"]).runId) as ControllerRpcResults[M];
      case "pause":
        return controller.pause((params as ControllerRpcParams["pause"]).runId) as ControllerRpcResults[M];
      case "cancel":
        return controller.cancel((params as ControllerRpcParams["cancel"]).runId) as ControllerRpcResults[M];
    }
  }

  #queueHeartbeat(): void {
    const descriptor = this.#descriptor;
    if (!descriptor) return;
    const updated: ControllerDescriptor = {...descriptor, heartbeatAt: new Date().toISOString()};
    this.#descriptor = updated;
    this.#descriptorWrites = this.#descriptorWrites
      .then(() => writeDescriptorAtomic(this.#paths.descriptor, updated))
      .catch(() => undefined);
  }

  async #removeStaleDescriptor(): Promise<void> {
    const existing = await inspectExistingDescriptor(this.#paths).catch((error: unknown) => {
      throw new ControllerIpcError("DESCRIPTOR_INVALID", errorMessage(error));
    });
    if (!existing) return;
    if (existing.userBinding !== currentUserBinding()) {
      throw new ControllerIpcError("USER_BINDING_MISMATCH", "refusing to replace a controller descriptor owned by another user");
    }
    if (processExists(existing.pid)) {
      throw new ControllerIpcError("CONTROLLER_ALREADY_RUNNING", `controller process ${existing.pid} is already running`);
    }
    await removeOwnedRuntimeFiles(this.#paths, existing);
  }
}

export class ControllerIpcClient {
  readonly #socket: Socket;
  readonly #descriptor: ControllerDescriptor;
  readonly #protocolVersion: number;
  readonly #maximumFrameBytes: number;
  readonly #requestTimeoutMs: number;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #decoder: JsonFrameDecoder;
  #closed = false;

  private constructor(
    socket: Socket,
    descriptor: ControllerDescriptor,
    protocolVersion: number,
    options: ControllerIpcClientOptions,
  ) {
    this.#socket = socket;
    this.#descriptor = descriptor;
    this.#protocolVersion = protocolVersion;
    this.#maximumFrameBytes = options.maximumFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.#decoder = new JsonFrameDecoder(this.#maximumFrameBytes);
    socket.on("data", (chunk) => this.#receive(chunk));
    socket.on("error", (error) => this.#failAll(new ControllerIpcError("CONNECTION_ERROR", error.message, true)));
    socket.on("close", () => {
      this.#closed = true;
      this.#failAll(new ControllerIpcError("CONNECTION_CLOSED", "controller connection closed", true));
    });
  }

  public static async connect(options: ControllerIpcClientOptions = {}): Promise<ControllerIpcClient> {
    positiveInteger(options.maximumFrameBytes ?? DEFAULT_MAX_FRAME_BYTES, "maximumFrameBytes", 64);
    positiveInteger(options.connectTimeoutMs ?? 5000, "connectTimeoutMs");
    positiveInteger(options.handshakeTimeoutMs ?? 5000, "handshakeTimeoutMs");
    positiveInteger(options.requestTimeoutMs ?? 30_000, "requestTimeoutMs");
    positiveInteger(options.maximumHeartbeatAgeMs ?? 30_000, "maximumHeartbeatAgeMs");
    const paths = controllerRuntimePaths(options);
    await assertSecureRuntimeDirectory(paths.directory);
    const descriptor = await readControllerDescriptor(paths.descriptor);
    validateDescriptorBinding(descriptor, paths, options.maximumHeartbeatAgeMs ?? 30_000);
    const nonce = await readNonceFile(paths.directory, descriptor.nonceRef);
    const socket = await connectSocket(descriptor.endpoint, options.connectTimeoutMs ?? 5000);
    try {
      const protocolVersion = await performHandshake(socket, descriptor, nonce, options);
      return new ControllerIpcClient(socket, descriptor, protocolVersion, options);
    } catch (error) {
      socket.destroy();
      throw error;
    }
  }

  public get descriptor(): ControllerDescriptor {
    return this.#descriptor;
  }

  public request<M extends ControllerMethod>(
    method: M,
    params: ControllerRpcParams[M],
    options: RpcRequestOptions = {},
  ): Promise<ControllerRpcResults[M]> {
    if (this.#closed) return Promise.reject(new ControllerIpcError("CONNECTION_CLOSED", "controller connection is closed", true));
    if (options.signal?.aborted) return Promise.reject(abortError());
    const requestId = createRequestId();
    const timeoutMs = options.timeoutMs ?? this.#requestTimeoutMs;
    positiveInteger(timeoutMs, "timeoutMs");
    const envelope: RpcRequest<M> = {
      kind: "request",
      requestId,
      protocolVersion: this.#protocolVersion,
      method,
      params,
    };

    return new Promise<ControllerRpcResults[M]>((resolve, reject) => {
      const onAbort = (): void => this.#rejectPending(requestId, abortError());
      options.signal?.addEventListener("abort", onAbort, {once: true});
      const timer = setTimeout(() => {
        this.#rejectPending(requestId, new ControllerIpcError("RPC_TIMEOUT", `controller request ${method} timed out`, true));
      }, timeoutMs);
      timer.unref();
      this.#pending.set(requestId, {
        resolve: (value) => resolve(value as ControllerRpcResults[M]),
        reject,
        timer,
        removeAbortListener: () => options.signal?.removeEventListener("abort", onAbort),
      });
      void writeFrame(this.#socket, envelope, this.#maximumFrameBytes).catch((error: unknown) => {
        this.#rejectPending(requestId, new ControllerIpcError("WRITE_FAILED", errorMessage(error), true));
      });
    });
  }

  public async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const closed = once(this.#socket, "close").then(() => undefined);
    this.#socket.end();
    await Promise.race([closed, delay(1000)]);
    if (!this.#socket.destroyed) this.#socket.destroy();
    this.#failAll(new ControllerIpcError("CONNECTION_CLOSED", "controller connection closed", true));
  }

  #receive(chunk: Buffer): void {
    try {
      for (const message of this.#decoder.push(chunk)) {
        if (!isObject(message) || message.kind !== "response" || !validRequestId(message.requestId) || typeof message.ok !== "boolean") {
          throw new ControllerIpcError("INVALID_RESPONSE", "controller returned an invalid response envelope");
        }
        const pending = this.#pending.get(message.requestId);
        if (!pending) continue;
        this.#pending.delete(message.requestId);
        clearTimeout(pending.timer);
        pending.removeAbortListener();
        if (message.ok) {
          pending.resolve(message.result);
        } else {
          const shape = parseRpcError(message.error);
          pending.reject(new ControllerIpcError(shape.code, shape.message, shape.retryable));
        }
      }
    } catch (error) {
      this.#socket.destroy();
      this.#failAll(new ControllerIpcError("INVALID_RESPONSE", errorMessage(error)));
    }
  }

  #rejectPending(requestId: string, error: Error): void {
    const pending = this.#pending.get(requestId);
    if (!pending) return;
    this.#pending.delete(requestId);
    clearTimeout(pending.timer);
    pending.removeAbortListener();
    pending.reject(error);
  }

  #failAll(error: Error): void {
    for (const requestId of this.#pending.keys()) this.#rejectPending(requestId, error);
  }
}

async function performHandshake(
  socket: Socket,
  descriptor: ControllerDescriptor,
  nonce: string,
  options: ControllerIpcClientOptions,
): Promise<number> {
  const requestId = createRequestId();
  const proofInput = {
    requestId,
    protocolMin: IPC_PROTOCOL_MIN,
    protocolMax: IPC_PROTOCOL_MAX,
    instanceId: descriptor.instanceId,
    userBinding: currentUserBinding(),
  } as const;
  const hello: ClientHello = {
    kind: "hello",
    ...proofInput,
    nonceProof: createNonceProof(nonce, proofInput),
  };
  const decoder = new JsonFrameDecoder(options.maximumFrameBytes);
  const response = new Promise<number>((resolve, reject) => {
    const onData = (chunk: Buffer): void => {
      try {
        for (const message of decoder.push(chunk)) {
          if (!isObject(message) || message.requestId !== requestId) continue;
          cleanup();
          if (message.kind === "welcome") {
            if (
              !Number.isSafeInteger(message.protocolVersion)
              || Number(message.protocolVersion) < IPC_PROTOCOL_MIN
              || Number(message.protocolVersion) > IPC_PROTOCOL_MAX
              || message.instanceId !== descriptor.instanceId
            ) {
              reject(new ControllerIpcError("HANDSHAKE_INVALID", "controller returned an invalid handshake"));
              return;
            }
            resolve(Number(message.protocolVersion));
            return;
          }
          if (message.kind === "handshake_error") {
            const shape = parseRpcError(message.error);
            reject(new ControllerIpcError(shape.code, shape.message, shape.retryable));
            return;
          }
          reject(new ControllerIpcError("HANDSHAKE_INVALID", "controller returned an invalid handshake"));
        }
      } catch (error) {
        cleanup();
        reject(new ControllerIpcError("HANDSHAKE_INVALID", errorMessage(error)));
      }
    };
    const onClose = (): void => {
      cleanup();
      reject(new ControllerIpcError("HANDSHAKE_CLOSED", "controller closed the connection during handshake", true));
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(new ControllerIpcError("HANDSHAKE_FAILED", error.message, true));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new ControllerIpcError("HANDSHAKE_TIMEOUT", "controller handshake timed out", true));
    }, options.handshakeTimeoutMs ?? 5000);
    timer.unref();
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("close", onClose);
      socket.off("error", onError);
    };
    socket.on("data", onData);
    socket.once("close", onClose);
    socket.once("error", onError);
  });
  await writeFrame(socket, hello, options.maximumFrameBytes);
  return response;
}

function parseHello(value: unknown): ClientHello | undefined {
  if (!isObject(value) || value.kind !== "hello" || !validRequestId(value.requestId)) return undefined;
  if (!Number.isSafeInteger(value.protocolMin) || !Number.isSafeInteger(value.protocolMax)) return undefined;
  if (typeof value.instanceId !== "string" || typeof value.userBinding !== "string" || typeof value.nonceProof !== "string") return undefined;
  return value as unknown as ClientHello;
}

function handshakeFailure(requestId: string, code: string, message: string): {readonly kind: "handshake_error"; readonly requestId: string; readonly error: RpcErrorShape} {
  return {kind: "handshake_error", requestId, error: {code, message, retryable: false}};
}

function errorShape(error: unknown): RpcErrorShape {
  if (error instanceof ControllerIpcError) return {code: error.code, message: error.message, retryable: error.retryable};
  if (error instanceof TypeError) return {code: "INVALID_PARAMS", message: error.message, retryable: false};
  if (isObject(error) && typeof error.code === "string" && error instanceof Error) {
    return {code: error.code, message: error.message, retryable: false};
  }
  return {code: "INTERNAL_ERROR", message: "controller request failed", retryable: false};
}

function parseRpcError(value: unknown): RpcErrorShape {
  if (!isObject(value) || typeof value.code !== "string" || typeof value.message !== "string" || typeof value.retryable !== "boolean") {
    throw new ControllerIpcError("INVALID_RESPONSE", "controller returned an invalid error envelope");
  }
  return {code: value.code, message: value.message, retryable: value.retryable};
}

async function writeFrame(socket: Socket, message: unknown, maximumBytes = DEFAULT_MAX_FRAME_BYTES): Promise<void> {
  const frame = encodeJsonFrame(message, maximumBytes);
  if (socket.destroyed || !socket.writable) throw new ControllerIpcError("CONNECTION_CLOSED", "controller connection is not writable", true);
  if (socket.write(frame)) return;
  await once(socket, "drain");
}

async function sendAndEnd(socket: Socket, message: unknown, maximumBytes = DEFAULT_MAX_FRAME_BYTES): Promise<void> {
  try {
    await writeFrame(socket, message, maximumBytes);
    socket.end();
  } catch {
    socket.destroy();
  }
}

function listen(server: Server, endpoint: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onListening = (): void => {
      cleanup();
      resolve();
    };
    const cleanup = (): void => {
      server.off("error", onError);
      server.off("listening", onListening);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(endpoint);
  });
}

function connectSocket(endpoint: string, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint);
    const timer = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(new ControllerIpcError("CONNECT_TIMEOUT", "timed out connecting to the local controller", true));
    }, timeoutMs);
    timer.unref();
    const onConnect = (): void => {
      cleanup();
      socket.setNoDelay(true);
      resolve(socket);
    };
    const onError = (error: Error): void => {
      cleanup();
      socket.destroy();
      reject(new ControllerIpcError("CONNECT_FAILED", error.message, true));
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off("connect", onConnect);
      socket.off("error", onError);
    };
    socket.once("connect", onConnect);
    socket.once("error", onError);
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}

function requestIdFrom(value: unknown): string {
  return isObject(value) && typeof value.requestId === "string" ? value.requestId : "rpc_invalid";
}

function validRequestId(value: unknown): value is string {
  return typeof value === "string" && /^rpc_[a-f0-9]{32}$/u.test(value);
}

function positiveInteger(value: number, name: string, minimum = 1): void {
  if (!Number.isSafeInteger(value) || value < minimum) throw new RangeError(`${name} must be an integer of at least ${minimum}`);
}

function abortError(): ControllerIpcError {
  return new ControllerIpcError("REQUEST_ABORTED", "controller request was aborted", true);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
