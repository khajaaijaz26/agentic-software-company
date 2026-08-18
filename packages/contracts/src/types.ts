export const CONTRACT_SCHEMA_VERSION = 1 as const;

export type ContractSchemaVersion = typeof CONTRACT_SCHEMA_VERSION;

export type JsonPrimitive = string | number | boolean | null;

export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type JsonObject = { readonly [key: string]: JsonValue };

export const ACTOR_TYPES = ["human", "agent", "system"] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

export interface ActorRef {
  readonly type: ActorType;
  readonly id: string;
}

export const EXTERNAL_CONNECTORS = ["github", "vercel", "supabase"] as const;
export type ExternalConnector = (typeof EXTERNAL_CONNECTORS)[number];

export const CONTROL_BOUNDARIES = ["local", ...EXTERNAL_CONNECTORS] as const;
export type ControlBoundary = (typeof CONTROL_BOUNDARIES)[number];

// Kept as the canonical runtime validation list for operation envelopes. The
// three entries in EXTERNAL_CONNECTORS remain the only connected platforms.
export const CONNECTORS = CONTROL_BOUNDARIES;
export type Connector = ControlBoundary;

export const ENVIRONMENTS = [
  "local",
  "development",
  "preview",
  "staging",
  "production",
] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

export interface OperationDescriptor {
  readonly schemaVersion: ContractSchemaVersion;
  readonly actor: ActorRef;
  readonly connector: Connector;
  readonly action: string;
  readonly resource: string;
  readonly environment: Environment;
  readonly artifactSha256: string | null;
  readonly parameters: JsonObject;
}

export interface OperationCandidate extends OperationDescriptor {
  readonly operationHash: string;
}

export interface ApprovalBinding {
  readonly schemaVersion: ContractSchemaVersion;
  readonly actor: ActorRef;
  readonly connector: Connector;
  readonly action: string;
  readonly resource: string;
  readonly environment: Environment;
  readonly artifactSha256: string | null;
  readonly operationHash: string;
}

export interface EventEnvelope<TData extends JsonObject = JsonObject> {
  readonly schemaVersion: ContractSchemaVersion;
  readonly eventId: string;
  readonly streamId: string;
  readonly eventType: string;
  readonly occurredAt: string;
  readonly actor: ActorRef;
  readonly data: TData;
  readonly metadata?: JsonObject;
}

export interface StoredEvent<TData extends JsonObject = JsonObject>
  extends EventEnvelope<TData> {
  readonly sequence: number;
  readonly streamVersion: number;
}

export interface CommandReceipt<TResponse extends JsonValue = JsonValue> {
  readonly schemaVersion: ContractSchemaVersion;
  readonly commandId: string;
  readonly operationHash: string;
  readonly streamId: string;
  readonly firstSequence: number;
  readonly lastSequence: number;
  readonly response: TResponse;
  readonly createdAt: string;
}
