export interface SecretReference {
  readonly scheme: "env" | "keychain" | "manager";
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

export class EnvironmentSecretBroker implements SecretBroker {
  public constructor(private readonly environment: NodeJS.ProcessEnv = process.env) {}

  public resolve(reference: SecretReference, purpose: string, ttlSeconds = 300): Promise<SecretLease> {
    if (reference.scheme !== "env") return Promise.reject(new Error(`unsupported secret scheme: ${reference.scheme}`));
    if (!/^[A-Z][A-Z0-9_]{1,127}$/u.test(reference.reference)) return Promise.reject(new Error("invalid environment secret reference"));
    const value = this.environment[reference.reference];
    if (!value) return Promise.reject(new Error(`secret reference ${reference.reference} is unavailable for ${purpose}`));
    return Promise.resolve({
      reference,
      value,
      expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
    });
  }

  public list(): Promise<readonly SecretReference[]> {
    return Promise.resolve([]);
  }
}

export function parseSecretReference(value: string): SecretReference {
  const match = /^(env|keychain|manager):\/\/(.+)$/u.exec(value);
  if (!match) throw new Error("secret references must use env://, keychain://, or manager://");
  const scheme = match[1];
  const reference = match[2];
  if (scheme === undefined || reference === undefined || reference === "") throw new Error("invalid secret reference");
  return {scheme: scheme as SecretReference["scheme"], reference};
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
