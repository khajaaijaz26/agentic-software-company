import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import {
  ACTOR_TYPES,
  CONNECTORS,
  CONTRACT_SCHEMA_VERSION,
  ENVIRONMENTS,
  approvalBindingHash,
  canonicalize,
  isSha256,
  type ActorRef,
  type ApprovalBinding,
  type JsonObject,
} from "../../contracts/src/index.js";

export const APPROVAL_STATUSES = [
  "PENDING",
  "APPROVED",
  "DENIED",
  "CHANGES_REQUESTED",
  "CANCELED",
  "SUPERSEDED",
  "EXPIRED",
  "CONSUMED",
  "INVALIDATED",
] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];
export type HumanApprovalDecision = "APPROVED" | "DENIED" | "CHANGES_REQUESTED";

const APPROVAL_TRANSITIONS: Readonly<Record<ApprovalStatus, readonly ApprovalStatus[]>> = {
  PENDING: [
    "APPROVED",
    "DENIED",
    "CHANGES_REQUESTED",
    "CANCELED",
    "SUPERSEDED",
    "EXPIRED",
    "INVALIDATED",
  ],
  APPROVED: ["CONSUMED", "CANCELED", "SUPERSEDED", "EXPIRED", "INVALIDATED"],
  CHANGES_REQUESTED: ["SUPERSEDED", "CANCELED", "EXPIRED"],
  DENIED: [],
  CANCELED: [],
  SUPERSEDED: [],
  EXPIRED: [],
  CONSUMED: [],
  INVALIDATED: [],
};

export function canTransitionApproval(from: ApprovalStatus, to: ApprovalStatus): boolean {
  return APPROVAL_TRANSITIONS[from].includes(to);
}

export interface ApprovalRecord {
  readonly schemaVersion: typeof CONTRACT_SCHEMA_VERSION;
  readonly approvalId: string;
  readonly binding: ApprovalBinding;
  readonly bindingHash: string;
  readonly status: ApprovalStatus;
  readonly requestedAt: string;
  readonly expiresAt: string;
  readonly decidedAt: string | null;
  readonly decidedBy: ActorRef | null;
  readonly decisionReason: string;
  readonly consumedAt: string | null;
  readonly terminalAt: string | null;
}

export interface RequestApprovalInput {
  readonly approvalId?: string;
  readonly binding: ApprovalBinding;
  readonly requestedAt: string;
  readonly expiresAt: string;
}

export interface DecideApprovalInput {
  readonly approvalId: string;
  readonly approver: ActorRef;
  readonly decision: HumanApprovalDecision;
  readonly decidedAt: string;
  readonly reason?: string;
}

export interface ConsumeApprovalInput {
  readonly approvalId: string;
  readonly binding: ApprovalBinding;
  readonly consumedAt: string;
}

export interface ApprovalAuthorization {
  readonly schema: "software-agent.approval-authorization/v1" | "agent-company.approval-authorization/v1";
  readonly approvalId: string;
  readonly bindingHash: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly nonce: string;
}

export class ApprovalError extends Error {}

export class ApprovalTokenError extends ApprovalError {
  public constructor(message = "approval authorization token is invalid") {
    super(message);
    this.name = "ApprovalTokenError";
  }
}

export class ApprovalNotFoundError extends ApprovalError {
  public constructor(approvalId: string) {
    super(`unknown approval: ${approvalId}`);
    this.name = "ApprovalNotFoundError";
  }
}

export class ApprovalBindingMismatchError extends ApprovalError {
  public constructor() {
    super("approval does not exactly match actor/action/resource/environment/artifact/operation hash");
    this.name = "ApprovalBindingMismatchError";
  }
}

export class ApprovalExpiredError extends ApprovalError {
  public constructor(approvalId: string) {
    super(`approval '${approvalId}' has expired`);
    this.name = "ApprovalExpiredError";
  }
}

export class ApprovalAlreadyConsumedError extends ApprovalError {
  public constructor(approvalId: string) {
    super(`approval '${approvalId}' has already been consumed`);
    this.name = "ApprovalAlreadyConsumedError";
  }
}

export class ApprovalStateError extends ApprovalError {
  public constructor(approvalId: string, status: ApprovalStatus) {
    super(`approval '${approvalId}' cannot perform this transition from '${status}'`);
    this.name = "ApprovalStateError";
  }
}

type SqliteRow = Record<string, unknown>;

function exact(value: string, field: string): void {
  if (value.length === 0 || value.trim() !== value) {
    throw new TypeError(`${field} must be non-empty and have no surrounding whitespace`);
  }
}

function timestamp(value: string, field: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new TypeError(`${field} must be an ISO timestamp`);
  }
  return parsed;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new ApprovalError(`invalid persisted text column '${field}'`);
  }
  return value;
}

function nullableText(value: unknown, field: string): string | null {
  return value === null ? null : text(value, field);
}

function bindingJson(binding: ApprovalBinding): JsonObject {
  return {
    schemaVersion: binding.schemaVersion,
    actor: { type: binding.actor.type, id: binding.actor.id },
    connector: binding.connector,
    action: binding.action,
    resource: binding.resource,
    environment: binding.environment,
    artifactSha256: binding.artifactSha256,
    operationHash: binding.operationHash,
  };
}

function isAllowedValue(values: readonly string[], value: unknown): boolean {
  return typeof value === "string" && values.includes(value);
}

function validateBinding(binding: ApprovalBinding): void {
  if (!isAllowedValue([String(CONTRACT_SCHEMA_VERSION)], String(binding.schemaVersion))) {
    throw new TypeError(`unsupported approval schema version: ${binding.schemaVersion}`);
  }
  if (!isAllowedValue(ACTOR_TYPES, binding.actor.type)) {
    throw new TypeError(`invalid approval actor type: ${binding.actor.type}`);
  }
  exact(binding.actor.id, "binding.actor.id");
  if (!isAllowedValue(CONNECTORS, binding.connector)) {
    throw new TypeError(`invalid connector: ${binding.connector}`);
  }
  if (!isAllowedValue(ENVIRONMENTS, binding.environment)) {
    throw new TypeError(`invalid environment: ${binding.environment}`);
  }
  exact(binding.action, "binding.action");
  exact(binding.resource, "binding.resource");
  if (binding.artifactSha256 !== null && !isSha256(binding.artifactSha256)) {
    throw new TypeError("binding artifact must be null or a lower-case SHA-256 digest");
  }
  if (!isSha256(binding.operationHash)) {
    throw new TypeError("binding operationHash must be a lower-case SHA-256 digest");
  }
}

function actorJson(actor: ActorRef): string {
  return canonicalize({ type: actor.type, id: actor.id });
}

function parseActor(value: unknown, field: string): ActorRef | null {
  if (value === null) {
    return null;
  }
  const parsed = JSON.parse(text(value, field)) as Record<string, unknown>;
  if (
    typeof parsed.type !== "string" ||
    !(ACTOR_TYPES as readonly string[]).includes(parsed.type) ||
    typeof parsed.id !== "string"
  ) {
    throw new ApprovalError(`invalid persisted actor column '${field}'`);
  }
  return Object.freeze({ type: parsed.type as ActorRef["type"], id: parsed.id });
}

function parseBinding(value: unknown): ApprovalBinding {
  const parsed = JSON.parse(text(value, "binding_json")) as Record<string, unknown>;
  const actor = parsed.actor as Record<string, unknown> | undefined;
  const binding = {
    schemaVersion: parsed.schemaVersion,
    actor: { type: actor?.type, id: actor?.id },
    connector: parsed.connector,
    action: parsed.action,
    resource: parsed.resource,
    environment: parsed.environment,
    artifactSha256: parsed.artifactSha256,
    operationHash: parsed.operationHash,
  } as ApprovalBinding;
  validateBinding(binding);
  return Object.freeze({ ...binding, actor: Object.freeze({ ...binding.actor }) });
}

export class ApprovalService {
  readonly #database: DatabaseSync;
  readonly #signingKey: Buffer;

  public constructor(filename: string) {
    exact(filename, "filename");
    this.#database = new DatabaseSync(filename);
    this.#database.exec("PRAGMA foreign_keys = ON");
    this.#database.exec("PRAGMA busy_timeout = 5000");
    this.#database.exec("PRAGMA journal_mode = WAL");
    this.#database.exec("PRAGMA synchronous = FULL");
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS approvals (
        approval_id TEXT PRIMARY KEY,
        binding_hash TEXT NOT NULL,
        binding_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (
          status IN (
            'PENDING', 'APPROVED', 'DENIED', 'CHANGES_REQUESTED', 'CANCELED',
            'SUPERSEDED', 'EXPIRED', 'CONSUMED', 'INVALIDATED'
          )
        ),
        requested_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        decided_at TEXT,
        decided_by_json TEXT,
        decision_reason TEXT NOT NULL DEFAULT '',
        consumed_at TEXT,
        terminal_at TEXT,
        schema_version INTEGER NOT NULL CHECK (schema_version = 1)
      );
      CREATE TABLE IF NOT EXISTS approval_signing_key (
        key_id INTEGER PRIMARY KEY CHECK (key_id = 1),
        secret BLOB NOT NULL CHECK (length(secret) = 32)
      );
    `);
    this.#database.prepare("INSERT OR IGNORE INTO approval_signing_key(key_id, secret) VALUES(1, ?)").run(randomBytes(32));
    const keyRow = this.#database.prepare("SELECT secret FROM approval_signing_key WHERE key_id = 1").get() as SqliteRow | undefined;
    if (keyRow === undefined || !(keyRow.secret instanceof Uint8Array) || keyRow.secret.byteLength !== 32) {
      throw new ApprovalError("approval signing key is unavailable");
    }
    this.#signingKey = Buffer.from(keyRow.secret);
  }

  public close(): void {
    this.#database.close();
    this.#signingKey.fill(0);
  }

  public issueAuthorization(approvalId: string, issuedAt: string): string {
    const record = this.#require(approvalId);
    if (record.status !== "APPROVED") {
      throw new ApprovalStateError(approvalId, record.status);
    }
    const issued = timestamp(issuedAt, "issuedAt");
    if (issued >= timestamp(record.expiresAt, "expiresAt")) {
      throw new ApprovalExpiredError(approvalId);
    }
    const authorization: ApprovalAuthorization = Object.freeze({
      schema: "software-agent.approval-authorization/v1",
      approvalId,
      bindingHash: record.bindingHash,
      issuedAt,
      expiresAt: record.expiresAt,
      nonce: randomBytes(18).toString("base64url"),
    });
    const payload = Buffer.from(canonicalize({
      schema: authorization.schema,
      approvalId: authorization.approvalId,
      bindingHash: authorization.bindingHash,
      issuedAt: authorization.issuedAt,
      expiresAt: authorization.expiresAt,
      nonce: authorization.nonce,
    }), "utf8").toString("base64url");
    const signature = this.#sign(payload);
    return `${payload}.${signature}`;
  }

  public consumeAuthorization(token: string, binding: ApprovalBinding, consumedAt: string): ApprovalRecord {
    const authorization = this.#verifyAuthorization(token);
    const record = this.#require(authorization.approvalId);
    if (record.bindingHash !== authorization.bindingHash || approvalBindingHash(binding) !== authorization.bindingHash) {
      throw new ApprovalBindingMismatchError();
    }
    if (authorization.expiresAt !== record.expiresAt || timestamp(consumedAt, "consumedAt") >= timestamp(authorization.expiresAt, "expiresAt")) {
      throw new ApprovalExpiredError(authorization.approvalId);
    }
    return this.consume({approvalId: authorization.approvalId, binding, consumedAt});
  }

  public request(input: RequestApprovalInput): ApprovalRecord {
    validateBinding(input.binding);
    const approvalId = input.approvalId ?? `apr_${randomUUID()}`;
    exact(approvalId, "approvalId");
    const requestedAt = timestamp(input.requestedAt, "requestedAt");
    const expiresAt = timestamp(input.expiresAt, "expiresAt");
    if (expiresAt <= requestedAt) {
      throw new TypeError("approval expiry must be after its request time");
    }
    const bindingHash = approvalBindingHash(input.binding);
    this.#database
      .prepare(`
        INSERT INTO approvals (
          approval_id, binding_hash, binding_json, status, requested_at, expires_at,
          schema_version
        ) VALUES (?, ?, ?, 'PENDING', ?, ?, ?)
      `)
      .run(
        approvalId,
        bindingHash,
        canonicalize(bindingJson(input.binding)),
        input.requestedAt,
        input.expiresAt,
        CONTRACT_SCHEMA_VERSION,
      );
    return this.#require(approvalId);
  }

  public get(approvalId: string): ApprovalRecord | null {
    exact(approvalId, "approvalId");
    const row = this.#database.prepare("SELECT * FROM approvals WHERE approval_id = ?").get(
      approvalId,
    ) as SqliteRow | undefined;
    return row === undefined ? null : this.#record(row);
  }

  public list(resource?: string): readonly ApprovalRecord[] {
    if (resource !== undefined) exact(resource, "resource");
    const rows = (resource === undefined
      ? this.#database.prepare("SELECT * FROM approvals ORDER BY requested_at DESC, approval_id DESC").all()
      : this.#database.prepare(`
          SELECT * FROM approvals
          WHERE json_extract(binding_json, '$.resource') = ?
          ORDER BY requested_at DESC, approval_id DESC
        `).all(resource)) as SqliteRow[];
    return Object.freeze(rows.map((row) => this.#record(row)));
  }

  public decide(input: DecideApprovalInput): ApprovalRecord {
    exact(input.approvalId, "approvalId");
    if (input.approver.type !== "human") {
      throw new TypeError("only a human actor may resolve an approval");
    }
    if (!isAllowedValue(["APPROVED", "DENIED", "CHANGES_REQUESTED"], input.decision)) {
      throw new TypeError(`unsupported human approval decision: ${input.decision}`);
    }
    exact(input.approver.id, "approver.id");
    const decisionTime = timestamp(input.decidedAt, "decidedAt");
    let expired = false;

    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.#require(input.approvalId);
      if (current.status !== "PENDING") {
        throw new ApprovalStateError(current.approvalId, current.status);
      }
      if (decisionTime >= timestamp(current.expiresAt, "expiresAt")) {
        this.#database
          .prepare(
            "UPDATE approvals SET status = 'EXPIRED', terminal_at = ? WHERE approval_id = ? AND status = 'PENDING'",
          )
          .run(input.decidedAt, input.approvalId);
        expired = true;
      } else {
        this.#database
          .prepare(`
            UPDATE approvals
            SET status = ?, decided_at = ?, decided_by_json = ?, decision_reason = ?
            WHERE approval_id = ? AND status = 'PENDING'
          `)
          .run(
            input.decision,
            input.decidedAt,
            actorJson(input.approver),
            input.reason ?? "",
            input.approvalId,
          );
      }
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }

    if (expired) {
      throw new ApprovalExpiredError(input.approvalId);
    }
    return this.#require(input.approvalId);
  }

  public consume(input: ConsumeApprovalInput): ApprovalRecord {
    exact(input.approvalId, "approvalId");
    validateBinding(input.binding);
    const consumeTime = timestamp(input.consumedAt, "consumedAt");
    let expired = false;

    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.#require(input.approvalId);
      const suppliedBinding = canonicalize(bindingJson(input.binding));
      const storedBinding = canonicalize(bindingJson(current.binding));
      if (
        current.bindingHash !== approvalBindingHash(input.binding) ||
        storedBinding !== suppliedBinding
      ) {
        throw new ApprovalBindingMismatchError();
      }
      if (current.status === "CONSUMED") {
        throw new ApprovalAlreadyConsumedError(current.approvalId);
      }
      if (current.status !== "APPROVED") {
        throw new ApprovalStateError(current.approvalId, current.status);
      }
      if (consumeTime >= timestamp(current.expiresAt, "expiresAt")) {
        this.#database
          .prepare(
            "UPDATE approvals SET status = 'EXPIRED', terminal_at = ? WHERE approval_id = ? AND status = 'APPROVED'",
          )
          .run(input.consumedAt, input.approvalId);
        expired = true;
      } else {
        const result = this.#database
          .prepare(`
            UPDATE approvals
            SET status = 'CONSUMED', consumed_at = ?
            WHERE approval_id = ? AND status = 'APPROVED'
          `)
          .run(input.consumedAt, input.approvalId);
        if (Number(result.changes) !== 1) {
          throw new ApprovalStateError(input.approvalId, current.status);
        }
      }
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }

    if (expired) {
      throw new ApprovalExpiredError(input.approvalId);
    }
    return this.#require(input.approvalId);
  }

  public cancel(approvalId: string, canceledAt: string): ApprovalRecord {
    return this.#terminalTransition(
      approvalId,
      canceledAt,
      "CANCELED",
      ["PENDING", "APPROVED", "CHANGES_REQUESTED"],
    );
  }

  public supersede(approvalId: string, supersededAt: string): ApprovalRecord {
    return this.#terminalTransition(
      approvalId,
      supersededAt,
      "SUPERSEDED",
      ["PENDING", "APPROVED", "CHANGES_REQUESTED"],
    );
  }

  public invalidate(approvalId: string, invalidatedAt: string): ApprovalRecord {
    return this.#terminalTransition(
      approvalId,
      invalidatedAt,
      "INVALIDATED",
      ["PENDING", "APPROVED"],
    );
  }

  public expire(approvalId: string, at: string): ApprovalRecord {
    const current = this.#require(approvalId);
    const atTime = timestamp(at, "at");
    if (!["PENDING", "APPROVED", "CHANGES_REQUESTED"].includes(current.status)) {
      throw new ApprovalStateError(approvalId, current.status);
    }
    if (atTime < timestamp(current.expiresAt, "expiresAt")) {
      throw new TypeError("approval cannot expire before its expiresAt time");
    }
    return this.#terminalTransition(
      approvalId,
      at,
      "EXPIRED",
      ["PENDING", "APPROVED", "CHANGES_REQUESTED"],
    );
  }

  #require(approvalId: string): ApprovalRecord {
    const record = this.get(approvalId);
    if (record === null) {
      throw new ApprovalNotFoundError(approvalId);
    }
    return record;
  }

  #terminalTransition(
    approvalId: string,
    at: string,
    next: "CANCELED" | "SUPERSEDED" | "EXPIRED" | "INVALIDATED",
    allowed: readonly ApprovalStatus[],
  ): ApprovalRecord {
    exact(approvalId, "approvalId");
    timestamp(at, "transition time");
    const current = this.#require(approvalId);
    if (!allowed.includes(current.status) || !canTransitionApproval(current.status, next)) {
      throw new ApprovalStateError(approvalId, current.status);
    }
    const result = this.#database
      .prepare("UPDATE approvals SET status = ?, terminal_at = ? WHERE approval_id = ? AND status = ?")
      .run(next, at, approvalId, current.status);
    if (Number(result.changes) !== 1) {
      throw new ApprovalStateError(approvalId, current.status);
    }
    return this.#require(approvalId);
  }

  #record(row: SqliteRow): ApprovalRecord {
    const status = text(row.status, "status") as ApprovalStatus;
    if (!(APPROVAL_STATUSES as readonly string[]).includes(status)) {
      throw new ApprovalError(`invalid persisted approval status '${status}'`);
    }
    return Object.freeze({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      approvalId: text(row.approval_id, "approval_id"),
      binding: parseBinding(row.binding_json),
      bindingHash: text(row.binding_hash, "binding_hash"),
      status,
      requestedAt: text(row.requested_at, "requested_at"),
      expiresAt: text(row.expires_at, "expires_at"),
      decidedAt: nullableText(row.decided_at, "decided_at"),
      decidedBy: parseActor(row.decided_by_json, "decided_by_json"),
      decisionReason: text(row.decision_reason, "decision_reason"),
      consumedAt: nullableText(row.consumed_at, "consumed_at"),
      terminalAt: nullableText(row.terminal_at, "terminal_at"),
    });
  }

  #sign(payload: string): string {
    return createHmac("sha256", this.#signingKey).update(payload).digest("base64url");
  }

  #verifyAuthorization(token: string): ApprovalAuthorization {
    const parts = token.split(".");
    if (parts.length !== 2 || parts[0] === undefined || parts[1] === undefined || parts[0] === "" || parts[1] === "") {
      throw new ApprovalTokenError();
    }
    const expected = Buffer.from(this.#sign(parts[0]), "utf8");
    const supplied = Buffer.from(parts[1], "utf8");
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
      throw new ApprovalTokenError();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    } catch {
      throw new ApprovalTokenError();
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new ApprovalTokenError();
    const value = parsed as Record<string, unknown>;
    if (
      !["software-agent.approval-authorization/v1", "agent-company.approval-authorization/v1"].includes(String(value.schema)) ||
      typeof value.approvalId !== "string" ||
      typeof value.bindingHash !== "string" ||
      typeof value.issuedAt !== "string" ||
      typeof value.expiresAt !== "string" ||
      typeof value.nonce !== "string" ||
      !isSha256(value.bindingHash)
    ) {
      throw new ApprovalTokenError();
    }
    timestamp(value.issuedAt, "authorization.issuedAt");
    timestamp(value.expiresAt, "authorization.expiresAt");
    return Object.freeze(value as unknown as ApprovalAuthorization);
  }
}
