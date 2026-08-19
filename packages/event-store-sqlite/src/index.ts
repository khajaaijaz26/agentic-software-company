import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { DatabaseSync } from "node:sqlite";

import {
  CONTRACT_SCHEMA_VERSION,
  canonicalize,
  isSha256,
  type ActorRef,
  type CommandReceipt,
  type JsonObject,
  type JsonValue,
  type StoredEvent,
} from "../../contracts/src/index.js";

export interface EventToAppend<TData extends JsonObject = JsonObject> {
  readonly eventId?: string;
  readonly eventType: string;
  readonly occurredAt: string;
  readonly actor: ActorRef;
  readonly data: TData;
  readonly metadata?: JsonObject;
}

export interface AppendCommand<TResponse extends JsonValue = JsonValue> {
  readonly commandId: string;
  readonly operationHash: string;
  readonly streamId: string;
  readonly expectedVersion: number;
  readonly events: readonly EventToAppend[];
  readonly response: TResponse;
  readonly createdAt: string;
}

export interface AppendResult<TResponse extends JsonValue = JsonValue> {
  readonly receipt: CommandReceipt<TResponse>;
  readonly events: readonly StoredEvent[];
  readonly replayed: boolean;
}

export interface OutboxRecord {
  readonly sequence: number;
  readonly eventId: string;
  readonly streamId: string;
  readonly eventType: string;
  readonly payload: JsonObject;
  readonly createdAt: string;
  readonly deliveredAt: string | null;
}

export interface SnapshotRecord<TState extends JsonValue = JsonValue> {
  readonly streamId: string;
  readonly streamVersion: number;
  readonly state: TState;
  readonly createdAt: string;
}

export class EventStoreError extends Error {}

export class IdempotencyConflictError extends EventStoreError {
  public constructor(commandId: string) {
    super(`command '${commandId}' was already recorded with different canonical input`);
    this.name = "IdempotencyConflictError";
  }
}

export class StreamVersionConflictError extends EventStoreError {
  public constructor(
    public readonly streamId: string,
    public readonly expected: number,
    public readonly actual: number,
  ) {
    super(`stream '${streamId}' version conflict: expected ${expected}, found ${actual}`);
    this.name = "StreamVersionConflictError";
  }
}

type SqliteRow = Record<string, unknown>;

function assertExact(value: string, field: string): void {
  if (value.length === 0 || value.trim() !== value) {
    throw new TypeError(`${field} must be non-empty and have no surrounding whitespace`);
  }
}

function assertTimestamp(value: string, field: string): void {
  if (!Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${field} must be an ISO timestamp`);
  }
}

function safeInteger(value: unknown, field: string): number {
  const numberValue = typeof value === "bigint" ? Number(value) : value;
  if (typeof numberValue !== "number" || !Number.isSafeInteger(numberValue)) {
    throw new EventStoreError(`invalid integer column '${field}'`);
  }
  return numberValue;
}

function textColumn(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new EventStoreError(`invalid text column '${field}'`);
  }
  return value;
}

function parseObject(value: unknown, field: string): JsonObject {
  const parsed: unknown = JSON.parse(textColumn(value, field));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new EventStoreError(`invalid JSON object column '${field}'`);
  }
  return parsed as JsonObject;
}

function parseValue(value: unknown, field: string): JsonValue {
  return JSON.parse(textColumn(value, field)) as JsonValue;
}

function actorJson(actor: ActorRef): string {
  assertExact(actor.id, "actor.id");
  if (!(["human", "agent", "system"] as const).includes(actor.type)) {
    throw new TypeError(`invalid actor type: ${actor.type}`);
  }
  return canonicalize({ type: actor.type, id: actor.id });
}

export class SqliteEventStore {
  readonly #database: DatabaseSync;
  readonly #notifications = new EventEmitter();
  #closed = false;

  public constructor(filename: string) {
    assertExact(filename, "filename");
    this.#database = new DatabaseSync(filename);
    this.#database.exec("PRAGMA foreign_keys = ON");
    this.#database.exec("PRAGMA busy_timeout = 5000");
    this.#database.exec("PRAGMA journal_mode = WAL");
    this.#database.exec("PRAGMA synchronous = FULL");
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        command_id TEXT NOT NULL,
        stream_id TEXT NOT NULL,
        stream_version INTEGER NOT NULL CHECK (stream_version > 0),
        event_type TEXT NOT NULL,
        schema_version INTEGER NOT NULL CHECK (schema_version = 1),
        occurred_at TEXT NOT NULL,
        actor_json TEXT NOT NULL,
        data_json TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        UNIQUE (stream_id, stream_version)
      );

      CREATE INDEX IF NOT EXISTS events_stream_idx
        ON events (stream_id, stream_version);
      CREATE INDEX IF NOT EXISTS events_command_idx
        ON events (command_id, sequence);

      CREATE TABLE IF NOT EXISTS command_receipts (
        command_id TEXT PRIMARY KEY,
        operation_hash TEXT NOT NULL,
        stream_id TEXT NOT NULL,
        first_sequence INTEGER NOT NULL,
        last_sequence INTEGER NOT NULL,
        response_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        schema_version INTEGER NOT NULL CHECK (schema_version = 1)
      );

      CREATE TABLE IF NOT EXISTS outbox (
        sequence INTEGER PRIMARY KEY REFERENCES events(sequence) ON DELETE RESTRICT,
        event_id TEXT NOT NULL UNIQUE,
        stream_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        delivered_at TEXT
      );
      CREATE INDEX IF NOT EXISTS outbox_pending_idx ON outbox(delivered_at, sequence);

      CREATE TABLE IF NOT EXISTS consumer_offsets (
        consumer_id TEXT PRIMARY KEY,
        sequence INTEGER NOT NULL CHECK(sequence >= 0),
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS snapshots (
        stream_id TEXT PRIMARY KEY,
        stream_version INTEGER NOT NULL CHECK(stream_version >= 0),
        state_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS dead_letters (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        consumer_id TEXT NOT NULL,
        sequence INTEGER NOT NULL REFERENCES events(sequence) ON DELETE RESTRICT,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(consumer_id, sequence)
      );
    `);
  }

  public close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#notifications.emit("close");
    this.#notifications.removeAllListeners();
    this.#database.close();
  }

  public journalMode(): string {
    const row = this.#database.prepare("PRAGMA journal_mode").get() as SqliteRow | undefined;
    return row === undefined ? "" : textColumn(row.journal_mode, "journal_mode");
  }

  public latestStreamVersion(streamId: string): number {
    assertExact(streamId, "streamId");
    const row = this.#database
      .prepare("SELECT COALESCE(MAX(stream_version), 0) AS version FROM events WHERE stream_id = ?")
      .get(streamId) as SqliteRow;
    return safeInteger(row.version, "version");
  }

  public latestSequence(): number {
    const row = this.#database.prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM events").get() as SqliteRow;
    return safeInteger(row.sequence, "sequence");
  }

  public getCommandReceipt<TResponse extends JsonValue = JsonValue>(
    commandId: string,
  ): CommandReceipt<TResponse> | null {
    assertExact(commandId, "commandId");
    const row = this.#database
      .prepare("SELECT * FROM command_receipts WHERE command_id = ?")
      .get(commandId) as SqliteRow | undefined;
    return row === undefined ? null : this.#receiptFromRow<TResponse>(row);
  }

  public append<TResponse extends JsonValue>(command: AppendCommand<TResponse>): AppendResult<TResponse> {
    this.#validateCommand(command);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.getCommandReceipt<TResponse>(command.commandId);
      if (existing !== null) {
        if (
          existing.operationHash !== command.operationHash ||
          existing.streamId !== command.streamId
        ) {
          throw new IdempotencyConflictError(command.commandId);
        }
        const events = this.#eventsForCommand(command.commandId);
        this.#database.exec("COMMIT");
        return Object.freeze({ receipt: existing, events, replayed: true });
      }

      const actualVersion = this.latestStreamVersion(command.streamId);
      if (actualVersion !== command.expectedVersion) {
        throw new StreamVersionConflictError(command.streamId, command.expectedVersion, actualVersion);
      }

      const insertEvent = this.#database.prepare(`
        INSERT INTO events (
          event_id, command_id, stream_id, stream_version, event_type,
          schema_version, occurred_at, actor_json, data_json, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertOutbox = this.#database.prepare(`
        INSERT INTO outbox(sequence, event_id, stream_id, event_type, payload_json, created_at)
        VALUES(?, ?, ?, ?, ?, ?)
      `);

      let firstSequence = 0;
      let lastSequence = 0;
      for (const [offset, event] of command.events.entries()) {
        const eventId = event.eventId ?? `evt_${randomUUID()}`;
        assertExact(eventId, "eventId");
        assertExact(event.eventType, "eventType");
        assertTimestamp(event.occurredAt, "event.occurredAt");
        const result = insertEvent.run(
          eventId,
          command.commandId,
          command.streamId,
          command.expectedVersion + offset + 1,
          event.eventType,
          CONTRACT_SCHEMA_VERSION,
          event.occurredAt,
          actorJson(event.actor),
          canonicalize(event.data),
          canonicalize(event.metadata ?? {}),
        );
        const sequence = safeInteger(result.lastInsertRowid, "lastInsertRowid");
        insertOutbox.run(
          sequence,
          eventId,
          command.streamId,
          event.eventType,
          canonicalize({
            schema: "software-agent.event/v2",
            eventId,
            streamId: command.streamId,
            streamVersion: command.expectedVersion + offset + 1,
            eventType: event.eventType,
            occurredAt: event.occurredAt,
            actor: {type: event.actor.type, id: event.actor.id},
            data: event.data,
            metadata: event.metadata ?? {},
          }),
          event.occurredAt,
        );
        firstSequence ||= sequence;
        lastSequence = sequence;
      }

      const receipt: CommandReceipt<TResponse> = Object.freeze({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        commandId: command.commandId,
        operationHash: command.operationHash,
        streamId: command.streamId,
        firstSequence,
        lastSequence,
        response: command.response,
        createdAt: command.createdAt,
      });
      this.#database
        .prepare(`
          INSERT INTO command_receipts (
            command_id, operation_hash, stream_id, first_sequence, last_sequence,
            response_json, created_at, schema_version
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          receipt.commandId,
          receipt.operationHash,
          receipt.streamId,
          receipt.firstSequence,
          receipt.lastSequence,
          canonicalize(receipt.response),
          receipt.createdAt,
          receipt.schemaVersion,
        );
      const events = this.#eventsForCommand(command.commandId);
      this.#database.exec("COMMIT");
      this.#notifications.emit("commit", lastSequence);
      return Object.freeze({ receipt, events, replayed: false });
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  public load(streamId: string, afterVersion = 0): readonly StoredEvent[] {
    assertExact(streamId, "streamId");
    if (!Number.isSafeInteger(afterVersion) || afterVersion < 0) {
      throw new TypeError("afterVersion must be a non-negative safe integer");
    }
    const rows = this.#database
      .prepare(
        "SELECT * FROM events WHERE stream_id = ? AND stream_version > ? ORDER BY stream_version ASC",
      )
      .all(streamId, afterVersion) as SqliteRow[];
    return Object.freeze(rows.map((row) => this.#eventFromRow(row)));
  }

  public replay(afterSequence = 0, limit?: number): readonly StoredEvent[] {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new TypeError("afterSequence must be a non-negative safe integer");
    }
    let rows: SqliteRow[];
    if (limit === undefined) {
      rows = this.#database
        .prepare("SELECT * FROM events WHERE sequence > ? ORDER BY sequence ASC")
        .all(afterSequence);
    } else {
      if (!Number.isSafeInteger(limit) || limit <= 0) {
        throw new TypeError("limit must be a positive safe integer");
      }
      rows = this.#database
        .prepare("SELECT * FROM events WHERE sequence > ? ORDER BY sequence ASC LIMIT ?")
        .all(afterSequence, limit);
    }
    return Object.freeze(rows.map((row) => this.#eventFromRow(row)));
  }

  public recent(limit = 100, streamId?: string): readonly StoredEvent[] {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 250) {
      throw new TypeError("limit must be between 1 and 250");
    }
    const rows = streamId === undefined
      ? this.#database.prepare("SELECT * FROM events ORDER BY sequence DESC LIMIT ?").all(limit) as SqliteRow[]
      : this.#database.prepare("SELECT * FROM events WHERE stream_id = ? ORDER BY sequence DESC LIMIT ?").all(streamId, limit) as SqliteRow[];
    return Object.freeze(rows.reverse().map((row) => this.#eventFromRow(row)));
  }

  public async waitForEvents(
    afterSequence: number,
    options: {readonly limit?: number; readonly timeoutMs?: number; readonly signal?: AbortSignal} = {},
  ): Promise<readonly StoredEvent[]> {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new TypeError("afterSequence must be non-negative");
    const limit = options.limit ?? 250;
    const timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 513) throw new TypeError("limit must be between 1 and 513");
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 30_000) throw new TypeError("timeoutMs must be between 0 and 30000");
    if (options.signal?.aborted) throw abortError(options.signal);
    const immediate = this.replay(afterSequence, limit);
    if (immediate.length > 0 || timeoutMs === 0) return immediate;
    if (this.#closed) throw new EventStoreError("event store is closed");

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#notifications.off("commit", onCommit);
        this.#notifications.off("close", onClose);
        options.signal?.removeEventListener("abort", onAbort);
        if (error) reject(error);
        else resolve();
      };
      const onCommit = (sequence: number): void => {
        if (sequence > afterSequence) finish();
      };
      const onClose = (): void => finish(new EventStoreError("event store is closed"));
      const onAbort = (): void => finish(abortError(options.signal));
      const timer = setTimeout(() => finish(), timeoutMs);
      timer.unref();
      this.#notifications.on("commit", onCommit);
      this.#notifications.once("close", onClose);
      options.signal?.addEventListener("abort", onAbort, {once: true});
      if (this.latestSequence() > afterSequence) finish();
    });
    return this.replay(afterSequence, limit);
  }

  public pendingOutbox(afterSequence = 0, limit = 100): readonly OutboxRecord[] {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new TypeError("afterSequence must be non-negative");
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 10_000) throw new TypeError("limit must be between 1 and 10000");
    const rows = this.#database.prepare(`
      SELECT * FROM outbox
      WHERE sequence > ? AND delivered_at IS NULL
      ORDER BY sequence ASC LIMIT ?
    `).all(afterSequence, limit) as SqliteRow[];
    return Object.freeze(rows.map((row) => Object.freeze({
      sequence: safeInteger(row.sequence, "sequence"),
      eventId: textColumn(row.event_id, "event_id"),
      streamId: textColumn(row.stream_id, "stream_id"),
      eventType: textColumn(row.event_type, "event_type"),
      payload: parseObject(row.payload_json, "payload_json"),
      createdAt: textColumn(row.created_at, "created_at"),
      deliveredAt: row.delivered_at === null ? null : textColumn(row.delivered_at, "delivered_at"),
    })));
  }

  public markOutboxDelivered(sequence: number, deliveredAt: string): void {
    if (!Number.isSafeInteger(sequence) || sequence <= 0) throw new TypeError("sequence must be positive");
    assertTimestamp(deliveredAt, "deliveredAt");
    const result = this.#database.prepare(`
      UPDATE outbox SET delivered_at = ? WHERE sequence = ? AND delivered_at IS NULL
    `).run(deliveredAt, sequence);
    if (Number(result.changes) !== 1) throw new EventStoreError(`outbox sequence '${sequence}' is unknown or already delivered`);
  }

  public consumerOffset(consumerId: string): number {
    assertExact(consumerId, "consumerId");
    const row = this.#database.prepare("SELECT sequence FROM consumer_offsets WHERE consumer_id = ?").get(consumerId) as SqliteRow | undefined;
    return row === undefined ? 0 : safeInteger(row.sequence, "sequence");
  }

  public commitConsumerOffset(consumerId: string, sequence: number, updatedAt: string): void {
    assertExact(consumerId, "consumerId");
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new TypeError("sequence must be non-negative");
    assertTimestamp(updatedAt, "updatedAt");
    const current = this.consumerOffset(consumerId);
    if (sequence < current) throw new EventStoreError(`consumer '${consumerId}' offset cannot move backwards`);
    this.#database.prepare(`
      INSERT INTO consumer_offsets(consumer_id, sequence, updated_at) VALUES(?, ?, ?)
      ON CONFLICT(consumer_id) DO UPDATE SET sequence=excluded.sequence, updated_at=excluded.updated_at
    `).run(consumerId, sequence, updatedAt);
  }

  public deadLetter(consumerId: string, sequence: number, reason: string, createdAt: string): void {
    assertExact(consumerId, "consumerId");
    assertExact(reason, "reason");
    assertTimestamp(createdAt, "createdAt");
    if (!Number.isSafeInteger(sequence) || sequence <= 0) throw new TypeError("sequence must be positive");
    this.#database.prepare(`
      INSERT INTO dead_letters(consumer_id, sequence, reason, created_at) VALUES(?, ?, ?, ?)
      ON CONFLICT(consumer_id, sequence) DO UPDATE SET reason=excluded.reason, created_at=excluded.created_at
    `).run(consumerId, sequence, reason, createdAt);
  }

  public saveSnapshot<TState extends JsonValue>(record: SnapshotRecord<TState>): SnapshotRecord<TState> {
    assertExact(record.streamId, "streamId");
    if (!Number.isSafeInteger(record.streamVersion) || record.streamVersion < 0) throw new TypeError("streamVersion must be non-negative");
    if (record.streamVersion > this.latestStreamVersion(record.streamId)) throw new StreamVersionConflictError(record.streamId, record.streamVersion, this.latestStreamVersion(record.streamId));
    assertTimestamp(record.createdAt, "createdAt");
    const state = canonicalize(record.state);
    const previous = this.loadSnapshot(record.streamId);
    if (previous !== null && record.streamVersion < previous.streamVersion) {
      throw new StreamVersionConflictError(record.streamId, record.streamVersion, previous.streamVersion);
    }
    if (previous !== null && record.streamVersion === previous.streamVersion) {
      if (canonicalize(previous.state) !== state) throw new EventStoreError("snapshot contents changed without a stream-version change");
      return Object.freeze({...record});
    }
    this.#database.prepare(`
      INSERT INTO snapshots(stream_id, stream_version, state_json, created_at) VALUES(?, ?, ?, ?)
      ON CONFLICT(stream_id) DO UPDATE SET
        stream_version=excluded.stream_version, state_json=excluded.state_json, created_at=excluded.created_at
      WHERE excluded.stream_version >= snapshots.stream_version
    `).run(record.streamId, record.streamVersion, state, record.createdAt);
    return Object.freeze({...record});
  }

  public loadSnapshot<TState extends JsonValue = JsonValue>(streamId: string): SnapshotRecord<TState> | null {
    assertExact(streamId, "streamId");
    const row = this.#database.prepare("SELECT * FROM snapshots WHERE stream_id = ?").get(streamId) as SqliteRow | undefined;
    return row === undefined ? null : Object.freeze({
      streamId,
      streamVersion: safeInteger(row.stream_version, "stream_version"),
      state: parseValue(row.state_json, "state_json") as TState,
      createdAt: textColumn(row.created_at, "created_at"),
    });
  }

  public checkpoint(mode: "PASSIVE" | "FULL" | "RESTART" | "TRUNCATE" = "PASSIVE"): void {
    this.#database.exec(`PRAGMA wal_checkpoint(${mode})`);
  }

  #eventsForCommand(commandId: string): readonly StoredEvent[] {
    const rows = this.#database
      .prepare("SELECT * FROM events WHERE command_id = ? ORDER BY sequence ASC")
      .all(commandId) as SqliteRow[];
    return Object.freeze(rows.map((row) => this.#eventFromRow(row)));
  }

  #validateCommand(command: AppendCommand): void {
    assertExact(command.commandId, "commandId");
    assertExact(command.streamId, "streamId");
    if (!isSha256(command.operationHash)) {
      throw new TypeError("operationHash must be a lower-case SHA-256 digest");
    }
    if (!Number.isSafeInteger(command.expectedVersion) || command.expectedVersion < 0) {
      throw new TypeError("expectedVersion must be a non-negative safe integer");
    }
    if (command.events.length === 0) {
      throw new TypeError("a command append must contain at least one event");
    }
    assertTimestamp(command.createdAt, "createdAt");
    canonicalize(command.response);
  }

  #receiptFromRow<TResponse extends JsonValue>(row: SqliteRow): CommandReceipt<TResponse> {
    return Object.freeze({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      commandId: textColumn(row.command_id, "command_id"),
      operationHash: textColumn(row.operation_hash, "operation_hash"),
      streamId: textColumn(row.stream_id, "stream_id"),
      firstSequence: safeInteger(row.first_sequence, "first_sequence"),
      lastSequence: safeInteger(row.last_sequence, "last_sequence"),
      response: parseValue(row.response_json, "response_json") as TResponse,
      createdAt: textColumn(row.created_at, "created_at"),
    });
  }

  #eventFromRow(row: SqliteRow): StoredEvent {
    const actor = parseObject(row.actor_json, "actor_json");
    if (typeof actor.type !== "string" || typeof actor.id !== "string") {
      throw new EventStoreError("invalid persisted actor");
    }
    return Object.freeze({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      sequence: safeInteger(row.sequence, "sequence"),
      streamVersion: safeInteger(row.stream_version, "stream_version"),
      eventId: textColumn(row.event_id, "event_id"),
      streamId: textColumn(row.stream_id, "stream_id"),
      eventType: textColumn(row.event_type, "event_type"),
      occurredAt: textColumn(row.occurred_at, "occurred_at"),
      actor: Object.freeze({ type: actor.type as ActorRef["type"], id: actor.id }),
      data: parseObject(row.data_json, "data_json"),
      metadata: parseObject(row.metadata_json, "metadata_json"),
    });
  }
}

function abortError(signal: AbortSignal | undefined): Error {
  return signal?.reason instanceof Error ? signal.reason : new Error("event wait was aborted");
}
