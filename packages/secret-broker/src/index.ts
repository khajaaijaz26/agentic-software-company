import {spawn} from "node:child_process";
import {platform as hostPlatform} from "node:os";

export type SecretScheme = "env" | "keychain" | "manager";

export interface SecretReference {
  readonly scheme: SecretScheme;
  readonly reference: string;
}

export interface SecretLease {
  readonly reference: SecretReference;
  value: string;
  readonly expiresAt: string;
}

export interface SecretBroker {
  resolve(reference: SecretReference, purpose: string, ttlSeconds?: number): Promise<SecretLease>;
  list(): Promise<readonly SecretReference[]>;
}

export interface CredentialBackend {
  readonly scheme: SecretScheme;
  get(reference: string): Promise<string>;
  list(): Promise<readonly string[]>;
  set?(reference: string, value: string): Promise<void>;
  delete?(reference: string): Promise<boolean>;
}

export interface CredentialCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface CredentialCommandOptions {
  readonly stdin?: string;
  readonly timeoutMs?: number;
}

export interface CredentialCommandRunner {
  run(command: string, args: readonly string[], options: CredentialCommandOptions): Promise<CredentialCommandResult>;
}

export interface EnvironmentSecretBrokerOptions {
  readonly scrubOnRead?: boolean;
  readonly now?: () => Date;
}

export class SecretUnavailableError extends Error {
  public readonly code = "SECRET_UNAVAILABLE";

  public constructor(public readonly reference: SecretReference) {
    super(`secret reference ${formatSecretReference(reference)} is unavailable`);
    this.name = "SecretUnavailableError";
  }
}

export class UnsupportedCredentialBackendError extends Error {
  public readonly code = "CREDENTIAL_BACKEND_UNSUPPORTED";

  public constructor(public readonly scheme: SecretScheme, reason: string) {
    super(`credential backend ${scheme} is unavailable: ${reason}`);
    this.name = "UnsupportedCredentialBackendError";
  }
}

export class EnvironmentCredentialBackend implements CredentialBackend {
  public readonly scheme = "env" as const;
  readonly #resolved = new Map<string, string>();

  public constructor(
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly scrubOnRead = true,
  ) {}

  public get(reference: string): Promise<string> {
    validateEnvironmentReference(reference);
    const cached = this.#resolved.get(reference);
    if (cached !== undefined) return Promise.resolve(cached);
    const value = this.environment[reference];
    if (value === undefined || value === "") {
      return Promise.reject(new SecretUnavailableError({scheme: this.scheme, reference}));
    }
    if (this.scrubOnRead) {
      this.#resolved.set(reference, value);
      Reflect.deleteProperty(this.environment, reference);
    }
    return Promise.resolve(value);
  }

  public list(): Promise<readonly string[]> {
    // Environment names are intentionally not enumerated because doing so would
    // disclose unrelated process configuration to provider-management callers.
    return Promise.resolve([]);
  }
}

export class SecretBackendBroker implements SecretBroker {
  readonly #backends = new Map<SecretScheme, CredentialBackend>();
  readonly #now: () => Date;

  public constructor(backends: readonly CredentialBackend[], now: () => Date = () => new Date()) {
    this.#now = now;
    for (const backend of backends) {
      if (this.#backends.has(backend.scheme)) throw new Error(`duplicate credential backend: ${backend.scheme}`);
      this.#backends.set(backend.scheme, backend);
    }
  }

  public async resolve(reference: SecretReference, purpose: string, ttlSeconds = 300): Promise<SecretLease> {
    validateSecretReference(reference);
    if (purpose.trim() === "" || purpose.length > 512) throw new Error("secret purpose must be between 1 and 512 characters");
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 3_600) {
      throw new Error("secret lease TTL must be an integer from 1 to 3600 seconds");
    }
    const backend = this.#backends.get(reference.scheme);
    if (!backend) throw new UnsupportedCredentialBackendError(reference.scheme, "no backend is configured");
    const value = await backend.get(reference.reference);
    if (value === "") throw new SecretUnavailableError(reference);
    return {
      reference: Object.freeze({...reference}),
      value,
      expiresAt: new Date(this.#now().getTime() + ttlSeconds * 1_000).toISOString(),
    };
  }

  public async list(): Promise<readonly SecretReference[]> {
    const result: SecretReference[] = [];
    for (const backend of this.#backends.values()) {
      const names = await backend.list();
      for (const reference of names) result.push(Object.freeze({scheme: backend.scheme, reference}));
    }
    return Object.freeze(result);
  }

  public async set(reference: SecretReference, value: string): Promise<void> {
    validateSecretReference(reference);
    if (value === "") throw new Error("secret value must not be empty");
    const backend = this.#backends.get(reference.scheme);
    if (!backend?.set) throw new UnsupportedCredentialBackendError(reference.scheme, "secure writes are not supported");
    await backend.set(reference.reference, value);
  }

  public async delete(reference: SecretReference): Promise<boolean> {
    validateSecretReference(reference);
    const backend = this.#backends.get(reference.scheme);
    if (!backend?.delete) throw new UnsupportedCredentialBackendError(reference.scheme, "secure deletion is not supported");
    return backend.delete(reference.reference);
  }
}

export class EnvironmentSecretBroker implements SecretBroker {
  readonly #broker: SecretBackendBroker;

  public constructor(environment: NodeJS.ProcessEnv = process.env, options: EnvironmentSecretBrokerOptions = {}) {
    this.#broker = new SecretBackendBroker(
      [new EnvironmentCredentialBackend(environment, options.scrubOnRead ?? true)],
      options.now,
    );
  }

  public resolve(reference: SecretReference, purpose: string, ttlSeconds?: number): Promise<SecretLease> {
    return this.#broker.resolve(reference, purpose, ttlSeconds);
  }

  public list(): Promise<readonly SecretReference[]> {
    return this.#broker.list();
  }
}

export class SpawnCredentialCommandRunner implements CredentialCommandRunner {
  public run(command: string, args: readonly string[], options: CredentialCommandOptions): Promise<CredentialCommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, [...args], {
        env: scrubSecretEnvironment(process.env),
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, options.timeoutMs ?? 10_000);
      timeout.unref();
      const collect = (target: Buffer[]) => (chunk: Buffer) => {
        outputBytes += chunk.byteLength;
        if (outputBytes > 64 * 1024) {
          child.kill();
          return;
        }
        target.push(chunk);
      };
      child.stdout.on("data", collect(stdout));
      child.stderr.on("data", collect(stderr));
      child.once("error", () => {
        clearTimeout(timeout);
        reject(new UnsupportedCredentialBackendError("keychain", "credential command could not be started"));
      });
      child.once("close", (code) => {
        clearTimeout(timeout);
        if (timedOut) {
          reject(new UnsupportedCredentialBackendError("keychain", "credential command timed out"));
          return;
        }
        if (outputBytes > 64 * 1024) {
          reject(new UnsupportedCredentialBackendError("keychain", "credential command output exceeded its limit"));
          return;
        }
        resolve({
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          exitCode: code ?? 1,
        });
      });
      child.stdin.end(options.stdin);
    });
  }
}

abstract class CommandCredentialBackend implements CredentialBackend {
  public readonly scheme = "keychain" as const;

  protected constructor(protected readonly runner: CredentialCommandRunner) {}

  public abstract get(reference: string): Promise<string>;

  public list(): Promise<readonly string[]> {
    // Platform keychain CLIs do not expose a consistent, safely bounded list.
    return Promise.resolve([]);
  }

  protected async successful(command: string, args: readonly string[], options: CredentialCommandOptions = {}): Promise<string> {
    const result = await this.runner.run(command, args, options);
    if (result.exitCode !== 0) throw new SecretUnavailableError({scheme: this.scheme, reference: "requested-entry"});
    return stripOneLineEnding(result.stdout);
  }
}

export class LinuxSecretServiceBackend extends CommandCredentialBackend {
  public constructor(runner: CredentialCommandRunner = new SpawnCredentialCommandRunner()) {
    super(runner);
  }

  public get(reference: string): Promise<string> {
    validateOpaqueReference(reference);
    return this.successful("secret-tool", ["lookup", "application", "software-agent", "account", reference]);
  }

  public async set(reference: string, value: string): Promise<void> {
    validateOpaqueReference(reference);
    const result = await this.runner.run(
      "secret-tool",
      ["store", "--label=Software Agent", "application", "software-agent", "account", reference],
      {stdin: value, timeoutMs: 10_000},
    );
    if (result.exitCode !== 0) throw new UnsupportedCredentialBackendError(this.scheme, "Secret Service rejected the write");
  }

  public async delete(reference: string): Promise<boolean> {
    validateOpaqueReference(reference);
    const result = await this.runner.run(
      "secret-tool",
      ["clear", "application", "software-agent", "account", reference],
      {timeoutMs: 10_000},
    );
    return result.exitCode === 0;
  }
}

export class MacOSKeychainBackend extends CommandCredentialBackend {
  public constructor(runner: CredentialCommandRunner = new SpawnCredentialCommandRunner()) {
    super(runner);
  }

  public get(reference: string): Promise<string> {
    validateOpaqueReference(reference);
    return this.successful("security", ["find-generic-password", "-a", reference, "-s", "software-agent", "-w"]);
  }

  public set(reference: string, value: string): Promise<void> {
    void reference;
    void value;
    return Promise.reject(new UnsupportedCredentialBackendError(
      this.scheme,
      "the built-in security CLI cannot accept a new password without argv exposure; use env:// until a native helper is installed",
    ));
  }

  public async delete(reference: string): Promise<boolean> {
    validateOpaqueReference(reference);
    const result = await this.runner.run(
      "security",
      ["delete-generic-password", "-a", reference, "-s", "software-agent"],
      {timeoutMs: 10_000},
    );
    return result.exitCode === 0;
  }
}

export class UnsupportedCredentialBackend implements CredentialBackend {
  public readonly scheme = "keychain" as const;

  public constructor(private readonly reason: string) {}

  public get(reference: string): Promise<string> {
    void reference;
    return Promise.reject(new UnsupportedCredentialBackendError(this.scheme, this.reason));
  }

  public list(): Promise<readonly string[]> {
    return Promise.resolve([]);
  }
}

export interface PlatformCredentialBackendOptions {
  readonly platform?: NodeJS.Platform;
  readonly runner?: CredentialCommandRunner;
  readonly commandAvailable?: (command: string) => boolean;
}

export function createPlatformCredentialBackend(options: PlatformCredentialBackendOptions = {}): CredentialBackend {
  const system = options.platform ?? hostPlatform();
  const runner = options.runner ?? new SpawnCredentialCommandRunner();
  const available = options.commandAvailable ?? (() => true);
  if (system === "linux") {
    return available("secret-tool")
      ? new LinuxSecretServiceBackend(runner)
      : new UnsupportedCredentialBackend("Secret Service command 'secret-tool' is not installed; configure env:// instead");
  }
  if (system === "darwin") {
    return available("security")
      ? new MacOSKeychainBackend(runner)
      : new UnsupportedCredentialBackend("macOS Keychain command 'security' is unavailable; configure env:// instead");
  }
  if (system === "win32") {
    return new UnsupportedCredentialBackend(
      "a safe Credential Manager helper is not installed; plaintext and cmdkey argv fallbacks are prohibited, so configure env:// instead",
    );
  }
  return new UnsupportedCredentialBackend(`platform ${system} has no supported credential-store adapter; configure env:// instead`);
}

const COMMON_PROVIDER_SECRET_NAMES = new Set([
  "ANTHROPIC_API_KEY",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
]);

export function scrubSecretEnvironment(
  environment: NodeJS.ProcessEnv,
  references: readonly SecretReference[] = [],
): NodeJS.ProcessEnv {
  const denied = new Set(COMMON_PROVIDER_SECRET_NAMES);
  for (const reference of references) {
    if (reference.scheme === "env") denied.add(reference.reference);
  }
  return Object.fromEntries(Object.entries(environment).filter(([name]) => !denied.has(name)));
}

export function parseSecretReference(value: string): SecretReference {
  const match = /^(env|keychain|manager):\/\/(.+)$/u.exec(value);
  if (!match) throw new Error("secret references must use env://, keychain://, or manager://");
  const scheme = match[1] as SecretScheme | undefined;
  const reference = match[2];
  if (scheme === undefined || reference === undefined) throw new Error("invalid secret reference");
  const parsed = {scheme, reference};
  validateSecretReference(parsed);
  return Object.freeze(parsed);
}

export async function withSecretLease<T>(
  broker: SecretBroker,
  reference: SecretReference,
  purpose: string,
  callback: (value: string) => Promise<T>,
): Promise<T> {
  const lease = await broker.resolve(reference, purpose);
  try {
    return await callback(lease.value);
  } finally {
    lease.value = "";
  }
}

function validateSecretReference(reference: SecretReference): void {
  if (reference.scheme === "env") validateEnvironmentReference(reference.reference);
  else validateOpaqueReference(reference.reference);
}

function validateEnvironmentReference(reference: string): void {
  if (!/^[A-Z][A-Z0-9_]{1,127}$/u.test(reference)) throw new Error("invalid environment secret reference");
}

function validateOpaqueReference(reference: string): void {
  if (reference.length < 1 || reference.length > 256 || hasControlCharacters(reference)) {
    throw new Error("invalid credential-store reference");
  }
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function formatSecretReference(reference: SecretReference): string {
  return `${reference.scheme}://${reference.reference}`;
}

function stripOneLineEnding(value: string): string {
  return value.replace(/\r?\n$/u, "");
}
