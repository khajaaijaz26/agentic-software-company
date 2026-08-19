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

export interface ProjectRoomRosterAgent {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: readonly string[];
  readonly state: "WORKING" | "WAITING" | "BLOCKED" | "DONE" | "FAILED";
  readonly status: string;
  readonly activity: string;
  readonly taskTitle: string;
  readonly sessionId: string | null;
  readonly model: string;
}

export interface ProjectRoomProviderSetting {
  readonly providerId: string;
  readonly enabled: boolean;
  readonly model: string;
  readonly credentialReference: string;
}

export interface ProjectRoomSettings {
  readonly workspace: string;
  readonly defaultModel: string;
  readonly tokenMode: "economy" | "balanced" | "quality";
  readonly providers: readonly ProjectRoomProviderSetting[];
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
  readonly roster: readonly ProjectRoomRosterAgent[];
  readonly settings: ProjectRoomSettings;
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
  | {readonly type: "provider.connect"; readonly providerId: "openai" | "anthropic"; readonly model: string; readonly secret: string; readonly expectedCursor: number}
  | {readonly type: "provider.test"; readonly providerId: "openai" | "anthropic"; readonly expectedCursor: number}
  | {readonly type: "provider.remove"; readonly providerId: "openai" | "anthropic"; readonly expectedCursor: number}
  | {readonly type: "model.select"; readonly model: string; readonly expectedCursor: number}
  | {readonly type: "tokens.mode"; readonly mode: "economy" | "balanced" | "quality"; readonly expectedCursor: number}
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
  | {readonly kind: "settings"}
  | {readonly kind: "api-key"; readonly providerId: "openai" | "anthropic"; readonly model: string; readonly value: string}
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
  readonly slashSelected: number;
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
  | {readonly type: "overlay.composer"; readonly prefill?: string}
  | {readonly type: "overlay.settings"}
  | {readonly type: "overlay.target"}
  | {readonly type: "slash.complete"}
  | {readonly type: "text.append"; readonly text: string}
  | {readonly type: "text.backspace"}
  | {readonly type: "input.confirm"}
  | {readonly type: "focus.next"; readonly reverse: boolean}
  | {readonly type: "focus.set"; readonly focus: ProjectRoomFocus}
  | {readonly type: "selection.move"; readonly delta: -1 | 1}
  | {readonly type: "events.follow.toggle"}
  | {readonly type: "events.clear.local"}
  | {readonly type: "approval.open"}
  | {readonly type: "approval.decision"; readonly decision: ApprovalDecision}
  | {readonly type: "mutation.blocked"}
  | {readonly type: "command.started"; readonly id: number}
  | {readonly type: "command.succeeded"; readonly id: number; readonly message?: string}
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
  "Open settings",
  "Show all agents",
  "Review approvals",
  "Search committed events",
  "Toggle event follow",
  "Open help",
  "Leave session",
] as const;

export interface SlashCommandSuggestion {
  readonly command: string;
  readonly usage: string;
  readonly description: string;
  readonly category: "View" | "AI & models" | "Run" | "Workspace" | "Session";
  readonly completion: string;
  readonly runOnSelect: boolean;
}

const SLASH_COMMANDS: readonly SlashCommandSuggestion[] = [
  {command: "/help", usage: "/help", description: "Open keyboard and workflow help", category: "View", completion: "/help", runOnSelect: true},
  {command: "/status", usage: "/status", description: "Show the current run and working-agent count", category: "View", completion: "/status", runOnSelect: true},
  {command: "/agents", usage: "/agents", description: "Focus the complete 26-role agent wall", category: "View", completion: "/agents", runOnSelect: true},
  {command: "/settings", usage: "/settings", description: "Show project, model, token, and API settings", category: "View", completion: "/settings", runOnSelect: true},
  {command: "/approvals", usage: "/approvals", description: "Focus pending approval packets", category: "View", completion: "/approvals", runOnSelect: true},
  {command: "/events", usage: "/events", description: "Focus committed controller activity", category: "View", completion: "/events", runOnSelect: true},
  {command: "/search", usage: "/search", description: "Search committed events", category: "View", completion: "/search", runOnSelect: true},
  {command: "/api", usage: "/api", description: "Show connected API providers", category: "AI & models", completion: "/api", runOnSelect: true},
  {command: "/api connect openai", usage: "/api connect openai [model]", description: "Connect OpenAI using masked secure-key entry", category: "AI & models", completion: "/api connect openai ", runOnSelect: true},
  {command: "/api connect anthropic", usage: "/api connect anthropic [model]", description: "Connect Anthropic using masked secure-key entry", category: "AI & models", completion: "/api connect anthropic ", runOnSelect: true},
  {command: "/api test openai", usage: "/api test openai", description: "Test the saved OpenAI credential", category: "AI & models", completion: "/api test openai", runOnSelect: true},
  {command: "/api test anthropic", usage: "/api test anthropic", description: "Test the saved Anthropic credential", category: "AI & models", completion: "/api test anthropic", runOnSelect: true},
  {command: "/api remove openai", usage: "/api remove openai", description: "Remove the saved OpenAI connection", category: "AI & models", completion: "/api remove openai", runOnSelect: true},
  {command: "/api remove anthropic", usage: "/api remove anthropic", description: "Remove the saved Anthropic connection", category: "AI & models", completion: "/api remove anthropic", runOnSelect: true},
  {command: "/model", usage: "/model provider/model", description: "Select the project model for new turns", category: "AI & models", completion: "/model ", runOnSelect: false},
  {command: "/tokens economy", usage: "/tokens economy", description: "Use the low-cost 25% token allowance", category: "AI & models", completion: "/tokens economy", runOnSelect: true},
  {command: "/tokens balanced", usage: "/tokens balanced", description: "Use the recommended 50% token allowance", category: "AI & models", completion: "/tokens balanced", runOnSelect: true},
  {command: "/tokens quality", usage: "/tokens quality", description: "Use the full 100% token allowance", category: "AI & models", completion: "/tokens quality", runOnSelect: true},
  {command: "/target", usage: "/target", description: "Choose the agent, task, or run for the next message", category: "Run", completion: "/target", runOnSelect: true},
  {command: "/follow", usage: "/follow", description: "Toggle live committed-event scrolling", category: "Run", completion: "/follow", runOnSelect: true},
  {command: "/clear", usage: "/clear", description: "Clear this local view without deleting durable history", category: "Run", completion: "/clear", runOnSelect: true},
  {command: "/project", usage: "/project", description: "Show the active project and how to switch", category: "Workspace", completion: "/project", runOnSelect: true},
  {command: "/open", usage: "/open <path-or-github-url>", description: "Show the safe command for opening another project", category: "Workspace", completion: "/open ", runOnSelect: false},
  {command: "/github", usage: "/github OWNER/REPO", description: "Show the command for opening a GitHub repository", category: "Workspace", completion: "/github ", runOnSelect: false},
  {command: "/leave", usage: "/leave", description: "Leave, pause, or cancel the active session", category: "Session", completion: "/leave", runOnSelect: true},
] as const;

export function slashCommandSuggestions(query: string): readonly SlashCommandSuggestion[] {
  const normalized = query.trim().toLowerCase();
  if (normalized === "" || normalized === "/") return SLASH_COMMANDS;
  const terms = normalized.replace(/^\//u, "").split(/\s+/u).filter((term) => term !== "");
  const syntaxMatches = SLASH_COMMANDS.filter((suggestion) => {
    const syntax = suggestion.usage.toLowerCase();
    return terms.every((term) => syntax.includes(term));
  });
  if (syntaxMatches.length > 0) return syntaxMatches;
  return SLASH_COMMANDS.filter((suggestion) => {
    const searchable = `${suggestion.usage} ${suggestion.description} ${suggestion.category}`.toLowerCase();
    return terms.every((term) => searchable.includes(term));
  });
}

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
    slashSelected: 0,
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
    case "overlay.settings":
      return {...state, overlay: {kind: "settings"}, notice: null};
    case "overlay.composer":
      return {
        ...state,
        overlay: {kind: "composer"},
        composerText: action.prefill ?? state.composerText,
        composerTarget: state.overlay.kind === "target" ? state.composerTarget : defaultComposerTarget(state.snapshot, state.selectedAgentId),
        slashSelected: 0,
        notice: null,
      };
    case "overlay.target":
      return {...state, overlay: {kind: "target", selected: targetIndex(state)}, notice: null};
    case "slash.complete":
      return completeSlashSelection(state);
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
    case "events.clear.local":
      return {...state, events: [], selectedEventId: null, notice: "Local chat/work view cleared. Durable controller history was not deleted."};
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
        ? {...state, pendingCommand: null, commandInFlight: false, notice: action.message ?? commandSuccessNotice(state.pendingCommand.command)}
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
    case "settings":
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
      if (slashMenuVisible(state) && key.tab) return {type: "slash.complete"};
      if (slashMenuVisible(state) && key.upArrow) return {type: "selection.move", delta: -1};
      if (slashMenuVisible(state) && key.downArrow) return {type: "selection.move", delta: 1};
      if (key.tab) return {type: "overlay.target"};
      if (key.backspace || key.delete) return {type: "text.backspace"};
      return printable(input, key) ? {type: "text.append", text: input} : null;
    case "api-key":
      if (key.return) return {type: "input.confirm"};
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
  if (key.ctrl && input.toLowerCase() === "f") return {type: "events.follow.toggle"};
  if (key.tab) return {type: "focus.next", reverse: key.shift};
  if (key.upArrow) return {type: "selection.move", delta: -1};
  if (key.downArrow) return {type: "selection.move", delta: 1};
  if (key.return && state.focus === "approvals") return {type: "approval.open"};
  if (input === "1") return {type: "focus.set", focus: "agents"};
  if (input === "2") return {type: "focus.set", focus: "events"};
  if (input === "3") return {type: "focus.set", focus: "approvals"};
  if (input === "4") return {type: "focus.set", focus: "tokens"};
  if (input === "5") return {type: "overlay.settings"};
  if (!key.ctrl && input === "/") return {type: "overlay.composer", prefill: "/"};
  if (!key.ctrl && input === "?") return {type: "overlay.help"};
  if (printable(input, key)) return {type: "overlay.composer", prefill: input};
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
  if (state.overlay.kind === "api-key") {
    const secretChunk = Array.from(text).filter((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point > 0x20 && (point < 0x7f || point > 0x9f);
    }).join("");
    if (secretChunk === "") return state;
    return {...state, overlay: {...state.overlay, value: `${state.overlay.value}${secretChunk}`.slice(0, 4_096)}, notice: null};
  }
  const clean = terminalText(text, 8_192);
  if (clean === "") return state;
  if (state.overlay.kind === "composer") {
    return {...state, composerText: `${state.composerText}${clean}`.slice(0, 8_192), slashSelected: 0, notice: null};
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
  if (state.overlay.kind === "composer") return {...state, composerText: dropLastCodePoint(state.composerText), slashSelected: 0};
  if (state.overlay.kind === "api-key") return {...state, overlay: {...state.overlay, value: dropLastCodePoint(state.overlay.value)}};
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
    case "api-key": {
      if (isReadOnly(state)) return {...state, overlay: {kind: "none"}, notice: "This Software Agent session is read-only; provider settings are disabled."};
      const secret = state.overlay.value.trim();
      if (secret.length < 8) return {...state, notice: "Enter the complete API key, or press Esc to cancel without saving anything."};
      return queueCommand(state, {
        type: "provider.connect",
        providerId: state.overlay.providerId,
        model: state.overlay.model,
        secret,
        expectedCursor: state.cursor,
      }, {kind: "none"});
    }
    case "help":
    case "settings":
    case "approval-detail":
      return {...state, overlay: {kind: "none"}};
    case "none":
      return state;
  }
}

function submitComposer(state: ProjectRoomState): ProjectRoomState {
  const trimmed = state.composerText.trim();
  if (trimmed === "") return {...state, notice: "Enter an objective or targeted instruction before submitting."};
  if (trimmed.startsWith("/") && !trimmed.startsWith("//")) return submitSlashComposer(state, trimmed);
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

export function slashMenuVisible(state: ProjectRoomState): boolean {
  return state.overlay.kind === "composer" && state.composerText.startsWith("/") && !state.composerText.startsWith("//");
}

function submitSlashComposer(state: ProjectRoomState, command: string): ProjectRoomState {
  if (validSlashInvocation(command)) return executeSlashCommand(state, command);
  const suggestions = slashCommandSuggestions(command);
  const selected = suggestions[clampIndex(state.slashSelected, suggestions.length)];
  if (selected === undefined) return executeSlashCommand(state, command);
  if (!selected.runOnSelect) return completeSlashSelection(state);
  return executeSlashCommand(state, selected.command);
}

function completeSlashSelection(state: ProjectRoomState): ProjectRoomState {
  if (!slashMenuVisible(state)) return state;
  const suggestions = slashCommandSuggestions(state.composerText);
  const selected = suggestions[clampIndex(state.slashSelected, suggestions.length)];
  if (selected === undefined) return {...state, notice: "No implemented slash command matches this text."};
  return {
    ...state,
    composerText: selected.completion,
    slashSelected: 0,
    notice: selected.completion.endsWith(" ") ? `Complete ${selected.usage}, then press Enter.` : null,
  };
}

function validSlashInvocation(command: string): boolean {
  const parts = command.trim().toLowerCase().split(/\s+/u);
  const root = parts[0] ?? "";
  const action = parts[1];
  const provider = parts[2];
  if (["/help", "/search", "/follow", "/leave", "/target", "/settings", "/agents", "/approvals", "/events", "/status", "/clear", "/project"].includes(root)) {
    return parts.length === 1;
  }
  if (root === "/open" || root === "/github") return true;
  if (root === "/model") return parts.length <= 2;
  if (root === "/tokens") {
    return parts.length === 1 || (parts.length === 2 && ["status", "25", "25%", "economy", "50", "50%", "balanced", "100", "100%", "quality"].includes(action ?? ""));
  }
  if (root !== "/api") return false;
  if (parts.length === 1 || ((action === "status" || action === "list") && parts.length === 2)) return true;
  if (!["connect", "test", "remove"].includes(action ?? "") || !["openai", "anthropic"].includes(provider ?? "")) return false;
  return action === "connect" ? parts.length <= 4 : parts.length === 3;
}

function executeSlashCommand(state: ProjectRoomState, command: string): ProjectRoomState {
  const parts = command.trim().split(/\s+/u);
  const root = parts[0]?.toLowerCase() ?? "";
  const action = parts[1]?.toLowerCase();
  const argument = parts[2];
  const clearComposer = {composerText: "", overlay: {kind: "none"} as const};
  switch (root) {
    case "/help": return {...state, ...clearComposer, overlay: {kind: "help"}, notice: null};
    case "/search": return {...state, ...clearComposer, overlay: {kind: "search", query: ""}, notice: null};
    case "/follow": return {...state, ...clearComposer, followEvents: !state.followEvents, notice: null};
    case "/leave": return {...state, ...clearComposer, overlay: {kind: "leave", selected: "continue"}, notice: null};
    case "/target": return {...state, ...clearComposer, overlay: {kind: "target", selected: targetIndex(state)}, notice: null};
    case "/settings": return {...state, ...clearComposer, overlay: {kind: "settings"}, notice: null};
    case "/agents": return {
      ...state,
      ...clearComposer,
      focus: "agents",
      notice: `${state.snapshot?.roster.length ?? 0} named roles are visible; only assigned roles consume model tokens.`,
    };
    case "/approvals": return {...state, ...clearComposer, focus: "approvals", notice: null};
    case "/events": return {...state, ...clearComposer, focus: "events", notice: null};
    case "/status": return {...state, ...clearComposer, notice: runStatusNotice(state.snapshot?.run ?? null)};
    case "/clear": return projectRoomReducer({...state, ...clearComposer}, {type: "events.clear.local"});
    case "/project":
      return {
        ...state,
        ...clearComposer,
        overlay: {kind: "settings"},
        notice: "Use software-agent open <local-path-or-github-url> to enter another project safely.",
      };
    case "/github":
    case "/open":
      return {
        ...state,
        ...clearComposer,
        notice: `Open a project with: software-agent open ${terminalText(parts.slice(1).join(" ") || "https://github.com/OWNER/REPO", 160)}`,
      };
    case "/api": {
      if (action === undefined || action === "status" || action === "list") {
        return {...state, ...clearComposer, overlay: {kind: "settings"}, notice: null};
      }
      const providerId = supportedUiProvider(argument);
      if (providerId === null) {
        return {...state, ...clearComposer, notice: "Use /api connect openai [model], /api connect anthropic [model], /api test <provider>, or /api remove <provider>."};
      }
      if (action === "connect") {
        if (isReadOnly(state)) return {...state, ...clearComposer, notice: "This session is read-only; provider settings are disabled."};
        const model = terminalText(parts[3] ?? defaultProviderModel(providerId), 256);
        return {
          ...state,
          ...clearComposer,
          overlay: {kind: "api-key", providerId, model, value: ""},
          notice: "Paste the key into the masked field. It is sent only to the OS credential store and is never written to project files.",
        };
      }
      if (action === "test") {
        return queueCommand({...state, ...clearComposer}, {type: "provider.test", providerId, expectedCursor: state.cursor}, {kind: "none"});
      }
      if (action === "remove") {
        if (isReadOnly(state)) return {...state, ...clearComposer, notice: "This session is read-only; provider settings are disabled."};
        return queueCommand({...state, ...clearComposer}, {type: "provider.remove", providerId, expectedCursor: state.cursor}, {kind: "none"});
      }
      return {...state, ...clearComposer, notice: "Unknown /api action. Use /help."};
    }
    case "/model": {
      const model = parts[1];
      if (model === undefined) return {...state, ...clearComposer, overlay: {kind: "settings"}, notice: "Use /model provider/model-id to change this project's default model."};
      if (isReadOnly(state)) return {...state, ...clearComposer, notice: "This session is read-only; model settings are disabled."};
      return queueCommand({...state, ...clearComposer}, {type: "model.select", model: terminalText(model, 256), expectedCursor: state.cursor}, {kind: "none"});
    }
    case "/tokens": {
      if (action === undefined || action === "status") return {...state, ...clearComposer, overlay: {kind: "settings"}, notice: null};
      const tokenMode = parseUiTokenMode(action);
      if (tokenMode === null) return {...state, ...clearComposer, notice: "Use /tokens 25, /tokens 50, /tokens 100, or economy/balanced/quality."};
      if (isReadOnly(state)) return {...state, ...clearComposer, notice: "This session is read-only; token settings are disabled."};
      return queueCommand({...state, ...clearComposer}, {type: "tokens.mode", mode: tokenMode, expectedCursor: state.cursor}, {kind: "none"});
    }
    default:
      return {...state, ...clearComposer, notice: `Unknown Software Agent command '${terminalText(root, 40)}'. Use /help.`};
  }
}

function supportedUiProvider(value: string | undefined): "openai" | "anthropic" | null {
  const normalized = value?.toLowerCase();
  return normalized === "openai" || normalized === "anthropic" ? normalized : null;
}

function defaultProviderModel(providerId: "openai" | "anthropic"): string {
  return providerId === "openai" ? "gpt-5" : "claude-sonnet-4-5";
}

function parseUiTokenMode(value: string): "economy" | "balanced" | "quality" | null {
  if (["25", "25%", "economy"].includes(value)) return "economy";
  if (["50", "50%", "balanced"].includes(value)) return "balanced";
  if (["100", "100%", "quality"].includes(value)) return "quality";
  return null;
}

function runStatusNotice(run: ProjectRoomRun | null): string {
  if (run === null) return "No run is active. Type a prompt to create one.";
  const passed = run.tasks.filter((task) => task.state === "PASSED").length;
  const working = run.agents.filter((agent) => /RUNNING|PLANNING/u.test(agent.state)).length;
  return `Run ${run.state}: ${passed}/${run.tasks.length} tasks passed; ${working} agent${working === 1 ? "" : "s"} working now.`;
}

function executePalette(state: ProjectRoomState): ProjectRoomState {
  if (state.overlay.kind !== "palette") return state;
  const actions = filteredPaletteActions(state.overlay.query);
  const selected = actions[clampIndex(state.overlay.selected, actions.length)];
  switch (selected) {
    case "Compose instruction": return projectRoomReducer({...state, overlay: {kind: "none"}}, {type: "overlay.composer"});
    case "Open settings": return {...state, overlay: {kind: "settings"}};
    case "Show all agents": return {...state, overlay: {kind: "none"}, focus: "agents", notice: `${state.snapshot?.roster.length ?? 0} named roles are available.`};
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
  if (slashMenuVisible(state)) {
    const count = slashCommandSuggestions(state.composerText).length;
    return {...state, slashSelected: wrapIndex(state.slashSelected + delta, count)};
  }
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

function commandSuccessNotice(command: ProjectRoomCommand): string {
  switch (command.type) {
    case "objective.create":
      return "Objective committed. The scheduler is assigning work; watch RUN PROGRESS and agent status.";
    case "instruction.submit":
      return "Instruction committed. It will run when the selected target has an active schedulable turn.";
    case "approval.decide":
      return "Approval decision committed. Waiting work can now continue if policy permits it.";
    case "provider.connect":
      return `${command.providerId} connected securely and ${command.providerId}/${command.model} selected for this project.`;
    case "provider.test":
      return `${command.providerId} credential and model connection verified.`;
    case "provider.remove":
      return `${command.providerId} removed; its Software Agent credential entry was also deleted when supported.`;
    case "model.select":
      return `Project model changed to ${command.model}. New turns will use the updated route.`;
    case "tokens.mode":
      return `Token mode changed to ${command.mode}. New runs will use the updated allowance.`;
    case "session.leave":
      return `Session disposition committed: ${command.disposition}.`;
  }
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
