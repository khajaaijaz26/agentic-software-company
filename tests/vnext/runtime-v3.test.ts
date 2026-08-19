import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

import {afterEach, describe, expect, it} from "vitest";

import {
  LocalController,
  type MutationLeaseView,
  type SoftwareAgentCommandContext,
} from "../../apps/control-plane/src/controller.js";
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

describe("Software Agent v0.3 durable runtime", () => {
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
