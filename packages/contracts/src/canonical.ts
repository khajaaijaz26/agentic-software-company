import { createHash } from "node:crypto";

import {
  ACTOR_TYPES,
  CONNECTORS,
  CONTRACT_SCHEMA_VERSION,
  ENVIRONMENTS,
  type ActorRef,
  type ApprovalBinding,
  type JsonObject,
  type JsonValue,
  type OperationCandidate,
  type OperationDescriptor,
} from "./types.js";

export class CanonicalizationError extends TypeError {
  public constructor(message: string) {
    super(message);
    this.name = "CanonicalizationError";
  }
}

function canonicalNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new CanonicalizationError("canonical JSON does not permit non-finite numbers");
  }
  if (Object.is(value, -0)) {
    return "0";
  }
  return JSON.stringify(value);
}

function assertPlainObject(value: object): void {
  const prototype: object | null = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new CanonicalizationError("canonical JSON accepts only arrays and plain objects");
  }
}

function canonicalizeInner(value: JsonValue, ancestors: ReadonlySet<object>): string {
  if (value === null) {
    return "null";
  }

  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
      return canonicalNumber(value);
    case "boolean":
      return value ? "true" : "false";
    case "object": {
      if (ancestors.has(value)) {
        throw new CanonicalizationError("canonical JSON does not permit cyclic values");
      }
      const nextAncestors = new Set(ancestors);
      nextAncestors.add(value);

      if (Array.isArray(value)) {
        const arrayValue = value as readonly JsonValue[];
        return `[${arrayValue.map((item) => canonicalizeInner(item, nextAncestors)).join(",")}]`;
      }

      assertPlainObject(value);
      const objectValue = value as JsonObject;
      const entries = Object.keys(objectValue)
        .sort()
        .map((key) => {
          const item = objectValue[key];
          if (item === undefined) {
            throw new CanonicalizationError(`undefined value at key '${key}'`);
          }
          return `${JSON.stringify(key)}:${canonicalizeInner(item, nextAncestors)}`;
        });
      return `{${entries.join(",")}}`;
    }
    default:
      throw new CanonicalizationError(`unsupported canonical JSON value: ${typeof value}`);
  }
}

export function canonicalize(value: JsonValue): string {
  return canonicalizeInner(value, new Set<object>());
}

export function sha256Bytes(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function sha256Canonical(value: JsonValue): string {
  return sha256Bytes(canonicalize(value));
}

export function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

function assertExactNonEmpty(value: string, field: string): void {
  if (value.length === 0 || value.trim() !== value) {
    throw new TypeError(`${field} must be non-empty and have no surrounding whitespace`);
  }
}

function assertActor(actor: ActorRef): void {
  if (!isAllowedValue(ACTOR_TYPES, actor.type)) {
    throw new TypeError(`unsupported actor type: ${actor.type}`);
  }
  assertExactNonEmpty(actor.id, "actor.id");
}

function isAllowedValue(values: readonly string[], value: unknown): boolean {
  return typeof value === "string" && values.includes(value);
}

function descriptorJson(descriptor: OperationDescriptor): JsonObject {
  return {
    schemaVersion: descriptor.schemaVersion,
    actor: { type: descriptor.actor.type, id: descriptor.actor.id },
    connector: descriptor.connector,
    action: descriptor.action,
    resource: descriptor.resource,
    environment: descriptor.environment,
    artifactSha256: descriptor.artifactSha256,
    parameters: descriptor.parameters,
  };
}

export function operationHash(descriptor: OperationDescriptor): string {
  return sha256Canonical(descriptorJson(descriptor));
}

function cloneJsonObject(value: JsonObject): JsonObject {
  return JSON.parse(canonicalize(value)) as JsonObject;
}

function deepFreezeJson<T extends JsonValue>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) {
      deepFreezeJson(child);
    }
    Object.freeze(value);
  }
  return value;
}

export function createOperationCandidate(
  input: Omit<OperationDescriptor, "schemaVersion"> & {
    readonly schemaVersion?: number;
  },
): OperationCandidate {
  const requestedSchemaVersion = input.schemaVersion ?? CONTRACT_SCHEMA_VERSION;
  if (requestedSchemaVersion !== CONTRACT_SCHEMA_VERSION) {
    throw new TypeError(`unsupported operation schema version: ${requestedSchemaVersion}`);
  }
  const schemaVersion: typeof CONTRACT_SCHEMA_VERSION = CONTRACT_SCHEMA_VERSION;
  assertActor(input.actor);
  if (!isAllowedValue(CONNECTORS, input.connector)) {
    throw new TypeError(`unsupported connector: ${input.connector}`);
  }
  if (!isAllowedValue(ENVIRONMENTS, input.environment)) {
    throw new TypeError(`unsupported environment: ${input.environment}`);
  }
  assertExactNonEmpty(input.action, "action");
  if (!/^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/.test(input.action)) {
    throw new TypeError("action must be a normalized lower-case identifier");
  }
  assertExactNonEmpty(input.resource, "resource");
  if (input.artifactSha256 !== null && !isSha256(input.artifactSha256)) {
    throw new TypeError("artifactSha256 must be null or a lower-case SHA-256 digest");
  }

  const parameters = deepFreezeJson(cloneJsonObject(input.parameters));
  const descriptor: OperationDescriptor = Object.freeze({
    schemaVersion,
    actor: Object.freeze({ ...input.actor }),
    connector: input.connector,
    action: input.action,
    resource: input.resource,
    environment: input.environment,
    artifactSha256: input.artifactSha256,
    parameters,
  });

  return Object.freeze({ ...descriptor, operationHash: operationHash(descriptor) });
}

export function hasOperationIntegrity(candidate: OperationCandidate): boolean {
  return isSha256(candidate.operationHash) && operationHash(candidate) === candidate.operationHash;
}

export function approvalBindingFor(candidate: OperationCandidate): ApprovalBinding {
  if (!hasOperationIntegrity(candidate)) {
    throw new TypeError("operation candidate hash does not match its canonical contents");
  }
  return Object.freeze({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    actor: Object.freeze({ ...candidate.actor }),
    connector: candidate.connector,
    action: candidate.action,
    resource: candidate.resource,
    environment: candidate.environment,
    artifactSha256: candidate.artifactSha256,
    operationHash: candidate.operationHash,
  });
}

export function approvalBindingHash(binding: ApprovalBinding): string {
  return sha256Canonical({
    schemaVersion: binding.schemaVersion,
    actor: { type: binding.actor.type, id: binding.actor.id },
    connector: binding.connector,
    action: binding.action,
    resource: binding.resource,
    environment: binding.environment,
    artifactSha256: binding.artifactSha256,
    operationHash: binding.operationHash,
  });
}
