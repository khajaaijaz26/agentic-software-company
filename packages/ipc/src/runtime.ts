import {createHash, randomBytes, randomUUID} from "node:crypto";
import {realpathSync, type Stats} from "node:fs";
import {chmod, lstat, mkdir, open, readFile, rename, rm, stat} from "node:fs/promises";
import {platform, userInfo} from "node:os";
import {basename, dirname, isAbsolute, join, relative, resolve, sep} from "node:path";

import {resolvePlatformPaths} from "../../config/src/index.js";
import {IPC_PROTOCOL_MAX, IPC_PROTOCOL_MIN} from "./protocol.js";

export const CONTROLLER_DESCRIPTOR_SCHEMA = "software-agent.controller/v2";
export const LEGACY_CONTROLLER_DESCRIPTOR_SCHEMA = "agent-company.controller/v1";
export const CONTROLLER_DESCRIPTOR_FILE = "controller.json";
export const CONTROLLER_LOCK_SCHEMA = "software-agent.controller-lock/v2";
export const LEGACY_CONTROLLER_LOCK_SCHEMA = "agent-company.controller-lock/v1";
export const CONTROLLER_LOCK_FILE = "controller.lock";

export interface ControllerDescriptor {
  readonly schema: typeof CONTROLLER_DESCRIPTOR_SCHEMA | typeof LEGACY_CONTROLLER_DESCRIPTOR_SCHEMA;
  readonly pid: number;
  readonly startedAt: string;
  readonly heartbeatAt: string;
  readonly endpoint: string;
  readonly transport: "unix" | "named-pipe";
  readonly instanceId: string;
  readonly protocol: {
    readonly min: number;
    readonly max: number;
  };
  readonly buildVersion: string;
  readonly userBinding: string;
  readonly nonceRef: string;
  readonly workspaceHash: string;
}

export interface ControllerRuntimePaths {
  readonly directory: string;
  readonly endpointDirectory: string;
  readonly descriptor: string;
  readonly lock: string;
  readonly workspaceHash: string;
}

export interface ControllerLock {
  readonly schema: typeof CONTROLLER_LOCK_SCHEMA | typeof LEGACY_CONTROLLER_LOCK_SCHEMA;
  readonly pid: number;
  readonly createdAt: string;
  readonly instanceId: string;
  readonly userBinding: string;
  readonly workspaceHash: string;
}

export interface RuntimePathOptions {
  readonly workspace?: string;
  readonly runtimeRoot?: string;
}

export class RuntimeSecurityError extends Error {
  public constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "RuntimeSecurityError";
  }
}

export function controllerRuntimePaths(options: RuntimePathOptions = {}): ControllerRuntimePaths {
  const workspace = canonicalWorkspace(options.workspace ?? process.cwd());
  const workspaceHash = sha256(workspace).slice(0, 24);
  const runtimeRoot = resolve(options.runtimeRoot ?? resolvePlatformPaths().runtime);
  const directory = join(runtimeRoot, "controllers", workspaceHash);
  return {
    directory,
    endpointDirectory: join(runtimeRoot, "s", workspaceHash),
    descriptor: join(directory, CONTROLLER_DESCRIPTOR_FILE),
    lock: join(directory, CONTROLLER_LOCK_FILE),
    workspaceHash,
  };
}

export function currentUserBinding(): string {
  const identity = userInfo();
  const uid = typeof identity.uid === "number" && identity.uid >= 0 ? String(identity.uid) : "none";
  const home = platform() === "win32" ? identity.homedir.toLowerCase() : identity.homedir;
  return sha256(`${platform()}\0${uid}\0${identity.username}\0${home}`).slice(0, 48);
}

export function newInstanceId(): string {
  return `ctl_${randomUUID().replaceAll("-", "")}`;
}

export function createControllerEndpoint(
  paths: ControllerRuntimePaths,
  instanceId: string,
  userBinding = currentUserBinding(),
): {readonly endpoint: string; readonly transport: ControllerDescriptor["transport"]} {
  if (!/^ctl_[a-f0-9]{32}$/u.test(instanceId)) throw new TypeError("invalid controller instance id");
  if (platform() === "win32") {
    return {
      endpoint: `\\\\.\\pipe\\software-agent-${userBinding.slice(0, 16)}-${paths.workspaceHash}-${instanceId}`,
      transport: "named-pipe",
    };
  }
  // Keep the socket outside the longer descriptor path. macOS and Linux cap
  // sockaddr_un paths, while the authenticated descriptor/nonce remain in the
  // compatibility-stable controllers directory.
  const endpoint = join(paths.endpointDirectory, "c.sock");
  if (Buffer.byteLength(endpoint, "utf8") > 100) {
    throw new RuntimeSecurityError("SOCKET_PATH_TOO_LONG", "controller Unix socket path exceeds the portable 100-byte limit");
  }
  return {endpoint, transport: "unix"};
}

export async function secureRuntimeDirectory(directory: string): Promise<void> {
  await mkdir(directory, {recursive: true, mode: 0o700});
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new RuntimeSecurityError("RUNTIME_PATH_UNSAFE", `runtime path is not a real directory: ${directory}`);
  }
  if (platform() !== "win32" && typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new RuntimeSecurityError("RUNTIME_OWNER_MISMATCH", "controller runtime directory is owned by a different user");
  }
  await chmod(directory, 0o700);
}

export async function assertSecureRuntimeDirectory(directory: string): Promise<void> {
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new RuntimeSecurityError("RUNTIME_PATH_UNSAFE", `runtime path is not a real directory: ${directory}`);
  }
  assertPrivateOwnership(metadata, "runtime directory");
}

export async function writeNonceFile(directory: string, instanceId: string, nonceHex: string): Promise<string> {
  if (!/^[a-f0-9]{64}$/u.test(nonceHex)) throw new TypeError("controller nonce must be 32 bytes of lowercase hex");
  const nonceRef = `nonce-${instanceId}.key`;
  const path = resolveNonceReference(directory, nonceRef);
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(nonceHex, {encoding: "utf8"});
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(path, 0o600);
  return nonceRef;
}

export function generateNonce(): string {
  return randomBytes(32).toString("hex");
}

export async function readNonceFile(directory: string, nonceRef: string): Promise<string> {
  const path = resolveNonceReference(directory, nonceRef);
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new RuntimeSecurityError("NONCE_PATH_UNSAFE", "controller nonce reference is not a regular file");
  }
  assertPrivateOwnership(metadata, "controller nonce file");
  const nonce = await readFile(path, "utf8");
  if (!/^[a-f0-9]{64}$/u.test(nonce)) throw new RuntimeSecurityError("NONCE_INVALID", "controller nonce file is invalid");
  return nonce;
}

export async function writeDescriptorAtomic(path: string, descriptor: ControllerDescriptor): Promise<void> {
  validateDescriptor(descriptor);
  await secureRuntimeDirectory(dirname(path));
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(descriptor, null, 2)}\n`, {encoding: "utf8"});
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    await rm(temporary, {force: true});
    throw error;
  }
}

export async function readControllerDescriptor(path: string): Promise<ControllerDescriptor> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new RuntimeSecurityError("DESCRIPTOR_PATH_UNSAFE", "controller descriptor is not a regular file");
  }
  assertPrivateOwnership(metadata, "controller descriptor");
  if (metadata.size > 64 * 1024) throw new RuntimeSecurityError("DESCRIPTOR_TOO_LARGE", "controller descriptor exceeds 64 KiB");
  const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  return validateDescriptor(parsed);
}

export function validateDescriptor(value: unknown): ControllerDescriptor {
  if (!isObject(value)) throw new RuntimeSecurityError("DESCRIPTOR_INVALID", "controller descriptor must be an object");
  if (value.schema !== CONTROLLER_DESCRIPTOR_SCHEMA && value.schema !== LEGACY_CONTROLLER_DESCRIPTOR_SCHEMA) {
    throw new RuntimeSecurityError("DESCRIPTOR_INVALID", "unsupported controller descriptor schema");
  }
  if (!Number.isSafeInteger(value.pid) || Number(value.pid) <= 0) throw new RuntimeSecurityError("DESCRIPTOR_INVALID", "invalid controller pid");
  if (!validIsoDate(value.startedAt) || !validIsoDate(value.heartbeatAt)) throw new RuntimeSecurityError("DESCRIPTOR_INVALID", "invalid controller timestamps");
  if (typeof value.endpoint !== "string" || value.endpoint.length === 0 || value.endpoint.length > 512) throw new RuntimeSecurityError("DESCRIPTOR_INVALID", "invalid controller endpoint");
  if (value.transport !== "unix" && value.transport !== "named-pipe") throw new RuntimeSecurityError("DESCRIPTOR_INVALID", "invalid controller transport");
  if (typeof value.instanceId !== "string" || !/^ctl_[a-f0-9]{32}$/u.test(value.instanceId)) throw new RuntimeSecurityError("DESCRIPTOR_INVALID", "invalid controller instance");
  if (!isObject(value.protocol) || !Number.isSafeInteger(value.protocol.min) || !Number.isSafeInteger(value.protocol.max)) {
    throw new RuntimeSecurityError("DESCRIPTOR_INVALID", "invalid controller protocol range");
  }
  if (Number(value.protocol.min) < 1 || Number(value.protocol.min) > Number(value.protocol.max)) throw new RuntimeSecurityError("DESCRIPTOR_INVALID", "invalid controller protocol range");
  if (typeof value.buildVersion !== "string" || value.buildVersion.length === 0 || value.buildVersion.length > 128) throw new RuntimeSecurityError("DESCRIPTOR_INVALID", "invalid controller build version");
  if (typeof value.userBinding !== "string" || !/^[a-f0-9]{48}$/u.test(value.userBinding)) throw new RuntimeSecurityError("DESCRIPTOR_INVALID", "invalid controller user binding");
  if (typeof value.nonceRef !== "string" || !/^nonce-ctl_[a-f0-9]{32}\.key$/u.test(value.nonceRef)) throw new RuntimeSecurityError("DESCRIPTOR_INVALID", "invalid controller nonce reference");
  if (value.nonceRef !== `nonce-${value.instanceId}.key`) throw new RuntimeSecurityError("DESCRIPTOR_INVALID", "controller nonce reference is not bound to its instance");
  if (typeof value.workspaceHash !== "string" || !/^[a-f0-9]{24}$/u.test(value.workspaceHash)) throw new RuntimeSecurityError("DESCRIPTOR_INVALID", "invalid workspace binding");
  return value as unknown as ControllerDescriptor;
}

export function validateDescriptorBinding(
  descriptor: ControllerDescriptor,
  paths: ControllerRuntimePaths,
  maximumHeartbeatAgeMs: number,
): void {
  if (descriptor.workspaceHash !== paths.workspaceHash) throw new RuntimeSecurityError("WORKSPACE_BINDING_MISMATCH", "controller descriptor belongs to a different workspace");
  if (descriptor.userBinding !== currentUserBinding()) throw new RuntimeSecurityError("USER_BINDING_MISMATCH", "controller descriptor belongs to a different local user");
  const heartbeatAge = Date.now() - Date.parse(descriptor.heartbeatAt);
  if (!Number.isFinite(heartbeatAge) || heartbeatAge > maximumHeartbeatAgeMs || heartbeatAge < -maximumHeartbeatAgeMs) throw new RuntimeSecurityError("DESCRIPTOR_STALE", "controller heartbeat is stale or implausibly in the future");
  if (descriptor.protocol.max < IPC_PROTOCOL_MIN || descriptor.protocol.min > IPC_PROTOCOL_MAX) throw new RuntimeSecurityError("PROTOCOL_MISMATCH", "controller and client protocol ranges do not overlap");
  const expected = descriptor.schema === LEGACY_CONTROLLER_DESCRIPTOR_SCHEMA
    ? createLegacyControllerEndpoint(paths, descriptor.instanceId, descriptor.userBinding)
    : createControllerEndpoint(paths, descriptor.instanceId, descriptor.userBinding);
  if (descriptor.transport !== expected.transport || descriptor.endpoint !== expected.endpoint) {
    throw new RuntimeSecurityError("ENDPOINT_UNSAFE", "descriptor endpoint is not the expected local socket for this instance");
  }
  resolveNonceReference(paths.directory, descriptor.nonceRef);
}

export function resolveNonceReference(directory: string, nonceRef: string): string {
  if (basename(nonceRef) !== nonceRef || nonceRef.includes(sep) || !/^nonce-ctl_[a-f0-9]{32}\.key$/u.test(nonceRef)) {
    throw new RuntimeSecurityError("NONCE_REFERENCE_UNSAFE", "controller nonce reference must be a safe local basename");
  }
  const resolved = resolve(directory, nonceRef);
  if (!pathInside(directory, resolved)) throw new RuntimeSecurityError("NONCE_REFERENCE_UNSAFE", "controller nonce reference escapes its runtime directory");
  return resolved;
}

export function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = isObject(error) && typeof error.code === "string" ? error.code : "";
    return code === "EPERM";
  }
}

export async function removeOwnedRuntimeFiles(paths: ControllerRuntimePaths, descriptor: ControllerDescriptor): Promise<void> {
  const current = await readControllerDescriptor(paths.descriptor).catch(() => undefined);
  await rm(resolveNonceReference(paths.directory, descriptor.nonceRef), {force: true});
  if (current?.instanceId === descriptor.instanceId) await rm(paths.descriptor, {force: true});
  const endpointRoot = descriptor.schema === LEGACY_CONTROLLER_DESCRIPTOR_SCHEMA ? paths.directory : paths.endpointDirectory;
  if (descriptor.transport === "unix" && pathInside(endpointRoot, descriptor.endpoint)) {
    await rm(descriptor.endpoint, {force: true});
  }
}

export async function inspectExistingDescriptor(paths: ControllerRuntimePaths): Promise<ControllerDescriptor | undefined> {
  const exists = await stat(paths.descriptor).then(() => true, () => false);
  if (!exists) return undefined;
  return readControllerDescriptor(paths.descriptor);
}

export async function acquireControllerLock(paths: ControllerRuntimePaths, instanceId: string): Promise<ControllerLock> {
  const lock: ControllerLock = {
    schema: CONTROLLER_LOCK_SCHEMA,
    pid: process.pid,
    createdAt: new Date().toISOString(),
    instanceId,
    userBinding: currentUserBinding(),
    workspaceHash: paths.workspaceHash,
  };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let created = false;
    try {
      const handle = await open(paths.lock, "wx", 0o600);
      created = true;
      try {
        await handle.writeFile(`${JSON.stringify(lock)}\n`, {encoding: "utf8"});
        await handle.sync();
      } finally {
        await handle.close();
      }
      await chmod(paths.lock, 0o600);
      return lock;
    } catch (error) {
      if (created) {
        await rm(paths.lock, {force: true}).catch(() => undefined);
        throw error;
      }
      if (!hasErrorCode(error, "EEXIST")) throw error;
      let existing: ControllerLock;
      try {
        existing = await readControllerLock(paths.lock);
      } catch (readError) {
        if (hasErrorCode(readError, "ENOENT")) continue;
        if (readError instanceof RuntimeSecurityError && readError.code === "CONTROLLER_LOCK_INVALID") {
          throw new RuntimeSecurityError("CONTROLLER_ALREADY_RUNNING", "another controller is acquiring the startup lock");
        }
        throw readError;
      }
      if (existing.userBinding !== lock.userBinding || existing.workspaceHash !== paths.workspaceHash) {
        throw new RuntimeSecurityError("CONTROLLER_LOCK_MISMATCH", "controller lock belongs to a different user or workspace");
      }
      if (processExists(existing.pid)) {
        throw new RuntimeSecurityError("CONTROLLER_ALREADY_RUNNING", `controller process ${existing.pid} is starting or already running`);
      }
      await removeControllerLockIfOwned(paths.lock, existing.instanceId);
    }
  }
  throw new RuntimeSecurityError("CONTROLLER_LOCK_BUSY", "could not acquire the controller startup lock");
}

export async function releaseControllerLock(paths: ControllerRuntimePaths, lock: ControllerLock): Promise<void> {
  await removeControllerLockIfOwned(paths.lock, lock.instanceId);
}

export async function readControllerLock(path: string): Promise<ControllerLock> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new RuntimeSecurityError("CONTROLLER_LOCK_UNSAFE", "controller lock is not a regular file");
  }
  assertPrivateOwnership(metadata, "controller lock");
  if (metadata.size > 4096) throw new RuntimeSecurityError("CONTROLLER_LOCK_INVALID", "controller lock exceeds 4 KiB");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    throw new RuntimeSecurityError("CONTROLLER_LOCK_INVALID", "controller lock JSON is invalid");
  }
  if (!isObject(parsed) || (parsed.schema !== CONTROLLER_LOCK_SCHEMA && parsed.schema !== LEGACY_CONTROLLER_LOCK_SCHEMA)) {
    throw new RuntimeSecurityError("CONTROLLER_LOCK_INVALID", "controller lock schema is invalid");
  }
  if (!Number.isSafeInteger(parsed.pid) || Number(parsed.pid) <= 0 || !validIsoDate(parsed.createdAt)) {
    throw new RuntimeSecurityError("CONTROLLER_LOCK_INVALID", "controller lock process fields are invalid");
  }
  if (typeof parsed.instanceId !== "string" || !/^ctl_[a-f0-9]{32}$/u.test(parsed.instanceId)) {
    throw new RuntimeSecurityError("CONTROLLER_LOCK_INVALID", "controller lock instance is invalid");
  }
  if (typeof parsed.userBinding !== "string" || !/^[a-f0-9]{48}$/u.test(parsed.userBinding)) {
    throw new RuntimeSecurityError("CONTROLLER_LOCK_INVALID", "controller lock user binding is invalid");
  }
  if (typeof parsed.workspaceHash !== "string" || !/^[a-f0-9]{24}$/u.test(parsed.workspaceHash)) {
    throw new RuntimeSecurityError("CONTROLLER_LOCK_INVALID", "controller lock workspace binding is invalid");
  }
  return parsed as unknown as ControllerLock;
}

function createLegacyControllerEndpoint(
  paths: ControllerRuntimePaths,
  instanceId: string,
  userBinding: string,
): {readonly endpoint: string; readonly transport: ControllerDescriptor["transport"]} {
  if (platform() === "win32") {
    return {
      endpoint: `\\\\.\\pipe\\agent-company-${userBinding.slice(0, 16)}-${paths.workspaceHash}-${instanceId}`,
      transport: "named-pipe",
    };
  }
  return {endpoint: join(paths.directory, `controller-${instanceId.slice(-16)}.sock`), transport: "unix"};
}

function pathInside(parent: string, child: string): boolean {
  const difference = relative(resolve(parent), resolve(child));
  return difference.length > 0 && !difference.startsWith(`..${sep}`) && difference !== ".." && !isAbsolute(difference);
}

async function removeControllerLockIfOwned(path: string, instanceId: string): Promise<void> {
  const current = await readControllerLock(path).catch(() => undefined);
  if (current?.instanceId === instanceId) await rm(path, {force: true});
}

function canonicalWorkspace(path: string): string {
  const absolute = resolve(path);
  let canonical: string;
  try {
    canonical = realpathSync.native(absolute);
  } catch {
    canonical = absolute;
  }
  return platform() === "win32" ? canonical.toLowerCase() : canonical;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function validIsoDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return isObject(error) && error.code === code;
}

function assertPrivateOwnership(metadata: Stats, label: string): void {
  if (platform() === "win32") return;
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new RuntimeSecurityError("RUNTIME_OWNER_MISMATCH", `${label} is owned by a different user`);
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new RuntimeSecurityError("RUNTIME_PERMISSIONS_UNSAFE", `${label} is accessible to group or other users`);
  }
}
