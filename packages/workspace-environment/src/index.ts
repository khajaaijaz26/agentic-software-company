import {spawn, type ChildProcess} from "node:child_process";
import {createHash, randomUUID} from "node:crypto";
import {lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat} from "node:fs/promises";
import {basename, dirname, isAbsolute, join, relative, resolve, sep} from "node:path";

import {sanitizeTerminal} from "../../observability/src/index.js";

const DEFAULT_IGNORED_DIRECTORIES = new Set([
  ".git", ".software-agent", ".agent-company", "node_modules", "__pycache__", ".venv", ".pytest_cache",
]);
const PROTECTED_ROOTS = new Set([".git", ".software-agent", ".agent-company", "node_modules"]);
const SAFE_ENVIRONMENT_KEYS = [
  "PATH", "Path", "PATHEXT", "SystemRoot", "COMSPEC", "HOME", "USERPROFILE", "TMP", "TEMP", "NO_COLOR", "TERM", "CI",
] as const;

export interface MutationAuthority {
  readonly leaseId: string;
  readonly fencingEpoch: number;
  readonly operationId: string;
}

export interface MutationPlan {
  readonly path: string;
  readonly previousSha256: string | null;
  readonly nextSha256: string;
  readonly sizeBytes: number;
}

export interface CommandPlan {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

export interface WorkspaceEnvironmentOptions {
  readonly maxReadBytes?: number;
  readonly maxFiles?: number;
  readonly sourceEnvironment?: NodeJS.ProcessEnv;
  readonly authorizeMutation?: (authority: MutationAuthority, plan: MutationPlan) => void | Promise<void>;
  readonly authorizeCommand?: (authority: MutationAuthority, plan: CommandPlan) => void | Promise<void>;
}

export interface TextFileSnapshot {
  readonly path: string;
  readonly content: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

export interface TextSearchHit {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly preview: string;
}

export interface FileWriteReceipt extends MutationPlan {
  readonly operationId: string;
  readonly leaseId: string;
  readonly fencingEpoch: number;
}

export interface CommandReceipt {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly truncated: boolean;
}

export class WorkspaceEnvironmentError extends Error {
  public constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "WorkspaceEnvironmentError";
  }
}

export class WorkspaceEnvironment {
  readonly #root: string;
  readonly #maxReadBytes: number;
  readonly #maxFiles: number;
  readonly #sourceEnvironment: NodeJS.ProcessEnv;
  readonly #authorizeMutation: WorkspaceEnvironmentOptions["authorizeMutation"];
  readonly #authorizeCommand: WorkspaceEnvironmentOptions["authorizeCommand"];

  private constructor(root: string, options: WorkspaceEnvironmentOptions) {
    this.#root = root;
    this.#maxReadBytes = boundedInteger(options.maxReadBytes ?? 1_048_576, 1, 16_777_216, "maxReadBytes");
    this.#maxFiles = boundedInteger(options.maxFiles ?? 5_000, 1, 100_000, "maxFiles");
    this.#sourceEnvironment = options.sourceEnvironment ?? process.env;
    this.#authorizeMutation = options.authorizeMutation;
    this.#authorizeCommand = options.authorizeCommand;
  }

  public static async open(root: string, options: WorkspaceEnvironmentOptions = {}): Promise<WorkspaceEnvironment> {
    const canonical = await realpath(resolve(root));
    const details = await stat(canonical);
    if (!details.isDirectory()) throw new WorkspaceEnvironmentError("WORKSPACE_NOT_DIRECTORY", `${root} is not a directory`);
    return new WorkspaceEnvironment(canonical, options);
  }

  public get root(): string {
    return this.#root;
  }

  public async listFiles(): Promise<readonly string[]> {
    const files: string[] = [];
    const pending: Array<{readonly absolute: string; readonly relative: string}> = [{absolute: this.#root, relative: ""}];
    while (pending.length > 0) {
      const current = pending.pop();
      if (current === undefined) break;
      const entries = await readdir(current.absolute, {withFileTypes: true});
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name)).reverse()) {
        if (entry.isSymbolicLink()) continue;
        const relativePath = current.relative === "" ? entry.name : `${current.relative}/${entry.name}`;
        if (entry.isDirectory()) {
          if (!DEFAULT_IGNORED_DIRECTORIES.has(entry.name)) {
            pending.push({absolute: join(current.absolute, entry.name), relative: relativePath});
          }
          continue;
        }
        if (!entry.isFile() || sensitivePath(relativePath)) continue;
        files.push(relativePath);
        if (files.length > this.#maxFiles) {
          throw new WorkspaceEnvironmentError("FILE_LIMIT_EXCEEDED", `workspace contains more than ${this.#maxFiles} visible files`);
        }
      }
    }
    return Object.freeze(files.sort());
  }

  public async readText(path: string, maxBytes = this.#maxReadBytes): Promise<TextFileSnapshot> {
    const boundedBytes = boundedInteger(maxBytes, 1, this.#maxReadBytes, "maxBytes");
    const normalized = normalizedWorkspacePath(path);
    assertReadablePath(normalized);
    const absolute = await this.#existingFile(normalized);
    const details = await stat(absolute);
    if (details.size > boundedBytes) {
      throw new WorkspaceEnvironmentError("FILE_TOO_LARGE", `${normalized} exceeds the ${boundedBytes}-byte read limit`);
    }
    const bytes = await readFile(absolute);
    if (bytes.includes(0)) throw new WorkspaceEnvironmentError("BINARY_FILE", `${normalized} is not a text file`);
    let content: string;
    try {
      content = new TextDecoder("utf-8", {fatal: true}).decode(bytes);
    } catch {
      throw new WorkspaceEnvironmentError("INVALID_UTF8", `${normalized} is not valid UTF-8 text`);
    }
    return Object.freeze({path: normalized, content, sha256: digest(bytes), sizeBytes: bytes.byteLength});
  }

  public async searchText(input: {
    readonly query: string;
    readonly path?: string;
    readonly maxResults?: number;
    readonly caseSensitive?: boolean;
  }): Promise<readonly TextSearchHit[]> {
    exactText(input.query, "query", 256);
    if (input.query.includes("\n") || input.query.includes("\0")) {
      throw new WorkspaceEnvironmentError("SEARCH_INVALID", "search query must be one line of literal text");
    }
    const prefix = input.path === undefined || input.path === "." ? undefined : normalizedWorkspacePath(input.path);
    const maximum = boundedInteger(input.maxResults ?? 50, 1, 200, "maxResults");
    const caseSensitive = input.caseSensitive ?? false;
    const needle = caseSensitive ? input.query : input.query.toLowerCase();
    const candidates = (await this.listFiles()).filter((path) => prefix === undefined || path === prefix || path.startsWith(`${prefix}/`));
    const hits: TextSearchHit[] = [];
    let scannedBytes = 0;
    for (const path of candidates) {
      if (hits.length >= maximum || scannedBytes >= 16_777_216) break;
      let snapshot: TextFileSnapshot;
      try {
        snapshot = await this.readText(path);
      } catch (error) {
        if (error instanceof WorkspaceEnvironmentError && ["BINARY_FILE", "FILE_TOO_LARGE", "INVALID_UTF8"].includes(error.code)) continue;
        throw error;
      }
      scannedBytes += snapshot.sizeBytes;
      const lines = snapshot.content.split("\n");
      for (let index = 0; index < lines.length && hits.length < maximum; index += 1) {
        const line = lines[index] ?? "";
        const searchable = caseSensitive ? line : line.toLowerCase();
        const column = searchable.indexOf(needle);
        if (column < 0) continue;
        hits.push(Object.freeze({
          path,
          line: index + 1,
          column: column + 1,
          preview: sanitizeTerminal(line.trim(), 500),
        }));
      }
    }
    return Object.freeze(hits);
  }

  public async writeText(input: {
    readonly path: string;
    readonly content: string;
    readonly expectedSha256: string | null;
    readonly authority: MutationAuthority;
  }): Promise<FileWriteReceipt> {
    if (!this.#authorizeMutation) {
      throw new WorkspaceEnvironmentError("AUTHORIZATION_REQUIRED", "workspace mutation requires controller authorization");
    }
    validateAuthority(input.authority);
    if (input.expectedSha256 !== null && !/^[a-f0-9]{64}$/u.test(input.expectedSha256)) {
      throw new WorkspaceEnvironmentError("INVALID_EXPECTED_DIGEST", "expectedSha256 must be null or a lowercase SHA-256 digest");
    }
    const normalized = normalizedWorkspacePath(input.path);
    assertWritablePath(normalized);
    const bytes = Buffer.from(input.content, "utf8");
    if (bytes.byteLength > 4_194_304) throw new WorkspaceEnvironmentError("WRITE_TOO_LARGE", "a single file write may not exceed 4 MiB");
    const before = await this.#currentDigest(normalized);
    if (before !== input.expectedSha256) {
      throw new WorkspaceEnvironmentError("FILE_REVISION_CONFLICT", `${normalized} changed since the proposed operation was prepared`);
    }
    const plan: MutationPlan = Object.freeze({path: normalized, previousSha256: before, nextSha256: digest(bytes), sizeBytes: bytes.byteLength});
    await this.#authorizeMutation(input.authority, plan);
    if (await this.#currentDigest(normalized) !== before) {
      throw new WorkspaceEnvironmentError("FILE_REVISION_CONFLICT", `${normalized} changed while authorization was being resolved`);
    }

    const target = resolve(this.#root, ...normalized.split("/"));
    await this.#prepareParent(dirname(target));
    const temporary = join(dirname(target), `.${basename(target)}.${process.pid}.${randomUUID()}.software-agent.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, {force: true});
      throw error;
    }
    return Object.freeze({...plan, ...input.authority});
  }

  public async runCommand(input: {
    readonly executable: string;
    readonly args: readonly string[];
    readonly authority: MutationAuthority;
    readonly cwd?: string;
    readonly timeoutMs?: number;
    readonly maxOutputBytes?: number;
  }): Promise<CommandReceipt> {
    if (!this.#authorizeCommand) {
      throw new WorkspaceEnvironmentError("AUTHORIZATION_REQUIRED", "command execution requires controller authorization");
    }
    validateAuthority(input.authority);
    exactText(input.executable, "executable", 4096);
    if (input.args.length > 128) throw new WorkspaceEnvironmentError("COMMAND_INVALID", "a command may not exceed 128 arguments");
    const args = Object.freeze(input.args.map((argument, index) => exactArgument(argument, index)));
    const cwd = input.cwd === undefined ? this.#root : await this.#existingDirectory(normalizedWorkspacePath(input.cwd));
    const plan: CommandPlan = Object.freeze({executable: input.executable, args, cwd});
    await this.#authorizeCommand(input.authority, plan);
    return executeCommand(plan, {
      environment: minimalEnvironment(this.#sourceEnvironment),
      timeoutMs: boundedInteger(input.timeoutMs ?? 120_000, 1, 3_600_000, "timeoutMs"),
      maxOutputBytes: boundedInteger(input.maxOutputBytes ?? 1_048_576, 1, 8_388_608, "maxOutputBytes"),
    });
  }

  async #existingFile(normalized: string): Promise<string> {
    await this.#assertNoSymlink(normalized, false);
    const actual = await realpath(resolve(this.#root, ...normalized.split("/")));
    assertContained(this.#root, actual);
    if (!(await lstat(actual)).isFile()) throw new WorkspaceEnvironmentError("PATH_NOT_FILE", `${normalized} is not a regular file`);
    return actual;
  }

  async #existingDirectory(normalized: string): Promise<string> {
    await this.#assertNoSymlink(normalized, false);
    const candidate = await realpath(resolve(this.#root, ...normalized.split("/")));
    assertContained(this.#root, candidate);
    if (!(await stat(candidate)).isDirectory()) throw new WorkspaceEnvironmentError("PATH_NOT_DIRECTORY", `${normalized} is not a directory`);
    return candidate;
  }

  async #currentDigest(normalized: string): Promise<string | null> {
    try {
      return (await this.readText(normalized, this.#maxReadBytes)).sha256;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async #prepareParent(parent: string): Promise<void> {
    assertContained(this.#root, parent);
    const distance = relative(this.#root, parent);
    if (distance !== "") await this.#assertNoSymlink(distance.split(sep).join("/"), true);
    await mkdir(parent, {recursive: true, mode: 0o700});
    assertContained(this.#root, await realpath(parent));
  }

  async #assertNoSymlink(normalized: string, allowMissing: boolean): Promise<void> {
    let current = this.#root;
    for (const segment of normalized.split("/")) {
      current = join(current, segment);
      try {
        if ((await lstat(current)).isSymbolicLink()) {
          throw new WorkspaceEnvironmentError("PATH_SYMLINK", `${normalized} crosses a symbolic link`);
        }
      } catch (error) {
        if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
    }
  }
}

function normalizedWorkspacePath(value: string): string {
  exactText(value, "path", 4096);
  if (isAbsolute(value) || /^[A-Za-z]:[\\/]/u.test(value) || value.includes("\0")) {
    throw new WorkspaceEnvironmentError("PATH_OUTSIDE_WORKSPACE", "path must be relative to the workspace");
  }
  const normalized = value.replaceAll("\\", "/").split("/").filter((segment) => segment !== "" && segment !== ".");
  if (normalized.length === 0 || normalized.some((segment) => segment === "..")) {
    throw new WorkspaceEnvironmentError("PATH_OUTSIDE_WORKSPACE", "path must stay inside the workspace");
  }
  return normalized.join("/");
}

function assertReadablePath(path: string): void {
  const first = path.split("/")[0];
  if (first !== undefined && PROTECTED_ROOTS.has(first)) {
    throw new WorkspaceEnvironmentError("PROTECTED_PATH", `${first} is controlled by Software Agent or the host toolchain`);
  }
  if (sensitivePath(path)) throw new WorkspaceEnvironmentError("SENSITIVE_PATH", `${path} may contain credentials`);
}

function assertWritablePath(path: string): void {
  assertReadablePath(path);
}

function sensitivePath(path: string): boolean {
  const name = basename(path).toLowerCase();
  if ([".env.example", ".env.sample", ".env.template"].includes(name)) return false;
  return /^\.env(?:\.|$)/u.test(name)
    || [".npmrc", ".pypirc", ".netrc", ".git-credentials", "credentials", "id_rsa", "id_ed25519"].includes(name)
    || /\.(?:pem|key|p12|pfx)$/u.test(name);
}

function assertContained(root: string, candidate: string): void {
  const distance = relative(root, candidate);
  if (distance === "" || (!distance.startsWith(`..${sep}`) && distance !== ".." && !isAbsolute(distance))) return;
  throw new WorkspaceEnvironmentError("PATH_OUTSIDE_WORKSPACE", `${candidate} is outside the workspace`);
}

function validateAuthority(authority: MutationAuthority): void {
  exactText(authority.leaseId, "leaseId", 512);
  exactText(authority.operationId, "operationId", 512);
  boundedInteger(authority.fencingEpoch, 1, Number.MAX_SAFE_INTEGER, "fencingEpoch");
}

function exactText(value: string, field: string, maxLength: number): void {
  if (value.length === 0 || value.trim() !== value || value.length > maxLength) {
    throw new WorkspaceEnvironmentError("INVALID_INPUT", `${field} must be non-empty, exact, and at most ${maxLength} characters`);
  }
}

function exactArgument(value: string, index: number): string {
  if (value.includes("\0") || value.length > 32_768) {
    throw new WorkspaceEnvironmentError("COMMAND_INVALID", `argument ${index} is invalid or too large`);
  }
  return value;
}

function boundedInteger(value: number, minimum: number, maximum: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new WorkspaceEnvironmentError("INVALID_LIMIT", `${field} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function digest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function minimalEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(SAFE_ENVIRONMENT_KEYS.flatMap((key) => source[key] === undefined ? [] : [[key, source[key]]]));
}

async function executeCommand(
  plan: CommandPlan,
  options: {readonly environment: NodeJS.ProcessEnv; readonly timeoutMs: number; readonly maxOutputBytes: number},
): Promise<CommandReceipt> {
  const started = Date.now();
  return new Promise((resolvePromise, reject) => {
    const child = spawn(plan.executable, [...plan.args], {
      cwd: plan.cwd,
      env: options.environment,
      detached: process.platform !== "win32",
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let capturedBytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;
    let outputLimitTerminationRequested = false;
    const capture = (target: Buffer[], chunk: Buffer): void => {
      const available = Math.max(0, options.maxOutputBytes - capturedBytes);
      if (available > 0) {
        const bounded = chunk.subarray(0, available);
        target.push(bounded);
        capturedBytes += bounded.byteLength;
      }
      if (chunk.byteLength > available) {
        truncated = true;
        if (!outputLimitTerminationRequested) {
          outputLimitTerminationRequested = true;
          void terminateProcessTree(child);
        }
      }
    };
    child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new WorkspaceEnvironmentError("COMMAND_START_FAILED", sanitizeTerminal(error.message)));
    });
    child.once("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(Object.freeze({
        executable: plan.executable,
        args: plan.args,
        cwd: plan.cwd,
        exitCode,
        signal,
        stdout: sanitizeTerminal(Buffer.concat(stdout).toString("utf8"), options.maxOutputBytes),
        stderr: sanitizeTerminal(Buffer.concat(stderr).toString("utf8"), options.maxOutputBytes),
        durationMs: Date.now() - started,
        timedOut,
        truncated,
      }));
    });
    const timer = setTimeout(() => {
      timedOut = true;
      void terminateProcessTree(child);
    }, options.timeoutMs);
  });
}

async function terminateProcessTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (pid === undefined || child.exitCode !== null) return;
  if (process.platform === "win32") {
    await new Promise<void>((resolvePromise) => {
      const killer = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], {shell: false, windowsHide: true, stdio: "ignore"});
      killer.once("error", () => {
        child.kill("SIGTERM");
        resolvePromise();
      });
      killer.once("close", () => resolvePromise());
    });
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}
