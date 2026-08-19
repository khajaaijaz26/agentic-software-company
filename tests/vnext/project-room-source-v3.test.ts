import {mkdtemp, readFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";

import {describe, expect, it, vi} from "vitest";

import type {ApprovalRecord} from "../../packages/approval-service/src/index.js";
import type {StoredEvent} from "../../packages/contracts/src/index.js";
import {
  initializeProject,
  loadProjectConfig,
  loadUserProviderConfig,
  type PlatformPaths,
} from "../../packages/config/src/index.js";
import type {CredentialBackend} from "../../packages/secret-broker/src/index.js";
import type {SoftwareAgentRunView, SoftwareAgentSnapshot} from "../../apps/control-plane/src/controller.js";
import {
  IpcProjectRoomSource,
  softwareAgentSnapshotToProjectRoom,
  type ProjectRoomRpcClient,
} from "../../apps/cli/src/project-room-source.js";

const run: SoftwareAgentRunView = {
  id: "run_one",
  projectId: "project_one",
  objective: "Improve the application",
  state: "RUNNING",
  revision: 5,
  maxParallel: 3,
  createdAt: "2026-08-19T00:00:00.000Z",
  tasks: [{
    id: "run_one:implementation",
    title: "Implement the change",
    role: "software-engineer",
    dependsOn: [],
    mutatesWorkspace: true,
    state: "RUNNING",
    revision: 2,
    sessionId: "session_engineer",
    activeTurnId: "turn_one",
    summary: "Editing src/index.ts",
  }],
  sessions: [{
    id: "session_engineer",
    role: "software-engineer",
    state: "RUNNING",
    revision: 2,
    currentTaskId: "run_one:implementation",
    currentTurnId: "turn_one",
    lastHeartbeatAt: "2026-08-19T00:00:02.000Z",
  }],
  assignments: [],
  attempts: [],
  handoffs: [],
  questions: [],
  mailbox: [],
};

function event(sequence: number, eventType: string, data: StoredEvent["data"]): StoredEvent {
  return {
    schemaVersion: 1,
    sequence,
    streamVersion: sequence,
    eventId: `evt_${sequence}`,
    streamId: "run_one",
    eventType,
    occurredAt: `2026-08-19T00:00:0${sequence}.000Z`,
    actor: {type: "agent", id: "session_engineer"},
    data,
  };
}

function snapshot(runs: readonly SoftwareAgentRunView[] = [run]): SoftwareAgentSnapshot {
  return {
    schema: "software-agent.snapshot/v2",
    cursor: 3,
    projectId: "project_one",
    projectName: "Demo",
    generatedAt: "2026-08-19T00:00:03.000Z",
    mutationLease: null,
    runs,
    tokenBudgets: [],
    recentEvents: [
      event(1, "software-agent.task.started", {runId: "run_one", taskId: "run_one:implementation", sessionId: "session_engineer"}),
      event(2, "software-agent.tool.started", {runId: "run_one", sessionId: "session_engineer", tool: "write_file", path: "src/index.ts"}),
      event(3, "software-agent.model.completed", {runId: "run_one", sessionId: "session_engineer", model: "openai/gpt-5-codex", inputTokens: 100, outputTokens: 40, costUsd: 0.01, summary: "Implemented the requested change"}),
    ],
  };
}

describe("Software Agent project-room IPC adapter", () => {
  it("projects committed runtime, model, tool, token, and approval evidence", () => {
    const approval = {
      schemaVersion: 1,
      approvalId: "approval_one",
      binding: {
        schemaVersion: 1,
        actor: {type: "agent", id: "session_engineer"},
        connector: "local",
        action: "command:execute",
        resource: "run_one",
        environment: "local",
        artifactSha256: "a".repeat(64),
        operationHash: "b".repeat(64),
      },
      bindingHash: "c".repeat(64),
      status: "PENDING",
      requestedAt: "2026-08-19T00:00:00.000Z",
      expiresAt: "2026-08-19T00:15:00.000Z",
      decidedAt: null,
      decidedBy: null,
      decisionReason: "",
      consumedAt: null,
      terminalAt: null,
    } satisfies ApprovalRecord;

    const room = softwareAgentSnapshotToProjectRoom(snapshot(), [approval], {branch: "main", control: true});

    expect(room).toMatchObject({projectName: "Demo", branch: "main", cursor: 3, controller: {mode: "CONTROL"}});
    expect(room.run?.agents[0]).toMatchObject({
      displayName: "Backend Engineer",
      provider: "openai",
      model: "gpt-5-codex",
      tokens: {input: 100, output: 40},
      requestedFiles: ["src/index.ts"],
      requestedTools: ["write_file"],
      approvalId: "approval_one",
    });
    expect(room.roster).toHaveLength(26);
    expect(room.roster.find((agent) => agent.id === "backend-engineer")).toMatchObject({
      state: "WORKING",
      status: "WORKING NOW",
      taskTitle: "Implement the change",
      sessionId: "session_engineer",
    });
    expect(room.roster.find((agent) => agent.id === "frontend-engineer")).toMatchObject({status: "WAITING FOR WORK", sessionId: null});
    expect(room.approvals[0]).toMatchObject({id: "approval_one", risk: "A3_PROCESS_EXECUTION"});
  });

  it("binds objective creation and resume to one renewable UI control lease", async () => {
    const calls: Array<{method: string; params: unknown}> = [];
    const request = vi.fn(async (method: string, params: unknown) => {
      calls.push({method, params});
      if (method === "mutation.acquire") return {
        leaseId: "lease_ui",
        attachmentId: "ui_test",
        fence: 7,
        acquiredAt: "2026-08-19T00:00:00.000Z",
        expiresAt: "2099-08-19T00:00:00.000Z",
        state: "ACTIVE",
      };
      if (method === "snapshot.get") return {...snapshot([]), cursor: 3, recentEvents: []};
      if (method === "run.create") return run;
      if (method === "run.resume") return {schema: "software-agent.command-receipt/v2", accepted: true, runId: run.id, revision: 6};
      if (method === "mutation.release") return {leaseId: "lease_ui", attachmentId: "ui_test", fence: 7, acquiredAt: "2026-08-19T00:00:00.000Z", expiresAt: "2026-08-19T00:00:01.000Z", state: "RELEASED"};
      if (method === "listApprovals") return [];
      throw new Error(`unexpected method ${method}`);
    }) as unknown as ProjectRoomRpcClient["request"];
    const source = new IpcProjectRoomSource({request}, {
      attachmentId: "ui_test",
      branch: "main",
      tokenMode: "economy",
    });
    await source.initialize();
    await source.execute({type: "objective.create", text: "Improve the application", expectedCursor: 3}, new AbortController().signal);
    await source.dispose();

    const create = calls.find(({method}) => method === "run.create")?.params as Record<string, unknown>;
    const resume = calls.find(({method}) => method === "run.resume")?.params as Record<string, unknown>;
    expect(create).toMatchObject({
      schema: "software-agent.command/v2",
      expectedRunRevision: 0,
      objective: "Improve the application",
      tokenMode: "economy",
    });
    expect(create.mutationLease).toEqual({leaseId: "lease_ui", fence: 7});
    expect(resume).toMatchObject({expectedRunRevision: 5, runId: "run_one"});
    expect(calls.map(({method}) => method)).toContain("mutation.release");
  });

  it("stores API keys only in the injected secure backend and rotates/removes them transactionally", async () => {
    const root = await mkdtemp(join(tmpdir(), "software-agent-room-provider-"));
    const workspace = join(root, "workspace");
    const platformPaths: PlatformPaths = {
      config: join(root, "home", "config"),
      data: join(root, "home", "data"),
      state: join(root, "home", "state"),
      cache: join(root, "home", "cache"),
      runtime: join(root, "home", "runtime"),
    };
    const secrets = new Map<string, string>();
    const backend: CredentialBackend = {
      scheme: "manager",
      get(reference) {
        const value = secrets.get(reference);
        return value === undefined ? Promise.reject(new Error("missing test credential")) : Promise.resolve(value);
      },
      list: () => Promise.resolve([...secrets.keys()]),
      set(reference, value) {
        secrets.set(reference, value);
        return Promise.resolve();
      },
      delete(reference) {
        return Promise.resolve(secrets.delete(reference));
      },
    };
    const request = vi.fn(async (method: string) => {
      if (method === "mutation.acquire") return {
        leaseId: "lease_provider",
        attachmentId: "ui_provider",
        fence: 1,
        acquiredAt: "2026-08-19T00:00:00.000Z",
        expiresAt: "2099-08-19T00:00:00.000Z",
        state: "ACTIVE",
      };
      if (method === "mutation.release") return {
        leaseId: "lease_provider",
        attachmentId: "ui_provider",
        fence: 1,
        acquiredAt: "2026-08-19T00:00:00.000Z",
        expiresAt: "2026-08-19T00:00:01.000Z",
        state: "RELEASED",
      };
      throw new Error(`unexpected method ${method}`);
    }) as unknown as ProjectRoomRpcClient["request"];
    const source = new IpcProjectRoomSource({request}, {
      workspace,
      attachmentId: "ui_provider",
      credentialBackend: backend,
      platformPaths,
    });
    const firstSecret = "provider-key-value-one";
    const secondSecret = "provider-key-value-two";
    try {
      await initializeProject(workspace, "Provider test");
      await source.initialize();
      await source.execute({type: "provider.connect", providerId: "openai", model: "gpt-test", secret: firstSecret, expectedCursor: 0}, new AbortController().signal);
      const first = await loadUserProviderConfig(platformPaths);
      const firstReference = first.providers.openai?.credential;
      expect(firstReference).toMatch(/^manager:\/\/provider\/openai\//u);
      expect(secrets.get(firstReference?.replace("manager://", "") ?? "")).toBe(firstSecret);
      expect(await loadProjectConfig(workspace)).toMatchObject({models: {default: "openai/gpt-test"}});

      await source.execute({type: "provider.connect", providerId: "openai", model: "gpt-next", secret: secondSecret, expectedCursor: 0}, new AbortController().signal);
      const rotated = await loadUserProviderConfig(platformPaths);
      expect(rotated.providers.openai?.credential).not.toBe(firstReference);
      expect([...secrets.values()]).toEqual([secondSecret]);

      const files = `${await readFile(join(platformPaths.config, "providers.toml"), "utf8")}\n${await readFile(join(workspace, ".software-agent", "project.toml"), "utf8")}`;
      expect(files).not.toContain(firstSecret);
      expect(files).not.toContain(secondSecret);

      await source.execute({type: "provider.remove", providerId: "openai", expectedCursor: 0}, new AbortController().signal);
      expect((await loadUserProviderConfig(platformPaths)).providers.openai).toBeUndefined();
      expect((await loadProjectConfig(workspace)).models.default).toBe("deterministic/local");
      expect(secrets.size).toBe(0);
    } finally {
      await source.dispose();
      await rm(root, {recursive: true, force: true});
    }
  });
});
