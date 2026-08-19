import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

import {afterEach, describe, expect, it} from "vitest";

import {startControllerDaemon} from "../../apps/controller-daemon/src/index.js";
import {initializeProject} from "../../packages/config/src/index.js";
import {ControllerIpcClient} from "../../packages/ipc/src/index.js";

const temporaryDirectories: string[] = [];
const cleanupCallbacks: Array<() => Promise<void>> = [];

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  for (const cleanup of cleanupCallbacks.splice(0).reverse()) await cleanup();
  for (const directory of temporaryDirectories.splice(0).reverse()) {
    rmSync(directory, {recursive: true, force: true});
  }
});

describe("Software Agent IPC v2", () => {
  it("supports bounded snapshots, idempotent commands, and race-free cursor polling", async () => {
    const workspace = temporaryDirectory("software-agent-ipc-v3-workspace-");
    const runtimeRoot = temporaryDirectory("software-agent-ipc-v3-runtime-");
    await initializeProject(workspace, "IPC v3", true);
    const daemon = await startControllerDaemon({workspace, runtimeRoot, heartbeatIntervalMs: 100});
    cleanupCallbacks.push(() => daemon.close());
    const client = await ControllerIpcClient.connect({workspace, runtimeRoot});
    cleanupCallbacks.push(() => client.close());

    const lease = await client.request("mutation.acquire", {
      commandId: "cmd_ipc_acquire",
      attachmentId: "uia_ipc",
      correlationId: "corr_ipc",
    });
    const base = {
      schema: "software-agent.command/v2" as const,
      actor: {type: "human" as const, id: "local-user"},
      correlationId: "corr_run",
      causationId: "cause_run",
      uiAttachmentId: lease.attachmentId,
      mutationLease: {leaseId: lease.leaseId, fence: lease.fence},
    };
    const created = await client.request("run.create", {
      ...base,
      commandId: "cmd_ipc_create",
      expectedRunRevision: 0,
      objective: "Prove live cursor delivery",
      maxParallel: 2,
    });
    const replayed = await client.request("run.create", {
      ...base,
      commandId: "cmd_ipc_create",
      expectedRunRevision: 0,
      objective: "Prove live cursor delivery",
      maxParallel: 2,
    });
    expect(replayed.id).toBe(created.id);

    const instructionInput = {
      ...base,
      commandId: "cmd_ipc_instruction",
      expectedRunRevision: created.revision,
      runId: created.id,
      target: {kind: "run" as const, id: created.id},
      text: "Keep the final handoff bounded and evidence-backed.",
    };
    const instruction = await client.request("instruction.submit", instructionInput);
    const instructionReplay = await client.request("instruction.submit", instructionInput);
    expect(instructionReplay).toEqual(instruction);
    expect(instruction.message).toMatchObject({kind: "INSTRUCTION", payload: instructionInput.text});

    const snapshot = await client.request("snapshot.get", {recentEventLimit: 5});
    expect(snapshot).toMatchObject({schema: "software-agent.snapshot/v2"});
    expect(snapshot.recentEvents.length).toBeLessThanOrEqual(5);
    const poll = client.request("events.poll", {afterCursor: snapshot.cursor, limit: 250, waitMs: 5_000});
    const accepted = await client.request("run.resume", {
      ...base,
      commandId: "cmd_ipc_resume",
      expectedRunRevision: instruction.runRevision,
      runId: created.id,
    });
    expect(accepted.accepted).toBe(true);

    const delivered = await poll;
    expect(delivered.schema).toBe("software-agent.events/v2");
    expect(delivered.resyncRequired).toBe(false);
    expect(delivered.events.length).toBeGreaterThan(0);
    expect(delivered.events[0]!.sequence).toBeGreaterThan(snapshot.cursor);

    let run = (await client.request("snapshot.get", {recentEventLimit: 5})).runs.find((candidate) => candidate.id === created.id);
    const deadline = Date.now() + 10_000;
    while (run?.state !== "SUCCEEDED" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      run = (await client.request("snapshot.get", {recentEventLimit: 5})).runs.find((candidate) => candidate.id === created.id);
    }
    expect(run?.state).toBe("SUCCEEDED");

    const legacy = await client.request("snapshot", {});
    expect(legacy.schema).toBe("agent-company.snapshot/v1");
  });
});
