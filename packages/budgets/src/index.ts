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

export type TokenBudgetMode = "economy" | "balanced" | "quality";
export type TokenReservationState = "ACTIVE" | "UNKNOWN" | "RECONCILED" | "RELEASED";
export const SOFTWARE_AGENT_EXTENSION_POOL_ID = "budget-extension-pool";

export interface TokenBudgetConfiguration {
  readonly scope: string;
  readonly fullLimitTokens: number;
  readonly mode: TokenBudgetMode;
  readonly agentShares?: Readonly<Record<string, number>>;
}

export interface TokenBudgetAccount {
  readonly scope: string;
  readonly mode: TokenBudgetMode;
  readonly fullLimitTokens: number;
  readonly baseLimitTokens: number;
  readonly extensionTokens: number;
  readonly effectiveLimitTokens: number;
  readonly spentTokens: number;
  readonly reservedTokens: number;
  readonly uncertainTokens: number;
  readonly remainingTokens: number;
  readonly warningAtTokens: number;
  readonly warning: boolean;
  readonly blocked: boolean;
}

export interface AgentTokenAllocation {
  readonly scope: string;
  readonly agentId: string;
  readonly allocatedTokens: number;
  readonly spentTokens: number;
  readonly reservedTokens: number;
  readonly remainingTokens: number;
}

export interface TokenReservationRequest {
  readonly agentId: string;
  readonly estimatedInputTokens: number;
  readonly maxOutputTokens: number;
  readonly toolResultReserveTokens: number;
}

export interface TokenBudgetReservation extends TokenReservationRequest {
  readonly id: string;
  readonly scope: string;
  readonly amountTokens: number;
  readonly billedTokens: number | "UNKNOWN";
  readonly state: TokenReservationState;
  readonly createdAt: string;
}

export interface ProviderTokenUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly reasoningTokens?: number;
  readonly totalTokens?: number;
}

export interface NormalizedProviderTokenUsage {
  readonly inputTokens: number | "UNKNOWN";
  readonly outputTokens: number | "UNKNOWN";
  readonly cachedInputTokens: number | "UNKNOWN";
  readonly reasoningTokens: number | "UNKNOWN";
  readonly totalTokens: number | "UNKNOWN";
  readonly billedTokens: number | "UNKNOWN";
  readonly status: "KNOWN" | "UNKNOWN";
}

export interface TokenBudgetExtension {
  readonly approvalId: string;
  readonly amountTokens: number;
  readonly expiresAt: string;
}

export interface BudgetLedgerOptions {
  readonly now?: () => Date;
}

export class BudgetExceededError extends Error {
  public constructor(public readonly account: BudgetAccount | TokenBudgetAccount | AgentTokenAllocation, requested: number) {
    const message = "remainingTokens" in account
      ? `budget ${account.scope} has ${account.remainingTokens} tokens remaining; ${requested} requested`
      : `budget ${account.scope} has $${account.remainingUsd.toFixed(4)} remaining; $${requested.toFixed(4)} requested`;
    super(message);
    this.name = "BudgetExceededError";
  }
}

export class InvalidBudgetExtensionError extends Error {
  public readonly code = "INVALID_BUDGET_EXTENSION";

  public constructor(message: string) {
    super(message);
    this.name = "InvalidBudgetExtensionError";
  }
}

export function effectiveTokenLimit(fullLimitTokens: number, mode: TokenBudgetMode): number {
  const full = integerTokens(fullLimitTokens, "full token limit");
  const numerator = mode === "economy" ? 25 : mode === "balanced" ? 50 : 100;
  return Math.floor(full * numerator / 100);
}

export function normalizeProviderTokenUsage(usage: ProviderTokenUsage): NormalizedProviderTokenUsage {
  const input = optionalTokenCount(usage.inputTokens);
  const output = optionalTokenCount(usage.outputTokens);
  const cached = optionalTokenCount(usage.cachedInputTokens);
  const reasoning = optionalTokenCount(usage.reasoningTokens);
  const total = optionalTokenCount(usage.totalTokens);
  const subsetsValid = (cached === "UNKNOWN" || (input !== "UNKNOWN" && cached <= input))
    && (reasoning === "UNKNOWN" || (output !== "UNKNOWN" && reasoning <= output));
  const expected = input !== "UNKNOWN" && output !== "UNKNOWN" ? input + output : "UNKNOWN";
  const totalValid = total !== "UNKNOWN" && (expected === "UNKNOWN" || total >= expected);
  const billed = totalValid
    ? total
    : subsetsValid && total === "UNKNOWN" && expected !== "UNKNOWN"
      ? expected
      : "UNKNOWN";
  return Object.freeze({
    inputTokens: input,
    outputTokens: output,
    cachedInputTokens: cached,
    reasoningTokens: reasoning,
    totalTokens: totalValid ? total : expected,
    billedTokens: billed,
    status: billed === "UNKNOWN" ? "UNKNOWN" : "KNOWN",
  });
}

export class BudgetLedger {
  readonly #database: DatabaseSync;
  readonly #now: () => Date;

  public constructor(filename: string, options: BudgetLedgerOptions = {}) {
    this.#now = options.now ?? (() => new Date());
    this.#database = new DatabaseSync(filename);
    this.#database.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;");
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
      CREATE TABLE IF NOT EXISTS token_budget_accounts (
        scope TEXT PRIMARY KEY,
        mode TEXT NOT NULL CHECK(mode IN ('economy','balanced','quality')),
        full_limit_tokens INTEGER NOT NULL CHECK(full_limit_tokens >= 0),
        base_limit_tokens INTEGER NOT NULL CHECK(base_limit_tokens >= 0),
        extension_tokens INTEGER NOT NULL DEFAULT 0 CHECK(extension_tokens >= 0),
        spent_tokens INTEGER NOT NULL DEFAULT 0 CHECK(spent_tokens >= 0),
        reserved_tokens INTEGER NOT NULL DEFAULT 0 CHECK(reserved_tokens >= 0),
        uncertain_tokens INTEGER NOT NULL DEFAULT 0 CHECK(uncertain_tokens >= 0)
      );
      CREATE TABLE IF NOT EXISTS token_budget_reservations (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL REFERENCES token_budget_accounts(scope),
        agent_id TEXT NOT NULL,
        estimated_input_tokens INTEGER NOT NULL CHECK(estimated_input_tokens >= 0),
        max_output_tokens INTEGER NOT NULL CHECK(max_output_tokens >= 0),
        tool_result_reserve_tokens INTEGER NOT NULL CHECK(tool_result_reserve_tokens >= 0),
        amount_tokens INTEGER NOT NULL CHECK(amount_tokens >= 0),
        billed_tokens INTEGER CHECK(billed_tokens IS NULL OR billed_tokens >= 0),
        state TEXT NOT NULL CHECK(state IN ('ACTIVE','UNKNOWN','RECONCILED','RELEASED')),
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS token_budget_agent_allocations (
        scope TEXT NOT NULL REFERENCES token_budget_accounts(scope),
        agent_id TEXT NOT NULL,
        allocated_tokens INTEGER NOT NULL CHECK(allocated_tokens >= 0),
        spent_tokens INTEGER NOT NULL DEFAULT 0 CHECK(spent_tokens >= 0),
        reserved_tokens INTEGER NOT NULL DEFAULT 0 CHECK(reserved_tokens >= 0),
        PRIMARY KEY(scope, agent_id)
      );
      CREATE TABLE IF NOT EXISTS token_budget_extensions (
        approval_id TEXT PRIMARY KEY,
        scope TEXT NOT NULL REFERENCES token_budget_accounts(scope),
        amount_tokens INTEGER NOT NULL CHECK(amount_tokens >= 0),
        expires_at TEXT NOT NULL,
        consumed_at TEXT NOT NULL
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
    const id = reservationId("bres");
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

  public configureTokenBudget(configuration: TokenBudgetConfiguration): TokenBudgetAccount {
    validateScope(configuration.scope);
    const full = integerTokens(configuration.fullLimitTokens, "full token limit");
    if (full < 1_000 || full > 10_000_000) throw new Error("full token limit must be from 1000 to 10000000");
    const base = effectiveTokenLimit(full, configuration.mode);
    const shares = normalizeAgentShares(configuration.agentShares);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.#database.prepare("SELECT scope FROM token_budget_accounts WHERE scope = ?").get(configuration.scope);
      if (existing) throw new Error(`token budget scope is already configured: ${configuration.scope}`);
      this.#database.prepare(`
        INSERT INTO token_budget_accounts(scope, mode, full_limit_tokens, base_limit_tokens)
        VALUES(?, ?, ?, ?)
      `).run(configuration.scope, configuration.mode, full, base);
      if (shares.length > 0) {
        let assigned = 0;
        shares.forEach(([agentId, percentage], index) => {
          const allocated = index === shares.length - 1 ? base - assigned : Math.floor(base * percentage / 100);
          assigned += allocated;
          this.#database.prepare(`
            INSERT INTO token_budget_agent_allocations(scope, agent_id, allocated_tokens)
            VALUES(?, ?, ?)
          `).run(configuration.scope, agentId, allocated);
        });
      }
      this.#database.exec("COMMIT");
      return this.tokenAccount(configuration.scope);
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  public tokenAccount(scope: string): TokenBudgetAccount {
    const row = this.#database.prepare("SELECT * FROM token_budget_accounts WHERE scope = ?").get(scope) as Record<string, unknown> | undefined;
    if (!row) throw new Error(`unknown token budget scope: ${scope}`);
    const full = numberColumn(row.full_limit_tokens);
    const base = numberColumn(row.base_limit_tokens);
    const extension = numberColumn(row.extension_tokens);
    const spent = numberColumn(row.spent_tokens);
    const reserved = numberColumn(row.reserved_tokens);
    const uncertain = numberColumn(row.uncertain_tokens);
    const effective = Math.min(full, base + extension);
    const remaining = Math.max(0, effective - spent - reserved);
    const warningAt = Math.floor(effective * 80 / 100);
    return Object.freeze({
      scope,
      mode: String(row.mode) as TokenBudgetMode,
      fullLimitTokens: full,
      baseLimitTokens: base,
      extensionTokens: extension,
      effectiveLimitTokens: effective,
      spentTokens: spent,
      reservedTokens: reserved,
      uncertainTokens: uncertain,
      remainingTokens: remaining,
      warningAtTokens: warningAt,
      warning: spent + reserved >= warningAt,
      blocked: spent + reserved >= effective,
    });
  }

  public agentTokenAllocations(scope: string): readonly AgentTokenAllocation[] {
    const rows = this.#database.prepare(`
      SELECT * FROM token_budget_agent_allocations WHERE scope = ? ORDER BY agent_id
    `).all(scope) as Record<string, unknown>[];
    return Object.freeze(rows.map((row) => freezeAgentAllocation(row)));
  }

  public reserveTokens(
    scope: string,
    request: TokenReservationRequest,
    now = new Date().toISOString(),
  ): TokenBudgetReservation {
    validateAgentId(request.agentId);
    const estimatedInput = integerTokens(request.estimatedInputTokens, "estimated input tokens");
    const maxOutput = integerTokens(request.maxOutputTokens, "maximum output tokens");
    const toolReserve = integerTokens(request.toolResultReserveTokens, "tool-result reserve tokens");
    const amount = safeTokenSum(estimatedInput, maxOutput, toolReserve);
    const id = reservationId("tbres");
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const account = this.tokenAccount(scope);
      if (amount > account.remainingTokens) throw new BudgetExceededError(account, amount);
      const allocation = this.#agentAllocation(scope, request.agentId);
      const allocationCount = this.#allocationCount(scope);
      if (!allocation && allocationCount > 0) {
        throw new Error(`Software Agent ${request.agentId} has no token allocation in ${scope}`);
      }
      if (allocation && amount > allocation.remainingTokens) throw new BudgetExceededError(allocation, amount);
      this.#database.prepare(`
        UPDATE token_budget_accounts SET reserved_tokens = reserved_tokens + ? WHERE scope = ?
      `).run(amount, scope);
      if (allocation) {
        this.#database.prepare(`
          UPDATE token_budget_agent_allocations SET reserved_tokens = reserved_tokens + ?
          WHERE scope = ? AND agent_id = ?
        `).run(amount, scope, request.agentId);
      }
      this.#database.prepare(`
        INSERT INTO token_budget_reservations(
          id, scope, agent_id, estimated_input_tokens, max_output_tokens,
          tool_result_reserve_tokens, amount_tokens, billed_tokens, state, created_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, NULL, 'ACTIVE', ?)
      `).run(id, scope, request.agentId, estimatedInput, maxOutput, toolReserve, amount, now);
      this.#database.exec("COMMIT");
      return Object.freeze({
        id,
        scope,
        agentId: request.agentId,
        estimatedInputTokens: estimatedInput,
        maxOutputTokens: maxOutput,
        toolResultReserveTokens: toolReserve,
        amountTokens: amount,
        billedTokens: "UNKNOWN",
        state: "ACTIVE",
        createdAt: now,
      });
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  public reconcileTokens(id: string, usage: ProviderTokenUsage): TokenBudgetReservation {
    const normalized = normalizeProviderTokenUsage(usage);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#tokenReservationRow(id);
      if (row.state !== "ACTIVE" && row.state !== "UNKNOWN") {
        throw new Error(`token reservation ${id} is already ${row.state}`);
      }
      if (normalized.billedTokens === "UNKNOWN") {
        if (row.state === "ACTIVE") {
          this.#database.prepare(`
            UPDATE token_budget_accounts SET uncertain_tokens = uncertain_tokens + ? WHERE scope = ?
          `).run(row.amountTokens, row.scope);
          this.#database.prepare("UPDATE token_budget_reservations SET state = 'UNKNOWN' WHERE id = ?").run(id);
        }
        this.#database.exec("COMMIT");
        return Object.freeze({...row, state: "UNKNOWN", billedTokens: "UNKNOWN"});
      }
      const billed = normalized.billedTokens;
      this.#database.prepare(`
        UPDATE token_budget_accounts
        SET reserved_tokens = reserved_tokens - ?,
            uncertain_tokens = uncertain_tokens - ?,
            spent_tokens = spent_tokens + ?
        WHERE scope = ?
      `).run(row.amountTokens, row.state === "UNKNOWN" ? row.amountTokens : 0, billed, row.scope);
      const allocation = this.#agentAllocation(row.scope, row.agentId);
      if (allocation) {
        this.#database.prepare(`
          UPDATE token_budget_agent_allocations
          SET reserved_tokens = reserved_tokens - ?, spent_tokens = spent_tokens + ?
          WHERE scope = ? AND agent_id = ?
        `).run(row.amountTokens, billed, row.scope, row.agentId);
      }
      this.#database.prepare(`
        UPDATE token_budget_reservations SET billed_tokens = ?, state = 'RECONCILED' WHERE id = ?
      `).run(billed, id);
      this.#database.exec("COMMIT");
      return Object.freeze({...row, billedTokens: billed, state: "RECONCILED"});
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  public releaseTokens(id: string): TokenBudgetReservation {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#tokenReservationRow(id);
      if (row.state !== "ACTIVE") {
        throw new Error(`token reservation ${id} cannot be released from ${row.state}`);
      }
      this.#database.prepare(`
        UPDATE token_budget_accounts SET reserved_tokens = reserved_tokens - ? WHERE scope = ?
      `).run(row.amountTokens, row.scope);
      const allocation = this.#agentAllocation(row.scope, row.agentId);
      if (allocation) {
        this.#database.prepare(`
          UPDATE token_budget_agent_allocations SET reserved_tokens = reserved_tokens - ?
          WHERE scope = ? AND agent_id = ?
        `).run(row.amountTokens, row.scope, row.agentId);
      }
      this.#database.prepare("UPDATE token_budget_reservations SET state = 'RELEASED' WHERE id = ?").run(id);
      this.#database.exec("COMMIT");
      return Object.freeze({...row, state: "RELEASED"});
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  public reassignAgentTokens(scope: string, fromAgentId: string, toAgentId: string, amountTokens: number): readonly AgentTokenAllocation[] {
    validateAgentId(fromAgentId);
    validateAgentId(toAgentId);
    if (fromAgentId === toAgentId) throw new Error("token reassignment requires two different agents");
    const amount = integerTokens(amountTokens, "reassigned tokens");
    if (amount === 0) throw new Error("reassigned tokens must be positive");
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const from = this.#agentAllocation(scope, fromAgentId);
      const to = this.#agentAllocation(scope, toAgentId);
      if (!from || !to) throw new Error("both token allocations must exist before reassignment");
      if (amount > from.remainingTokens) throw new BudgetExceededError(from, amount);
      this.#database.prepare(`
        UPDATE token_budget_agent_allocations SET allocated_tokens = allocated_tokens - ?
        WHERE scope = ? AND agent_id = ?
      `).run(amount, scope, fromAgentId);
      this.#database.prepare(`
        UPDATE token_budget_agent_allocations SET allocated_tokens = allocated_tokens + ?
        WHERE scope = ? AND agent_id = ?
      `).run(amount, scope, toAgentId);
      this.#database.exec("COMMIT");
      return this.agentTokenAllocations(scope);
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  public extendTokenBudget(scope: string, extension: TokenBudgetExtension): TokenBudgetAccount {
    validateApprovalId(extension.approvalId);
    const amount = integerTokens(extension.amountTokens, "extension tokens");
    const expiresAt = parseTimestamp(extension.expiresAt, "extension expiry");
    const consumedAtText = this.#now().toISOString();
    const consumedAt = parseTimestamp(consumedAtText, "extension consumption time");
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.#database.prepare("SELECT approval_id FROM token_budget_extensions WHERE approval_id = ?").get(extension.approvalId);
      if (existing) throw new InvalidBudgetExtensionError(`budget approval ${extension.approvalId} was already consumed`);
      const account = this.tokenAccount(scope);
      const exactIncrement = Math.floor(account.fullLimitTokens * 25 / 100);
      if (amount !== exactIncrement) {
        throw new InvalidBudgetExtensionError(`extension must equal exactly 25% of the full ceiling (${exactIncrement} tokens)`);
      }
      if (expiresAt <= consumedAt) throw new InvalidBudgetExtensionError("budget extension approval is expired");
      if (expiresAt - consumedAt > 15 * 60 * 1_000) {
        throw new InvalidBudgetExtensionError("budget extension approval expiry exceeds 15 minutes");
      }
      if (account.effectiveLimitTokens + amount > account.fullLimitTokens) {
        throw new InvalidBudgetExtensionError("budget extension would exceed the configured full ceiling");
      }
      this.#database.prepare(`
        INSERT INTO token_budget_extensions(approval_id, scope, amount_tokens, expires_at, consumed_at)
        VALUES(?, ?, ?, ?, ?)
      `).run(extension.approvalId, scope, amount, extension.expiresAt, consumedAtText);
      this.#database.prepare(`
        UPDATE token_budget_accounts SET extension_tokens = extension_tokens + ? WHERE scope = ?
      `).run(amount, scope);
      if (this.#allocationCount(scope) > 0) {
        this.#database.prepare(`
          INSERT INTO token_budget_agent_allocations(scope, agent_id, allocated_tokens)
          VALUES(?, ?, ?)
          ON CONFLICT(scope, agent_id) DO UPDATE SET allocated_tokens = allocated_tokens + excluded.allocated_tokens
        `).run(scope, SOFTWARE_AGENT_EXTENSION_POOL_ID, amount);
      }
      this.#database.exec("COMMIT");
      return this.tokenAccount(scope);
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

  #tokenReservationRow(id: string): TokenBudgetReservation {
    const row = this.#database.prepare("SELECT * FROM token_budget_reservations WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) throw new Error(`unknown token budget reservation: ${id}`);
    const billed = row.billed_tokens === null ? "UNKNOWN" : numberColumn(row.billed_tokens);
    return {
      id,
      scope: String(row.scope),
      agentId: String(row.agent_id),
      estimatedInputTokens: numberColumn(row.estimated_input_tokens),
      maxOutputTokens: numberColumn(row.max_output_tokens),
      toolResultReserveTokens: numberColumn(row.tool_result_reserve_tokens),
      amountTokens: numberColumn(row.amount_tokens),
      billedTokens: billed,
      state: String(row.state) as TokenReservationState,
      createdAt: String(row.created_at),
    };
  }

  #agentAllocation(scope: string, agentId: string): AgentTokenAllocation | undefined {
    const row = this.#database.prepare(`
      SELECT * FROM token_budget_agent_allocations WHERE scope = ? AND agent_id = ?
    `).get(scope, agentId) as Record<string, unknown> | undefined;
    return row ? freezeAgentAllocation(row) : undefined;
  }

  #allocationCount(scope: string): number {
    const row = this.#database.prepare(`
      SELECT COUNT(*) AS count FROM token_budget_agent_allocations WHERE scope = ?
    `).get(scope) as Record<string, unknown>;
    return numberColumn(row.count);
  }
}

function freezeAgentAllocation(row: Record<string, unknown>): AgentTokenAllocation {
  const allocated = numberColumn(row.allocated_tokens);
  const spent = numberColumn(row.spent_tokens);
  const reserved = numberColumn(row.reserved_tokens);
  return Object.freeze({
    scope: String(row.scope),
    agentId: String(row.agent_id),
    allocatedTokens: allocated,
    spentTokens: spent,
    reservedTokens: reserved,
    remainingTokens: Math.max(0, allocated - spent - reserved),
  });
}

function normalizeAgentShares(shares: Readonly<Record<string, number>> | undefined): [string, number][] {
  if (!shares) return [];
  const entries = Object.entries(shares).sort(([left], [right]) => left.localeCompare(right));
  let total = 0;
  for (const [agentId, percentage] of entries) {
    validateAgentId(agentId);
    if (!Number.isFinite(percentage) || percentage <= 0 || percentage > 100) {
      throw new Error("agent token shares must be finite percentages from 0 to 100");
    }
    total += percentage;
  }
  if (Math.abs(total - 100) > 0.000001) throw new Error("agent token shares must total exactly 100 percent");
  return entries;
}

function optionalTokenCount(value: number | undefined): number | "UNKNOWN" {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : "UNKNOWN";
}

function integerTokens(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a safe non-negative integer`);
  return value;
}

function safeTokenSum(...values: readonly number[]): number {
  const result = values.reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(result)) throw new Error("token reservation exceeds safe integer range");
  return result;
}

function validateScope(scope: string): void {
  if (scope.length < 1 || scope.length > 256 || hasControlCharacters(scope)) throw new Error("invalid budget scope");
}

function validateAgentId(agentId: string): void {
  if (!/^[a-z0-9][a-z0-9._:-]{0,127}$/u.test(agentId)) throw new Error("invalid Software Agent ID");
}

function validateApprovalId(approvalId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(approvalId)) throw new InvalidBudgetExtensionError("invalid budget approval ID");
}

function parseTimestamp(value: string, label: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new InvalidBudgetExtensionError(`${label} must be an ISO timestamp`);
  return timestamp;
}

function reservationId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
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

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) return true;
  }
  return false;
}
