import {describe, expect, it} from "vitest";

import {
  createInitialProjectRoomState,
  projectRoomInput,
  projectRoomReducer,
  slashCommandSuggestions,
  type ProjectRoomKey,
  type ProjectRoomSnapshot,
  type ProjectRoomState,
} from "../../apps/operator-console/src/project-room-state.js";
import {
  createTerminalRestorer,
  projectRoomLayout,
  renderProjectRoomText,
  terminalLogoText,
} from "../../apps/operator-console/src/project-room.js";
import {softwareAgentRoster} from "../../packages/agent-registry/src/index.js";

const NO_KEY: ProjectRoomKey = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  home: false,
  end: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
};

const NOW = "2026-08-19T12:00:00.000Z";

function key(overrides: Partial<ProjectRoomKey>): ProjectRoomKey {
  return {...NO_KEY, ...overrides};
}

function roster(): ProjectRoomSnapshot["roster"] {
  return softwareAgentRoster().map((definition) => {
    const sessionId = definition.id === "orchestrator"
      ? "agent_orchestrator"
      : definition.id === "frontend-engineer"
        ? "agent_engineer"
        : definition.id === "qa-strategist"
          ? "agent_reviewer"
          : null;
    const working = definition.id === "frontend-engineer";
    const blocked = definition.id === "qa-strategist";
    return {
      id: definition.id,
      displayName: definition.displayName,
      capabilities: definition.capabilities,
      state: working ? "WORKING" : blocked ? "BLOCKED" : "WAITING",
      status: working ? "WORKING NOW" : blocked ? "WAITING ON DEPENDENCY" : "WAITING FOR WORK",
      activity: working ? "Applying a bounded UI patch" : blocked ? "Waiting for plan approval" : "Available; no task is assigned.",
      taskTitle: working ? "Build the project room" : blocked ? "Review the terminal" : "No assigned task",
      sessionId,
      model: working ? "openai/gpt-test" : blocked ? "anthropic/claude-test" : "Not allocated",
    };
  });
}

function snapshot(overrides: Partial<ProjectRoomSnapshot> = {}): ProjectRoomSnapshot {
  return {
    schema: "software-agent.project-room/v1",
    projectId: "project_demo",
    projectName: "Demo repository",
    branch: "feature/live-room",
    generatedAt: NOW,
    cursor: 12,
    controller: {state: "CONNECTED", mode: "CONTROL"},
    roster: roster(),
    settings: {
      workspace: "C:\\work\\demo",
      defaultModel: "openai/gpt-test",
      tokenMode: "balanced",
      providers: [{providerId: "openai", enabled: true, model: "openai/gpt-test", credentialReference: "manager://provider/openai"}],
    },
    run: {
      id: "run_demo",
      objective: "Implement the interactive terminal",
      state: "RUNNING",
      startedAt: "2026-08-19T11:55:00.000Z",
      agents: [
        {
          id: "agent_engineer",
          role: "Software Engineer",
          displayName: "Engineer",
          state: "RUNNING",
          taskId: "task_build",
          taskTitle: "Build the project room",
          activity: "Applying a bounded UI patch",
          activitySince: "2026-08-19T11:59:00.000Z",
          lastEventAt: "2026-08-19T11:59:50.000Z",
          provider: "openai",
          model: "gpt-test",
          tokens: {input: 120, output: 40, cached: 20, reasoning: 10},
          costUsd: 0.0123,
          blocker: null,
          approvalId: null,
          requestedFiles: ["apps/operator-console/src/project-room.tsx"],
          requestedTools: ["apply_patch"],
          evidence: ["artifact_patch"],
        },
        {
          id: "agent_reviewer",
          role: "Reviewer / QA",
          displayName: "Reviewer",
          state: "WAITING_APPROVAL",
          taskId: "task_review",
          taskTitle: "Review the terminal",
          activity: "Waiting for plan approval",
          activitySince: "2026-08-19T11:58:00.000Z",
          lastEventAt: "2026-08-19T11:59:40.000Z",
          provider: "anthropic",
          model: "claude-test",
          tokens: {input: 80, output: 12, cached: 0, reasoning: 0},
          costUsd: "UNKNOWN",
          blocker: "Plan decision required",
          approvalId: "approval_plan",
          requestedFiles: [],
          requestedTools: [],
          evidence: [],
        },
        {
          id: "agent_orchestrator",
          role: "Master Orchestrator",
          displayName: "Master Orchestrator",
          state: "IDLE",
          taskId: "task_plan",
          taskTitle: "Create the bounded plan",
          activity: "Plan committed and handed off",
          activitySince: null,
          lastEventAt: "2026-08-19T11:59:30.000Z",
          provider: "openai",
          model: "gpt-test",
          tokens: {input: 60, output: 20, cached: 10, reasoning: 5},
          costUsd: 0.0042,
          blocker: null,
          approvalId: null,
          requestedFiles: ["README.md"],
          requestedTools: ["search_code"],
          evidence: ["artifact_plan"],
        },
      ],
      tasks: [
        {id: "task_build", title: "Build the project room", state: "RUNNING", agentId: "agent_engineer"},
        {id: "task_review", title: "Review the terminal", state: "WAITING_APPROVAL", agentId: "agent_reviewer"},
        {id: "task_plan", title: "Create the bounded plan", state: "PASSED", agentId: "agent_orchestrator"},
      ],
      tokens: {input: 260, output: 72, cached: 30, reasoning: 15},
      costUsd: 0.0165,
      tokenBudget: {used: 377, limit: 2_000},
    },
    approvals: [
      {
        id: "approval_plan",
        status: "PENDING",
        risk: "A2_GUARDED_MUTATION",
        title: "Approve implementation plan",
        purpose: "Allow the bounded local change",
        action: "plan:accept",
        resource: "run_demo",
        exactPreview: "Accept plan artifact sha256:demo",
        impact: "Permits local project edits",
        expiresAt: "2026-08-19T13:00:00.000Z",
        agentId: "agent_reviewer",
        taskId: "task_review",
        evidence: ["artifact_plan"],
      },
    ],
    importantEvents: [
      {
        sequence: 12,
        eventId: "event_12",
        occurredAt: "2026-08-19T11:59:50.000Z",
        type: "agent.activity_changed",
        severity: "INFO",
        summary: "Engineer started applying a bounded UI patch",
        agentId: "agent_engineer",
        taskId: "task_build",
        approvalId: null,
      },
    ],
    ...overrides,
  };
}

function readyState(readOnly = false): ProjectRoomState {
  const state = createInitialProjectRoomState({width: 120, height: 32, now: Date.parse(NOW)});
  return projectRoomReducer(state, {
    type: "snapshot.received",
    snapshot: snapshot({controller: {state: "CONNECTED", mode: readOnly ? "READ_ONLY" : "CONTROL"}}),
  });
}

function input(state: ProjectRoomState, value: string, pressed: ProjectRoomKey = NO_KEY): ProjectRoomState {
  const action = projectRoomInput(state, value, pressed);
  return action === null ? state : projectRoomReducer(state, action);
}

describe("Software Agent v0.5 project room", () => {
  it("uses the A7 responsive breakpoints and short-terminal fallback", () => {
    expect(projectRoomLayout(59, 30)).toBe("plain");
    expect(projectRoomLayout(60, 30)).toBe("narrow");
    expect(projectRoomLayout(89, 30)).toBe("narrow");
    expect(projectRoomLayout(90, 30)).toBe("two-card");
    expect(projectRoomLayout(119, 30)).toBe("two-card");
    expect(projectRoomLayout(120, 30)).toBe("three-card");
    expect(projectRoomLayout(180, 19)).toBe("plain");
  });

  it("keeps projections authoritative and requests a resync on an event gap", () => {
    let state = readyState();
    expect(state.connection).toBe("connected");
    expect(state.selectedAgentId).toBe("agent_engineer");

    state = projectRoomReducer(state, {
      type: "events.received",
      update: {
        cursor: 13,
        events: [{
          sequence: 13,
          eventId: "event_13",
          occurredAt: NOW,
          type: "task.progressed",
          severity: "INFO",
          summary: "Committed event 13",
          agentId: "agent_engineer",
          taskId: "task_build",
          approvalId: null,
        }],
        snapshot: snapshot({cursor: 13}),
      },
    });
    expect(state.cursor).toBe(13);
    expect(state.events.at(-1)?.eventId).toBe("event_13");

    state = projectRoomReducer(state, {
      type: "events.received",
      update: {
        cursor: 15,
        events: [{
          sequence: 15,
          eventId: "event_15",
          occurredAt: NOW,
          type: "task.progressed",
          severity: "WARN",
          summary: "Gap",
          agentId: "agent_engineer",
          taskId: "task_build",
          approvalId: null,
        }],
        snapshot: snapshot({cursor: 15}),
      },
    });
    expect(state.connection).toBe("resyncing");
    expect(state.resyncRequested).toBe(true);
    expect(state.cursor).toBe(13);
  });

  it("supports deterministic help, search, follow, palette, and leave input states", () => {
    let state = readyState();
    state = input(state, "?");
    expect(state.overlay.kind).toBe("help");
    state = input(state, "", key({escape: true}));
    expect(state.overlay.kind).toBe("none");

    state = input(state, "/");
    state = input(state, "search");
    state = input(state, "", key({return: true}));
    state = input(state, "engineer");
    expect(state.overlay).toMatchObject({kind: "search", query: "engineer"});
    state = input(state, "", key({return: true}));
    expect(state.selectedEventId).toBe("event_12");

    state = input(state, "f", key({ctrl: true}));
    expect(state.followEvents).toBe(false);
    state = input(state, "k", key({ctrl: true}));
    expect(state.overlay.kind).toBe("palette");
    state = input(state, "", key({escape: true}));
    state = input(state, "c", key({ctrl: true}));
    expect(state.overlay.kind).toBe("leave");

    state = readyState();
    state = input(state, "Fix the failing tests");
    expect(state.overlay.kind).toBe("composer");
    expect(state.composerText).toBe("Fix the failing tests");
  });

  it("opens a complete, filterable slash-command menu with live settings", () => {
    let state = readyState();
    state = input(state, "/");
    expect(state.overlay.kind).toBe("composer");
    expect(slashCommandSuggestions("/")).toHaveLength(25);
    expect(slashCommandSuggestions("/").map((command) => command.command)).toEqual(expect.arrayContaining([
      "/help",
      "/agents",
      "/settings",
      "/api connect openai",
      "/api connect anthropic",
      "/model",
      "/tokens balanced",
      "/target",
      "/open",
      "/leave",
    ]));
    const menu = renderProjectRoomText(state, {width: 120, height: 36, ascii: true, noColor: true});
    expect(menu).toContain("SOFTWARE AGENT SLASH COMMANDS");
    expect(menu).toContain("Project: C:\\work\\demo");
    expect(menu).toContain("Model: openai/gpt-test | Tokens: balanced | API: openai");
    expect(menu).toContain("/api connect openai [model]");
    expect(menu).toContain("Type filter | Up/Down choose | Tab complete | Enter run");

    state = input(state, "api connect anth");
    expect(slashCommandSuggestions(state.composerText).map((command) => command.command)).toEqual(["/api connect anthropic"]);
    state = input(state, "", key({tab: true}));
    expect(state.composerText).toBe("/api connect anthropic ");
    state = input(state, "", key({return: true}));
    expect(state.overlay).toMatchObject({kind: "api-key", providerId: "anthropic"});

    state = readyState();
    state = input(state, "/");
    state = input(state, "", key({downArrow: true}));
    expect(state.slashSelected).toBe(1);
    state = input(state, "", key({return: true}));
    expect(state.notice).toContain("Run RUNNING");
  });

  it("uses chat slash commands for secure API setup, models, tokens, settings, and the 26-role wall", () => {
    let state = readyState();
    state = input(state, "/");
    state = input(state, "api connect openai gpt-test");
    state = input(state, "", key({return: true}));
    expect(state.overlay).toMatchObject({kind: "api-key", providerId: "openai", model: "gpt-test", value: ""});
    state = input(state, "sk-private-test-value");
    const masked = renderProjectRoomText(state, {width: 120, height: 32, ascii: true, noColor: true});
    expect(masked).toContain("MASKED 21 characters");
    expect(masked).not.toContain("sk-private-test-value");
    state = input(state, "", key({return: true}));
    expect(state.pendingCommand?.command).toMatchObject({
      type: "provider.connect",
      providerId: "openai",
      model: "gpt-test",
      expectedCursor: 12,
    });

    state = readyState();
    state = input(state, "/");
    state = input(state, "tokens 25");
    state = input(state, "", key({return: true}));
    expect(state.pendingCommand?.command).toMatchObject({type: "tokens.mode", mode: "economy"});

    state = readyState();
    state = input(state, "/");
    state = input(state, "settings");
    state = input(state, "", key({return: true}));
    expect(state.overlay.kind).toBe("settings");

    state = readyState();
    state = input(state, "/");
    state = input(state, "agents");
    state = input(state, "", key({return: true}));
    expect(state.notice).toContain("26 named roles");
  });

  it("defaults normal chat to the Software Agent team and queues a versioned instruction", () => {
    let state = readyState();
    state = input(state, "Add focused tests");
    expect(state.overlay.kind).toBe("composer");
    expect(state.composerTarget).toMatchObject({kind: "run", id: "run_demo", label: "Software Agent team"});
    state = input(state, "", key({return: true}));
    expect(state.pendingCommand?.command).toMatchObject({
      type: "instruction.submit",
      text: "Add focused tests",
      target: {kind: "run", id: "run_demo"},
    });
    const commandId = state.pendingCommand?.id;
    expect(commandId).toBeTypeOf("number");
    state = projectRoomReducer(state, {type: "command.started", id: commandId ?? 0});
    state = projectRoomReducer(state, {type: "command.succeeded", id: commandId ?? 0});
    expect(state.notice).toContain("live model and tool activity");
  });

  it("renders user follow-ups and the agent's actual final response as conversation", () => {
    const state = projectRoomReducer(
      createInitialProjectRoomState({width: 120, height: 32, now: Date.parse(NOW)}),
      {type: "snapshot.received", snapshot: snapshot({
        cursor: 14,
        importantEvents: [
          {
            sequence: 13,
            eventId: "event_user_message",
            occurredAt: "2026-08-19T11:59:51.000Z",
            type: "software-agent.instruction.submitted",
            severity: "INFO",
            summary: "What changed in the terminal?",
            agentId: "agent_orchestrator",
            taskId: "task_chat",
            approvalId: null,
          },
          {
            sequence: 14,
            eventId: "event_agent_reply",
            occurredAt: "2026-08-19T11:59:52.000Z",
            type: "software-agent.turn.completed",
            severity: "INFO",
            summary: "You can now type naturally, see live work, and continue the conversation with retained context.",
            agentId: "agent_orchestrator",
            taskId: "task_chat",
            approvalId: null,
          },
        ],
      })},
    );

    const output = renderProjectRoomText(state, {width: 120, height: 32, ascii: true, noColor: true});
    expect(output).toContain("YOU > What changed in the terminal?");
    expect(output).toContain("Master Orchestrator > [REPLY] You can now type naturally");
    expect(output).not.toContain("mailbox.message");
  });

  it("changes composer targets explicitly and preserves escaped slash input", () => {
    let state = readyState();
    state = projectRoomReducer(state, {type: "overlay.composer"});
    state = input(state, "", key({tab: true}));
    expect(state.overlay.kind).toBe("target");
    state = input(state, "", key({downArrow: true}));
    state = input(state, "", key({downArrow: true}));
    state = input(state, "", key({return: true}));
    expect(state.composerTarget).toMatchObject({kind: "agent", id: "agent_reviewer"});
    state = input(state, "//help");
    state = input(state, "", key({return: true}));
    expect(state.pendingCommand?.command).toMatchObject({type: "instruction.submit", text: "/help"});
  });

  it("requires approval detail and confirmation and blocks mutation in read-only mode", () => {
    let state = readyState();
    state = input(state, "3");
    state = input(state, "", key({return: true}));
    expect(state.overlay).toMatchObject({kind: "approval-detail", approvalId: "approval_plan"});
    state = input(state, "a");
    expect(state.overlay).toMatchObject({kind: "approval-confirm", decision: "APPROVED"});
    state = input(state, "", key({return: true}));
    expect(state.pendingCommand?.command).toMatchObject({
      type: "approval.decide",
      approvalId: "approval_plan",
      decision: "APPROVED",
    });

    state = readyState(true);
    state = input(state, "3");
    state = input(state, "", key({return: true}));
    state = input(state, "a");
    expect(state.overlay.kind).toBe("approval-detail");
    expect(state.notice).toContain("read-only");
    expect(state.pendingCommand).toBeNull();
  });

  it("renders truthful live panels plus ASCII, stale, reconnect, and empty states", () => {
    const live = renderProjectRoomText(readyState(), {width: 120, height: 32, ascii: true, noColor: true});
    expect(live).toContain(">_ o-o-o [OK] SOFTWARE AGENT");
    expect(live).toContain("RUN WORKING (RUNNING)");
    expect(live).toContain("CHAT & WORK");
    expect(live).toContain("AGENT WALL");
    expect(live).toContain("WORKING NOW");
    expect(live).toContain("WAITING FOR WORK");
    expect(live).toContain("Tasks [");
    expect(live).toContain("Applying a bounded UI patch");
    expect(live).toContain("openai/gpt-test");
    expect(live).toContain("TOKENS & COST");
    expect(live).toContain("APPROVALS");
    expect(live).toContain("EVENTS");
    expect(live).toContain("Ctrl+F Live");
    expect(live).not.toContain("active UNKNOWN");
    expect(live).not.toContain("\u001b");

    let stale = projectRoomReducer(readyState(), {type: "clock.tick", now: Date.parse(NOW) + 31_000});
    stale = projectRoomReducer(stale, {type: "connection.lost", message: "controller unavailable"});
    const degraded = renderProjectRoomText(stale, {width: 88, height: 28, ascii: true, noColor: true});
    expect(degraded).toContain("RECONNECTING");
    expect(degraded).toContain("STALE");

    const empty = projectRoomReducer(
      createInitialProjectRoomState({width: 80, height: 24, now: Date.parse(NOW)}),
      {type: "snapshot.received", snapshot: snapshot({run: null, approvals: [], importantEvents: []})},
    );
    expect(renderProjectRoomText(empty, {width: 80, height: 24, ascii: true, noColor: true})).toContain("No active run");

    const failed = projectRoomReducer(stale, {type: "connection.error", message: "resync failed"});
    expect(renderProjectRoomText(failed, {width: 80, height: 24, ascii: true, noColor: true})).toContain("ERROR");
  });

  it("does not advertise keyboard controls in the legacy static snapshot renderer", () => {
    const output = renderProjectRoomText(readyState(), {
      width: 100,
      height: 30,
      ascii: true,
      noColor: true,
      interactive: false,
    });
    expect(output).toContain("Snapshot view; keyboard controls are not attached.");
    expect(output).not.toContain("Ctrl+K");
    expect(output).not.toContain("press c");
  });

  it("restores cursor and terminal styling exactly once", () => {
    const writes: string[] = [];
    const restorer = createTerminalRestorer({isTTY: true, write: (value) => { writes.push(value); }});
    restorer.install();
    restorer.restore();
    restorer.restore();
    restorer.uninstall();
    expect(writes).toEqual(["\u001b[?25l", "\u001b[0m\u001b[?25h"]);
  });

  it("renders a compact terminal translation of the established logo", () => {
    expect(terminalLogoText(false)).toBe("❯_ ●─●─● ✓ SOFTWARE AGENT");
    expect(terminalLogoText(true)).toBe(">_ o-o-o [OK] SOFTWARE AGENT");
    expect(terminalLogoText(false, true)).toBe("❯_ SA ✓");
  });
});
