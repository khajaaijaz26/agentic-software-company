import {mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

import {afterEach, describe, expect, it, vi} from "vitest";

import type {SoftwareAgentStepExecutionRequest} from "../../apps/control-plane/src/runtime-v3.js";
import {StepManifestSchema, type StepFrame} from "../../apps/worker-runtime/src/index.js";
import {
  executeSoftwareAgentStep,
  type AgentCommandApprovalRequest,
  type AgentModelInvocation,
} from "../../packages/agent-execution/src/index.js";
import type {ModelResult} from "../../packages/model-gateway/src/index.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0).reverse()) rmSync(directory, {recursive: true, force: true});
});

function result(input: AgentModelInvocation, text: string, toolCalls: ModelResult["toolCalls"]): ModelResult {
  return {
    requestId: input.request.requestId,
    providerId: "fake",
    modelId: "coding-model",
    providerRequestId: `response_${input.request.requestId}`,
    stopReason: toolCalls.length === 0 ? "completed" : "tool_call",
    text,
    toolCalls,
    usage: {inputTokens: 100, outputTokens: 25, cachedInputTokens: 0, reasoningTokens: 5, totalTokens: 125, source: "PROVIDER"},
    inputTokens: 100,
    outputTokens: 25,
    cost: 0.01,
    currency: "USD",
  };
}

describe("controller-owned Software Agent execution", () => {
  it("sends bounded prior conversation plus the current user message to the selected model", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "software-agent-conversation-"));
    temporaryDirectories.push(workspace);
    const manifest = StepManifestSchema.parse({
      schema: "software-agent.step/v1",
      runId: "run_chat",
      taskId: "task_chat",
      taskRevision: 1,
      sessionId: "session_orchestrator",
      turnId: "turn_chat",
      turnRevision: 2,
      attemptId: "attempt_chat",
      leaseId: "lease_chat",
      fencingEpoch: 1,
      leaseExpiresAt: "2099-08-19T00:00:00.000Z",
      role: "master-orchestrator",
      taskTitle: "Answer user: What changed?",
      objective: "Improve the terminal experience",
      interaction: "conversation",
      prompt: "What changed?",
      conversation: [
        {role: "user", content: "Please improve the terminal.", speaker: "User"},
        {role: "assistant", content: "The team completed the first pass.", speaker: "Software Engineer"},
      ],
      workspaceRevision: "workspace:test:v1",
      simulatedWorkMs: 10,
      heartbeatIntervalMs: 10_000,
      limits: {wallTimeMs: 60_000, maxOutputBytes: 1_048_576},
    });
    const invokeModel = vi.fn(async (input: AgentModelInvocation): Promise<ModelResult> => result(input, "The terminal now supports follow-up chat.", []));

    const completed = await executeSoftwareAgentStep({
      manifest,
      signal: new AbortController().signal,
      onFrame: () => undefined,
    }, {
      workspace,
      invokeModel,
      resolveModel: async () => ({providerId: "fake", modelId: "coding-model", routingRevision: 1}),
    });

    const request = invokeModel.mock.calls[0]?.[0].request;
    expect(request?.messages).toEqual([
      {role: "user", content: "[User]\nPlease improve the terminal."},
      {role: "assistant", content: "[Software Engineer]\nThe team completed the first pass."},
      expect.objectContaining({role: "user", content: expect.stringContaining("Current user message: What changed?")}),
    ]);
    expect(request?.system).toContain("continuous terminal conversation");
    expect(completed.summary).toBe("The terminal now supports follow-up chat.");
  });

  it("uses model tool calls to read an exact revision, atomically write, and report live evidence", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "software-agent-execution-"));
    temporaryDirectories.push(workspace);
    writeFileSync(join(workspace, "README.md"), "before\n");
    const frames: StepFrame[] = [];
    let turn = 0;
    const invokeModel = vi.fn(async (input: AgentModelInvocation): Promise<ModelResult> => {
      turn += 1;
      if (turn === 1) {
        return result(input, "I will inspect the target first.", [{callId: "call_read", name: "read_file", arguments: {path: "README.md"}}]);
      }
      if (turn === 2) {
        const tool = input.request.toolResults?.[0];
        const snapshot = JSON.parse(tool?.content ?? "{}") as {sha256: string};
        return result(input, "I will apply the bounded edit.", [{
          callId: "call_write",
          name: "write_file",
          arguments: {path: "README.md", content: "after\n", expected_sha256: snapshot.sha256},
        }]);
      }
      return result(input, "Updated README.md after reading its exact revision.", []);
    });
    const manifest = StepManifestSchema.parse({
      schema: "software-agent.step/v1",
      runId: "run_test",
      taskId: "run_test:implementation",
      taskRevision: 1,
      sessionId: "session_engineer",
      turnId: "turn_test",
      turnRevision: 1,
      attemptId: "attempt_test",
      leaseId: "lease_test",
      fencingEpoch: 1,
      leaseExpiresAt: "2099-08-19T00:00:00.000Z",
      role: "software-engineer",
      taskTitle: "Implement the requested change",
      objective: "Update the README",
      workspaceRevision: "workspace:test:v1",
      simulatedWorkMs: 10,
      heartbeatIntervalMs: 10_000,
      limits: {wallTimeMs: 60_000, maxOutputBytes: 1_048_576},
    });
    const execution: SoftwareAgentStepExecutionRequest = {
      manifest,
      signal: new AbortController().signal,
      onFrame: (frame) => { frames.push(frame); },
    };

    const completed = await executeSoftwareAgentStep(execution, {
      workspace,
      invokeModel,
      resolveModel: async () => ({providerId: "fake", modelId: "coding-model", routingRevision: 1}),
    });

    expect(readFileSync(join(workspace, "README.md"), "utf8")).toBe("after\n");
    expect(completed).toMatchObject({
      kind: "worker.completed",
      providerId: "fake",
      modelId: "coding-model",
      toolsUsed: ["read_file", "write_file"],
      filesChanged: ["README.md"],
      usage: {inputTokens: 300, outputTokens: 75, totalTokens: 375},
      costUsd: 0.03,
    });
    expect(frames.filter((frame) => frame.kind === "worker.activity").map((frame) => frame.activity.type))
      .toEqual(["model.started", "model.completed", "tool.started", "tool.completed", "model.started", "model.completed", "tool.started", "tool.completed", "model.started", "model.completed"]);
    expect(invokeModel).toHaveBeenCalledTimes(3);
  });

  it("routes every allowlisted process command through the controller approval boundary", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "software-agent-command-approval-"));
    temporaryDirectories.push(workspace);
    const manifest = StepManifestSchema.parse({
      schema: "software-agent.step/v1",
      runId: "run_command",
      taskId: "run_command:implementation",
      taskRevision: 1,
      sessionId: "session_engineer",
      turnId: "turn_command",
      turnRevision: 1,
      attemptId: "attempt_command",
      leaseId: "lease_command",
      fencingEpoch: 1,
      leaseExpiresAt: "2099-08-19T00:00:00.000Z",
      role: "software-engineer",
      taskTitle: "Verify the repository",
      objective: "Inspect repository status",
      workspaceRevision: "workspace:test:v1",
      simulatedWorkMs: 10,
      heartbeatIntervalMs: 10_000,
      limits: {wallTimeMs: 60_000, maxOutputBytes: 1_048_576},
    });
    let turn = 0;
    const approvalRequests: AgentCommandApprovalRequest[] = [];
    const authorizeCommand = vi.fn(async (request: AgentCommandApprovalRequest) => {
      approvalRequests.push(request);
      await Promise.resolve();
    });
    const invokeModel = vi.fn(async (input: AgentModelInvocation): Promise<ModelResult> => {
      turn += 1;
      return turn === 1
        ? result(input, "I will verify the repository state.", [{
            callId: "call_status",
            name: "run_command",
            arguments: {executable: "git", args: ["status", "--short"], cwd: "."},
          }])
        : result(input, "Repository status was checked through the approved command boundary.", []);
    });

    const completed = await executeSoftwareAgentStep({
      manifest,
      signal: new AbortController().signal,
      onFrame: () => undefined,
    }, {
      workspace,
      invokeModel,
      authorizeCommand,
      resolveModel: async () => ({providerId: "fake", modelId: "coding-model", routingRevision: 1}),
    });

    expect(authorizeCommand).toHaveBeenCalledOnce();
    expect(approvalRequests[0]).toMatchObject({
      manifest: {runId: "run_command", sessionId: "session_engineer"},
      authority: {leaseId: "lease_command", fencingEpoch: 1, operationId: "call_status"},
      plan: {executable: "git", args: ["status", "--short"]},
    });
    expect(completed.toolsUsed).toEqual(["run_command"]);
  });
});
