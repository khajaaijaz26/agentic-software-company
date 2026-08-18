import {randomUUID} from "node:crypto";
import {DatabaseSync} from "node:sqlite";

export interface BudgetAccount {
  readonly scope: string;
  readonly limitUsd: number;
  readonly spentUsd: number;
  readonly reservedUsd: number;
  readonly remainingUsd: number;
}

export interface BudgetReservation {
  readonly id: string;
  readonly scope: string;
  readonly amountUsd: number;
  readonly state: "ACTIVE" | "RECONCILED" | "RELEASED";
  readonly createdAt: string;
}

export class BudgetExceededError extends Error {
  public constructor(public readonly account: BudgetAccount, requested: number) {
    super(`budget ${account.scope} has $${account.remainingUsd.toFixed(4)} remaining; $${requested.toFixed(4)} requested`);
    this.name = "BudgetExceededError";
  }
}

export class BudgetLedger {
  readonly #database: DatabaseSync;

  public constructor(filename: string) {
    this.#database = new DatabaseSync(filename);
    this.#database.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL;");
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS budget_accounts (
        scope TEXT PRIMARY KEY,
        limit_microusd INTEGER NOT NULL CHECK(limit_microusd >= 0),
        spent_microusd INTEGER NOT NULL DEFAULT 0 CHECK(spent_microusd >= 0),
        reserved_microusd INTEGER NOT NULL DEFAULT 0 CHECK(reserved_microusd >= 0)
      );
      CREATE TABLE IF NOT EXISTS budget_reservations (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL REFERENCES budget_accounts(scope),
        amount_microusd INTEGER NOT NULL CHECK(amount_microusd >= 0),
        state TEXT NOT NULL CHECK(state IN ('ACTIVE','RECONCILED','RELEASED')),
        created_at TEXT NOT NULL
      );
    `);
  }

  public close(): void {
    this.#database.close();
  }

  public setLimit(scope: string, limitUsd: number): BudgetAccount {
    const limit = toMicroUsd(limitUsd);
    this.#database.prepare(`
      INSERT INTO budget_accounts(scope, limit_microusd) VALUES(?, ?)
      ON CONFLICT(scope) DO UPDATE SET limit_microusd=excluded.limit_microusd
    `).run(scope, limit);
    return this.account(scope);
  }

  public account(scope: string): BudgetAccount {
    const row = this.#database.prepare("SELECT * FROM budget_accounts WHERE scope = ?").get(scope) as Record<string, unknown> | undefined;
    if (!row) throw new Error(`unknown budget scope: ${scope}`);
    const limit = numberColumn(row.limit_microusd);
    const spent = numberColumn(row.spent_microusd);
    const reserved = numberColumn(row.reserved_microusd);
    return Object.freeze({
      scope,
      limitUsd: fromMicroUsd(limit),
      spentUsd: fromMicroUsd(spent),
      reservedUsd: fromMicroUsd(reserved),
      remainingUsd: fromMicroUsd(Math.max(0, limit - spent - reserved)),
    });
  }

  public reserve(scope: string, amountUsd: number, now = new Date().toISOString()): BudgetReservation {
    const amount = toMicroUsd(amountUsd);
    const id = `bres_${randomUUID().replaceAll("-", "")}`;
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const account = this.account(scope);
      if (amountUsd > account.remainingUsd + 0.0000001) throw new BudgetExceededError(account, amountUsd);
      this.#database.prepare("UPDATE budget_accounts SET reserved_microusd = reserved_microusd + ? WHERE scope = ?").run(amount, scope);
      this.#database.prepare("INSERT INTO budget_reservations VALUES(?, ?, ?, 'ACTIVE', ?)").run(id, scope, amount, now);
      this.#database.exec("COMMIT");
      return Object.freeze({id, scope, amountUsd: fromMicroUsd(amount), state: "ACTIVE", createdAt: now});
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  public reconcile(id: string, actualUsd: number): BudgetReservation {
    const actual = toMicroUsd(actualUsd);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#reservationRow(id);
      if (row.state !== "ACTIVE") throw new Error(`reservation ${id} is already ${row.state}`);
      const reserved = toMicroUsd(row.amountUsd);
      const account = this.account(row.scope);
      if (actual > reserved + toMicroUsd(account.remainingUsd)) {
        throw new BudgetExceededError(account, fromMicroUsd(actual - reserved));
      }
      this.#database.prepare(`
        UPDATE budget_accounts
        SET reserved_microusd = reserved_microusd - ?, spent_microusd = spent_microusd + ?
        WHERE scope = ?
      `).run(reserved, actual, row.scope);
      this.#database.prepare("UPDATE budget_reservations SET amount_microusd = ?, state = 'RECONCILED' WHERE id = ?").run(actual, id);
      this.#database.exec("COMMIT");
      return Object.freeze({...row, amountUsd: fromMicroUsd(actual), state: "RECONCILED"});
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  public release(id: string): BudgetReservation {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#reservationRow(id);
      if (row.state !== "ACTIVE") throw new Error(`reservation ${id} is already ${row.state}`);
      const amount = toMicroUsd(row.amountUsd);
      this.#database.prepare("UPDATE budget_accounts SET reserved_microusd = reserved_microusd - ? WHERE scope = ?").run(amount, row.scope);
      this.#database.prepare("UPDATE budget_reservations SET state = 'RELEASED' WHERE id = ?").run(id);
      this.#database.exec("COMMIT");
      return Object.freeze({...row, state: "RELEASED"});
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  #reservationRow(id: string): BudgetReservation {
    const row = this.#database.prepare("SELECT * FROM budget_reservations WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) throw new Error(`unknown budget reservation: ${id}`);
    return {
      id,
      scope: String(row.scope),
      amountUsd: fromMicroUsd(numberColumn(row.amount_microusd)),
      state: String(row.state) as BudgetReservation["state"],
      createdAt: String(row.created_at),
    };
  }
}

function toMicroUsd(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new Error("budget values must be finite and non-negative");
  return Math.round(value * 1_000_000);
}

function fromMicroUsd(value: number): number {
  return value / 1_000_000;
}

function numberColumn(value: unknown): number {
  const number = typeof value === "bigint" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number)) throw new Error("invalid SQLite budget value");
  return number;
}
