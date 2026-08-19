import React from "react";
import {render, useStdout} from "ink";

import type {ControllerSnapshot} from "../../control-plane/src/controller.js";
import type {JsonValue, StoredEvent} from "../../../packages/contracts/src/index.js";
import {softwareAgentRoster} from "../../../packages/agent-registry/src/index.js";
import {
  createInitialProjectRoomState,
  projectRoomReducer,
  type ProjectRoomAgent,
  type ProjectRoomApproval,
  type ProjectRoomEvent,
  type ProjectRoomSnapshot,
  type ProjectRoomTask,
  type ProjectRoomTokenUsage,
} from "./project-room-state.js";
import {ProjectRoomView, renderProjectRoomText} from "./project-room.js";

export {
  ProjectRoom,
  ProjectRoomView,
  createTerminalRestorer,
  openProjectRoom,
  projectRoomLayout,
  renderProjectRoomText,
} from "./project-room.js";
export type {
  OpenProjectRoomOptions,
  ProjectRoomLayout,
  ProjectRoomProps,
  ProjectRoomRenderOptions,
  ProjectRoomCommandResult,
  ProjectRoomSource,
  TerminalOutput,
  TerminalRestorer,
} from "./project-room.js";
export {
  createInitialProjectRoomState,
  isContiguousUpdate,
  projectRoomInput,
  projectRoomReducer,
  targetCandidates,
} from "./project-room-state.js";
export type {
  ApprovalDecision,
  ComposerTarget,
  LeaveDisposition,
  ProjectRoomAction,
  ProjectRoomAgent,
  ProjectRoomApproval,
  ProjectRoomCommand,
  ProjectRoomCommittedUpdate,
  ProjectRoomEvent,
  ProjectRoomKey,
  ProjectRoomRosterAgent,
  ProjectRoomSettings,
  ProjectRoomSnapshot,
  ProjectRoomState,
} from "./project-room-state.js";

export interface DashboardOptions {
  readonly noColor?: boolean;
  readonly ascii?: boolean;
  readonly width?: number;
  readonly height?: number;
}

/** Retained for the v0.2 CLI ABI. New interactive code uses `projectRoomLayout`. */
export type DashboardLayout = "plain" | "narrow" | "compact" | "standard" | "wide";

/** Retained for compatibility with existing v0.2 snapshot tests. */
export function dashboardLayout(width: number, height = 24): DashboardLayout {
  if (width < 60 || height < 20) return "plain";
  if (width < 80) return "narrow";
  if (width < 110) return "compact";
  if (width < 140) return "standard";
  return "wide";
}

export function Dashboard({snapshot, noColor = false, ascii = false}: {
  readonly snapshot: ControllerSnapshot;
  readonly noColor?: boolean;
  readonly ascii?: boolean;
}): React.JSX.Element {
  const {stdout} = useStdout();
  const width = stdout.columns || 100;
  const height = stdout.rows || 24;
  const state = legacyProjectRoomState(snapshot, width, height);
  return <ProjectRoomView state={state} width={width} height={height} noColor={noColor || process.env.NO_COLOR !== undefined} ascii={ascii} interactive={false}/>;
}

export function renderPlainDashboard(snapshot: ControllerSnapshot, width = 80): string {
  const height = 24;
  return renderProjectRoomText(legacyProjectRoomState(snapshot, width, height), {width, height, noColor: true, ascii: true, interactive: false});
}

export function openDashboard(snapshot: ControllerSnapshot, options: DashboardOptions = {}): void {
  const width = options.width ?? (process.stdout.columns || 80);
  const height = options.height ?? (process.stdout.rows || 24);
  if (!process.stdout.isTTY || options.width !== undefined || options.height !== undefined) {
    process.stdout.write(`${renderProjectRoomText(legacyProjectRoomState(snapshot, width, height), {width, height, noColor: true, ascii: true, interactive: false})}\n`);
    return;
  }
  render(<Dashboard snapshot={snapshot} noColor={options.noColor ?? false} ascii={options.ascii ?? process.env.TERM === "dumb"}/>);
}

export function controllerSnapshotToProjectRoom(snapshot: ControllerSnapshot): ProjectRoomSnapshot {
  const run = snapshot.runs[0] ?? null;
  const events = snapshot.events.map(toProjectRoomEvent);
  const taskById = new Map(run?.tasks.map((task) => [task.id, task]) ?? []);
  const agents: readonly ProjectRoomAgent[] = run?.agents.map((agent) => {
    const task = taskById.get(agent.taskId);
    const lastEvent = snapshot.events.findLast((event) => jsonString(event.data.agentId) === agent.id);
    const [provider, ...modelParts] = agent.model.split("/");
    return {
      id: agent.id,
      role: agent.role,
      displayName: agent.displayName,
      state: agent.state,
      taskId: agent.taskId,
      taskTitle: task?.title ?? "No committed task title",
      activity: `Committed state: ${agent.state}; detailed activity unavailable in this snapshot.`,
      activitySince: null,
      lastEventAt: lastEvent?.occurredAt ?? null,
      provider: provider === "" || provider === undefined ? "UNKNOWN" : provider,
      model: modelParts.join("/") || "UNKNOWN",
      tokens: unknownUsage(),
      costUsd: agent.estimatedCostUsd,
      blocker: /WAITING|BLOCKED/u.test(agent.state) ? `Agent is ${agent.state}; no committed blocker detail is available.` : null,
      approvalId: null,
      requestedFiles: [],
      requestedTools: [],
      evidence: [],
    };
  }) ?? [];
  const tasks: readonly ProjectRoomTask[] = run?.tasks.map((task) => ({
    id: task.id,
    title: task.title,
    state: task.state,
    agentId: agents.find((agent) => agent.taskId === task.id)?.id ?? null,
  })) ?? [];
  const approvals: readonly ProjectRoomApproval[] = run?.approvalIds.map((approvalId) => {
    const requested = snapshot.events.findLast((event) => event.eventType === "approval.requested" && jsonString(event.data.approvalId) === approvalId);
    const action = requested === undefined ? "UNKNOWN" : jsonString(requested.data.action) ?? "UNKNOWN";
    const resource = requested === undefined ? run.id : jsonString(requested.data.resource) ?? run.id;
    return {
      id: approvalId,
      status: "PENDING",
      risk: "UNCLASSIFIED",
      title: action === "plan:accept" ? "Approve implementation plan" : `Review ${action}`,
      purpose: "Inspect the exact committed approval record before deciding.",
      action,
      resource,
      exactPreview: requested === undefined ? "Exact preview unavailable in the v0.2 snapshot." : `${action} on ${resource}`,
      impact: "Impact detail unavailable in the v0.2 snapshot.",
      expiresAt: requested === undefined ? "UNKNOWN" : jsonString(requested.data.expiresAt) ?? "UNKNOWN",
      agentId: null,
      taskId: null,
      evidence: requested === undefined ? [] : [jsonString(requested.data.artifactSha256) ?? "no artifact hash"],
    };
  }) ?? [];
  const cursor = snapshot.events.at(-1)?.sequence ?? 0;
  const roster = softwareAgentRoster().map((definition) => {
    const agent = agents.find((candidate) => candidate.role === definition.id);
    return agent === undefined
      ? {
          id: definition.id,
          displayName: definition.displayName,
          capabilities: definition.capabilities,
          state: "WAITING" as const,
          status: "WAITING FOR WORK",
          activity: "Available; no task is assigned.",
          taskTitle: "No assigned task",
          sessionId: null,
          model: "Not allocated",
        }
      : {
          id: definition.id,
          displayName: definition.displayName,
          capabilities: definition.capabilities,
          state: /FAILED/u.test(agent.state) ? "FAILED" as const : /RUNNING/u.test(agent.state) ? "WORKING" as const : "WAITING" as const,
          status: /RUNNING/u.test(agent.state) ? "WORKING NOW" : /FAILED/u.test(agent.state) ? "FAILED" : "WAITING FOR WORK",
          activity: agent.activity,
          taskTitle: agent.taskTitle,
          sessionId: agent.id,
          model: `${agent.provider}/${agent.model}`,
        };
  });
  return {
    schema: "software-agent.project-room/v1",
    projectId: snapshot.projectId,
    projectName: snapshot.projectName,
    branch: "branch unavailable",
    generatedAt: snapshot.generatedAt,
    cursor,
    controller: {state: "CONNECTED", mode: "CONTROL"},
    roster,
    settings: {workspace: "UNKNOWN", defaultModel: "deterministic/local", tokenMode: "balanced", providers: []},
    run: run === null ? null : {
      id: run.id,
      objective: run.objective,
      state: run.state,
      startedAt: run.createdAt,
      agents,
      tasks,
      tokens: unknownUsage(),
      costUsd: run.costUsd,
      tokenBudget: {used: 0, limit: "UNKNOWN"},
    },
    approvals,
    importantEvents: events,
  };
}

function legacyProjectRoomState(snapshot: ControllerSnapshot, width: number, height: number) {
  const generatedAt = Date.parse(snapshot.generatedAt);
  const state = createInitialProjectRoomState({
    width,
    height,
    now: Number.isFinite(generatedAt) ? generatedAt : Date.now(),
  });
  return projectRoomReducer(state, {type: "snapshot.received", snapshot: controllerSnapshotToProjectRoom(snapshot)});
}

function toProjectRoomEvent(event: StoredEvent): ProjectRoomEvent {
  return {
    sequence: event.sequence,
    eventId: event.eventId,
    occurredAt: event.occurredAt,
    type: event.eventType,
    severity: eventSeverity(event.eventType),
    summary: jsonString(event.data.summary) ?? event.eventType,
    agentId: jsonString(event.data.agentId),
    taskId: jsonString(event.data.taskId),
    approvalId: jsonString(event.data.approvalId),
  };
}

function eventSeverity(eventType: string): ProjectRoomEvent["severity"] {
  if (/failed|error|denied|canceled/u.test(eventType)) return "ERROR";
  if (/waiting|blocked|paused|approval/u.test(eventType)) return "WARN";
  return "INFO";
}

function jsonString(value: JsonValue | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function unknownUsage(): ProjectRoomTokenUsage {
  return {input: "UNKNOWN", output: "UNKNOWN", cached: "UNKNOWN", reasoning: "UNKNOWN"};
}
