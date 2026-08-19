import {mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

import {afterEach, describe, expect, it, vi} from "vitest";
import {z} from "zod";

import {runCli} from "../../apps/cli/src/index.js";
import {LocalController} from "../../apps/control-plane/src/controller.js";
import {dashboardLayout, renderPlainDashboard} from "../../apps/operator-console/src/dashboard.js";
import {AgentRegistry, softwareAgentRoster} from "../../packages/agent-registry/src/index.js";
import {ArtifactStore} from "../../packages/artifact-store/src/index.js";
import {AttachmentService} from "../../packages/attachments/src/index.js";
import {BudgetExceededError, BudgetLedger} from "../../packages/budgets/src/index.js";
import {initializeProject, loadProjectConfig, projectFiles} from "../../packages/config/src/index.js";
import {COMMANDS, commandPalette} from "../../packages/command-registry/src/index.js";
import {createAction, ConnectorPolicyError} from "../../packages/connectors/src/index.js";
import {DeterministicModelAdapter, ModelGateway} from "../../packages/model-gateway/src/index.js";
import {redact, sanitizeTerminal} from "../../packages/observability/src/index.js";
import {ToolGateway} from "../../packages/tool-gateway/src/index.js";
import {ChildWorkerSupervisor} from "../../packages/worker-supervisor/src/index.js";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "software-agent-platform-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0).reverse()) {
    rmSync(directory, {recursive: true, force: true});
  }
});

describe("project initialization and platform paths", () => {
  it("previews without writing and initializes private project-local state atomically", async () => {
    const workspace = temporaryDirectory();
    const preview = await initializeProject(workspace, "Blueprint Demo", false);
    expect(preview.planned).toEqual([
      projectFiles(workspace).projectFile,
      projectFiles(workspace).policyFile,
      projectFiles(workspace).gitignoreFile,
    ]);
    expect(() => readFileSync(preview.files.projectFile)).toThrow();

    await initializeProject(workspace, "Blueprint Demo", true);
    const config = await loadProjectConfig(workspace);
    expect(config).toMatchObject({schema: "software-agent.project/v2", project: {name: "Blueprint Demo"}});
    expect(readFileSync(preview.files.gitignoreFile, "utf8")).toContain("*.sqlite-wal");

    const repeated = await initializeProject(workspace, "Replacement Name", true);
    expect(repeated.created).toEqual([]);
    expect(await loadProjectConfig(workspace)).toEqual(config);
  });
});

describe("artifacts and attachment trust boundaries", () => {
  it("deduplicates bytes by real SHA-256 and verifies them before use", async () => {
    const root = temporaryDirectory();
    const store = new ArtifactStore(join(root, "artifacts"));
    const first = await store.put(Buffer.from("same bytes"), {
      logicalName: "first.txt",
      mediaType: "text/plain",
      producer: "test",
    });
    const second = await store.put(Buffer.from("same bytes"), {
      logicalName: "first.txt",
      mediaType: "text/plain",
      producer: "test",
    });

    expect(first.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(second.sha256).toBe(first.sha256);
    expect(second).toEqual(first);
    const alias = await store.put(Buffer.from("same bytes"), {
      logicalName: "alias.txt",
      mediaType: "text/plain",
      producer: "test",
    });
    expect(alias.sha256).toBe(first.sha256);
    expect(alias.artifact_id).not.toBe(first.artifact_id);
    expect(await store.list()).toHaveLength(2);
    expect(await store.verify(first.sha256)).toBe(true);
    expect(Buffer.from(await store.read(first.sha256)).toString("utf8")).toBe("same bytes");
  });

  it("detects tampered artifact metadata manifests", async () => {
    const root = temporaryDirectory();
    const store = new ArtifactStore(join(root, "artifacts"));
    const manifest = await store.put(Buffer.from("trusted bytes"), {
      logicalName: "evidence.txt",
      mediaType: "text/plain",
      producer: "test",
    });
    writeFileSync(
      join(root, "artifacts", "manifests", `${manifest.artifact_id}.json`),
      JSON.stringify({...manifest, logical_name: "substituted.txt"}),
    );
    await expect(store.getManifest(manifest.artifact_id)).rejects.toThrow("failed integrity verification");
  });

  it("never transfers during ingestion and blocks secrets, malware, and root escapes", async () => {
    const root = temporaryDirectory();
    const outside = temporaryDirectory();
    const store = new ArtifactStore(join(root, ".software-agent", "artifacts"));
    const service = new AttachmentService(store, {allowedRoots: [root]});
    writeFileSync(join(root, "safe.txt"), "ordinary project context");
    writeFileSync(join(root, "secret.txt"), "api_key=abcdefghijklmnop");
    writeFileSync(join(root, "eicar.txt"), "EICAR-STANDARD-ANTIVIRUS-TEST-FILE");
    writeFileSync(join(outside, "outside.txt"), "outside");

    await expect(service.ingestFile(join(root, "safe.txt"))).resolves.toMatchObject({state: "READY", transfer_count: 0});
    await expect(service.ingestFile(join(root, "secret.txt"))).resolves.toMatchObject({state: "BLOCKED", transfer_count: 0});
    await expect(service.ingestFile(join(root, "eicar.txt"))).resolves.toMatchObject({state: "QUARANTINED", transfer_count: 0});
    await expect(service.ingestFile(join(outside, "outside.txt"))).rejects.toMatchObject({
      code: "ATTACHMENT_OUTSIDE_ALLOWED_ROOT",
    });
  });
});

describe("budgets, models, tools, and connected policy", () => {
  it("executes an immutable, leased attempt in a separate worker process", async () => {
    const workspace = temporaryDirectory();
    const execution = await new ChildWorkerSupervisor().execute({
      runId: "run_worker",
      taskId: "task_worker",
      role: "test-automation-engineer",
      workspace,
      objective: "Return deterministic verification evidence.",
      modelId: "local",
      wallTimeMs: 15_000,
    });
    expect(execution.pid).not.toBe(process.pid);
    expect(execution.result).toMatchObject({
      schema: "software-agent.result/v1",
      runId: "run_worker",
      taskId: "task_worker",
      leaseId: execution.manifest.leaseId,
      status: "completed",
    });
  });

  it("atomically reserves, reconciles, and rejects overspend", () => {
    const ledger = new BudgetLedger(join(temporaryDirectory(), "budget.sqlite"));
    try {
      ledger.setLimit("run:one", 1);
      const reservation = ledger.reserve("run:one", 0.6);
      expect(ledger.account("run:one")).toMatchObject({reservedUsd: 0.6, remainingUsd: 0.4});
      expect(() => ledger.reserve("run:one", 0.5)).toThrow(BudgetExceededError);
      ledger.reconcile(reservation.id, 0.5);
      expect(ledger.account("run:one")).toMatchObject({spentUsd: 0.5, reservedUsd: 0, remainingUsd: 0.5});
    } finally {
      ledger.close();
    }
  });

  it("pins a deterministic provider and reports actual metering", async () => {
    const gateway = new ModelGateway();
    gateway.register(new DeterministicModelAdapter());
    const result = await gateway.complete("deterministic", {
      requestId: "request_one",
      modelId: "local",
      system: "Produce evidence.",
      input: "Verify the local vertical slice.",
      maxOutputTokens: 100,
    }, new AbortController().signal);
    expect(result).toMatchObject({providerId: "deterministic", modelId: "local", cost: 0, currency: "USD"});
    expect(result.inputTokens).toBeGreaterThan(0);
  });

  it("requires an exact approval consumer for shared mutations", async () => {
    const consume = vi.fn(async () => undefined);
    const gateway = new ToolGateway({consume});
    gateway.register({
      name: "repository.push",
      operation: "repository.push",
      risk: "A3_SHARED_MUTATION",
      input: z.object({branch: z.string()}),
      execute: async ({branch}) => ({branch}),
    });
    const request = {
      name: "repository.push",
      arguments: {branch: "feature/safe"},
      context: {
        actorId: "agent:backend",
        projectId: "project_one",
        runId: "run_one",
        taskId: "task_one",
        workspace: process.cwd(),
        environment: "preview",
        allowedHosts: [],
      },
      operationHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      resource: "github://owner/repository/feature/safe",
    } as const;
    await expect(gateway.call(request)).rejects.toMatchObject({code: "APPROVAL_REQUIRED"});
    await expect(gateway.call({...request, approval: {approvalId: "approval_one", token: "opaque", operationHash: request.operationHash}})).resolves.toEqual({branch: "feature/safe"});
    expect(consume).toHaveBeenCalledOnce();
  });

  it("requires approval for reversible remote tool mutations", async () => {
    const gateway = new ToolGateway({consume: async () => undefined});
    gateway.register({
      name: "preview.deploy",
      operation: "deployment.preview",
      risk: "A2_REMOTE_REVERSIBLE",
      input: z.object({ref: z.string()}),
      execute: async ({ref}) => ({ref}),
    });
    await expect(gateway.call({
      name: "preview.deploy",
      arguments: {ref: "candidate"},
      context: {
        actorId: "agent:devops",
        projectId: "project_one",
        runId: "run_one",
        taskId: "task_one",
        workspace: process.cwd(),
        environment: "preview",
        allowedHosts: [],
      },
      operationHash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      resource: "vercel://project/preview",
    })).rejects.toMatchObject({code: "APPROVAL_REQUIRED"});
  });

  it("separates observation from mutation and hard-denies production reset", () => {
    expect(createAction({connectorId: "github", capability: "checks:inspect", targetRef: "github://repo"}).risk.class).toBe("A0_OBSERVE");
    expect(createAction({connectorId: "vercel", capability: "deployment:production", targetRef: "vercel://project", environment: "production"}).risk.class).toBe("A4_PRODUCTION_OR_SECURITY");
    expect(createAction({
      connectorId: "github",
      capability: "branch:push",
      targetRef: "github://repo/main",
      environment: "production",
      risk: "A0_OBSERVE",
    }).risk.class).toBe("A4_PRODUCTION_OR_SECURITY");
    expect(() => createAction({connectorId: "supabase", capability: "database:reset", targetRef: "supabase://project", environment: "production"})).toThrow(ConnectorPolicyError);
    expect(() => createAction({connectorId: "SUPABASE", capability: "DATABASE:SEED", targetRef: "supabase://project", environment: "production"})).toThrow(ConnectorPolicyError);
  });
});

describe("catalog, terminal safety, controller replay, and CLI ABI", () => {
  it("publishes one shared, searchable command registry without duplicate paths", () => {
    expect(COMMANDS.length).toBeGreaterThan(100);
    expect(new Set(COMMANDS.map((command) => command.path)).size).toBe(COMMANDS.length);
    expect(commandPalette("production").some((command) => command.path === "deploy production")).toBe(true);
    expect(commandPalette("repo push")[0]).toMatchObject({path: "repo push", mutates: true, connected: true});
  });

  it("selects the blueprint responsive TUI breakpoints and a safe short-terminal fallback", () => {
    expect(dashboardLayout(140, 30)).toBe("wide");
    expect(dashboardLayout(110, 30)).toBe("standard");
    expect(dashboardLayout(80, 30)).toBe("compact");
    expect(dashboardLayout(60, 30)).toBe("narrow");
    expect(dashboardLayout(59, 30)).toBe("plain");
    expect(dashboardLayout(160, 19)).toBe("plain");
  });

  it("exposes 25 specialists plus the orchestrator and activates only relevant roles", () => {
    const registry = new AgentRegistry();
    expect(registry.list()).toHaveLength(25);
    expect(softwareAgentRoster()).toHaveLength(26);
    const roles = registry.activateFor("Build a React UI and deploy a preview").map((role) => role.id);
    expect(roles).toContain("frontend-engineer");
    expect(roles).toContain("devops-platform");
    expect(roles.length).toBeLessThan(25);
    expect(registry.activationPlan("Build a React UI")[0]).toMatchObject({
      estimatedCostUsd: 0,
      deactivateWhen: expect.stringContaining("terminal"),
    });
  });

  it("redacts secrets and neutralizes terminal control characters", () => {
    expect(sanitizeTerminal("before\u001b]52;c;clipboard\u0007 after sk-abcdefghijklmnop")).not.toContain("sk-abcdefghijklmnop");
    expect(sanitizeTerminal("line\rforged")).toContain("\\r");
    expect(redact({authorization: "Bearer abc", inputTokens: 42, nested: {ok: true}})).toEqual({
      authorization: "[REDACTED]",
      inputTokens: 42,
      nested: {ok: true},
    });
  });

  it("persists the approved vertical slice and deterministically replays it after restart", async () => {
    const workspace = temporaryDirectory();
    await initializeProject(workspace, "Replay Demo", true);
    let controller = await LocalController.open(workspace);
    const run = await controller.createRun("Build and test a small backend API");
    expect(run.state).toBe("WAITING_APPROVAL");
    expect(run.agents.length).toBeLessThan(25);
    const approvalId = run.approvalIds[0];
    expect(approvalId).toBeDefined();
    controller.approve(approvalId!);
    const completed = await controller.resume(run.id);
    expect(completed.state).toBe("SUCCEEDED");
    expect(completed.tasks.every((task) => task.state === "PASSED")).toBe(true);
    const eventCount = controller.snapshot().events.length;
    controller.close();

    controller = await LocalController.open(workspace);
    try {
      expect(controller.getRun(run.id)).toMatchObject({state: "SUCCEEDED", objective: run.objective});
      expect(controller.snapshot().events).toHaveLength(eventCount);
      expect(renderPlainDashboard(controller.snapshot(), 58)).toContain("[OK] [PASSED]");
    } finally {
      controller.close();
    }
  });

  it("redacts credential-like values before durable run and approval events", async () => {
    const workspace = temporaryDirectory();
    await initializeProject(workspace, "Redaction Demo", true);
    const controller = await LocalController.open(workspace);
    try {
      const run = await controller.createRun("Investigate token=supersecretvalue safely");
      expect(run.objective).toContain("[REDACTED]");
      expect(run.objective).not.toContain("supersecretvalue");
      controller.approve(run.approvalIds[0] ?? "", undefined, "password=anothersecretvalue");
      expect(JSON.stringify(controller.snapshot())).not.toContain("anothersecretvalue");
    } finally {
      controller.close();
    }
  });

  it("uses versioned machine envelopes for a complete headless v0.4 run", async () => {
    const workspace = temporaryDirectory();
    const output: string[] = [];
    const error: string[] = [];
    const io = {stdout: (value: string) => output.push(value), stderr: (value: string) => error.push(value)};
    expect(await runCli(["node", "software-agent", "--json", "init", workspace, "--name", "CLI Demo"], io)).toBe(0);
    writeFileSync(join(workspace, "context.txt"), "safe local context");
    output.length = 0;
    expect(await runCli(["node", "software-agent", "--project", workspace, "--json", "attachments", "add", join(workspace, "context.txt")], io)).toBe(0);
    const attachment = JSON.parse(output.join("")) as {data: {artifact: {artifact_id: string}; transfer_count: number}};
    expect(attachment.data.transfer_count).toBe(0);
    output.length = 0;
    expect(await runCli(["node", "software-agent", "--project", workspace, "--json", "artifacts", "verify", attachment.data.artifact.artifact_id], io)).toBe(0);
    expect(JSON.parse(output.join("")).data.valid).toBe(true);
    output.length = 0;
    expect(await runCli(["node", "software-agent", "--project", workspace, "--json", "run", "Implement", "a", "safe", "change"], io)).toBe(0);
    const envelope = JSON.parse(output.join("")) as {schema: string; type: string; data: {id: string; state: string}};
    expect(envelope).toMatchObject({schema: "software-agent.output/v1", type: "run.completed", data: {state: "SUCCEEDED"}});
    expect(error).toEqual([]);
  });

  it("fails reserved options clearly and keeps offline diagnostics local", async () => {
    const workspace = temporaryDirectory();
    await initializeProject(workspace, "CLI Options", true);
    const output: string[] = [];
    const io = {stdout: (value: string) => output.push(value), stderr: () => undefined};

    expect(await runCli(["node", "software-agent", "--project", workspace, "--profile", "future", "--json", "version"], io)).toBe(6);
    expect(JSON.parse(output.join(""))).toMatchObject({
      schema: "software-agent.error/v1",
      data: {code: "CAPABILITY_UNAVAILABLE"},
    });

    output.length = 0;
    expect(await runCli(["node", "software-agent", "--project", workspace, "--offline", "--json", "doctor"], io)).toBe(0);
    const doctor = JSON.parse(output.join("")) as {data: {connectors: Array<{details: string[]}>}};
    expect(doctor.data.connectors).toHaveLength(3);
    expect(doctor.data.connectors.every((item) => item.details[0]?.includes("probe not attempted"))).toBe(true);
  });
});
