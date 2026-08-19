import React, {useEffect, useReducer, useRef} from "react";
import {Box, Text, render, useApp, useInput, useStdout} from "ink";
import type {Key} from "ink";

import {sanitizeTerminal} from "../../../packages/observability/src/index.js";
import {
  createInitialProjectRoomState,
  filteredPaletteActions,
  isContiguousUpdate,
  projectRoomInput,
  projectRoomReducer,
  targetCandidates,
  type ComposerTarget,
  type LeaveDisposition,
  type ProjectRoomAgent,
  type ProjectRoomApproval,
  type ProjectRoomCommand,
  type ProjectRoomCommittedUpdate,
  type ProjectRoomEvent,
  type ProjectRoomFocus,
  type ProjectRoomKey,
  type ProjectRoomSnapshot,
  type ProjectRoomState,
  type ProjectRoomTokenUsage,
} from "./project-room-state.js";

export type ProjectRoomLayout = "plain" | "narrow" | "two-card" | "three-card";

export interface ProjectRoomSource {
  /** Loads an authoritative projection and its committed-event cursor. */
  readonly load: (signal: AbortSignal) => Promise<ProjectRoomSnapshot>;
  /** Waits for the next bounded committed-event batch after `cursor`. */
  readonly nextCommitted: (cursor: number, signal: AbortSignal) => Promise<ProjectRoomCommittedUpdate>;
  /** Sends a typed intent; the UI changes authority state only after a later committed update. */
  readonly execute: (command: ProjectRoomCommand, signal: AbortSignal) => Promise<void>;
}

export interface ProjectRoomProps {
  readonly source: ProjectRoomSource;
  readonly noColor?: boolean;
  readonly ascii?: boolean;
  readonly width?: number;
  readonly height?: number;
  readonly staleAfterMs?: number;
  readonly onLeave?: (disposition: LeaveDisposition) => void;
}

export interface ProjectRoomRenderOptions {
  readonly width: number;
  readonly height: number;
  readonly noColor?: boolean;
  readonly ascii?: boolean;
  readonly interactive?: boolean;
}

export interface OpenProjectRoomOptions {
  readonly noColor?: boolean;
  readonly ascii?: boolean;
  readonly width?: number;
  readonly height?: number;
  readonly staleAfterMs?: number;
}

export interface TerminalOutput {
  readonly isTTY?: boolean;
  readonly write: (value: string) => unknown;
}

export interface TerminalRestorer {
  readonly install: () => void;
  readonly restore: () => void;
  readonly uninstall: () => void;
}

const TERMINAL_HIDE_CURSOR = "\u001b[?25l";
const TERMINAL_RESTORE = "\u001b[0m\u001b[?25h";

export function projectRoomLayout(width: number, height = 24): ProjectRoomLayout {
  if (width < 60 || height < 20) return "plain";
  if (width < 90) return "narrow";
  if (width < 120) return "two-card";
  return "three-card";
}

export function createTerminalRestorer(output: TerminalOutput): TerminalRestorer {
  let installed = false;
  let restored = false;
  const restore = (): void => {
    if (!installed || restored || output.isTTY !== true) return;
    restored = true;
    output.write(TERMINAL_RESTORE);
  };
  const onExit = (): void => { restore(); };
  const detach = (): void => {
    process.removeListener("exit", onExit);
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    process.removeListener("SIGHUP", onSighup);
  };
  const forwardSignal = (signal: NodeJS.Signals): void => {
    restore();
    detach();
    process.kill(process.pid, signal);
  };
  const onSigint = (): void => { forwardSignal("SIGINT"); };
  const onSigterm = (): void => { forwardSignal("SIGTERM"); };
  const onSighup = (): void => { forwardSignal("SIGHUP"); };
  return {
    install: () => {
      if (installed || output.isTTY !== true) return;
      installed = true;
      restored = false;
      output.write(TERMINAL_HIDE_CURSOR);
      process.once("exit", onExit);
      process.once("SIGINT", onSigint);
      process.once("SIGTERM", onSigterm);
      process.once("SIGHUP", onSighup);
    },
    restore,
    uninstall: () => {
      detach();
      installed = false;
    },
  };
}

export function ProjectRoom({
  source,
  noColor = false,
  ascii = false,
  width,
  height,
  staleAfterMs,
  onLeave,
}: ProjectRoomProps): React.JSX.Element {
  const {stdout} = useStdout();
  const {exit} = useApp();
  const terminalWidth = width ?? (stdout.columns || 100);
  const terminalHeight = height ?? (stdout.rows || 24);
  const [state, dispatch] = useReducer(projectRoomReducer, createInitialProjectRoomState({
    width: terminalWidth,
    height: terminalHeight,
    ...(staleAfterMs === undefined ? {} : {staleAfterMs}),
  }));
  const activeCommand = useRef<number | null>(null);

  useEffect(() => {
    dispatch({type: "dimensions.changed", width: width ?? (stdout.columns || 100), height: height ?? (stdout.rows || 24)});
  }, [height, stdout.columns, stdout.rows, width]);

  useEffect(() => {
    const restorer = createTerminalRestorer(stdout);
    restorer.install();
    return () => {
      restorer.restore();
      restorer.uninstall();
    };
  }, [stdout]);

  useEffect(() => {
    const abort = new AbortController();
    void pumpProjectRoom(source, dispatch, abort.signal);
    return () => { abort.abort(); };
  }, [source]);

  useEffect(() => {
    const timer = setInterval(() => { dispatch({type: "clock.tick", now: Date.now()}); }, 1_000);
    return () => { clearInterval(timer); };
  }, []);

  useEffect(() => {
    const pending = state.pendingCommand;
    if (pending === null || activeCommand.current === pending.id) return;
    activeCommand.current = pending.id;
    const abort = new AbortController();
    dispatch({type: "command.started", id: pending.id});
    void source.execute(pending.command, abort.signal).then(() => {
      dispatch({type: "command.succeeded", id: pending.id});
      if (pending.command.type === "session.leave") {
        onLeave?.(pending.command.disposition);
        exit();
      }
    }).catch((error: unknown) => {
      if (!abort.signal.aborted) dispatch({type: "command.failed", id: pending.id, message: errorMessage(error)});
    });
    return () => { abort.abort(); };
  }, [exit, onLeave, source, state.pendingCommand]);

  useInput((input, key) => {
    const action = projectRoomInput(state, input, inkKey(key));
    if (action !== null) dispatch(action);
  });

  const colorsDisabled = noColor || process.env.NO_COLOR !== undefined;
  return <ProjectRoomView state={state} width={state.width} height={state.height} noColor={colorsDisabled} ascii={ascii}/>;
}

export function ProjectRoomView({state, width, height, noColor = false, ascii = false, interactive = true}: {
  readonly state: ProjectRoomState;
  readonly width: number;
  readonly height: number;
  readonly noColor?: boolean;
  readonly ascii?: boolean;
  readonly interactive?: boolean;
}): React.JSX.Element {
  const layout = projectRoomLayout(width, height);
  if (layout === "plain") return <Text>{renderProjectRoomText(state, {width, height, noColor: true, ascii: true, interactive})}</Text>;

  const run = state.snapshot?.run ?? null;
  const agents = visibleAgents(run?.agents ?? [], state.selectedAgentId, layout === "three-card" ? 3 : layout === "two-card" ? 2 : 5);
  const cardColumns = layout === "three-card" ? 3 : layout === "two-card" ? 2 : 1;
  const cardWidth = layout === "narrow" ? Math.max(30, width - 4) : Math.max(28, Math.floor((width - cardColumns - 4) / cardColumns));
  const selectedAgent = run?.agents.find((agent) => agent.id === state.selectedAgentId) ?? run?.agents[0] ?? null;
  const selectedApproval = state.snapshot?.approvals.find((approval) => approval.id === state.selectedApprovalId) ?? state.snapshot?.approvals[0] ?? null;
  const selectedEvent = state.events.find((event) => event.eventId === state.selectedEventId) ?? state.events.at(-1) ?? null;
  const connectionColor = noColor ? undefined : connectionTone(state.connection);

  return (
    <Box flexDirection="column" paddingX={1} width={width} height={height} overflow="hidden">
      <Box borderStyle={ascii ? "classic" : "round"} paddingX={1} justifyContent="space-between" {...borderColorProp(connectionColor)}>
        <Text bold {...textColorProp(noColor ? undefined : "cyan")}>SOFTWARE AGENT</Text>
        <Text wrap="truncate">{safe(state.snapshot?.projectName ?? "Loading workspace", 42)} @ {safe(state.snapshot?.branch ?? "unknown", 24)}</Text>
        <Text>{run?.state ?? "NO ACTIVE RUN"}</Text>
      </Box>
      <ConnectionBanner state={state} noColor={noColor}/>
      {run === null ? (
        <Box flexDirection="column" borderStyle={ascii ? "classic" : "single"} paddingX={1} marginTop={1}>
          <Text bold>No active run</Text>
          <Text>{interactive ? "Press c and enter an objective. Software Agent will wait for committed controller state." : "This snapshot contains no active run."}</Text>
        </Box>
      ) : (
        <>
          <Box justifyContent="space-between" marginTop={1}>
            <Text bold>AGENTS</Text>
            <Text dimColor>{safe(run.objective, Math.max(30, width - 20))}</Text>
          </Box>
          {layout === "narrow" ? (
            <CompactAgentList agents={agents} selectedAgentId={state.selectedAgentId} focused={state.focus === "agents"} noColor={noColor} ascii={ascii}/>
          ) : (
            <Box flexDirection="row" flexWrap="wrap" gap={1}>
              {agents.map((agent) => (
                <AgentCard
                  key={agent.id}
                  agent={agent}
                  width={cardWidth}
                  selected={agent.id === state.selectedAgentId && state.focus === "agents"}
                  now={state.now}
                  noColor={noColor}
                  ascii={ascii}
                />
              ))}
            </Box>
          )}
          {layout === "narrow" ? (
            <Box marginTop={1} flexDirection="column">
              {state.focus === "events" ? (
                <EventPanel events={state.events} selectedEventId={state.selectedEventId} focused follow={state.followEvents} width={undefined} noColor={noColor} ascii={ascii}/>
              ) : null}
              {state.focus === "agents" ? <DetailPanel agent={selectedAgent} event={selectedEvent} focus={state.focus} width={undefined} noColor={noColor} ascii={ascii}/> : null}
              {state.focus === "approvals" ? (
                <ApprovalPanel approvals={state.snapshot?.approvals ?? []} selected={selectedApproval} focused readOnly={state.snapshot?.controller.mode === "READ_ONLY"} width={undefined} noColor={noColor} ascii={ascii}/>
              ) : null}
              {state.focus === "tokens" ? <TokenPanel usage={run.tokens} costUsd={run.costUsd} budget={run.tokenBudget} focused width={undefined} noColor={noColor} ascii={ascii}/> : null}
            </Box>
          ) : (
            <>
              <Box flexDirection="row" gap={1} marginTop={1}>
                <EventPanel events={state.events} selectedEventId={state.selectedEventId} focused={state.focus === "events"} follow={state.followEvents} width="54%" noColor={noColor} ascii={ascii}/>
                <DetailPanel agent={selectedAgent} event={selectedEvent} focus={state.focus} width="46%" noColor={noColor} ascii={ascii}/>
              </Box>
              <Box flexDirection="row" gap={1} marginTop={1}>
                <ApprovalPanel approvals={state.snapshot?.approvals ?? []} selected={selectedApproval} focused={state.focus === "approvals"} readOnly={state.snapshot?.controller.mode === "READ_ONLY"} width="58%" noColor={noColor} ascii={ascii}/>
                <TokenPanel usage={run.tokens} costUsd={run.costUsd} budget={run.tokenBudget} focused={state.focus === "tokens"} width="42%" noColor={noColor} ascii={ascii}/>
              </Box>
            </>
          )}
        </>
      )}
      {interactive ? <ComposerLine state={state} noColor={noColor} ascii={ascii}/> : null}
      {state.notice === null ? null : <Text {...textColorProp(noColor ? undefined : "yellow")}>{safe(state.notice, Math.max(20, width - 2))}</Text>}
      {interactive ? <Overlay state={state} noColor={noColor} ascii={ascii}/> : null}
      {interactive ? <Footer state={state}/> : <Text dimColor>Snapshot view; keyboard controls are not attached.</Text>}
    </Box>
  );
}

export function renderProjectRoomText(state: ProjectRoomState, options: ProjectRoomRenderOptions): string {
  const {width, height} = options;
  const ascii = options.ascii ?? false;
  const interactive = options.interactive ?? true;
  const run = state.snapshot?.run ?? null;
  const access = state.snapshot?.controller.mode ?? "READ_ONLY";
  const status = [state.connection.toUpperCase(), access, state.stale ? "STALE" : null, `cursor ${state.cursor}`].filter((value) => value !== null).join(" | ");
  const lines = [
    clip(`SOFTWARE AGENT | ${state.snapshot?.projectName ?? "Loading workspace"} @ ${state.snapshot?.branch ?? "unknown"} | ${run?.state ?? "NO ACTIVE RUN"}`, width, ascii),
    clip(`[${status}]${state.connectionMessage === null ? "" : ` ${state.connectionMessage}`}`, width, ascii),
    "-".repeat(Math.max(1, Math.min(width, 120))),
  ];
  if (run === null) {
    lines.push("No active run.", interactive ? "Press c to compose a new objective; no work is simulated before committed controller events." : "This snapshot contains no active run.");
  } else {
    lines.push(clip(`Objective: ${run.objective}`, width, ascii), "AGENTS");
    const columnCount = projectRoomLayout(width, height) === "three-card" ? 3 : projectRoomLayout(width, height) === "two-card" ? 2 : 1;
    lines.push(...agentTextGrid(run.agents, columnCount, width, state, ascii));
    lines.push("TASKS");
    for (const task of run.tasks.slice(0, 5)) lines.push(clip(` ${glyph(task.state, ascii)} [${task.state}] ${task.title}`, width, ascii));
    lines.push("EVENTS");
    for (const event of state.events.slice(-4).reverse()) {
      const marker = event.eventId === state.selectedEventId ? ">" : " ";
      lines.push(clip(`${marker}${event.sequence.toString().padStart(5, "0")} ${event.severity} ${event.summary}`, width, ascii));
    }
    lines.push(`APPROVALS${access === "READ_ONLY" ? " [READ-ONLY]" : ""}`);
    if ((state.snapshot?.approvals.length ?? 0) === 0) lines.push(" No pending approvals.");
    for (const approval of state.snapshot?.approvals.slice(0, 3) ?? []) lines.push(clip(` ${glyph(approval.status, ascii)} ${approval.id} ${approval.risk} ${approval.title}`, width, ascii));
    lines.push("TOKENS & COST");
    lines.push(clip(` ${formatUsage(run.tokens)} | ${formatCost(run.costUsd)} | budget ${run.tokenBudget.used}/${formatToken(run.tokenBudget.limit)}`, width, ascii));
  }
  if (interactive) lines.push(clip(`COMPOSER [to: ${targetLabel(state.composerTarget)}] > ${state.overlay.kind === "composer" ? state.composerText : "press c"}`, width, ascii));
  if (state.notice !== null) lines.push(clip(`NOTICE: ${state.notice}`, width, ascii));
  if (interactive) {
    lines.push(...renderOverlayText(state, width, ascii));
    const footer = projectRoomLayout(width, height) === "plain" ? plainFooterText(state) : footerText(state);
    lines.push(clip(footer, width, ascii));
  } else {
    lines.push("Snapshot view; keyboard controls are not attached.");
  }
  return lines.join("\n");
}

export async function openProjectRoom(source: ProjectRoomSource, options: OpenProjectRoomOptions = {}): Promise<void> {
  const width = options.width ?? (process.stdout.columns || 100);
  const height = options.height ?? (process.stdout.rows || 24);
  const ascii = options.ascii ?? process.env.TERM === "dumb";
  const noColor = options.noColor === true || process.env.NO_COLOR !== undefined;
  if (!process.stdout.isTTY || options.width !== undefined || options.height !== undefined) {
    const abort = new AbortController();
    const snapshot = await source.load(abort.signal);
    const state = projectRoomReducer(createInitialProjectRoomState({width, height}), {type: "snapshot.received", snapshot});
    process.stdout.write(`${renderProjectRoomText(state, {width, height, ascii: true, noColor: true})}\n`);
    return;
  }
  const instance = render(
    <ProjectRoom
      source={source}
      noColor={noColor}
      ascii={ascii}
      {...(options.staleAfterMs === undefined ? {} : {staleAfterMs: options.staleAfterMs})}
    />,
    {exitOnCtrlC: false, maxFps: 20, incrementalRendering: true},
  );
  await instance.waitUntilExit();
}

async function pumpProjectRoom(
  source: ProjectRoomSource,
  dispatch: React.Dispatch<Parameters<typeof projectRoomReducer>[1]>,
  signal: AbortSignal,
): Promise<void> {
  let cursor = 0;
  let connected = false;
  let failures = 0;
  while (!isAborted(signal)) {
    try {
      dispatch({type: "connection.connecting"});
      const snapshot = await source.load(signal);
      if (isAborted(signal)) return;
      cursor = snapshot.cursor;
      dispatch({type: "snapshot.received", snapshot});
      connected = true;
      failures = 0;
      while (!isAborted(signal)) {
        const update = await source.nextCommitted(cursor, signal);
        if (isAborted(signal)) return;
        dispatch({type: "events.received", update});
        if (!isContiguousUpdate(cursor, update)) break;
        cursor = update.cursor;
      }
    } catch (error: unknown) {
      if (isAborted(signal)) return;
      failures += 1;
      const message = errorMessage(error);
      dispatch(failures >= 3 ? {type: "connection.error", message} : {type: "connection.lost", message});
      await abortableDelay(Math.min(2_000, 200 * 2 ** Math.min(failures, 4)), signal);
      if (connected) dispatch({type: "connection.connecting"});
    }
  }
}

function ConnectionBanner({state, noColor}: {readonly state: ProjectRoomState; readonly noColor: boolean}): React.JSX.Element {
  const access = state.snapshot?.controller.mode ?? "READ_ONLY";
  const values = [state.connection.toUpperCase(), access, state.stale ? "STALE" : null, `cursor ${state.cursor}`].filter((value) => value !== null);
  return (
    <Box justifyContent="space-between">
      <Text {...textColorProp(noColor ? undefined : connectionTone(state.connection))}>{values.join(" | ")}</Text>
      <Text wrap="truncate">{state.connectionMessage ?? "Committed-event projection"}</Text>
    </Box>
  );
}

function AgentCard({agent, width, selected, now, noColor, ascii}: {
  readonly agent: ProjectRoomAgent;
  readonly width: number;
  readonly selected: boolean;
  readonly now: number;
  readonly noColor: boolean;
  readonly ascii: boolean;
}): React.JSX.Element {
  return (
    <Box flexDirection="column" width={width} borderStyle={ascii ? "classic" : "single"} paddingX={1} {...borderColorProp(noColor ? undefined : selected ? "magenta" : stateTone(agent.state))}>
      <Text bold inverse={selected}>{glyph(agent.state, ascii)} {safe(agent.displayName, Math.max(12, width - 6))}</Text>
      <Text>{agent.state} | {safe(agent.role, Math.max(12, width - 12))}</Text>
      <Text wrap="truncate">Task: {safe(agent.taskTitle, Math.max(12, width - 8))}</Text>
      <Text wrap="truncate">Now: {safe(agent.activity, Math.max(12, width - 7))}</Text>
      <Text>{safe(`${agent.provider}/${agent.model}`, Math.max(12, width - 2))}</Text>
      <Text>{formatUsage(agent.tokens)} | {formatCost(agent.costUsd)}</Text>
      <Text dimColor>active {formatAge(agent.activitySince, now)} | event {formatAge(agent.lastEventAt, now)}</Text>
      {agent.blocker === null ? null : <Text {...textColorProp(noColor ? undefined : "yellow")}>Blocked: {safe(agent.blocker, Math.max(12, width - 11))}</Text>}
      {agent.approvalId === null ? null : <Text {...textColorProp(noColor ? undefined : "yellow")}>Approval: {safe(agent.approvalId, Math.max(12, width - 12))}</Text>}
      <Text dimColor>files {agent.requestedFiles.length} | tools {agent.requestedTools.length} | evidence {agent.evidence.length}</Text>
    </Box>
  );
}

function CompactAgentList({agents, selectedAgentId, focused, noColor, ascii}: {
  readonly agents: readonly ProjectRoomAgent[];
  readonly selectedAgentId: string | null;
  readonly focused: boolean;
  readonly noColor: boolean;
  readonly ascii: boolean;
}): React.JSX.Element {
  return (
    <Box flexDirection="column" borderStyle={ascii ? "classic" : "single"} paddingX={1} {...borderColorProp(noColor ? undefined : focused ? "magenta" : undefined)}>
      {agents.length === 0 ? <Text dimColor>No active agent sessions.</Text> : agents.map((agent) => (
        <Text key={agent.id} inverse={focused && agent.id === selectedAgentId} wrap="truncate">
          {glyph(agent.state, ascii)} {agent.displayName} [{agent.state}] | {safe(agent.taskTitle, 24)} | {safe(agent.activity, 28)}{agent.approvalId === null ? "" : ` | approval ${safe(agent.approvalId, 18)}`}
        </Text>
      ))}
    </Box>
  );
}

function EventPanel({events, selectedEventId, focused, follow, width, noColor, ascii}: {
  readonly events: readonly ProjectRoomEvent[];
  readonly selectedEventId: string | null;
  readonly focused: boolean;
  readonly follow: boolean;
  readonly width: number | string | undefined;
  readonly noColor: boolean;
  readonly ascii: boolean;
}): React.JSX.Element {
  return (
    <Box flexDirection="column" borderStyle={ascii ? "classic" : "single"} paddingX={1} {...widthProp(width)} {...borderColorProp(noColor ? undefined : focused ? "magenta" : undefined)}>
      <Box justifyContent="space-between"><Text bold>EVENTS</Text><Text>{follow ? "FOLLOW" : "PAUSED"}</Text></Box>
      {events.length === 0 ? <Text dimColor>No committed events yet.</Text> : events.slice(-5).reverse().map((event) => (
        <Text key={event.eventId} inverse={event.eventId === selectedEventId} wrap="truncate">
          {glyph(event.severity, ascii)} {event.sequence.toString().padStart(5, "0")} {safe(event.summary, 90)}
        </Text>
      ))}
    </Box>
  );
}

function DetailPanel({agent, event, focus, width, noColor, ascii}: {
  readonly agent: ProjectRoomAgent | null;
  readonly event: ProjectRoomEvent | null;
  readonly focus: ProjectRoomFocus;
  readonly width: number | string | undefined;
  readonly noColor: boolean;
  readonly ascii: boolean;
}): React.JSX.Element {
  return (
    <Box flexDirection="column" borderStyle={ascii ? "classic" : "single"} paddingX={1} {...widthProp(width)} {...borderColorProp(noColor ? undefined : "blue")}>
      <Text bold>DETAIL</Text>
      {focus === "events" && event !== null ? (
        <>
          <Text>{event.type} #{event.sequence}</Text>
          <Text wrap="truncate">{safe(event.summary, 120)}</Text>
          <Text dimColor>{event.occurredAt}</Text>
        </>
      ) : agent === null ? <Text dimColor>Select an agent or event.</Text> : (
        <>
          <Text>{agent.displayName} | {agent.taskId}</Text>
          <Text wrap="truncate">{agent.activity}</Text>
          <Text wrap="truncate">Files: {agent.requestedFiles.join(", ") || "none"}</Text>
          <Text wrap="truncate">Tools: {agent.requestedTools.join(", ") || "none"}</Text>
          <Text wrap="truncate">Evidence: {agent.evidence.join(", ") || "none"}</Text>
          <Text wrap="truncate">Blocker: {agent.blocker ?? "none"} | Approval: {agent.approvalId ?? "none"}</Text>
        </>
      )}
    </Box>
  );
}

function ApprovalPanel({approvals, selected, focused, readOnly, width, noColor, ascii}: {
  readonly approvals: readonly ProjectRoomApproval[];
  readonly selected: ProjectRoomApproval | null;
  readonly focused: boolean;
  readonly readOnly: boolean;
  readonly width: number | string | undefined;
  readonly noColor: boolean;
  readonly ascii: boolean;
}): React.JSX.Element {
  return (
    <Box flexDirection="column" borderStyle={ascii ? "classic" : "single"} paddingX={1} {...widthProp(width)} {...borderColorProp(noColor ? undefined : focused ? "magenta" : "yellow")}>
      <Box justifyContent="space-between"><Text bold>APPROVALS</Text><Text>{readOnly ? "READ-ONLY" : `${approvals.length} OPEN`}</Text></Box>
      {selected === null ? <Text dimColor>No approval packets.</Text> : (
        <>
          <Text inverse={focused}>{glyph(selected.status, ascii)} {selected.id} | {selected.risk}</Text>
          <Text wrap="truncate">{safe(selected.title, 100)}</Text>
          <Text dimColor>Enter opens the exact packet; no direct approval shortcut.</Text>
        </>
      )}
    </Box>
  );
}

function TokenPanel({usage, costUsd, budget, focused, width, noColor, ascii}: {
  readonly usage: ProjectRoomTokenUsage;
  readonly costUsd: number | "UNKNOWN";
  readonly budget: {readonly used: number; readonly limit: number | "UNKNOWN"};
  readonly focused: boolean;
  readonly width: number | string | undefined;
  readonly noColor: boolean;
  readonly ascii: boolean;
}): React.JSX.Element {
  return (
    <Box flexDirection="column" borderStyle={ascii ? "classic" : "single"} paddingX={1} {...widthProp(width)} {...borderColorProp(noColor ? undefined : focused ? "magenta" : "cyan")}>
      <Text bold>TOKENS & COST</Text>
      <Text>{formatUsage(usage)}</Text>
      <Text>{formatCost(costUsd)}</Text>
      <Text>Budget {budget.used}/{formatToken(budget.limit)}</Text>
    </Box>
  );
}

function ComposerLine({state, noColor, ascii}: {readonly state: ProjectRoomState; readonly noColor: boolean; readonly ascii: boolean}): React.JSX.Element {
  const active = state.overlay.kind === "composer";
  return (
    <Box borderStyle={ascii ? "classic" : "single"} paddingX={1} marginTop={1} {...borderColorProp(noColor ? undefined : active ? "magenta" : undefined)}>
      <Text bold>COMPOSER </Text>
      <Text>[to: {targetLabel(state.composerTarget)}] </Text>
      <Text inverse={active}>{active ? state.composerText || " " : "press c"}</Text>
      {active ? <Text dimColor>  Tab target | Enter submit | Esc close</Text> : null}
    </Box>
  );
}

function Overlay({state, noColor, ascii}: {readonly state: ProjectRoomState; readonly noColor: boolean; readonly ascii: boolean}): React.JSX.Element | null {
  const overlay = state.overlay;
  if (overlay.kind === "none" || overlay.kind === "composer") return null;
  const borderColor = noColor ? undefined : "magenta";
  if (overlay.kind === "help") return (
    <Box flexDirection="column" borderStyle={ascii ? "classic" : "double"} paddingX={1} {...borderColorProp(borderColor)}>
      <Text bold>SOFTWARE AGENT HELP</Text>
      <Text>1 Agents | 2 Events | 3 Approvals | 4 Tokens | Tab focus | j/k move</Text>
      <Text>c Compose | / Search | Ctrl+K Palette | f Follow | q or Ctrl+C Leave | ? Close</Text>
      <Text>Approval: Enter detail, then a approve / d deny / r request changes, then Enter confirms.</Text>
    </Box>
  );
  if (overlay.kind === "search") return <OverlayBox title="SEARCH COMMITTED EVENTS" value={overlay.query} hint="Enter select | Esc close" color={borderColor} ascii={ascii}/>;
  if (overlay.kind === "palette") {
    const actions = filteredPaletteActions(overlay.query);
    return (
      <Box flexDirection="column" borderStyle={ascii ? "classic" : "double"} paddingX={1} {...borderColorProp(borderColor)}>
        <Text bold>SOFTWARE AGENT COMMAND PALETTE</Text>
        <Text>Query: {overlay.query || " "}</Text>
        {actions.slice(0, 6).map((action, index) => <Text key={action} inverse={index === overlay.selected}>{index === overlay.selected ? ">" : " "} {action}</Text>)}
        {actions.length === 0 ? <Text>No implemented command matches.</Text> : null}
      </Box>
    );
  }
  if (overlay.kind === "target") {
    const candidates = targetCandidates(state.snapshot);
    return (
      <Box flexDirection="column" borderStyle={ascii ? "classic" : "double"} paddingX={1} {...borderColorProp(borderColor)}>
        <Text bold>SELECT EXPLICIT TARGET</Text>
        {candidates.slice(0, 8).map((target, index) => <Text key={targetKey(target)} inverse={index === overlay.selected}>{index === overlay.selected ? ">" : " "} {targetLabel(target)}</Text>)}
        <Text dimColor>Arrows choose | Enter applies | Esc returns</Text>
      </Box>
    );
  }
  if (overlay.kind === "leave") return (
    <Box flexDirection="column" borderStyle={ascii ? "classic" : "double"} paddingX={1} {...borderColorProp(borderColor)}>
      <Text bold>LEAVE SOFTWARE AGENT SESSION</Text>
      <Text>Choose exactly what happens to active work:</Text>
      {(["continue", "pause", "cancel"] as const).map((item) => <Text key={item} inverse={item === overlay.selected}>{item === overlay.selected ? ">" : " "} {item.toUpperCase()}</Text>)}
      <Text dimColor>Arrows choose | Enter sends | Esc returns</Text>
    </Box>
  );
  const approvalId = overlay.approvalId;
  const approval = state.snapshot?.approvals.find((candidate) => candidate.id === approvalId) ?? null;
  if (approval === null) return <OverlayBox title="APPROVAL UNAVAILABLE" value={approvalId} hint="Esc close" color={borderColor} ascii={ascii}/>;
  if (overlay.kind === "approval-confirm") return (
    <Box flexDirection="column" borderStyle={ascii ? "classic" : "double"} paddingX={1} {...borderColorProp(noColor ? undefined : "red")}>
      <Text bold>CONFIRM {overlay.decision}</Text>
      <Text>{approval.id} | {approval.risk}</Text>
      <Text wrap="truncate">Exact action: {approval.exactPreview}</Text>
      <Text>Enter confirms this exact decision; Esc returns without changing state.</Text>
    </Box>
  );
  return (
    <Box flexDirection="column" borderStyle={ascii ? "classic" : "double"} paddingX={1} {...borderColorProp(borderColor)}>
      <Text bold>APPROVAL DETAIL</Text>
      <Text>{glyph(approval.status, ascii)} {approval.id} | {approval.status} | {approval.risk}</Text>
      <Text>Title: {approval.title}</Text>
      <Text>Purpose: {approval.purpose}</Text>
      <Text>Action: {approval.action}</Text>
      <Text>Resource: {approval.resource}</Text>
      <Text wrap="truncate">Exact preview: {approval.exactPreview}</Text>
      <Text wrap="truncate">Impact: {approval.impact}</Text>
      <Text>Expires: {approval.expiresAt} | Evidence: {approval.evidence.join(", ") || "none"}</Text>
      <Text>{state.snapshot?.controller.mode === "READ_ONLY" ? "READ-ONLY: decisions disabled" : "a Approve | d Deny | r Request changes"} | Esc close</Text>
    </Box>
  );
}

function OverlayBox({title, value, hint, color, ascii}: {readonly title: string; readonly value: string; readonly hint: string; readonly color: string | undefined; readonly ascii: boolean}): React.JSX.Element {
  return (
    <Box flexDirection="column" borderStyle={ascii ? "classic" : "double"} paddingX={1} {...borderColorProp(color)}>
      <Text bold>{title}</Text><Text>{value || " "}</Text><Text dimColor>{hint}</Text>
    </Box>
  );
}

function Footer({state}: {readonly state: ProjectRoomState}): React.JSX.Element {
  return <Text dimColor>{state.width < 90 ? plainFooterText(state) : footerText(state)}</Text>;
}

function footerText(state: ProjectRoomState): string {
  if (state.overlay.kind === "composer") return "Composer: type | Tab target | Enter submit | Esc close";
  if (state.overlay.kind !== "none") return "Overlay: arrows move | Enter confirm | Esc close";
  return "1 Agents  2 Events  3 Approvals  4 Tokens  Tab Focus  c Compose  / Search  Ctrl+K Palette  f Follow  ? Help  q Leave";
}

function plainFooterText(state: ProjectRoomState): string {
  if (state.overlay.kind === "composer") return "Type | Tab Target | Enter Submit | Esc Close";
  if (state.overlay.kind !== "none") return "Arrows Move | Enter Confirm | Esc Close";
  return "c Compose | Tab Focus | ? Help | q Leave";
}

function renderOverlayText(state: ProjectRoomState, width: number, ascii: boolean): readonly string[] {
  const overlay = state.overlay;
  if (overlay.kind === "none" || overlay.kind === "composer") return [];
  if (overlay.kind === "help") return ["SOFTWARE AGENT HELP", "1-4 focus | Tab cycle | j/k move | c compose | / search | Ctrl+K palette | f follow | q leave | Esc close"];
  if (overlay.kind === "search") return [`SEARCH COMMITTED EVENTS > ${clip(overlay.query, Math.max(10, width - 28), ascii)}`];
  if (overlay.kind === "palette") return ["SOFTWARE AGENT COMMAND PALETTE", ...filteredPaletteActions(overlay.query).slice(0, 6).map((action, index) => `${index === overlay.selected ? ">" : " "} ${action}`)];
  if (overlay.kind === "target") return ["SELECT EXPLICIT TARGET", ...targetCandidates(state.snapshot).slice(0, 8).map((target, index) => `${index === overlay.selected ? ">" : " "} ${targetLabel(target)}`)];
  if (overlay.kind === "leave") return ["LEAVE SOFTWARE AGENT SESSION", ...(["continue", "pause", "cancel"] as const).map((item) => `${item === overlay.selected ? ">" : " "} ${item.toUpperCase()}`)];
  const approval = state.snapshot?.approvals.find((candidate) => candidate.id === overlay.approvalId);
  if (approval === undefined) return ["APPROVAL UNAVAILABLE"];
  if (overlay.kind === "approval-confirm") return [`CONFIRM ${overlay.decision}`, clip(`Exact action: ${approval.exactPreview}`, width, ascii), "Enter confirms | Esc returns"];
  return [
    "APPROVAL DETAIL",
    clip(`${glyph(approval.status, ascii)} ${approval.id} | ${approval.status} | ${approval.risk}`, width, ascii),
    clip(`Purpose: ${approval.purpose}`, width, ascii),
    clip(`Exact preview: ${approval.exactPreview}`, width, ascii),
    clip(`Impact: ${approval.impact}`, width, ascii),
    state.snapshot?.controller.mode === "READ_ONLY" ? "READ-ONLY: decisions disabled" : "a Approve | d Deny | r Request changes",
  ];
}

function agentTextGrid(agents: readonly ProjectRoomAgent[], columns: number, width: number, state: ProjectRoomState, ascii: boolean): readonly string[] {
  if (agents.length === 0) return [" No active agent sessions."];
  const visible = visibleAgents(agents, state.selectedAgentId, columns);
  const gap = " | ";
  const columnWidth = Math.max(20, Math.floor((width - gap.length * (columns - 1)) / columns));
  const cards = visible.map((agent) => [
    `${agent.id === state.selectedAgentId ? ">" : " "}${glyph(agent.state, ascii)} ${agent.displayName} [${agent.state}]`,
    ` ${agent.taskTitle}`,
    ` ${agent.activity}`,
    ` ${agent.provider}/${agent.model}`,
    ` ${formatUsage(agent.tokens)} | ${formatCost(agent.costUsd)}`,
    ` active ${formatAge(agent.activitySince, state.now)} | event ${formatAge(agent.lastEventAt, state.now)}`,
  ].map((line) => pad(clip(line, columnWidth, ascii), columnWidth)));
  const rows: string[] = [];
  const rowCount = Math.max(...cards.map((card) => card.length));
  for (let index = 0; index < rowCount; index += 1) rows.push(cards.map((card) => card[index] ?? " ".repeat(columnWidth)).join(gap).trimEnd());
  return rows;
}

function visibleAgents(agents: readonly ProjectRoomAgent[], selectedId: string | null, limit: number): readonly ProjectRoomAgent[] {
  if (agents.length <= limit) return agents;
  const index = Math.max(0, agents.findIndex((agent) => agent.id === selectedId));
  const start = Math.min(index, Math.max(0, agents.length - limit));
  return agents.slice(start, start + limit);
}

function targetLabel(target: ComposerTarget): string {
  return target.kind === "objective" ? target.label : `${target.kind}:${target.label}`;
}

function targetKey(target: ComposerTarget): string {
  return target.kind === "objective" ? "objective" : `${target.kind}:${target.id}`;
}

function glyph(state: string, ascii: boolean): string {
  if (/SUCCEEDED|PASSED|COMPLETE|APPROVED/u.test(state)) return ascii ? "[OK]" : "✓";
  if (/FAILED|CANCELED|DENIED|CRITICAL|ERROR/u.test(state)) return ascii ? "[X]" : "✕";
  if (/WAITING|BLOCKED|PAUSED|WARN/u.test(state)) return ascii ? "[!]" : "◆";
  if (/RUNNING|CLAIMED|PLANNING|INFO/u.test(state)) return ascii ? "[>]" : "●";
  return ascii ? "[ ]" : "○";
}

function formatUsage(usage: ProjectRoomTokenUsage): string {
  return `in ${formatToken(usage.input)} out ${formatToken(usage.output)} cached ${formatToken(usage.cached)} reason ${formatToken(usage.reasoning)}`;
}

function formatToken(value: number | "UNKNOWN"): string {
  return value === "UNKNOWN" ? "UNKNOWN" : value.toLocaleString("en-US");
}

function formatCost(value: number | "UNKNOWN"): string {
  return value === "UNKNOWN" ? "cost UNKNOWN" : `$${value.toFixed(4)} USD`;
}

function formatAge(timestamp: string | null, now: number): string {
  if (timestamp === null) return "UNKNOWN";
  const value = Date.parse(timestamp);
  if (!Number.isFinite(value)) return "UNKNOWN";
  const seconds = Math.max(0, Math.floor((now - value) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h`;
}

function clip(value: string, width: number, ascii: boolean): string {
  const clean = safe(value, Math.max(1, width * 4));
  if (clean.length <= width) return clean;
  const ending = ascii ? "..." : "…";
  return `${clean.slice(0, Math.max(1, width - ending.length))}${ending}`;
}

function safe(value: string, limit: number): string {
  return sanitizeTerminal(value, Math.max(1, limit)).replaceAll("\n", " ");
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : `${value}${" ".repeat(width - value.length)}`;
}

function stateTone(state: string): "green" | "red" | "yellow" | "cyan" | undefined {
  if (/SUCCEEDED|PASSED|COMPLETE/u.test(state)) return "green";
  if (/FAILED|CANCELED|DENIED/u.test(state)) return "red";
  if (/WAITING|BLOCKED|PAUSED/u.test(state)) return "yellow";
  if (/RUNNING|CLAIMED|PLANNING/u.test(state)) return "cyan";
  return undefined;
}

function connectionTone(connection: ProjectRoomState["connection"]): "green" | "red" | "yellow" | "cyan" {
  if (connection === "connected") return "green";
  if (connection === "error") return "red";
  if (connection === "reconnecting" || connection === "resyncing") return "yellow";
  return "cyan";
}

function borderColorProp(color: string | undefined): {readonly borderColor?: string} {
  return color === undefined ? {} : {borderColor: color};
}

function textColorProp(color: string | undefined): {readonly color?: string} {
  return color === undefined ? {} : {color};
}

function widthProp(width: number | string | undefined): {readonly width?: number | string} {
  return width === undefined ? {} : {width};
}

function inkKey(key: Key): ProjectRoomKey {
  return {
    upArrow: key.upArrow,
    downArrow: key.downArrow,
    leftArrow: key.leftArrow,
    rightArrow: key.rightArrow,
    pageDown: key.pageDown,
    pageUp: key.pageUp,
    home: key.home,
    end: key.end,
    return: key.return,
    escape: key.escape,
    ctrl: key.ctrl,
    shift: key.shift,
    tab: key.tab,
    backspace: key.backspace,
    delete: key.delete,
    meta: key.meta,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, {once: true});
  });
}

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}
