import {createHash} from "node:crypto";
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
import {ControllerIpcError} from "../../packages/ipc/src/index.js";
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
    const createdRun: SoftwareAgentRunView = {
      ...run,
      tasks: [{...(run.tasks[0] as SoftwareAgentRunView["tasks"][number]), id: "task_orchestrator", role: "master-orchestrator"}],
    };
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
      if (method === "run.create") return createdRun;
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
    const result = await source.execute({type: "objective.create", text: "Improve the application", expectedCursor: 3}, new AbortController().signal);
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
    expect(result.replyTaskId).toBe("task_orchestrator");
    expect(calls.map(({method}) => method)).toContain("mutation.release");
  });

  it("submits normal chat as a runnable turn and resumes a paused run without sending UI-only target fields", async () => {
    const calls: Array<{method: string; params: unknown}> = [];
    const paused = {...run, state: "PAUSED" as const};
    const request = vi.fn(async (method: string, params: unknown) => {
      calls.push({method, params});
      if (method === "mutation.acquire") return {
        leaseId: "lease_chat",
        attachmentId: "ui_chat",
        fence: 3,
        acquiredAt: "2026-08-19T00:00:00.000Z",
        expiresAt: "2099-08-19T00:00:00.000Z",
        state: "ACTIVE",
      };
      if (method === "snapshot.get") return {...snapshot([paused]), recentEvents: []};
      if (method === "instruction.submit") return {
        message: {
          id: "message_chat",
          from: "local-user",
          to: "session_engineer",
          kind: "INSTRUCTION",
          payload: "Fix the failing test",
          createdAt: "2026-08-19T00:00:01.000Z",
        },
        runRevision: 8,
      };
      if (method === "run.resume") return {schema: "software-agent.command-receipt/v2", accepted: true, runId: run.id, revision: 9};
      if (method === "mutation.release") return {leaseId: "lease_chat", attachmentId: "ui_chat", fence: 3, acquiredAt: "2026-08-19T00:00:00.000Z", expiresAt: "2026-08-19T00:00:02.000Z", state: "RELEASED"};
      throw new Error(`unexpected method ${method}`);
    }) as unknown as ProjectRoomRpcClient["request"];
    const source = new IpcProjectRoomSource({request}, {attachmentId: "ui_chat"});
    await source.initialize();
    const result = await source.execute({
      type: "instruction.submit",
      runId: run.id,
      text: "Fix the failing test",
      target: {kind: "run", id: run.id, label: "Software Agent team"},
      expectedCursor: 3,
    }, new AbortController().signal);
    await source.dispose();

    const submitted = calls.find(({method}) => method === "instruction.submit")?.params as Record<string, unknown>;
    expect(submitted.target).toEqual({kind: "run", id: run.id});
    expect(calls.find(({method}) => method === "run.resume")?.params).toMatchObject({expectedRunRevision: 8, runId: run.id});
    expect(result.message).toContain("Message sent to Software Engineer");
    expect(result.message).toContain("final reply");
    const commandId = submitted.commandId as string;
    expect(result.replyTaskId).toBe(`tsk_${createHash("sha256").update(`${commandId}:conversation`, "utf8").digest("hex").slice(0, 32)}`);
  });

  it("rebases chat safely when live agent events advance the run revision", async () => {
    const instructionRevisions: number[] = [];
    let snapshotCalls = 0;
    const request = vi.fn(async (method: string, params: unknown) => {
      if (method === "mutation.acquire") return {
        leaseId: "lease_rebase",
        attachmentId: "ui_rebase",
        fence: 4,
        acquiredAt: "2026-08-19T00:00:00.000Z",
        expiresAt: "2099-08-19T00:00:00.000Z",
        state: "ACTIVE",
      };
      if (method === "snapshot.get") {
        snapshotCalls += 1;
        const revision = snapshotCalls === 1 ? 5 : 7;
        return {...snapshot([{...run, revision}]), cursor: snapshotCalls === 1 ? 4 : 6, recentEvents: []};
      }
      if (method === "instruction.submit") {
        const revision = (params as {expectedRunRevision: number}).expectedRunRevision;
        instructionRevisions.push(revision);
        if (instructionRevisions.length === 1) throw new ControllerIpcError("RUN_REVISION_CONFLICT", "live event won the first append", true);
        return {
          message: {id: "message_rebased", from: "local-user", to: "session_engineer", kind: "INSTRUCTION", payload: "Continue the fix", createdAt: "2026-08-19T00:00:02.000Z"},
          runRevision: 10,
        };
      }
      if (method === "mutation.release") return {leaseId: "lease_rebase", attachmentId: "ui_rebase", fence: 4, acquiredAt: "2026-08-19T00:00:00.000Z", expiresAt: "2026-08-19T00:00:03.000Z", state: "RELEASED"};
      throw new Error(`unexpected method ${method}`);
    }) as unknown as ProjectRoomRpcClient["request"];
    const source = new IpcProjectRoomSource({request}, {attachmentId: "ui_rebase"});
    await source.initialize();
    const result = await source.execute({
      type: "instruction.submit",
      runId: run.id,
      text: "Continue the fix",
      target: {kind: "run", id: run.id, label: "Software Agent team"},
      expectedCursor: 3,
    }, new AbortController().signal);
    await source.dispose();

    expect(instructionRevisions).toEqual([5, 7]);
    expect(result.message).toContain("Message sent to Software Engineer");
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
