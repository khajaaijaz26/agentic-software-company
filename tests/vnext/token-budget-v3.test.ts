import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

import {afterEach, describe, expect, it} from "vitest";

import {
  BudgetExceededError,
  BudgetLedger,
  InvalidBudgetExtensionError,
  SOFTWARE_AGENT_EXTENSION_POOL_ID,
  effectiveTokenLimit,
  normalizeProviderTokenUsage,
} from "../../packages/budgets/src/index.js";

const ledgers: BudgetLedger[] = [];
const temporaryDirectories: string[] = [];

function databaseFile(): string {
  const directory = mkdtempSync(join(tmpdir(), "software-agent-budget-"));
  temporaryDirectories.push(directory);
  return join(directory, "budget.sqlite");
}

function ledger(filename = databaseFile(), now?: () => Date): BudgetLedger {
  const value = new BudgetLedger(filename, {...(now === undefined ? {} : {now})});
  ledgers.push(value);
  return value;
}

afterEach(() => {
  for (const value of ledgers.splice(0).reverse()) value.close();
  for (const directory of temporaryDirectories.splice(0).reverse()) {
    rmSync(directory, {recursive: true, force: true});
  }
});

describe("Software Agent normalized token accounting", () => {
  it("uses a valid provider total without double-counting cached or reasoning subsets", () => {
    expect(normalizeProviderTokenUsage({
      inputTokens: 100,
      outputTokens: 40,
      cachedInputTokens: 60,
      reasoningTokens: 20,
      totalTokens: 140,
    })).toEqual({
      inputTokens: 100,
      outputTokens: 40,
      cachedInputTokens: 60,
      reasoningTokens: 20,
      totalTokens: 140,
      billedTokens: 140,
      status: "KNOWN",
    });
    expect(normalizeProviderTokenUsage({
      inputTokens: 100,
      outputTokens: 40,
      cachedInputTokens: 101,
      totalTokens: 140,
    })).toMatchObject({billedTokens: 140, status: "KNOWN"});
  });

  it("falls back to input plus output and marks malformed or incomplete usage unknown", () => {
    expect(normalizeProviderTokenUsage({inputTokens: 12, outputTokens: 8, cachedInputTokens: 4}))
      .toMatchObject({billedTokens: 20, status: "KNOWN"});
    expect(normalizeProviderTokenUsage({inputTokens: 12, outputTokens: -1}))
      .toMatchObject({billedTokens: "UNKNOWN", status: "UNKNOWN"});
    expect(normalizeProviderTokenUsage({inputTokens: 12}))
      .toMatchObject({billedTokens: "UNKNOWN", status: "UNKNOWN"});
  });

  it("calculates the three deterministic mode ceilings", () => {
    expect(effectiveTokenLimit(100_000, "economy")).toBe(25_000);
    expect(effectiveTokenLimit(100_000, "balanced")).toBe(50_000);
    expect(effectiveTokenLimit(100_000, "quality")).toBe(100_000);
  });
});

describe("Software Agent race-safe token ledger", () => {
  it("reserves estimated input, maximum output, and tool-result headroom atomically", () => {
    const value = ledger();
    value.configureTokenBudget({
      scope: "run:one",
      fullLimitTokens: 100_000,
      mode: "balanced",
      agentShares: {"master-orchestrator": 25, "software-engineer": 50, "reviewer-qa": 25},
    });
    const reservation = value.reserveTokens("run:one", {
      agentId: "software-engineer",
      estimatedInputTokens: 1_000,
      maxOutputTokens: 2_000,
      toolResultReserveTokens: 500,
    });

    expect(reservation).toMatchObject({amountTokens: 3_500, state: "ACTIVE", agentId: "software-engineer"});
    expect(value.tokenAccount("run:one")).toMatchObject({
      fullLimitTokens: 100_000,
      effectiveLimitTokens: 50_000,
      reservedTokens: 3_500,
      remainingTokens: 46_500,
      warning: false,
      blocked: false,
    });
  });

  it("allows only one concurrent reservation at an exact shared boundary", async () => {
    const filename = databaseFile();
    const first = ledger(filename);
    const second = ledger(filename);
    first.configureTokenBudget({scope: "run:race", fullLimitTokens: 4_000, mode: "quality"});

    const results = await Promise.allSettled([
      Promise.resolve().then(() => first.reserveTokens("run:race", {
        agentId: "software-engineer",
        estimatedInputTokens: 1_000,
        maxOutputTokens: 2_000,
        toolResultReserveTokens: 0,
      })),
      Promise.resolve().then(() => second.reserveTokens("run:race", {
        agentId: "reviewer-qa",
        estimatedInputTokens: 1_000,
        maxOutputTokens: 2_000,
        toolResultReserveTokens: 0,
      })),
    ]);

    expect(results.filter(({status}) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({status}) => status === "rejected")).toHaveLength(1);
    expect(first.tokenAccount("run:race").reservedTokens).toBe(3_000);
  });

  it("reconciles known usage and records overspend instead of hiding incurred tokens", () => {
    const value = ledger();
    value.configureTokenBudget({scope: "run:known", fullLimitTokens: 2_000, mode: "quality"});
    const reservation = value.reserveTokens("run:known", {
      agentId: "software-engineer",
      estimatedInputTokens: 500,
      maxOutputTokens: 500,
      toolResultReserveTokens: 0,
    });
    value.reconcileTokens(reservation.id, {inputTokens: 800, outputTokens: 1_500, totalTokens: 2_300});

    expect(value.tokenAccount("run:known")).toMatchObject({
      spentTokens: 2_300,
      reservedTokens: 0,
      remainingTokens: 0,
      blocked: true,
    });
  });

  it("retains the complete reservation for partial or unknown usage until later reconciliation", () => {
    const value = ledger();
    value.configureTokenBudget({scope: "run:unknown", fullLimitTokens: 10_000, mode: "quality"});
    const reservation = value.reserveTokens("run:unknown", {
      agentId: "software-engineer",
      estimatedInputTokens: 1_000,
      maxOutputTokens: 2_000,
      toolResultReserveTokens: 500,
    });
    expect(value.reconcileTokens(reservation.id, {inputTokens: 1_000})).toMatchObject({state: "UNKNOWN"});
    expect(value.tokenAccount("run:unknown")).toMatchObject({reservedTokens: 3_500, uncertainTokens: 3_500});

    value.reconcileTokens(reservation.id, {inputTokens: 1_000, outputTokens: 700, totalTokens: 1_700});
    expect(value.tokenAccount("run:unknown")).toMatchObject({reservedTokens: 0, uncertainTokens: 0, spentTokens: 1_700});
  });

  it("releases a reservation only when no provider billing may have occurred", () => {
    const value = ledger();
    value.configureTokenBudget({scope: "run:release", fullLimitTokens: 10_000, mode: "quality"});
    const reservation = value.reserveTokens("run:release", {
      agentId: "software-engineer",
      estimatedInputTokens: 100,
      maxOutputTokens: 100,
      toolResultReserveTokens: 0,
    });
    value.releaseTokens(reservation.id);
    expect(value.tokenAccount("run:release")).toMatchObject({spentTokens: 0, reservedTokens: 0});
  });

  it("enforces per-agent shares until an explicit atomic reassignment", () => {
    const value = ledger();
    value.configureTokenBudget({
      scope: "run:shares",
      fullLimitTokens: 100_000,
      mode: "balanced",
      agentShares: {"master-orchestrator": 25, "software-engineer": 50, "reviewer-qa": 25},
    });
    expect(() => value.reserveTokens("run:shares", {
      agentId: "reviewer-qa",
      estimatedInputTokens: 13_000,
      maxOutputTokens: 0,
      toolResultReserveTokens: 0,
    })).toThrow(BudgetExceededError);

    value.reassignAgentTokens("run:shares", "software-engineer", "reviewer-qa", 5_000);
    expect(value.reserveTokens("run:shares", {
      agentId: "reviewer-qa",
      estimatedInputTokens: 13_000,
      maxOutputTokens: 0,
      toolResultReserveTokens: 0,
    })).toMatchObject({amountTokens: 13_000});

    expect(() => value.reserveTokens("run:shares", {
      agentId: "unallocated-agent",
      estimatedInputTokens: 1,
      maxOutputTokens: 0,
      toolResultReserveTokens: 0,
    })).toThrow("has no token allocation");
  });

  it("places extensions for shared budgets in an explicitly reassignable pool", () => {
    const value = ledger(databaseFile(), () => new Date("2026-08-19T10:00:00.000Z"));
    value.configureTokenBudget({
      scope: "run:shared-extension",
      fullLimitTokens: 100_000,
      mode: "balanced",
      agentShares: {"software-engineer": 50, "reviewer-qa": 50},
    });
    value.extendTokenBudget("run:shared-extension", {
      approvalId: "approval_shared",
      amountTokens: 25_000,
      expiresAt: "2026-08-19T10:15:00.000Z",
    });

    expect(value.agentTokenAllocations("run:shared-extension")).toContainEqual(expect.objectContaining({
      agentId: SOFTWARE_AGENT_EXTENSION_POOL_ID,
      allocatedTokens: 25_000,
    }));
    value.reassignAgentTokens("run:shared-extension", SOFTWARE_AGENT_EXTENSION_POOL_ID, "reviewer-qa", 5_000);
    expect(value.agentTokenAllocations("run:shared-extension")).toContainEqual(expect.objectContaining({
      agentId: "reviewer-qa",
      allocatedTokens: 30_000,
    }));
  });

  it("consumes exact, expiring, single-use 25-percent extensions up to the full ceiling", () => {
    const value = ledger(databaseFile(), () => new Date("2026-08-19T10:00:00.000Z"));
    value.configureTokenBudget({scope: "run:extend", fullLimitTokens: 100_000, mode: "balanced"});
    const first = value.extendTokenBudget("run:extend", {
      approvalId: "approval_1",
      amountTokens: 25_000,
      expiresAt: "2026-08-19T10:15:00.000Z",
    });
    expect(first.effectiveLimitTokens).toBe(75_000);
    expect(() => value.extendTokenBudget("run:extend", {
      approvalId: "approval_1",
      amountTokens: 25_000,
      expiresAt: "2026-08-19T10:15:00.000Z",
    })).toThrow(InvalidBudgetExtensionError);
    expect(value.extendTokenBudget("run:extend", {
      approvalId: "approval_2",
      amountTokens: 25_000,
      expiresAt: "2026-08-19T10:15:00.000Z",
    }).effectiveLimitTokens).toBe(100_000);
    expect(() => value.extendTokenBudget("run:extend", {
      approvalId: "approval_3",
      amountTokens: 25_000,
      expiresAt: "2026-08-19T10:15:00.000Z",
    })).toThrow(InvalidBudgetExtensionError);
  });

  it("rejects expired or non-exact extension packets", () => {
    const value = ledger(databaseFile(), () => new Date("2026-08-19T10:00:00.000Z"));
    value.configureTokenBudget({scope: "run:invalid-extension", fullLimitTokens: 100_000, mode: "economy"});
    expect(() => value.extendTokenBudget("run:invalid-extension", {
      approvalId: "approval_wrong",
      amountTokens: 10_000,
      expiresAt: "2026-08-19T10:15:00.000Z",
    })).toThrow(InvalidBudgetExtensionError);
    expect(() => value.extendTokenBudget("run:invalid-extension", {
      approvalId: "approval_expired",
      amountTokens: 25_000,
      expiresAt: "2026-08-19T09:59:59.000Z",
    })).toThrow(InvalidBudgetExtensionError);
  });
});
