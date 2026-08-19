import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

import {afterEach, describe, expect, it} from "vitest";

import {
  LocalController,
  type CompletedSoftwareAgentStepFrame,
  type MutationLeaseView,
  type SoftwareAgentCommandContext,
  type SoftwareAgentStepExecutor,
} from "../../apps/control-plane/src/controller.js";
import {StepFrameSchema, type StepManifest} from "../../apps/worker-runtime/src/index.js";
import {initializeProject} from "../../packages/config/src/index.js";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "software-agent-runtime-v3-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0).reverse()) {
    rmSync(directory, {recursive: true, force: true});
  }
});

function command(
  commandId: string,
  lease: MutationLeaseView,
  expectedRunRevision: number,
): SoftwareAgentCommandContext {
  return {
    schema: "software-agent.command/v2",
    commandId,
    actor: {type: "human", id: "local-user"},
    expectedRunRevision,
    correlationId: `corr_${commandId}`,
    causationId: `cause_${commandId}`,
    uiAttachmentId: lease.attachmentId,
    mutationLease: {leaseId: lease.leaseId, fence: lease.fence},
  };
}

describe("Software Agent v0.5 durable runtime", () => {
  it("turns every follow-up message into a scheduled conversational agent reply with bounded history", async () => {
    const workspace = temporaryDirectory();
    await initializeProject(workspace, "Runtime conversation", true);
    const manifests: StepManifest[] = [];
    const stepExecutor: SoftwareAgentStepExecutor = async ({manifest}) => {
      manifests.push(manifest);
      return StepFrameSchema.parse({
        schema: "software-agent.step-frame/v1",
        kind: "worker.completed",
        runId: manifest.runId,
        taskId: manifest.taskId,
        taskRevision: manifest.taskRevision,
        sessionId: manifest.sessionId,
        turnId: manifest.turnId,
        turnRevision: manifest.turnRevision,
        attemptId: manifest.attemptId,
        leaseId: manifest.leaseId,
        fencingEpoch: manifest.fencingEpoch,
        at: new Date().toISOString(),
        summary: manifest.interaction === "conversation"
          ? `${manifest.role} replied to: ${manifest.prompt}`
          : `${manifest.role} completed ${manifest.taskTitle}`,
      }) as CompletedSoftwareAgentStepFrame;
    };
    const controller = await LocalController.open(workspace, {stepExecutor});
    try {
      const lease = controller.acquireMutationLease({
        commandId: "cmd_chat_acquire",
        attachmentId: "uia_chat",
        actor: {type: "human", id: "local-user"},
        correlationId: "corr_chat",
      });
      const created = controller.createRunV2({
        ...command("cmd_chat_create", lease, 0),
        objective: "Build a visible terminal assistant",
        maxParallel: 2,
      });
      controller.resumeRunV2({...command("cmd_chat_resume", lease, created.revision), runId: created.id});
      let current = await controller.waitForRunV2(created.id, ["SUCCEEDED"], 10_000);

      const first = controller.submitInstructionV2({
        ...command("cmd_chat_first", lease, current.revision),
        runId: current.id,
        target: {kind: "run", id: current.id},
        text: "Explain what the team completed.",
      });
      expect(first.message.to).toBe(current.sessions.find((session) => session.role === "master-orchestrator")?.id);
      current = await controller.waitForRunV2(current.id, ["SUCCEEDED"], 10_000);

      const second = controller.submitInstructionV2({
        ...command("cmd_chat_second", lease, current.revision),
        runId: current.id,
        target: {kind: "run", id: current.id},
        text: "Update the README with that result.",
      });
      expect(second.message.to).toBe(current.sessions.find((session) => session.role === "software-engineer")?.id);
      current = await controller.waitForRunV2(current.id, ["SUCCEEDED"], 10_000);

      const conversational = manifests.filter((manifest) => manifest.interaction === "conversation");
      expect(conversational).toHaveLength(2);
      expect(conversational[0]).toMatchObject({
        role: "master-orchestrator",
        prompt: "Explain what the team completed.",
        conversation: [],
      });
      expect(conversational[1]).toMatchObject({
        role: "software-engineer",
        prompt: "Update the README with that result.",
      });
      expect(conversational[1]?.conversation).toEqual([
        {role: "user", content: "Explain what the team completed.", speaker: "User"},
        {role: "assistant", content: "master-orchestrator replied to: Explain what the team completed.", speaker: "Master Orchestrator"},
      ]);
      expect(current.tasks.filter((task) => task.interaction === "conversation").map((task) => task.state)).toEqual(["PASSED", "PASSED"]);
      const events = controller.historyV2({runId: current.id, afterCursor: 0, limit: 250}).events;
      expect(events.filter((event) => event.eventType === "software-agent.instruction.submitted")).toHaveLength(2);
      expect(events.filter((event) => event.eventType === "software-agent.turn.completed" && typeof event.data.taskId === "string" && event.data.taskId.startsWith("tsk_"))).toHaveLength(2);
    } finally {
      await controller.shutdown();
    }
  });

  it("runs the deterministic three-session fan-out concurrently and exposes a bounded snapshot", async () => {
    const workspace = temporaryDirectory();
    await initializeProject(workspace, "Runtime v3", true);
    const controller = await LocalController.open(workspace);
    try {
      const lease = controller.acquireMutationLease({
        commandId: "cmd_acquire_primary",
        attachmentId: "uia_primary",
        actor: {type: "human", id: "local-user"},
        correlationId: "corr_primary",
      });
      const created = controller.createRunV2({
        ...command("cmd_create_concurrent", lease, 0),
        objective: "Implement and independently review a bounded deterministic change",
        maxParallel: 2,
      });
      expect(created.sessions.map((session) => session.role).sort()).toEqual([
        "master-orchestrator",
        "reviewer-qa",
        "software-engineer",
      ]);

      const startedAt = performance.now();
      const accepted = controller.resumeRunV2({
        ...command("cmd_resume_concurrent", lease, created.revision),
        runId: created.id,
      });
      expect(accepted).toMatchObject({schema: "software-agent.command-receipt/v2", accepted: true, runId: created.id});
      expect(performance.now() - startedAt).toBeLessThan(100);

      const completed = await controller.waitForRunV2(created.id, ["SUCCEEDED"], 10_000);
      expect(completed.state).toBe("SUCCEEDED");
      expect(completed.tasks.every((task) => task.state === "PASSED")).toBe(true);
      expect(completed.attempts.length).toBeGreaterThanOrEqual(completed.tasks.length);
      expect(completed.attempts.every((attempt) => attempt.fencingEpoch > 0)).toBe(true);

      const events = controller.historyV2({runId: created.id, afterCursor: 0, limit: 250}).events;
      const starts = events.filter((event) => event.eventType === "software-agent.attempt.started");
      const finishes = events.filter((event) => event.eventType === "software-agent.attempt.completed");
      const implementation = starts.find((event) => typeof event.data.taskId === "string" && event.data.taskId.endsWith(":implementation"));
      const riskReview = starts.find((event) => typeof event.data.taskId === "string" && event.data.taskId.endsWith(":test-plan-risk"));
      const implementationFinish = finishes.find((event) => typeof event.data.taskId === "string" && event.data.taskId.endsWith(":implementation"));
      const riskReviewFinish = finishes.find((event) => typeof event.data.taskId === "string" && event.data.taskId.endsWith(":test-plan-risk"));
      expect(implementation).toBeDefined();
      expect(riskReview).toBeDefined();
      expect(Date.parse(implementation!.occurredAt)).toBeLessThan(Date.parse(riskReviewFinish!.occurredAt));
      expect(Date.parse(riskReview!.occurredAt)).toBeLessThan(Date.parse(implementationFinish!.occurredAt));
      expect(events.some((event) => event.eventType === "software-agent.handoff.accepted")).toBe(true);

      const snapshot = controller.snapshotV2({recentEventLimit: 8});
      expect(snapshot.schema).toBe("software-agent.snapshot/v2");
      expect(snapshot.cursor).toBeGreaterThan(0);
      expect(snapshot.recentEvents.length).toBeLessThanOrEqual(8);
      expect(Buffer.byteLength(JSON.stringify(snapshot), "utf8")).toBeLessThan(1024 * 1024);
    } finally {
      await controller.shutdown();
    }
  });

  it("fences mutation controllers and makes command replay and question answers single-use", async () => {
    const workspace = temporaryDirectory();
    await initializeProject(workspace, "Runtime fencing", true);
    const controller = await LocalController.open(workspace);
    try {
      const first = controller.acquireMutationLease({
        commandId: "cmd_acquire_first",
        attachmentId: "uia_first",
        actor: {type: "human", id: "local-user"},
        correlationId: "corr_first",
      });
      expect(() => controller.acquireMutationLease({
        commandId: "cmd_acquire_blocked",
        attachmentId: "uia_second",
        actor: {type: "human", id: "local-user"},
        correlationId: "corr_second",
      })).toThrowError(expect.objectContaining({code: "MUTATION_LEASE_HELD"}));

      const created = controller.createRunV2({
        ...command("cmd_create_idempotent", first, 0),
        objective: "Exercise durable questions",
        maxParallel: 1,
      });
      const replayed = controller.createRunV2({
        ...command("cmd_create_idempotent", first, 0),
        objective: "Exercise durable questions",
        maxParallel: 1,
      });
      expect(replayed.id).toBe(created.id);

      const asked = controller.askQuestionV2({
        ...command("cmd_question", first, created.revision),
        runId: created.id,
        sessionId: created.sessions[0]!.id,
        prompt: "Which acceptance boundary should be used?",
      });
      const answered = controller.answerQuestionV2({
        ...command("cmd_answer", first, asked.runRevision),
        runId: created.id,
        questionId: asked.question.id,
        answer: "Use the committed deterministic boundary.",
      });
      expect(answered.question.state).toBe("ANSWERED");
      expect(() => controller.answerQuestionV2({
        ...command("cmd_answer_again", first, answered.runRevision),
        runId: created.id,
        questionId: asked.question.id,
        answer: "A different answer",
      })).toThrowError(expect.objectContaining({code: "QUESTION_ALREADY_ANSWERED"}));

      controller.releaseMutationLease({
        commandId: "cmd_release_first",
        attachmentId: first.attachmentId,
        leaseId: first.leaseId,
        fence: first.fence,
        actor: {type: "human", id: "local-user"},
        correlationId: "corr_release",
      });
      const second = controller.acquireMutationLease({
        commandId: "cmd_acquire_second",
        attachmentId: "uia_second",
        actor: {type: "human", id: "local-user"},
        correlationId: "corr_second_after_release",
      });
      expect(second.fence).toBeGreaterThan(first.fence);
      expect(() => controller.resumeRunV2({
        ...command("cmd_stale_resume", first, answered.runRevision),
        runId: created.id,
      })).toThrowError(expect.objectContaining({code: "MUTATION_LEASE_STALE"}));
    } finally {
      await controller.shutdown();
    }
  });
});
