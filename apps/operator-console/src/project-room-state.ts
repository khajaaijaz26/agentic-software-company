import {sanitizeTerminal} from "../../../packages/observability/src/index.js";

export const PROJECT_ROOM_SNAPSHOT_SCHEMA = "software-agent.project-room/v1" as const;
export const PROJECT_ROOM_STALE_AFTER_MS = 30_000;
export const PROJECT_ROOM_EVENT_LIMIT = 500;

export type ProjectRoomConnection = "connecting" | "connected" | "reconnecting" | "resyncing" | "error";
export type ProjectRoomFocus = "agents" | "events" | "approvals" | "tokens";
export type ProjectRoomSeverity = "DEBUG" | "INFO" | "WARN" | "ERROR" | "CRITICAL";
export type ProjectRoomAccessMode = "CONTROL" | "READ_ONLY";
export type TokenCount = number | "UNKNOWN";

export interface ProjectRoomTokenUsage {
  readonly input: TokenCount;
  readonly output: TokenCount;
  readonly cached: TokenCount;
  readonly reasoning: TokenCount;
}

export interface ProjectRoomAgent {
  readonly id: string;
  readonly role: string;
  readonly displayName: string;
  readonly state: string;
  readonly taskId: string;
  readonly taskTitle: string;
  readonly activity: string;
  readonly activitySince: string | null;
  readonly lastEventAt: string | null;
  readonly provider: string;
  readonly model: string;
  readonly tokens: ProjectRoomTokenUsage;
  readonly costUsd: number | "UNKNOWN";
  readonly blocker: string | null;
  readonly approvalId: string | null;
  readonly requestedFiles: readonly string[];
  readonly requestedTools: readonly string[];
  readonly evidence: readonly string[];
}

export interface ProjectRoomTask {
  readonly id: string;
  readonly title: string;
  readonly state: string;
  readonly agentId: string | null;
}

export interface ProjectRoomTokenBudget {
  readonly used: number;
  readonly limit: number | "UNKNOWN";
}

export interface ProjectRoomRun {
  readonly id: string;
  readonly objective: string;
  readonly state: string;
  readonly startedAt: string;
  readonly agents: readonly ProjectRoomAgent[];
  readonly tasks: readonly ProjectRoomTask[];
  readonly tokens: ProjectRoomTokenUsage;
  readonly costUsd: number | "UNKNOWN";
  readonly tokenBudget: ProjectRoomTokenBudget;
}

export interface ProjectRoomApproval {
  readonly id: string;
  readonly status: string;
  readonly risk: string;
  readonly title: string;
  readonly purpose: string;
  readonly action: string;
  readonly resource: string;
  readonly exactPreview: string;
  readonly impact: string;
  readonly expiresAt: string;
  readonly agentId: string | null;
  readonly taskId: string | null;
  readonly evidence: readonly string[];
}

export interface ProjectRoomEvent {
  readonly sequence: number;
  readonly eventId: string;
  readonly occurredAt: string;
  readonly type: string;
  readonly severity: ProjectRoomSeverity;
  readonly summary: string;
  readonly agentId: string | null;
  readonly taskId: string | null;
  readonly approvalId: string | null;
}

export interface ProjectRoomSnapshot {
  readonly schema: typeof PROJECT_ROOM_SNAPSHOT_SCHEMA;
  readonly projectId: string;
  readonly projectName: string;
  readonly branch: string;
  readonly generatedAt: string;
  readonly cursor: number;
  readonly controller: {
    readonly state: string;
    readonly mode: ProjectRoomAccessMode;
  };
  readonly run: ProjectRoomRun | null;
  readonly approvals: readonly ProjectRoomApproval[];
  readonly importantEvents: readonly ProjectRoomEvent[];
}

export interface ProjectRoomCommittedUpdate {
  readonly cursor: number;
  readonly events: readonly ProjectRoomEvent[];
  /** Authoritative projection after every event through `cursor`. */
  readonly snapshot: ProjectRoomSnapshot;
}

export type ComposerTarget =
  | {readonly kind: "objective"; readonly label: "new objective"}
  | {readonly kind: "agent"; readonly id: string; readonly label: string}
  | {readonly kind: "task"; readonly id: string; readonly label: string}
  | {readonly kind: "run"; readonly id: string; readonly label: string};

export type ApprovalDecision = "APPROVED" | "DENIED" | "CHANGES_REQUESTED";
export type LeaveDisposition = "continue" | "pause" | "cancel";

export type ProjectRoomCommand =
  | {readonly type: "objective.create"; readonly text: string; readonly expectedCursor: number}
  | {readonly type: "instruction.submit"; readonly runId: string; readonly text: string; readonly target: Exclude<ComposerTarget, {readonly kind: "objective"}>; readonly expectedCursor: number}
  | {readonly type: "approval.decide"; readonly approvalId: string; readonly decision: ApprovalDecision; readonly expectedCursor: number}
  | {readonly type: "session.leave"; readonly disposition: LeaveDisposition; readonly expectedCursor: number};

export interface PendingProjectRoomCommand {
  readonly id: number;
  readonly command: ProjectRoomCommand;
}

export type ProjectRoomOverlay =
  | {readonly kind: "none"}
  | {readonly kind: "help"}
  | {readonly kind: "search"; readonly query: string}
  | {readonly kind: "palette"; readonly query: string; readonly selected: number}
  | {readonly kind: "leave"; readonly selected: LeaveDisposition}
  | {readonly kind: "composer"}
  | {readonly kind: "target"; readonly selected: number}
  | {readonly kind: "approval-detail"; readonly approvalId: string}
  | {readonly kind: "approval-confirm"; readonly approvalId: string; readonly decision: ApprovalDecision};

export interface ProjectRoomState {
  readonly snapshot: ProjectRoomSnapshot | null;
  readonly events: readonly ProjectRoomEvent[];
  readonly cursor: number;
  readonly connection: ProjectRoomConnection;
  readonly connectionMessage: string | null;
  readonly resyncRequested: boolean;
  readonly width: number;
  readonly height: number;
  readonly now: number;
  readonly staleAfterMs: number;
  readonly stale: boolean;
  readonly focus: ProjectRoomFocus;
  readonly overlay: ProjectRoomOverlay;
  readonly selectedAgentId: string | null;
  readonly selectedEventId: string | null;
  readonly selectedApprovalId: string | null;
  readonly composerText: string;
  readonly composerTarget: ComposerTarget;
  readonly followEvents: boolean;
  readonly notice: string | null;
  readonly pendingCommand: PendingProjectRoomCommand | null;
  readonly commandInFlight: boolean;
  readonly nextCommandId: number;
}

export interface InitialProjectRoomStateOptions {
  readonly width?: number;
  readonly height?: number;
  readonly now?: number;
  readonly staleAfterMs?: number;
}

export type ProjectRoomAction =
  | {readonly type: "dimensions.changed"; readonly width: number; readonly height: number}
  | {readonly type: "connection.connecting"}
  | {readonly type: "connection.lost"; readonly message: string}
  | {readonly type: "connection.error"; readonly message: string}
  | {readonly type: "snapshot.received"; readonly snapshot: ProjectRoomSnapshot}
  | {readonly type: "events.received"; readonly update: ProjectRoomCommittedUpdate}
  | {readonly type: "clock.tick"; readonly now: number}
  | {readonly type: "overlay.close"}
  | {readonly type: "overlay.help"}
  | {readonly type: "overlay.search"}
  | {readonly type: "overlay.palette"}
  | {readonly type: "overlay.leave"}
  | {readonly type: "overlay.composer"}
  | {readonly type: "overlay.target"}
  | {readonly type: "text.append"; readonly text: string}
  | {readonly type: "text.backspace"}
  | {readonly type: "input.confirm"}
  | {readonly type: "focus.next"; readonly reverse: boolean}
  | {readonly type: "focus.set"; readonly focus: ProjectRoomFocus}
  | {readonly type: "selection.move"; readonly delta: -1 | 1}
  | {readonly type: "events.follow.toggle"}
  | {readonly type: "approval.open"}
  | {readonly type: "approval.decision"; readonly decision: ApprovalDecision}
  | {readonly type: "mutation.blocked"}
  | {readonly type: "command.started"; readonly id: number}
  | {readonly type: "command.succeeded"; readonly id: number}
  | {readonly type: "command.failed"; readonly id: number; readonly message: string}
  | {readonly type: "notice.clear"};

export interface ProjectRoomKey {
  readonly upArrow: boolean;
  readonly downArrow: boolean;
  readonly leftArrow: boolean;
  readonly rightArrow: boolean;
  readonly pageDown: boolean;
  readonly pageUp: boolean;
  readonly home: boolean;
  readonly end: boolean;
  readonly return: boolean;
  readonly escape: boolean;
  readonly ctrl: boolean;
  readonly shift: boolean;
  readonly tab: boolean;
  readonly backspace: boolean;
  readonly delete: boolean;
  readonly meta: boolean;
}

const FOCUS_ORDER: readonly ProjectRoomFocus[] = ["agents", "events", "approvals", "tokens"];
const LEAVE_ORDER: readonly LeaveDisposition[] = ["continue", "pause", "cancel"];
const PALETTE_ACTIONS = [
  "Compose instruction",
  "Review approvals",
  "Search committed events",
  "Toggle event follow",
  "Open help",
  "Leave session",
] as const;

export function createInitialProjectRoomState(options: InitialProjectRoomStateOptions = {}): ProjectRoomState {
  return {
    snapshot: null,
    events: [],
    cursor: 0,
    connection: "connecting",
    connectionMessage: null,
    resyncRequested: false,
    width: normalizeDimension(options.width ?? 100),
    height: normalizeDimension(options.height ?? 24),
    now: options.now ?? Date.now(),
    staleAfterMs: options.staleAfterMs ?? PROJECT_ROOM_STALE_AFTER_MS,
    stale: false,
    focus: "agents",
    overlay: {kind: "none"},
    selectedAgentId: null,
    selectedEventId: null,
    selectedApprovalId: null,
    composerText: "",
    composerTarget: {kind: "objective", label: "new objective"},
    followEvents: true,
    notice: null,
    pendingCommand: null,
    commandInFlight: false,
    nextCommandId: 1,
  };
}

export function projectRoomReducer(state: ProjectRoomState, action: ProjectRoomAction): ProjectRoomState {
  switch (action.type) {
    case "dimensions.changed":
      return {...state, width: normalizeDimension(action.width), height: normalizeDimension(action.height)};
    case "connection.connecting":
      return {...state, connection: state.snapshot === null ? "connecting" : "reconnecting", connectionMessage: null};
    case "connection.lost":
      return {...state, connection: "reconnecting", connectionMessage: terminalText(action.message, 240)};
    case "connection.error":
      return {...state, connection: "error", connectionMessage: terminalText(action.message, 240)};
    case "snapshot.received":
      return receiveSnapshot(state, action.snapshot);
    case "events.received":
      return receiveEvents(state, action.update);
    case "clock.tick":
      return {...state, now: action.now, stale: isSnapshotStale(state.snapshot, action.now, state.staleAfterMs)};
    case "overlay.close":
      return {...state, overlay: {kind: "none"}, notice: null};
    case "overlay.help":
      return {...state, overlay: {kind: "help"}, notice: null};
    case "overlay.search":
      return {...state, overlay: {kind: "search", query: ""}, notice: null};
    case "overlay.palette":
      return {...state, overlay: {kind: "palette", query: "", selected: 0}, notice: null};
    case "overlay.leave":
      return {...state, overlay: {kind: "leave", selected: "continue"}, notice: null};
    case "overlay.composer":
      return {
        ...state,
        overlay: {kind: "composer"},
        composerTarget: state.overlay.kind === "target" ? state.composerTarget : defaultComposerTarget(state.snapshot, state.selectedAgentId),
        notice: null,
      };
    case "overlay.target":
      return {...state, overlay: {kind: "target", selected: targetIndex(state)}, notice: null};
    case "text.append":
      return appendText(state, action.text);
    case "text.backspace":
      return backspaceText(state);
    case "input.confirm":
      return confirmOverlay(state);
    case "focus.next":
      return {...state, focus: cycle(FOCUS_ORDER, state.focus, action.reverse ? -1 : 1), overlay: {kind: "none"}, notice: null};
    case "focus.set":
      return {...state, focus: action.focus, overlay: {kind: "none"}, notice: null};
    case "selection.move":
      return moveSelection(state, action.delta);
    case "events.follow.toggle":
      return {...state, followEvents: !state.followEvents, notice: null};
    case "approval.open":
      return openApproval(state);
    case "approval.decision":
      return beginApprovalDecision(state, action.decision);
    case "mutation.blocked":
      return {...state, notice: "This Software Agent session is read-only; obtain the control lease before changing state."};
    case "command.started":
      return state.pendingCommand?.id === action.id ? {...state, commandInFlight: true, notice: "Sending committed command..."} : state;
    case "command.succeeded":
      return state.pendingCommand?.id === action.id
        ? {...state, pendingCommand: null, commandInFlight: false, notice: "Command accepted; waiting for a committed event."}
        : state;
    case "command.failed":
      return state.pendingCommand?.id === action.id
        ? {...state, pendingCommand: null, commandInFlight: false, notice: `Command failed: ${terminalText(action.message, 240)}`}
        : state;
    case "notice.clear":
      return {...state, notice: null};
  }
}

export function projectRoomInput(state: ProjectRoomState, input: string, key: ProjectRoomKey): ProjectRoomAction | null {
  if (key.escape) {
    if (state.overlay.kind === "none") return {type: "overlay.leave"};
    if (state.overlay.kind === "target") return {type: "overlay.composer"};
    if (state.overlay.kind === "approval-confirm") return {type: "approval.open"};
    return {type: "overlay.close"};
  }
  if (key.ctrl && input.toLowerCase() === "c") return {type: "overlay.leave"};

  switch (state.overlay.kind) {
    case "help":
      return input === "?" || key.return ? {type: "overlay.close"} : null;
    case "search":
    case "palette":
      if (key.return) return {type: "input.confirm"};
      if (key.backspace || key.delete) return {type: "text.backspace"};
      if (key.upArrow) return {type: "selection.move", delta: -1};
      if (key.downArrow) return {type: "selection.move", delta: 1};
      return printable(input, key) ? {type: "text.append", text: input} : null;
    case "composer":
      if (key.return) return {type: "input.confirm"};
      if (key.tab) return {type: "overlay.target"};
      if (key.backspace || key.delete) return {type: "text.backspace"};
      return printable(input, key) ? {type: "text.append", text: input} : null;
    case "target":
      if (key.return) return {type: "input.confirm"};
      if (key.upArrow || key.leftArrow) return {type: "selection.move", delta: -1};
      if (key.downArrow || key.rightArrow) return {type: "selection.move", delta: 1};
      return null;
    case "leave":
      if (key.return) return {type: "input.confirm"};
      if (key.upArrow || key.leftArrow) return {type: "selection.move", delta: -1};
      if (key.downArrow || key.rightArrow) return {type: "selection.move", delta: 1};
      return null;
    case "approval-detail":
      if (input === "a") return isReadOnly(state) ? {type: "mutation.blocked"} : {type: "approval.decision", decision: "APPROVED"};
      if (input === "d") return isReadOnly(state) ? {type: "mutation.blocked"} : {type: "approval.decision", decision: "DENIED"};
      if (input === "r") return isReadOnly(state) ? {type: "mutation.blocked"} : {type: "approval.decision", decision: "CHANGES_REQUESTED"};
      return null;
    case "approval-confirm":
      return key.return ? {type: "input.confirm"} : null;
    case "none":
      break;
  }

  if (key.ctrl && input.toLowerCase() === "k") return {type: "overlay.palette"};
  if (key.tab) return {type: "focus.next", reverse: key.shift};
  if (key.upArrow || input === "k") return {type: "selection.move", delta: -1};
  if (key.downArrow || input === "j") return {type: "selection.move", delta: 1};
  if (key.return && state.focus === "approvals") return {type: "approval.open"};
  if (input === "1") return {type: "focus.set", focus: "agents"};
  if (input === "2") return {type: "focus.set", focus: "events"};
  if (input === "3") return {type: "focus.set", focus: "approvals"};
  if (input === "4") return {type: "focus.set", focus: "tokens"};
  if (!key.ctrl && input === "c") return {type: "overlay.composer"};
  if (!key.ctrl && input === "/") return {type: "overlay.search"};
  if (!key.ctrl && input === "f") return {type: "events.follow.toggle"};
  if (!key.ctrl && input === "?") return {type: "overlay.help"};
  if (!key.ctrl && input === "q") return {type: "overlay.leave"};
  return null;
}

export function isContiguousUpdate(cursor: number, update: ProjectRoomCommittedUpdate): boolean {
  if (update.cursor < cursor || update.snapshot.cursor !== update.cursor) return false;
  const fresh = update.events.filter((event) => event.sequence > cursor).sort((left, right) => left.sequence - right.sequence);
  if (update.cursor === cursor) return fresh.length === 0;
  if (fresh.length === 0 || fresh[0]?.sequence !== cursor + 1 || fresh.at(-1)?.sequence !== update.cursor) return false;
  for (let index = 1; index < fresh.length; index += 1) {
    if (fresh[index]?.sequence !== (fresh[index - 1]?.sequence ?? 0) + 1) return false;
  }
  return new Set(fresh.map((event) => event.sequence)).size === fresh.length;
}

export function targetCandidates(snapshot: ProjectRoomSnapshot | null): readonly ComposerTarget[] {
  if (snapshot?.run === null || snapshot === null) return [{kind: "objective", label: "new objective"}];
  const agents = snapshot.run.agents.map((agent): ComposerTarget => ({kind: "agent", id: agent.id, label: agent.displayName}));
  const tasks = snapshot.run.tasks.map((task): ComposerTarget => ({kind: "task", id: task.id, label: task.title}));
  return [...agents, ...tasks, {kind: "run", id: snapshot.run.id, label: "whole run"}];
}

export function filteredPaletteActions(query: string): readonly string[] {
  const needle = query.trim().toLowerCase();
  return needle === "" ? PALETTE_ACTIONS : PALETTE_ACTIONS.filter((action) => action.toLowerCase().includes(needle));
}

function receiveSnapshot(state: ProjectRoomState, snapshot: ProjectRoomSnapshot): ProjectRoomState {
  const next = reconcileSelections(state, snapshot, snapshot.importantEvents);
  return {
    ...next,
    snapshot,
    events: snapshot.importantEvents.slice(-PROJECT_ROOM_EVENT_LIMIT),
    cursor: snapshot.cursor,
    connection: "connected",
    connectionMessage: null,
    resyncRequested: false,
    stale: isSnapshotStale(snapshot, state.now, state.staleAfterMs),
    composerTarget: defaultComposerTarget(snapshot, next.selectedAgentId),
  };
}

function receiveEvents(state: ProjectRoomState, update: ProjectRoomCommittedUpdate): ProjectRoomState {
  if (!isContiguousUpdate(state.cursor, update)) {
    return {
      ...state,
      connection: "resyncing",
      connectionMessage: `Committed event cursor gap after ${state.cursor}; requesting an authoritative resync.`,
      resyncRequested: true,
    };
  }
  const fresh = update.events.filter((event) => event.sequence > state.cursor).sort((left, right) => left.sequence - right.sequence);
  const events = [...state.events, ...fresh].slice(-PROJECT_ROOM_EVENT_LIMIT);
  const next = reconcileSelections(state, update.snapshot, events);
  return {
    ...next,
    snapshot: update.snapshot,
    events,
    cursor: update.cursor,
    connection: "connected",
    connectionMessage: null,
    resyncRequested: false,
    stale: isSnapshotStale(update.snapshot, state.now, state.staleAfterMs),
    selectedEventId: state.followEvents ? events.at(-1)?.eventId ?? next.selectedEventId : next.selectedEventId,
  };
}

function reconcileSelections(
  state: ProjectRoomState,
  snapshot: ProjectRoomSnapshot,
  events: readonly ProjectRoomEvent[],
): ProjectRoomState {
  const agentId = snapshot.run?.agents.some((agent) => agent.id === state.selectedAgentId) === true
    ? state.selectedAgentId
    : snapshot.run?.agents[0]?.id ?? null;
  const approvalId = snapshot.approvals.some((approval) => approval.id === state.selectedApprovalId)
    ? state.selectedApprovalId
    : snapshot.approvals[0]?.id ?? null;
  const eventId = events.some((event) => event.eventId === state.selectedEventId)
    ? state.selectedEventId
    : events.at(-1)?.eventId ?? null;
  return {...state, selectedAgentId: agentId, selectedApprovalId: approvalId, selectedEventId: eventId};
}

function appendText(state: ProjectRoomState, text: string): ProjectRoomState {
  const clean = terminalText(text, 8_192);
  if (clean === "") return state;
  if (state.overlay.kind === "composer") {
    return {...state, composerText: `${state.composerText}${clean}`.slice(0, 8_192), notice: null};
  }
  if (state.overlay.kind === "search") {
    return {...state, overlay: {kind: "search", query: `${state.overlay.query}${clean}`.slice(0, 256)}};
  }
  if (state.overlay.kind === "palette") {
    return {...state, overlay: {kind: "palette", query: `${state.overlay.query}${clean}`.slice(0, 256), selected: 0}};
  }
  return state;
}

function backspaceText(state: ProjectRoomState): ProjectRoomState {
  if (state.overlay.kind === "composer") return {...state, composerText: dropLastCodePoint(state.composerText)};
  if (state.overlay.kind === "search") return {...state, overlay: {kind: "search", query: dropLastCodePoint(state.overlay.query)}};
  if (state.overlay.kind === "palette") return {...state, overlay: {...state.overlay, query: dropLastCodePoint(state.overlay.query), selected: 0}};
  return state;
}

function confirmOverlay(state: ProjectRoomState): ProjectRoomState {
  switch (state.overlay.kind) {
    case "search": {
      const query = state.overlay.query.trim().toLowerCase();
      const match = query === "" ? null : state.events.findLast((event) => `${event.type} ${event.summary}`.toLowerCase().includes(query));
      return {
        ...state,
        overlay: {kind: "none"},
        focus: "events",
        selectedEventId: match?.eventId ?? state.selectedEventId,
        notice: match === undefined ? `No committed event matches '${terminalText(state.overlay.query, 80)}'.` : null,
      };
    }
    case "palette":
      return executePalette(state);
    case "composer":
      return submitComposer(state);
    case "target": {
      const candidates = targetCandidates(state.snapshot);
      const target = candidates[clampIndex(state.overlay.selected, candidates.length)] ?? state.composerTarget;
      return {...state, composerTarget: target, overlay: {kind: "composer"}, notice: null};
    }
    case "leave":
      if (state.overlay.selected !== "continue" && isReadOnly(state)) return {...state, notice: "This Software Agent session is read-only; only leaving without mutation is available."};
      return queueCommand(state, {type: "session.leave", disposition: state.overlay.selected, expectedCursor: state.cursor}, {kind: "none"});
    case "approval-confirm":
      if (isReadOnly(state)) return {...state, notice: "This Software Agent session is read-only; approval decisions are disabled."};
      return queueCommand(state, {
        type: "approval.decide",
        approvalId: state.overlay.approvalId,
        decision: state.overlay.decision,
        expectedCursor: state.cursor,
      }, {kind: "approval-detail", approvalId: state.overlay.approvalId});
    case "help":
    case "approval-detail":
      return {...state, overlay: {kind: "none"}};
    case "none":
      return state;
  }
}

function submitComposer(state: ProjectRoomState): ProjectRoomState {
  const trimmed = state.composerText.trim();
  if (trimmed === "") return {...state, notice: "Enter an objective or targeted instruction before submitting."};
  if (trimmed.startsWith("/") && !trimmed.startsWith("//")) return executeSlashCommand(state, trimmed);
  if (isReadOnly(state)) return {...state, notice: "This Software Agent session is read-only; instructions are disabled."};
  const text = trimmed.startsWith("//") ? trimmed.slice(1) : trimmed;
  if (state.composerTarget.kind === "objective") {
    return queueCommand({...state, composerText: ""}, {type: "objective.create", text, expectedCursor: state.cursor}, {kind: "none"});
  }
  const runId = state.snapshot?.run?.id;
  if (runId === undefined) return {...state, notice: "The selected target has no active run; resync before submitting."};
  return queueCommand({...state, composerText: ""}, {
    type: "instruction.submit",
    runId,
    text,
    target: state.composerTarget,
    expectedCursor: state.cursor,
  }, {kind: "none"});
}

function executeSlashCommand(state: ProjectRoomState, command: string): ProjectRoomState {
  switch (command.toLowerCase()) {
    case "/help": return {...state, overlay: {kind: "help"}, composerText: "", notice: null};
    case "/search": return {...state, overlay: {kind: "search", query: ""}, composerText: "", notice: null};
    case "/follow": return {...state, overlay: {kind: "none"}, composerText: "", followEvents: !state.followEvents, notice: null};
    case "/leave": return {...state, overlay: {kind: "leave", selected: "continue"}, composerText: "", notice: null};
    case "/target": return {...state, overlay: {kind: "target", selected: targetIndex(state)}, composerText: "", notice: null};
    default: return {...state, notice: `Unknown Software Agent command '${terminalText(command, 80)}'. Use /help.`};
  }
}

function executePalette(state: ProjectRoomState): ProjectRoomState {
  if (state.overlay.kind !== "palette") return state;
  const actions = filteredPaletteActions(state.overlay.query);
  const selected = actions[clampIndex(state.overlay.selected, actions.length)];
  switch (selected) {
    case "Compose instruction": return projectRoomReducer({...state, overlay: {kind: "none"}}, {type: "overlay.composer"});
    case "Review approvals": return {...state, overlay: {kind: "none"}, focus: "approvals"};
    case "Search committed events": return {...state, overlay: {kind: "search", query: ""}};
    case "Toggle event follow": return {...state, overlay: {kind: "none"}, followEvents: !state.followEvents};
    case "Open help": return {...state, overlay: {kind: "help"}};
    case "Leave session": return {...state, overlay: {kind: "leave", selected: "continue"}};
    default: return {...state, notice: "No implemented command matches the palette query."};
  }
}

function openApproval(state: ProjectRoomState): ProjectRoomState {
  const approval = selectedApproval(state);
  return approval === null
    ? {...state, notice: "There is no approval to inspect."}
    : {...state, selectedApprovalId: approval.id, overlay: {kind: "approval-detail", approvalId: approval.id}, notice: null};
}

function beginApprovalDecision(state: ProjectRoomState, decision: ApprovalDecision): ProjectRoomState {
  if (state.overlay.kind !== "approval-detail") return state;
  const approvalId = state.overlay.approvalId;
  const approval = state.snapshot?.approvals.find((candidate) => candidate.id === approvalId);
  if (approval === undefined || approval.status !== "PENDING") return {...state, notice: "This approval is no longer pending."};
  return {...state, overlay: {kind: "approval-confirm", approvalId: approval.id, decision}, notice: null};
}

function moveSelection(state: ProjectRoomState, delta: -1 | 1): ProjectRoomState {
  if (state.overlay.kind === "palette") {
    const count = filteredPaletteActions(state.overlay.query).length;
    return {...state, overlay: {...state.overlay, selected: wrapIndex(state.overlay.selected + delta, count)}};
  }
  if (state.overlay.kind === "leave") {
    return {...state, overlay: {...state.overlay, selected: cycle(LEAVE_ORDER, state.overlay.selected, delta)}};
  }
  if (state.overlay.kind === "target") {
    return {...state, overlay: {...state.overlay, selected: wrapIndex(state.overlay.selected + delta, targetCandidates(state.snapshot).length)}};
  }
  const snapshot = state.snapshot;
  if (state.focus === "agents") {
    const agents = snapshot?.run?.agents ?? [];
    const selected = moveId(agents, state.selectedAgentId, delta);
    return {...state, selectedAgentId: selected, composerTarget: defaultComposerTarget(snapshot, selected)};
  }
  if (state.focus === "events") {
    return {...state, selectedEventId: moveId(state.events, state.selectedEventId, delta), followEvents: false};
  }
  if (state.focus === "approvals") {
    return {...state, selectedApprovalId: moveId(snapshot?.approvals ?? [], state.selectedApprovalId, delta)};
  }
  return state;
}

function selectedApproval(state: ProjectRoomState): ProjectRoomApproval | null {
  return state.snapshot?.approvals.find((approval) => approval.id === state.selectedApprovalId)
    ?? state.snapshot?.approvals[0]
    ?? null;
}

function queueCommand(state: ProjectRoomState, command: ProjectRoomCommand, overlay: ProjectRoomOverlay): ProjectRoomState {
  if (state.pendingCommand !== null || state.commandInFlight) return {...state, notice: "Wait for the current command receipt before sending another command."};
  return {
    ...state,
    overlay,
    pendingCommand: {id: state.nextCommandId, command},
    nextCommandId: state.nextCommandId + 1,
    notice: "Command ready for the controller.",
  };
}

function defaultComposerTarget(snapshot: ProjectRoomSnapshot | null, selectedAgentId: string | null): ComposerTarget {
  if (snapshot?.run === null || snapshot === null) return {kind: "objective", label: "new objective"};
  const agent = snapshot.run.agents.find((candidate) => candidate.id === selectedAgentId) ?? snapshot.run.agents[0];
  if (agent !== undefined) return {kind: "agent", id: agent.id, label: agent.displayName};
  const task = snapshot.run.tasks[0];
  if (task !== undefined) return {kind: "task", id: task.id, label: task.title};
  return {kind: "run", id: snapshot.run.id, label: "whole run"};
}

function targetIndex(state: ProjectRoomState): number {
  const candidates = targetCandidates(state.snapshot);
  const index = candidates.findIndex((candidate) => sameTarget(candidate, state.composerTarget));
  return index < 0 ? 0 : index;
}

function sameTarget(left: ComposerTarget, right: ComposerTarget): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "objective" && right.kind === "objective") return true;
  return "id" in left && "id" in right && left.id === right.id;
}

function isReadOnly(state: ProjectRoomState): boolean {
  return state.snapshot?.controller.mode === "READ_ONLY";
}

function isSnapshotStale(snapshot: ProjectRoomSnapshot | null, now: number, staleAfterMs: number): boolean {
  if (snapshot === null) return false;
  const generated = Date.parse(snapshot.generatedAt);
  return !Number.isFinite(generated) || now - generated > staleAfterMs;
}

function moveId(items: readonly ({readonly id: string} | {readonly eventId: string})[], selected: string | null, delta: -1 | 1): string | null {
  if (items.length === 0) return null;
  const ids = items.map((item) => "id" in item ? item.id : item.eventId);
  const current = Math.max(0, ids.indexOf(selected ?? ""));
  return ids[wrapIndex(current + delta, ids.length)] ?? null;
}

function cycle<T>(items: readonly T[], selected: T, delta: number): T {
  const index = Math.max(0, items.indexOf(selected));
  return items[wrapIndex(index + delta, items.length)] ?? selected;
}

function wrapIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return ((index % length) + length) % length;
}

function clampIndex(index: number, length: number): number {
  return Math.max(0, Math.min(index, Math.max(0, length - 1)));
}

function normalizeDimension(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1;
}

function printable(input: string, key: ProjectRoomKey): boolean {
  return input.length > 0 && !key.ctrl && !key.meta && !key.return && !key.escape && !key.tab;
}

function terminalText(value: string, limit: number): string {
  return sanitizeTerminal(value, limit).replaceAll("\n", " ");
}

function dropLastCodePoint(value: string): string {
  return Array.from(value).slice(0, -1).join("");
}
