import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ApprovalAlreadyConsumedError,
  ApprovalBindingMismatchError,
  ApprovalExpiredError,
  ApprovalService,
  ApprovalTokenError,
  APPROVAL_STATUSES,
  canTransitionApproval,
  type ApprovalStatus,
} from "../../packages/approval-service/src/index.js";
import {
  approvalBindingFor,
  canonicalize,
  createOperationCandidate,
  hasOperationIntegrity,
  sha256Bytes,
  sha256Canonical,
  type ApprovalBinding,
  type OperationCandidate,
} from "../../packages/contracts/src/index.js";
import {
  DagValidationError,
  AGENT_STATUSES,
  RevisionConflictError,
  RUN_STATUSES,
  StateTransitionError,
  TASK_STATUSES,
  canTransitionRun,
  canTransitionTask,
  createRunState,
  createTaskState,
  getDagReadiness,
  topologicalOrder,
  transitionRun,
  transitionTask,
  type RunStatus,
  type TaskStatus,
} from "../../packages/domain/src/index.js";
import {
  IdempotencyConflictError,
  SqliteEventStore,
  StreamVersionConflictError,
} from "../../packages/event-store-sqlite/src/index.js";
import { evaluateConnectorOperation } from "../../packages/policy-engine/src/index.js";

const NOW = "2026-08-18T10:00:00.000Z";
const LATER = "2026-08-18T10:05:00.000Z";
const EXPIRES = "2026-08-18T11:00:00.000Z";
const ACTOR = { type: "agent", id: "backend-engineer:run_1" } as const;

const openResources: Array<{ close(): void }> = [];
const temporaryDirectories: string[] = [];

function databaseFile(name: string): string {
  const directory = mkdtempSync(join(tmpdir(), "agent-company-core-"));
  temporaryDirectories.push(directory);
  return join(directory, name);
}

function eventStore(): SqliteEventStore {
  const store = new SqliteEventStore(databaseFile("events.sqlite"));
  openResources.push(store);
  return store;
}

function approvalService(): ApprovalService {
  const service = new ApprovalService(databaseFile("approvals.sqlite"));
  openResources.push(service);
  return service;
}

afterEach(() => {
  for (const resource of openResources.splice(0).reverse()) {
    resource.close();
  }
  for (const directory of temporaryDirectories.splice(0).reverse()) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("canonical contracts", () => {
  it("canonicalizes object keys recursively and hashes equivalent JSON identically", () => {
    const left = { z: [{ b: 2, a: 1 }], a: -0 } as const;
    const right = { a: 0, z: [{ a: 1, b: 2 }] } as const;

    expect(canonicalize(left)).toBe('{"a":0,"z":[{"a":1,"b":2}]}');
    expect(sha256Canonical(left)).toBe(sha256Canonical(right));
  });

  it("creates immutable, integrity-checkable operations for local and connected boundaries", () => {
    const first = createOperationCandidate({
      actor: ACTOR,
      connector: "local",
      action: "shell.execute",
      resource: "workspace://project",
      environment: "local",
      artifactSha256: null,
      parameters: { command: ["npm", "test"], timeoutMs: 60_000 },
    });
    const second = createOperationCandidate({
      actor: ACTOR,
      connector: "local",
      action: "shell.execute",
      resource: "workspace://project",
      environment: "local",
      artifactSha256: null,
      parameters: { timeoutMs: 60_000, command: ["npm", "test"] },
    });

    expect(first.operationHash).toBe(second.operationHash);
    expect(hasOperationIntegrity(first)).toBe(true);
    const tampered = { ...first, resource: "workspace://other" } as OperationCandidate;
    expect(hasOperationIntegrity(tampered)).toBe(false);
  });
});

describe("canonical state machines", () => {
  const runTransitions: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
    DRAFT: ["PLANNING", "CANCELED"],
    PLANNING: ["WAITING_INPUT", "WAITING_APPROVAL", "RUNNING", "FAILED", "CANCELED"],
    WAITING_INPUT: ["PLANNING", "CANCELED"],
    WAITING_APPROVAL: ["RUNNING", "PLANNING", "FAILED", "CANCELED"],
    RUNNING: [
      "WAITING_INPUT",
      "WAITING_APPROVAL",
      "PAUSING",
      "RECOVERING",
      "NEEDS_RECONCILIATION",
      "SUCCEEDED",
      "PARTIAL",
      "FAILED",
      "CANCELED",
    ],
    PAUSING: ["PAUSED", "NEEDS_RECONCILIATION", "FAILED"],
    PAUSED: ["RUNNING", "RECOVERING", "CANCELED"],
    RECOVERING: ["RUNNING", "PAUSED", "NEEDS_RECONCILIATION", "PARTIAL", "FAILED"],
    NEEDS_RECONCILIATION: ["RECOVERING", "PARTIAL", "FAILED"],
    SUCCEEDED: [],
    PARTIAL: [],
    FAILED: [],
    CANCELED: [],
  };

  const taskTransitions: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
    PROPOSED: ["BLOCKED", "READY", "SKIPPED", "CANCELED"],
    BLOCKED: ["READY", "SKIPPED", "CANCELED"],
    READY: ["CLAIMED", "BLOCKED", "CANCELED"],
    CLAIMED: ["RUNNING", "READY", "FAILED", "CANCELED"],
    RUNNING: ["WAITING_TOOL", "WAITING_INPUT", "WAITING_APPROVAL", "REVIEW", "FAILED", "CANCELED"],
    WAITING_TOOL: ["RUNNING", "FAILED", "CANCELED"],
    WAITING_INPUT: ["RUNNING", "FAILED", "CANCELED"],
    WAITING_APPROVAL: ["RUNNING", "REWORK", "FAILED", "CANCELED"],
    REVIEW: ["REWORK", "PASSED", "FAILED"],
    REWORK: ["READY", "BLOCKED", "CANCELED"],
    PASSED: [],
    FAILED: [],
    SKIPPED: [],
    CANCELED: [],
  };

  it("exposes exactly the blueprint run and task transitions", () => {
    expect(AGENT_STATUSES).toEqual([
      "ACTIVATING", "PLANNING", "RUNNING", "WAITING_TOOL", "WAITING_INPUT", "WAITING_APPROVAL",
      "BLOCKED", "REVIEWING", "PAUSED", "SUCCEEDED", "FAILED", "STOPPED",
    ]);
    for (const from of RUN_STATUSES) {
      for (const to of RUN_STATUSES) {
        expect(canTransitionRun(from, to), `${from} -> ${to}`).toBe(
          runTransitions[from].includes(to),
        );
      }
    }
    for (const from of TASK_STATUSES) {
      for (const to of TASK_STATUSES) {
        expect(canTransitionTask(from, to), `${from} -> ${to}`).toBe(
          taskTransitions[from].includes(to),
        );
      }
    }
  });

  it("increments revisions and rejects illegal paths or stale controllers", () => {
    const draft = createRunState("run_1", NOW);
    const planning = transitionRun(draft, "PLANNING", LATER, 0);
    expect(planning).toMatchObject({ status: "PLANNING", revision: 1 });
    expect(() => transitionRun(planning, "SUCCEEDED", LATER)).toThrow(StateTransitionError);
    expect(() => transitionRun(planning, "RUNNING", LATER, 0)).toThrow(RevisionConflictError);

    const proposed = createTaskState("task_1", "run_1", NOW);
    const ready = transitionTask(proposed, "READY", LATER);
    expect(ready).toMatchObject({ status: "READY", revision: 1 });
    expect(() => transitionTask(ready, "PASSED", LATER)).toThrow(StateTransitionError);
  });
});

describe("DAG helpers", () => {
  const nodes = [
    { id: "review", dependsOn: ["build"] },
    { id: "build", dependsOn: ["plan"] },
    { id: "plan", dependsOn: [] },
  ] as const;

  it("orders dependencies and reports deterministic readiness", () => {
    expect(topologicalOrder(nodes)).toEqual(["plan", "build", "review"]);
    expect(getDagReadiness(nodes, {}).ready).toEqual(["plan"]);
    expect(getDagReadiness(nodes, { plan: "PASSED" })).toEqual({
      ready: ["build"],
      waiting: ["review"],
      blocked: [],
    });
    expect(getDagReadiness(nodes, { plan: "FAILED" }).blocked).toEqual(["build"]);
  });

  it("rejects cycles, duplicate nodes, and missing dependencies", () => {
    expect(() =>
      topologicalOrder([
        { id: "a", dependsOn: ["b"] },
        { id: "b", dependsOn: ["a"] },
      ]),
    ).toThrow(DagValidationError);
    expect(() =>
      topologicalOrder([
        { id: "a", dependsOn: [] },
        { id: "a", dependsOn: [] },
      ]),
    ).toThrow(DagValidationError);
    expect(() => topologicalOrder([{ id: "a", dependsOn: ["missing"] }])).toThrow(
      DagValidationError,
    );
  });
});

describe("SQLite event store", () => {
  function command(commandId: string, streamId: string, expectedVersion: number, label: string) {
    return {
      commandId,
      operationHash: sha256Canonical({ commandId, streamId, label }),
      streamId,
      expectedVersion,
      events: [
        {
          eventId: `evt_${commandId}`,
          eventType: "run.transitioned",
          occurredAt: NOW,
          actor: ACTOR,
          data: { label },
        },
      ],
      response: { accepted: true, label },
      createdAt: NOW,
    } as const;
  }

  it("uses WAL and appends, loads, and globally replays ordered events", () => {
    const store = eventStore();
    expect(store.journalMode()).toBe("wal");
    store.append(command("cmd_1", "run_1", 0, "one"));
    store.append(command("cmd_2", "run_2", 0, "two"));
    store.append(command("cmd_3", "run_1", 1, "three"));

    expect(store.load("run_1").map((event) => event.streamVersion)).toEqual([1, 2]);
    expect(store.replay().map((event) => event.data.label)).toEqual(["one", "two", "three"]);
    expect(store.replay(1, 1)).toHaveLength(1);
  });

  it("returns the original command receipt without duplicating events", () => {
    const store = eventStore();
    const input = command("cmd_same", "run_1", 0, "one");
    const first = store.append(input);
    const replay = store.append(input);

    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.receipt).toEqual(first.receipt);
    expect(store.replay()).toHaveLength(1);
    expect(store.pendingOutbox()).toHaveLength(1);
  });

  it("persists transactional outbox, consumer offsets, and replay snapshots", () => {
    const store = eventStore();
    store.append(command("cmd_outbox", "run_outbox", 0, "one"));
    const [pending] = store.pendingOutbox();
    expect(pending).toMatchObject({streamId: "run_outbox", eventType: "run.transitioned", deliveredAt: null});
    expect(pending?.payload).toMatchObject({schema: "agent-company.event/v1", streamVersion: 1});
    store.commitConsumerOffset("projection:runs", pending!.sequence, LATER);
    expect(store.consumerOffset("projection:runs")).toBe(pending!.sequence);
    expect(() => store.commitConsumerOffset("projection:runs", 0, LATER)).toThrow();
    store.markOutboxDelivered(pending!.sequence, LATER);
    expect(store.pendingOutbox()).toEqual([]);

    store.saveSnapshot({streamId: "run_outbox", streamVersion: 1, state: {status: "PLANNING"}, createdAt: LATER});
    expect(store.loadSnapshot("run_outbox")).toEqual({
      streamId: "run_outbox",
      streamVersion: 1,
      state: {status: "PLANNING"},
      createdAt: LATER,
    });
  });

  it("fails closed on command-key drift and optimistic stream conflicts", () => {
    const store = eventStore();
    store.append(command("cmd_1", "run_1", 0, "one"));
    expect(() => store.append(command("cmd_1", "run_1", 1, "changed"))).toThrow(
      IdempotencyConflictError,
    );
    expect(() => store.append(command("cmd_2", "run_1", 0, "stale"))).toThrow(
      StreamVersionConflictError,
    );
  });
});

describe("connector policy", () => {
  function operation(
    connector: "github" | "vercel" | "supabase",
    action: string,
    environment: "preview" | "production",
  ): OperationCandidate {
    return createOperationCandidate({
      actor: ACTOR,
      connector,
      action,
      resource: `${connector}://account/project`,
      environment,
      artifactSha256: sha256Bytes("candidate"),
      parameters: {},
    });
  }

  it("keeps push, pull-request creation, preview, and production as separate risks", () => {
    expect(evaluateConnectorOperation(operation("github", "push", "preview"))).toMatchObject({
      permitted: true,
      approvalClass: "A2_REMOTE_REVERSIBLE",
      requiresApproval: true,
    });
    expect(
      evaluateConnectorOperation(operation("github", "push_and_create_pull_request", "preview")),
    ).toMatchObject({ permitted: false, hardDenied: false, risk: "unknown" });
    expect(
      evaluateConnectorOperation(operation("vercel", "deploy_preview", "preview")),
    ).toMatchObject({ approvalClass: "A2_REMOTE_REVERSIBLE" });
    expect(
      evaluateConnectorOperation(operation("vercel", "deploy_production", "production")),
    ).toMatchObject({ approvalClass: "A4_PRODUCTION_OR_SECURITY" });
  });

  it("hard-denies production Supabase reset/seed and production secret copying", () => {
    expect(
      evaluateConnectorOperation(operation("supabase", "reset_database", "production")),
    ).toMatchObject({
      permitted: false,
      hardDenied: true,
      approvalClass: "A5_DESTRUCTIVE_OR_IRREVERSIBLE",
      risk: "hard_denied",
    });
    expect(
      evaluateConnectorOperation(operation("supabase", "seed_database", "production")),
    ).toMatchObject({ permitted: false, hardDenied: true });
    expect(
      evaluateConnectorOperation(operation("vercel", "copy_environment_secrets", "production")),
    ).toMatchObject({ permitted: false, hardDenied: true });
  });

  it("hard-denies a candidate changed after hashing", () => {
    const original = operation("github", "push", "preview");
    const changed = { ...original, resource: "github://other/repository" } as OperationCandidate;
    expect(evaluateConnectorOperation(changed)).toMatchObject({
      permitted: false,
      hardDenied: true,
    });
  });
});

describe("approval service", () => {
  const transitionTable: Readonly<Record<ApprovalStatus, readonly ApprovalStatus[]>> = {
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

  function candidate(actorId = ACTOR.id): OperationCandidate {
    return createOperationCandidate({
      actor: { type: "agent", id: actorId },
      connector: "github",
      action: "push",
      resource: "github://owner/repository/refs/heads/task-1",
      environment: "preview",
      artifactSha256: sha256Bytes("commit"),
      parameters: { force: false },
    });
  }

  it("exposes only the canonical approval states and transitions", () => {
    expect(APPROVAL_STATUSES).toEqual([
      "PENDING",
      "APPROVED",
      "DENIED",
      "CHANGES_REQUESTED",
      "CANCELED",
      "SUPERSEDED",
      "EXPIRED",
      "CONSUMED",
      "INVALIDATED",
    ]);
    for (const from of APPROVAL_STATUSES) {
      for (const to of APPROVAL_STATUSES) {
        expect(canTransitionApproval(from, to), `${from} -> ${to}`).toBe(
          transitionTable[from].includes(to),
        );
      }
    }
  });

  it("binds an approval exactly and consumes it once atomically", () => {
    const service = approvalService();
    const binding = approvalBindingFor(candidate());
    const request = service.request({
      approvalId: "apr_once",
      binding,
      requestedAt: NOW,
      expiresAt: EXPIRES,
    });
    expect(request.status).toBe("PENDING");

    const approved = service.decide({
      approvalId: request.approvalId,
      approver: { type: "human", id: "owner" },
      decision: "APPROVED",
      decidedAt: LATER,
      reason: "reviewed exact branch and candidate",
    });
    expect(approved.status).toBe("APPROVED");

    const changed: ApprovalBinding = { ...binding, resource: `${binding.resource}-changed` };
    expect(() =>
      service.consume({ approvalId: request.approvalId, binding: changed, consumedAt: LATER }),
    ).toThrow(ApprovalBindingMismatchError);

    expect(
      service.consume({ approvalId: request.approvalId, binding, consumedAt: LATER }).status,
    ).toBe("CONSUMED");
    expect(() =>
      service.consume({ approvalId: request.approvalId, binding, consumedAt: LATER }),
    ).toThrow(ApprovalAlreadyConsumedError);
  });

  it("signs short-lived authorizations and rejects token tampering", () => {
    const service = approvalService();
    const binding = approvalBindingFor(candidate());
    service.request({approvalId: "apr_token", binding, requestedAt: NOW, expiresAt: EXPIRES});
    service.decide({
      approvalId: "apr_token",
      approver: {type: "human", id: "owner"},
      decision: "APPROVED",
      decidedAt: LATER,
    });
    const token = service.issueAuthorization("apr_token", LATER);
    const replacement = token.endsWith("a") ? "b" : "a";
    expect(() => service.consumeAuthorization(`${token.slice(0, -1)}${replacement}`, binding, LATER)).toThrow(ApprovalTokenError);
    expect(service.consumeAuthorization(token, binding, LATER).status).toBe("CONSUMED");
    expect(() => service.consumeAuthorization(token, binding, LATER)).toThrow(ApprovalAlreadyConsumedError);
  });

  it("keeps authorization verification stable across controller restart", () => {
    const filename = databaseFile("approval-restart.sqlite");
    const first = new ApprovalService(filename);
    const binding = approvalBindingFor(candidate());
    first.request({approvalId: "apr_restart", binding, requestedAt: NOW, expiresAt: EXPIRES});
    first.decide({
      approvalId: "apr_restart",
      approver: {type: "human", id: "owner"},
      decision: "APPROVED",
      decidedAt: LATER,
    });
    const token = first.issueAuthorization("apr_restart", LATER);
    first.close();

    const restarted = new ApprovalService(filename);
    openResources.push(restarted);
    expect(restarted.consumeAuthorization(token, binding, LATER).status).toBe("CONSUMED");
  });

  it("expires at the exact deadline and never authorizes execution", () => {
    const service = approvalService();
    const binding = approvalBindingFor(candidate());
    service.request({ approvalId: "apr_expiry", binding, requestedAt: NOW, expiresAt: EXPIRES });
    service.decide({
      approvalId: "apr_expiry",
      approver: { type: "human", id: "owner" },
      decision: "APPROVED",
      decidedAt: LATER,
    });

    expect(() =>
      service.consume({ approvalId: "apr_expiry", binding, consumedAt: EXPIRES }),
    ).toThrow(ApprovalExpiredError);
    expect(service.get("apr_expiry")?.status).toBe("EXPIRED");
  });

  it("supports the local control boundary without pretending it is an external connector", () => {
    const service = approvalService();
    const local = createOperationCandidate({
      actor: ACTOR,
      connector: "local",
      action: "filesystem.write",
      resource: "workspace://project/src/file.ts",
      environment: "local",
      artifactSha256: sha256Bytes("proposed contents"),
      parameters: { mode: "replace" },
    });
    const record = service.request({
      approvalId: "apr_local",
      binding: approvalBindingFor(local),
      requestedAt: NOW,
      expiresAt: EXPIRES,
    });
    expect(record.binding.connector).toBe("local");
  });
});
