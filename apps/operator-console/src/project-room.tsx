import React, {useEffect, useReducer, useRef} from "react";
import {Box, Text, render, useApp, useInput, useStdout} from "ink";
import type {Key} from "ink";

import {sanitizeTerminal} from "../../../packages/observability/src/index.js";
import {
  createInitialProjectRoomState,
  filteredPaletteActions,
  isContiguousUpdate,
  pendingVoiceReplyEvent,
  projectRoomInput,
  projectRoomReducer,
  slashCommandSuggestions,
  slashMenuVisible,
  targetCandidates,
  type SlashCommandSuggestion,
  type ComposerTarget,
  type LeaveDisposition,
  type ProjectRoomAgent,
  type ProjectRoomApproval,
  type ProjectRoomCommand,
  type ProjectRoomCommittedUpdate,
  type ProjectRoomEvent,
  type ProjectRoomFocus,
  type ProjectRoomKey,
  type ProjectRoomRun,
  type ProjectRoomRosterAgent,
  type ProjectRoomSnapshot,
  type ProjectRoomState,
  type ProjectRoomTask,
  type ProjectRoomTokenUsage,
} from "./project-room-state.js";
import type {VoiceAssistant, VoiceRecordingSession} from "../../../packages/voice-input/src/index.js";

export type ProjectRoomLayout = "plain" | "narrow" | "two-card" | "three-card";

export interface ProjectRoomSource {
  /** Loads an authoritative projection and its committed-event cursor. */
  readonly load: (signal: AbortSignal) => Promise<ProjectRoomSnapshot>;
  /** Waits for the next bounded committed-event batch after `cursor`. */
  readonly nextCommitted: (cursor: number, signal: AbortSignal) => Promise<ProjectRoomCommittedUpdate>;
  /** Sends a typed intent; the UI changes authority state only after a later committed update. */
  readonly execute: (command: ProjectRoomCommand, signal: AbortSignal) => Promise<ProjectRoomCommandResult | undefined>;
  /** Optional local push-to-talk and spoken-reply capability. Never crosses controller IPC. */
  readonly voice?: VoiceAssistant;
}

export interface ProjectRoomCommandResult {
  readonly message?: string;
  /** Exact task whose committed turn completion is the reply to this command. */
  readonly replyTaskId?: string;
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

export function terminalLogoText(ascii = false, compact = false): string {
  if (ascii) return compact ? ">_ SA [OK]" : ">_ o-o-o [OK] SOFTWARE AGENT";
  return compact ? "❯_ SA ✓" : "❯_ ●─●─● ✓ SOFTWARE AGENT";
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
  const voiceStart = useRef<{readonly id: number; readonly abort: AbortController} | null>(null);
  const voiceSession = useRef<{readonly id: number; readonly session: VoiceRecordingSession} | null>(null);
  const voiceFinish = useRef<{readonly id: number; readonly abort: AbortController} | null>(null);
  const spokenReply = useRef<{readonly eventId: string; readonly abort: AbortController} | null>(null);

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
    void source.execute(pending.command, abort.signal).then(async (result) => {
      let refreshError: unknown;
      if (pending.command.type !== "session.leave") {
        try {
          const snapshot = await source.load(abort.signal);
          if (!abort.signal.aborted) dispatch({type: "snapshot.received", snapshot});
        } catch (error) {
          refreshError = error;
        }
      }
      if (abort.signal.aborted) return;
      dispatch({
        type: "command.succeeded",
        id: pending.id,
        ...(result?.message === undefined ? {} : {message: result.message}),
        ...(result?.replyTaskId === undefined ? {} : {replyTaskId: result.replyTaskId}),
      });
      if (refreshError !== undefined) dispatch({type: "connection.lost", message: `Command committed; refresh failed: ${errorMessage(refreshError)}`});
      if (pending.command.type === "session.leave") {
        onLeave?.(pending.command.disposition);
        exit();
      }
    }).catch((error: unknown) => {
      if (!abort.signal.aborted) dispatch({type: "command.failed", id: pending.id, message: errorMessage(error)});
    });
    return () => { abort.abort(); };
  }, [exit, onLeave, source, state.pendingCommand]);

  useEffect(() => {
    const overlay = state.overlay;
    if (overlay.kind !== "voice") return;
    const voice = source.voice;
    if (overlay.phase === "starting" && voiceStart.current?.id !== overlay.sessionId && voiceSession.current?.id !== overlay.sessionId) {
      if (voice === undefined) {
        dispatch({type: "voice.failed", sessionId: overlay.sessionId, message: "This Software Agent build has no voice input service."});
        return;
      }
      const abort = new AbortController();
      voiceStart.current = {id: overlay.sessionId, abort};
      void voice.start(abort.signal).then(async (session) => {
        if (abort.signal.aborted) {
          await session.cancel().catch(() => undefined);
          return;
        }
        voiceSession.current = {id: overlay.sessionId, session};
        dispatch({
          type: "voice.started",
          sessionId: overlay.sessionId,
          deviceName: session.deviceName,
          startedAt: session.startedAt,
          maxDurationMs: session.maxDurationMs,
        });
      }).catch((error: unknown) => {
        if (!abort.signal.aborted) dispatch({type: "voice.failed", sessionId: overlay.sessionId, message: errorMessage(error)});
      }).finally(() => {
        if (voiceStart.current?.id === overlay.sessionId) voiceStart.current = null;
      });
      return;
    }
    if (overlay.phase === "transcribing" && voiceFinish.current?.id !== overlay.sessionId) {
      const active = voiceSession.current;
      if (active?.id !== overlay.sessionId) return;
      const abort = new AbortController();
      voiceFinish.current = {id: overlay.sessionId, abort};
      void active.session.stopAndTranscribe(abort.signal).then((transcript) => {
        if (!abort.signal.aborted) dispatch({type: "voice.transcribed", sessionId: overlay.sessionId, text: transcript.text});
      }).catch((error: unknown) => {
        if (!abort.signal.aborted) dispatch({type: "voice.failed", sessionId: overlay.sessionId, message: errorMessage(error)});
      }).finally(() => {
        if (voiceSession.current?.id === overlay.sessionId) voiceSession.current = null;
        if (voiceFinish.current?.id === overlay.sessionId) voiceFinish.current = null;
      });
      return;
    }
    if (overlay.phase === "cancelling") {
      if (voiceStart.current?.id === overlay.sessionId) voiceStart.current.abort.abort();
      if (voiceFinish.current?.id === overlay.sessionId) voiceFinish.current.abort.abort();
      const active = voiceSession.current?.id === overlay.sessionId ? voiceSession.current : null;
      if (active !== null) voiceSession.current = null;
      void (active?.session.cancel() ?? Promise.resolve()).catch(() => undefined).finally(() => {
        dispatch({type: "voice.canceled", sessionId: overlay.sessionId});
      });
    }
  }, [source.voice, state.overlay]);

  useEffect(() => {
    const reply = pendingVoiceReplyEvent(state);
    const voice = source.voice;
    if (reply === null || voice === undefined || spokenReply.current !== null) return;
    const abort = new AbortController();
    spokenReply.current = {eventId: reply.eventId, abort};
    dispatch({type: "voice.reply.started", eventId: reply.eventId});
    void voice.speak(spokenReplyText(state, reply), abort.signal).then(() => {
      if (!abort.signal.aborted) dispatch({type: "voice.reply.succeeded", eventId: reply.eventId});
    }).catch((error: unknown) => {
      if (!abort.signal.aborted) dispatch({type: "voice.reply.failed", eventId: reply.eventId, message: errorMessage(error)});
    }).finally(() => {
      if (spokenReply.current?.eventId === reply.eventId) spokenReply.current = null;
    });
  }, [source.voice, state]);

  useEffect(() => () => {
    voiceStart.current?.abort.abort();
    voiceFinish.current?.abort.abort();
    spokenReply.current?.abort.abort();
    void voiceSession.current?.session.cancel().catch(() => undefined);
  }, []);

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
  const selectedAgent = run?.agents.find((agent) => agent.id === state.selectedAgentId) ?? run?.agents[0] ?? null;
  const selectedApproval = state.snapshot?.approvals.find((approval) => approval.id === state.selectedApprovalId) ?? state.snapshot?.approvals[0] ?? null;
  const selectedEvent = state.events.find((event) => event.eventId === state.selectedEventId) ?? state.events.at(-1) ?? null;
  const connectionColor = noColor ? undefined : connectionTone(state.connection);
  const simple = state.viewMode === "simple";

  return (
    <Box flexDirection="column" paddingX={1} width={width} height={height} overflow="hidden">
      <Box borderStyle={ascii ? "classic" : "round"} paddingX={1} justifyContent="space-between" {...borderColorProp(connectionColor)}>
        <TerminalLogo ascii={ascii} noColor={noColor} compact={layout === "narrow"}/>
        <Text wrap="truncate">{safe(state.snapshot?.projectName ?? "Loading workspace", layout === "narrow" ? 24 : 42)} @ {safe(state.snapshot?.branch ?? "unknown", layout === "narrow" ? 16 : 24)}</Text>
        <Text>{simple ? simpleRunLabel(run) : run?.state ?? "NO ACTIVE RUN"}</Text>
      </Box>
      {simple ? <SimpleConnectionBanner state={state} noColor={noColor}/> : <ConnectionBanner state={state} noColor={noColor}/>}
      {simple ? (
        <SimpleWorkspace state={state} run={run} layout={layout} noColor={noColor} ascii={ascii} interactive={interactive}/>
      ) : layout !== "narrow" ? (
        <>
          {run === null
            ? <Text dimColor>No active run. Type a prompt in CHAT to create one; all specialists remain token-free while waiting.</Text>
            : <RunProgressSummary run={run} width={width} noColor={noColor} ascii={ascii}/>
          }
          <Box flexDirection="row">
            <WorkstreamPanel state={state} run={run} width="50%" noColor={noColor} ascii={ascii}/>
            <AgentWall roster={state.snapshot?.roster ?? []} selectedAgentId={state.selectedAgentId} width="50%" noColor={noColor} ascii={ascii}/>
          </Box>
          <WorkspaceStatusStrip state={state} run={run} noColor={noColor} ascii={ascii}/>
        </>
      ) : run === null ? (
        <Box flexDirection="column" borderStyle={ascii ? "classic" : "single"} paddingX={1} marginTop={1}>
          <Text bold>No active run</Text>
          <Text>{interactive ? "Type an objective, press Ctrl+R to talk to Nova, or press / for commands. All 26 named roles wait without consuming tokens." : "This snapshot contains no active run."}</Text>
          <AgentWall roster={state.snapshot?.roster ?? []} selectedAgentId={state.selectedAgentId} width={undefined} noColor={noColor} ascii={ascii}/>
        </Box>
      ) : (
        <>
          <RunProgressSummary run={run} width={width} noColor={noColor} ascii={ascii}/>
          <CompactAgentList agents={agents} tasks={run.tasks} selectedAgentId={state.selectedAgentId} focused={state.focus === "agents"} noColor={noColor} ascii={ascii}/>
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
  if (state.viewMode === "simple") return renderSimpleProjectRoomText(state, options);
  const {width, height} = options;
  const ascii = options.ascii ?? false;
  const interactive = options.interactive ?? true;
  const run = state.snapshot?.run ?? null;
  const access = state.snapshot?.controller.mode ?? "READ_ONLY";
  const status = [state.connection.toUpperCase(), access, state.stale ? "STALE" : null, `cursor ${state.cursor}`].filter((value) => value !== null).join(" | ");
  const lines = [
    clip(`${terminalLogoText(ascii)} | ${state.snapshot?.projectName ?? "Loading workspace"} @ ${state.snapshot?.branch ?? "unknown"} | ${run?.state ?? "NO ACTIVE RUN"}`, width, ascii),
    clip(`[${status}]${state.connectionMessage === null ? "" : ` ${state.connectionMessage}`}`, width, ascii),
    "-".repeat(Math.max(1, Math.min(width, 120))),
  ];
  if (run === null) {
    lines.push(
      "No active run.",
      "CHAT & WORK",
      interactive ? "YOU > Type a project request, press Ctrl+R for Nova voice, or press / for commands." : "No active run.",
      `AGENT WALL | 0 working | ${state.snapshot?.roster.length ?? 0} named roles | unused roles are token-free`,
      ...rosterTextGrid(state.snapshot?.roster ?? [], width, ascii),
    );
  } else {
    lines.push(clip(runProgressText(run, ascii), width, ascii), "CHAT & WORK", clip(`YOU > ${run.objective}`, width, ascii));
    for (const event of chatAndWorkEvents(state.events).slice(-8)) {
      lines.push(clip(`${workEventSpeaker(event, run)} > ${chatEventMarker(event, ascii)}${event.summary}`, width, ascii));
    }
    lines.push(
      `AGENT WALL | ${state.snapshot?.roster.filter((agent) => agent.state === "WORKING").length ?? 0} working | ${state.snapshot?.roster.length ?? 0} named roles`,
      ...rosterTextGrid(state.snapshot?.roster ?? [], width, ascii),
      "ACTIVE EXECUTION SEATS",
    );
    const columnCount = projectRoomLayout(width, height) === "three-card" ? 3 : projectRoomLayout(width, height) === "two-card" ? 2 : 1;
    lines.push(...agentTextGrid(run.agents, run.tasks, columnCount, width, state, ascii));
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
  const settings = state.snapshot?.settings;
  lines.push(clip(`SETTINGS | model ${settings?.defaultModel ?? "deterministic/local"} | tokens ${settings?.tokenMode ?? "balanced"} | API ${settings?.providers.filter((provider) => provider.enabled).map((provider) => provider.providerId).join(",") || "offline"}`, width, ascii));
  if (interactive) lines.push(clip(`CHAT [to: ${targetLabel(state.composerTarget)}] > ${state.overlay.kind === "composer" ? state.composerText : "type to chat, Ctrl+R voice, or / commands"}`, width, ascii));
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

function renderSimpleProjectRoomText(state: ProjectRoomState, options: ProjectRoomRenderOptions): string {
  const {width} = options;
  const ascii = options.ascii ?? false;
  const interactive = options.interactive ?? true;
  const run = state.snapshot?.run ?? null;
  const settings = state.snapshot?.settings;
  const provider = settings?.providers.find((item) => item.enabled);
  const workspace = settings?.workspace ?? "";
  const connection = state.connection === "connected" && !state.stale
    ? "READY"
    : state.connection === "error" ? "CONNECTION PROBLEM" : state.connection.toUpperCase();
  const access = state.snapshot?.controller.mode === "READ_ONLY" ? "VIEW ONLY" : "IN CONTROL";
  const lines = [
    clip(`${terminalLogoText(ascii)} | ${state.snapshot?.projectName ?? "Loading workspace"} @ ${state.snapshot?.branch ?? "unknown"} | ${simpleRunLabel(run)}`, width, ascii),
    clip(`${connection} | ${access} | standalone local controller${state.stale ? " | LAST UPDATE MAY BE OLD" : ""}${state.connectionMessage === null ? "" : ` | ${state.connectionMessage}`}`, width, ascii),
    "-".repeat(Math.max(1, Math.min(width, 120))),
  ];
  if (isPersonalHomeWorkspace(workspace)) {
    lines.push(
      "CHOOSE A PROJECT FOLDER",
      clip(`Software Agent is currently in your home folder: ${workspace}`, width, ascii),
      "Leave this screen, then run: software-agent open C:\\path\\to\\your-project",
      "This prevents accidental scanning of thousands of unrelated personal files.",
    );
  }
  if (run === null) {
    lines.push(
      provider === undefined ? "WELCOME — CONNECT AI OR START IN DEMO MODE" : "READY — WHAT WOULD YOU LIKE TO DO?",
      provider === undefined ? "1. Type /setup to connect OpenAI or Anthropic securely." : "Type what you want to build, fix, review, research, or explain.",
      provider === undefined ? "2. Then type your request normally and press Enter." : "Software Agent will choose the right specialists automatically.",
      provider === undefined ? "Real answers require your own API key; offline mode is a demonstration." : "",
    );
  } else {
    const progress = summarizeTasks(run.tasks);
    const active = ["SUCCEEDED", "FAILED", "CANCELED"].includes(run.state)
      ? undefined
      : run.agents.find((agent) => isAgentWorking(agent.state));
    const progressMessage = run.state === "SUCCEEDED"
      ? "All requested steps are complete. You can continue with another message."
      : run.state === "FAILED"
        ? "Work needs attention. Review the problem below, then tell Software Agent how to continue."
        : run.state === "CANCELED"
          ? "Work stopped. Your committed history is still saved."
          : active === undefined ? "Preparing the next step..." : `${active.displayName} is working — ${active.activity}`;
    lines.push(
      clip(`${glyph(run.state, ascii)} ${simpleRunLabel(run)} | ${run.objective}`, width, ascii),
      clip(`${progressBar(progress.passed, progress.total, 16, ascii)} ${progress.percent}% | ${progress.passed}/${progress.total} steps finished`, width, ascii),
      clip(progressMessage, width, ascii),
    );
  }
  const pending = state.snapshot?.approvals.filter((approval) => approval.status === "PENDING") ?? [];
  if (pending[0] !== undefined) lines.push(clip(`YOUR DECISION IS NEEDED | ${pending[0].title} | type /approvals`, width, ascii));
  lines.push("CONVERSATION");
  if (run === null) lines.push(interactive ? "Your conversation will appear here. Start typing below." : "No conversation has started.");
  else lines.push(clip(`YOU > ${run.objective}`, width, ascii));
  for (const event of chatAndWorkEvents(state.events).slice(-10)) {
    lines.push(clip(`${simpleEventSpeaker(event, run)} > ${simpleEventMessage(event, ascii)}`, width, ascii));
  }
  const roster = state.snapshot?.roster ?? [];
  const terminal = run !== null && ["SUCCEEDED", "FAILED", "CANCELED"].includes(run.state);
  const working = run === null || terminal ? [] : roster.filter((agent) => agent.state === "WORKING");
  const blocked = run === null || terminal && run.state !== "FAILED" ? [] : roster.filter((agent) => agent.state === "BLOCKED" || agent.state === "FAILED");
  const done = run === null ? [] : roster.filter((agent) => agent.state === "DONE");
  const ready = run === null ? roster.length : roster.filter((agent) => agent.state === "WAITING").length;
  lines.push("TEAM NOW");
  const visible = [...working, ...blocked, ...(working.length + blocked.length === 0 ? done.slice(0, 3) : [])].slice(0, 6);
  if (visible.length === 0) lines.push(" No specialist is working right now.");
  for (const agent of visible) lines.push(clip(` ${glyph(agent.state, ascii)} ${agent.displayName} — ${simpleRosterStatus(agent)}`, width, ascii));
  lines.push(`${working.length} working | ${blocked.length} need attention | ${done.length} finished | ${ready} ready | /agents shows all ${roster.length}`);
  const budget = run === null ? "no tokens used" : `${run.tokenBudget.used}/${formatToken(run.tokenBudget.limit)} tokens`;
  lines.push(clip(`AI ${provider === undefined ? "not connected (offline demo)" : `connected (${provider.providerId})`} | ${(settings?.tokenMode ?? "balanced").toUpperCase()} | ${budget} | ${pending.length} approvals`, width, ascii));
  if (interactive) lines.push(clip(`YOU > ${state.overlay.kind === "composer" ? state.composerText : "Type a request · Ctrl+R Nova voice · / commands"}`, width, ascii));
  if (state.notice !== null) lines.push(clip(`NOTICE: ${state.notice}`, width, ascii));
  if (interactive) {
    lines.push(...renderOverlayText(state, width, ascii));
    lines.push(clip(plainFooterText(state), width, ascii));
  } else {
    lines.push("Snapshot view; keyboard controls are not attached.");
  }
  return lines.filter((line) => line !== "").join("\n");
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

function TerminalLogo({ascii, noColor, compact}: {
  readonly ascii: boolean;
  readonly noColor: boolean;
  readonly compact: boolean;
}): React.JSX.Element {
  return (
    <Box>
      <Text bold {...textColorProp(noColor ? undefined : "cyan")}>{ascii ? ">_" : "❯_"}</Text>
      <Text bold {...textColorProp(noColor ? undefined : "magenta")}>{compact ? " SA" : ascii ? " o-o-o" : " ●─●─●"}</Text>
      <Text bold {...textColorProp(noColor ? undefined : "green")}>{ascii ? " [OK]" : " ✓"}</Text>
      {compact ? null : <Text bold> SOFTWARE AGENT</Text>}
    </Box>
  );
}

function RunProgressSummary({run, width, noColor, ascii}: {
  readonly run: ProjectRoomRun;
  readonly width: number;
  readonly noColor: boolean;
  readonly ascii: boolean;
}): React.JSX.Element {
  const progress = summarizeTasks(run.tasks);
  const agents = summarizeAgents(run.agents);
  const runLabel = operationalRunLabel(run, progress, agents.working);
  const failures = progress.failed === 0 ? "" : ` | ${progress.failed} failed`;
  return (
    <Box
      flexDirection={width < 100 ? "column" : "row"}
      justifyContent="space-between"
      marginTop={1}
      paddingX={1}
      {...borderColorProp(noColor ? undefined : stateTone(run.state))}
    >
      <Text bold {...textColorProp(noColor ? undefined : stateTone(run.state))}>{glyph(run.state, ascii)} RUN {runLabel} ({run.state})</Text>
      <Text>Tasks {progressBar(progress.passed, progress.total, 12, ascii)} {progress.passed}/{progress.total} passed | {progress.percent}%{failures}</Text>
      <Text>{agents.working} working | {agents.waiting} waiting | {agents.idle} idle | {agents.done} done</Text>
    </Box>
  );
}

function ConnectionBanner({state, noColor}: {readonly state: ProjectRoomState; readonly noColor: boolean}): React.JSX.Element {
  const access = state.snapshot?.controller.mode ?? "READ_ONLY";
  const values = [state.connection.toUpperCase(), access, state.stale ? "STALE" : null, `cursor ${state.cursor}`].filter((value) => value !== null);
  return (
    <Box justifyContent="space-between">
      <Text {...textColorProp(noColor ? undefined : connectionTone(state.connection))}>{values.join(" | ")}</Text>
      <Text wrap="truncate">{state.connectionMessage ?? "Live committed controller state"}</Text>
    </Box>
  );
}

function SimpleConnectionBanner({state, noColor}: {readonly state: ProjectRoomState; readonly noColor: boolean}): React.JSX.Element {
  const access = state.snapshot?.controller.mode === "READ_ONLY" ? "View only" : "You are in control";
  const label = state.connection === "connected"
    ? state.stale ? "Updating..." : "Ready"
    : state.connection === "connecting" ? "Starting..."
      : state.connection === "reconnecting" ? "Reconnecting..."
        : state.connection === "resyncing" ? "Refreshing..." : "Connection problem";
  const detail = state.connectionMessage ?? `${access} — runs independently in this terminal`;
  return (
    <Box justifyContent="space-between">
      <Text bold {...textColorProp(noColor ? undefined : connectionTone(state.connection))}>{label}</Text>
      <Text wrap="truncate">{detail}{state.stale ? " — showing the last known update" : ""}</Text>
    </Box>
  );
}

function SimpleWorkspace({state, run, layout, noColor, ascii, interactive}: {
  readonly state: ProjectRoomState;
  readonly run: ProjectRoomRun | null;
  readonly layout: ProjectRoomLayout;
  readonly noColor: boolean;
  readonly ascii: boolean;
  readonly interactive: boolean;
}): React.JSX.Element {
  const pendingApprovals = state.snapshot?.approvals.filter((approval) => approval.status === "PENDING") ?? [];
  const pendingApproval = pendingApprovals[0];
  const connectedProvider = state.snapshot?.settings.providers.find((provider) => provider.enabled);
  const workspace = state.snapshot?.settings.workspace ?? "";
  const horizontal = layout !== "narrow";
  return (
    <>
      {isPersonalHomeWorkspace(workspace) ? (
        <Box flexDirection="column" borderStyle={ascii ? "classic" : "double"} paddingX={1} marginTop={1} {...borderColorProp(noColor ? undefined : "yellow")}>
          <Text bold>CHOOSE A PROJECT FOLDER</Text>
          <Text wrap="truncate">Software Agent is currently in your home folder: {workspace}</Text>
          <Text>Press Esc to leave, then run: <Text bold>software-agent open C:\path\to\your-project</Text></Text>
          <Text dimColor>This prevents accidental scanning of thousands of unrelated personal files.</Text>
        </Box>
      ) : null}
      {run === null ? (
        <Box flexDirection="column" borderStyle={ascii ? "classic" : "single"} paddingX={1} marginTop={1} {...borderColorProp(noColor ? undefined : connectedProvider === undefined ? "yellow" : "cyan")}>
          <Text bold>{connectedProvider === undefined ? "WELCOME — CONNECT AI OR START IN DEMO MODE" : "READY — WHAT WOULD YOU LIKE TO DO?"}</Text>
          {connectedProvider === undefined ? (
            <>
              <Text>1. Type <Text bold>/setup</Text> to connect OpenAI or Anthropic securely.</Text>
              <Text>2. Then type your request normally and press Enter.</Text>
              <Text dimColor>You can explore offline now, but real answers require your own API key.</Text>
            </>
          ) : (
            <>
              <Text>Type what you want to build, fix, review, research, or explain.</Text>
              <Text dimColor>Software Agent will choose the right specialists and show their work here.</Text>
            </>
          )}
        </Box>
      ) : <SimpleRunProgress run={run} noColor={noColor} ascii={ascii}/>}
      {pendingApproval === undefined ? null : <SimpleApprovalCallout approval={pendingApproval} count={pendingApprovals.length} noColor={noColor} ascii={ascii}/>}
      <Box flexDirection={horizontal ? "row" : "column"}>
        <SimpleConversationPanel state={state} run={run} width={horizontal ? "68%" : undefined} noColor={noColor} ascii={ascii} interactive={interactive}/>
        <SimpleTeamPanel roster={state.snapshot?.roster ?? []} run={run} width={horizontal ? "32%" : undefined} noColor={noColor} ascii={ascii}/>
      </Box>
      <SimpleWorkspaceStatus state={state} run={run} noColor={noColor} ascii={ascii}/>
    </>
  );
}

function SimpleRunProgress({run, noColor, ascii}: {
  readonly run: ProjectRoomRun;
  readonly noColor: boolean;
  readonly ascii: boolean;
}): React.JSX.Element {
  const progress = summarizeTasks(run.tasks);
  const terminal = ["SUCCEEDED", "FAILED", "CANCELED"].includes(run.state);
  const active = terminal ? undefined : run.agents.find((agent) => isAgentWorking(agent.state));
  const failed = run.agents.find((agent) => /FAILED/u.test(agent.state)) ?? run.agents.find((agent) => agent.blocker !== null);
  const message = failed !== undefined
    ? `Needs attention — ${failed.displayName}: ${failed.blocker ?? failed.activity}`
    : run.state === "SUCCEEDED"
      ? `Finished — ${progress.passed} of ${progress.total} steps completed`
      : run.state === "PAUSED"
        ? "Paused — your work is saved and can be resumed"
        : active === undefined
          ? "Preparing the next step..."
          : `${active.displayName} is working — ${active.activity}`;
  return (
    <Box flexDirection="column" marginTop={1} paddingX={1}>
      <Text bold {...textColorProp(noColor ? undefined : stateTone(run.state))}>{glyph(run.state, ascii)} {simpleRunLabel(run)} · {safe(run.objective, 120)}</Text>
      <Text wrap="truncate">{safe(message, 180)}</Text>
      <Text dimColor>{progressBar(progress.passed, progress.total, 16, ascii)} {progress.percent}% · {progress.passed}/{progress.total} steps finished</Text>
    </Box>
  );
}

function SimpleConversationPanel({state, run, width, noColor, ascii, interactive}: {
  readonly state: ProjectRoomState;
  readonly run: ProjectRoomRun | null;
  readonly width: string | number | undefined;
  readonly noColor: boolean;
  readonly ascii: boolean;
  readonly interactive: boolean;
}): React.JSX.Element {
  const events = chatAndWorkEvents(state.events).slice(-Math.max(6, Math.min(12, state.height - 16)));
  const active = run === null || ["SUCCEEDED", "FAILED", "CANCELED"].includes(run.state)
    ? undefined
    : run.agents.find((agent) => isAgentWorking(agent.state));
  return (
    <Box flexDirection="column" borderStyle={ascii ? "classic" : "single"} paddingX={1} {...widthProp(width)} {...borderColorProp(noColor ? undefined : "cyan")}>
      <Box justifyContent="space-between"><Text bold>CONVERSATION</Text><Text>{state.followEvents ? "LIVE" : "PAUSED"}</Text></Box>
      {run === null ? (
        <Text dimColor>{interactive ? "Your conversation will appear here. Start typing below." : "No conversation has started."}</Text>
      ) : (
        <Text wrap="truncate"><Text {...textColorProp(noColor ? undefined : "cyan")}>YOU › </Text>{safe(run.objective, 240)}</Text>
      )}
      {events.map((event) => (
        <Text key={event.eventId} wrap={isAgentReply(event) ? "wrap" : "truncate"}>
          <Text {...textColorProp(noColor ? undefined : simpleEventTone(event))}>{simpleEventSpeaker(event, run)} › </Text>
          {simpleEventMessage(event, ascii)}
        </Text>
      ))}
      {run !== null && events.length === 0 ? <Text dimColor>The team is preparing your work...</Text> : null}
      {active === undefined ? null : <Text wrap="truncate"><Text {...textColorProp(noColor ? undefined : "green")}>WORKING NOW › </Text>{active.displayName}: {safe(active.activity, 180)}</Text>}
    </Box>
  );
}

function SimpleTeamPanel({roster, run, width, noColor, ascii}: {
  readonly roster: readonly ProjectRoomRosterAgent[];
  readonly run: ProjectRoomRun | null;
  readonly width: string | number | undefined;
  readonly noColor: boolean;
  readonly ascii: boolean;
}): React.JSX.Element {
  const terminal = run !== null && ["SUCCEEDED", "FAILED", "CANCELED"].includes(run.state);
  const working = run === null || terminal ? [] : roster.filter((agent) => agent.state === "WORKING");
  const blocked = run === null || terminal && run.state !== "FAILED" ? [] : roster.filter((agent) => agent.state === "BLOCKED" || agent.state === "FAILED");
  const done = run === null ? [] : roster.filter((agent) => agent.state === "DONE");
  const visible = [...working, ...blocked, ...(working.length + blocked.length === 0 ? done.slice(0, 3) : [])].slice(0, 6);
  const ready = run === null ? roster.length : roster.filter((agent) => agent.state === "WAITING").length;
  return (
    <Box flexDirection="column" borderStyle={ascii ? "classic" : "single"} paddingX={1} {...widthProp(width)} {...borderColorProp(noColor ? undefined : "magenta")}>
      <Text bold>TEAM</Text>
      {visible.length === 0 ? <Text dimColor>No specialist is working yet.</Text> : visible.map((agent) => (
        <Box key={agent.id} flexDirection="column">
          <Text {...textColorProp(noColor ? undefined : rosterTone(agent.state))}>{glyph(agent.state, ascii)} {agent.displayName}</Text>
          <Text dimColor wrap="truncate">  {simpleRosterStatus(agent)}</Text>
        </Box>
      ))}
      {run !== null && working.length === 0 && blocked.length === 0 && done.length === 0 ? <Text dimColor>Assigning the right specialists...</Text> : null}
      <Text dimColor>{working.length} working · {blocked.length} need attention · {done.length} finished · {ready} ready</Text>
      <Text dimColor>Type /agents to see all {roster.length} specialists.</Text>
    </Box>
  );
}

function SimpleApprovalCallout({approval, count, noColor, ascii}: {
  readonly approval: ProjectRoomApproval;
  readonly count: number;
  readonly noColor: boolean;
  readonly ascii: boolean;
}): React.JSX.Element {
  return (
    <Box borderStyle={ascii ? "classic" : "single"} paddingX={1} {...borderColorProp(noColor ? undefined : "yellow")}>
      <Text bold {...textColorProp(noColor ? undefined : "yellow")}>YOUR DECISION IS NEEDED</Text>
      <Text wrap="truncate"> · {safe(approval.title, 80)} · {count} waiting · type /approvals</Text>
    </Box>
  );
}

function SimpleWorkspaceStatus({state, run, noColor, ascii}: {
  readonly state: ProjectRoomState;
  readonly run: ProjectRoomRun | null;
  readonly noColor: boolean;
  readonly ascii: boolean;
}): React.JSX.Element {
  const settings = state.snapshot?.settings;
  const provider = settings?.providers.find((item) => item.enabled);
  const approvals = state.snapshot?.approvals.filter((approval) => approval.status === "PENDING").length ?? 0;
  const ai = provider === undefined ? "AI not connected — offline demo" : `AI connected · ${provider.providerId}`;
  const budget = run === null ? "no tokens used" : `${run.tokenBudget.used}/${formatToken(run.tokenBudget.limit)} tokens`;
  return (
    <Box borderStyle={ascii ? "classic" : "single"} paddingX={1} justifyContent="space-between" {...borderColorProp(noColor ? undefined : provider === undefined ? "yellow" : "gray")}>
      <Text>{ai}</Text>
      <Text>{(settings?.tokenMode ?? "balanced").toUpperCase()} · {budget}</Text>
      <Text>{approvals} approval{approvals === 1 ? "" : "s"} · /details for more</Text>
    </Box>
  );
}

function WorkstreamPanel({state, run, width, noColor, ascii}: {
  readonly state: ProjectRoomState;
  readonly run: ProjectRoomRun | null;
  readonly width: string | number | undefined;
  readonly noColor: boolean;
  readonly ascii: boolean;
}): React.JSX.Element {
  const events = chatAndWorkEvents(state.events).slice(-Math.max(5, Math.min(10, state.height - 18)));
  const working = run?.agents.filter((agent) => isAgentWorking(agent.state)) ?? [];
  const files = [...new Set((run?.agents ?? []).flatMap((agent) => agent.requestedFiles))].slice(-4);
  const tools = [...new Set((run?.agents ?? []).flatMap((agent) => agent.requestedTools))].slice(-4);
  return (
    <Box flexDirection="column" borderStyle={ascii ? "classic" : "single"} paddingX={1} {...widthProp(width)} {...borderColorProp(noColor ? undefined : state.focus === "events" ? "magenta" : "cyan")}>
      <Box justifyContent="space-between">
        <Text bold>CHAT &amp; WORK</Text>
        <Text>{state.followEvents ? "LIVE" : "SCROLL PAUSED"}</Text>
      </Box>
      {run === null
        ? <Text><Text {...textColorProp(noColor ? undefined : "cyan")}>YOU › </Text>Type a project request below, or press Ctrl+R to talk to Nova.</Text>
        : <Text wrap="truncate"><Text {...textColorProp(noColor ? undefined : "cyan")}>YOU (objective) › </Text>{safe(run.objective, 180)}</Text>
      }
      <Text dimColor>{ascii ? "-" : "─"} conversation and live work {ascii ? "-" : "─"}</Text>
      {events.length === 0
        ? <Text dimColor>No work events yet. Waiting roles consume no model tokens.</Text>
        : events.map((event) => (
            <Text key={event.eventId} inverse={event.eventId === state.selectedEventId && state.focus === "events"} wrap={isAgentReply(event) ? "wrap" : "truncate"}>
              <Text {...textColorProp(noColor ? undefined : eventTone(event.severity))}>{workEventSpeaker(event, run)} › </Text>
              {chatEventMarker(event, ascii)}{safe(event.summary, isAgentReply(event) ? 800 : 180)}
            </Text>
          ))
      }
      {working.map((agent) => (
        <Text key={agent.id} wrap="truncate"><Text {...textColorProp(noColor ? undefined : "green")}>NOW {agent.displayName} › </Text>{safe(agent.activity, 150)}</Text>
      ))}
      {files.length === 0 ? null : <Text wrap="truncate"><Text bold>FILES </Text>{files.join(" · ")}</Text>}
      {tools.length === 0 ? null : <Text wrap="truncate"><Text bold>TOOLS </Text>{tools.join(" · ")}</Text>}
    </Box>
  );
}

function AgentWall({roster, selectedAgentId, width, noColor, ascii}: {
  readonly roster: readonly ProjectRoomRosterAgent[];
  readonly selectedAgentId: string | null;
  readonly width: string | number | undefined;
  readonly noColor: boolean;
  readonly ascii: boolean;
}): React.JSX.Element {
  const working = roster.filter((agent) => agent.state === "WORKING").length;
  const blocked = roster.filter((agent) => agent.state === "BLOCKED").length;
  const rows = Math.ceil(roster.length / 2);
  return (
    <Box flexDirection="column" borderStyle={ascii ? "classic" : "single"} paddingX={1} {...widthProp(width)} {...borderColorProp(noColor ? undefined : "magenta")}>
      <Box justifyContent="space-between">
        <Text bold>AGENT WALL</Text>
        <Text>{working} WORKING · {blocked} BLOCKED · {roster.length} ROLES</Text>
      </Box>
      {Array.from({length: rows}, (_, row) => {
        const left = roster[row];
        const right = roster[row + rows];
        return (
          <Box key={`roster-${row}`} flexDirection="row">
            <AgentWallTile agent={left} index={row + 1} selectedAgentId={selectedAgentId} width="50%" noColor={noColor} ascii={ascii}/>
            <AgentWallTile agent={right} index={row + rows + 1} selectedAgentId={selectedAgentId} width="50%" noColor={noColor} ascii={ascii}/>
          </Box>
        );
      })}
    </Box>
  );
}

function AgentWallTile({agent, index, selectedAgentId, width, noColor, ascii}: {
  readonly agent: ProjectRoomRosterAgent | undefined;
  readonly index: number;
  readonly selectedAgentId: string | null;
  readonly width: string | number;
  readonly noColor: boolean;
  readonly ascii: boolean;
}): React.JSX.Element {
  if (agent === undefined) return <Box {...widthProp(width)}/>;
  const selected = agent.sessionId !== null && agent.sessionId === selectedAgentId;
  const status = agent.state === "WORKING"
    ? `WORKING · ${agent.taskTitle}`
    : agent.state === "BLOCKED"
      ? `BLOCKED · ${agent.taskTitle}`
      : agent.state === "WAITING"
        ? "WAITING FOR WORK"
        : agent.state;
  const left = ascii ? "[" : "⟦";
  const right = ascii ? "]" : "⟧";
  return (
    <Box {...widthProp(width)} paddingRight={1}>
      <Text inverse={selected} dimColor={agent.state === "WAITING"} {...textColorProp(noColor ? undefined : rosterTone(agent.state))} wrap="truncate">
        {left}{index.toString().padStart(2, "0")} {glyph(agent.state, ascii)} {agent.displayName} · {status}{right}
      </Text>
    </Box>
  );
}

function WorkspaceStatusStrip({state, run, noColor, ascii}: {
  readonly state: ProjectRoomState;
  readonly run: ProjectRoomRun | null;
  readonly noColor: boolean;
  readonly ascii: boolean;
}): React.JSX.Element {
  const settings = state.snapshot?.settings;
  const approvals = state.snapshot?.approvals.filter((approval) => approval.status === "PENDING").length ?? 0;
  const providers = settings?.providers.filter((provider) => provider.enabled).map((provider) => provider.providerId).join(", ") || "offline";
  const budget = run === null ? "no active budget" : `${run.tokenBudget.used}/${formatToken(run.tokenBudget.limit)} tokens`;
  return (
    <Box borderStyle={ascii ? "classic" : "single"} paddingX={1} justifyContent="space-between" {...borderColorProp(noColor ? undefined : approvals > 0 ? "yellow" : "gray")}>
      <Text>{glyph(approvals > 0 ? "PENDING" : "APPROVED", ascii)} {approvals} APPROVALS</Text>
      <Text wrap="truncate">MODEL {settings?.defaultModel ?? "deterministic/local"}</Text>
      <Text>TOKENS {(settings?.tokenMode ?? "balanced").toUpperCase()} · {budget}</Text>
      <Text>API {providers}</Text>
    </Box>
  );
}

function simpleRunLabel(run: ProjectRoomRun | null): string {
  if (run === null) return "READY";
  if (run.state === "SUCCEEDED") return "FINISHED";
  if (run.state === "FAILED") return "NEEDS ATTENTION";
  if (run.state === "CANCELED") return "STOPPED";
  if (run.state === "PAUSED") return "PAUSED";
  return "WORKING";
}

function isPersonalHomeWorkspace(value: string): boolean {
  const normalized = value.replaceAll("\\", "/").replace(/\/+$/u, "");
  return /^[A-Za-z]:\/Users\/[^/]+$/iu.test(normalized)
    || /^\/Users\/[^/]+$/u.test(normalized)
    || /^\/home\/[^/]+$/u.test(normalized);
}

function simpleRosterStatus(agent: ProjectRoomRosterAgent): string {
  if (agent.state === "WORKING") return `Working on: ${agent.taskTitle}`;
  if (agent.state === "BLOCKED") return `Waiting: ${agent.activity}`;
  if (agent.state === "FAILED") return `Problem: ${agent.activity}`;
  if (agent.state === "DONE") return `Finished: ${agent.taskTitle}`;
  return "Ready when needed — no tokens being used";
}

function simpleEventSpeaker(event: ProjectRoomEvent, run: ProjectRoomRun | null): string {
  if (event.type === "software-agent.instruction.submitted") return "YOU";
  if (isAgentReply(event)) return workEventSpeaker(event, run);
  if (/approval/u.test(event.type)) return "APPROVAL";
  return workEventSpeaker(event, run);
}

function simpleEventMessage(event: ProjectRoomEvent, ascii: boolean): string {
  const summary = safe(event.summary, isAgentReply(event) ? 800 : 200);
  if (event.type === "software-agent.instruction.submitted") return summary;
  if (isAgentReply(event)) return `${ascii ? "[REPLY]" : "✓"} ${summary}`;
  if (/model\.started/u.test(event.type)) return "Thinking...";
  if (/model\.completed/u.test(event.type)) return "Finished thinking; preparing the answer...";
  if (/tool\.started/u.test(event.type)) return `Working with a tool — ${summary}`;
  if (/tool\.completed/u.test(event.type)) return `Tool finished — ${summary}`;
  if (/approval\.requested/u.test(event.type)) return `Approval needed — ${summary}`;
  if (/approval\.approved|approval\.consumed/u.test(event.type)) return `Approved — continuing work${summary === "" ? "" : ` · ${summary}`}`;
  if (/approval\.denied/u.test(event.type)) return `Approval denied — ${summary}`;
  if (/failed/u.test(event.type) || event.severity === "ERROR" || event.severity === "CRITICAL") return `Problem — ${summary}`;
  return summary;
}

function simpleEventTone(event: ProjectRoomEvent): string {
  if (event.type === "software-agent.instruction.submitted") return "cyan";
  if (isAgentReply(event)) return "green";
  return eventTone(event.severity);
}

function meaningfulWorkEvents(events: readonly ProjectRoomEvent[]): readonly ProjectRoomEvent[] {
  return events.filter((event) => !/(?:mutation\.renewed|heartbeat|lease\.renewed)/u.test(event.type));
}

function chatAndWorkEvents(events: readonly ProjectRoomEvent[]): readonly ProjectRoomEvent[] {
  return meaningfulWorkEvents(events).filter((event) => /(?:instruction\.submitted|turn\.completed|model\.(?:started|completed)|tool\.(?:started|completed|failed)|approval\.(?:requested|approved|denied|consumed)|attempt\.failed|turn\.failed|task\.failed|run\.failed)/u.test(event.type));
}

function isAgentReply(event: ProjectRoomEvent): boolean {
  return event.type === "software-agent.turn.completed";
}

function spokenReplyText(state: ProjectRoomState, event: ProjectRoomEvent): string {
  const run = state.snapshot?.run ?? null;
  const direct = run?.agents.find((agent) => agent.id === event.agentId);
  const task = run?.tasks.find((candidate) => candidate.id === event.taskId);
  const owner = task === undefined ? undefined : run?.agents.find((agent) => agent.id === task.agentId);
  const speaker = direct?.displayName ?? owner?.displayName ?? (event.severity === "ERROR" || event.severity === "CRITICAL" ? "Software Agent" : "Nova");
  return sanitizeTerminal(`${speaker} says: ${event.summary}`, 3_800);
}

function chatEventMarker(event: ProjectRoomEvent, ascii: boolean): string {
  if (event.type === "software-agent.instruction.submitted") return "";
  if (isAgentReply(event)) return ascii ? "[REPLY] " : "✓ ";
  return `${glyph(event.severity, ascii)} `;
}

function workEventSpeaker(event: ProjectRoomEvent, run: ProjectRoomRun | null): string {
  if (/instruction\.submitted|run\.created|question\.answered/u.test(event.type)) return "YOU";
  if (/approval/u.test(event.type)) return "APPROVAL";
  const direct = run?.agents.find((agent) => agent.id === event.agentId);
  if (direct !== undefined) return direct.displayName;
  const task = run?.tasks.find((candidate) => candidate.id === event.taskId);
  const owner = task === undefined ? undefined : run?.agents.find((agent) => agent.id === task.agentId);
  return owner?.displayName ?? "CONTROLLER";
}

function rosterTone(state: ProjectRoomRosterAgent["state"]): string {
  if (state === "WORKING") return "green";
  if (state === "BLOCKED") return "yellow";
  if (state === "FAILED") return "red";
  if (state === "DONE") return "cyan";
  return "gray";
}

function eventTone(severity: ProjectRoomEvent["severity"]): string {
  if (severity === "ERROR" || severity === "CRITICAL") return "red";
  if (severity === "WARN") return "yellow";
  return "cyan";
}

function CompactAgentList({agents, tasks, selectedAgentId, focused, noColor, ascii}: {
  readonly agents: readonly ProjectRoomAgent[];
  readonly tasks: readonly ProjectRoomTask[];
  readonly selectedAgentId: string | null;
  readonly focused: boolean;
  readonly noColor: boolean;
  readonly ascii: boolean;
}): React.JSX.Element {
  return (
    <Box flexDirection="column" borderStyle={ascii ? "classic" : "single"} paddingX={1} {...borderColorProp(noColor ? undefined : focused ? "magenta" : undefined)}>
      {agents.length === 0 ? <Text dimColor>No active agent sessions.</Text> : agents.map((agent) => (
        <Text key={agent.id} inverse={focused && agent.id === selectedAgentId} wrap="truncate">
          {glyph(agent.state, ascii)} {agent.displayName} [{operationalAgentLabel(agent.state)}] {agentTaskProgressText(tasks, agent.id, ascii)} | {safe(agent.taskTitle, 24)} | {isAgentWorking(agent.state) ? "Now" : "Last"}: {safe(agent.activity, 24)}{agent.approvalId === null ? "" : ` | approval ${safe(agent.approvalId, 18)}`}
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
      <Box justifyContent="space-between"><Text bold>EVENTS</Text><Text>{follow ? "LIVE SCROLL" : "SCROLL PAUSED"}</Text></Box>
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
  const simple = state.viewMode === "simple";
  return (
    <Box borderStyle={ascii ? "classic" : "single"} paddingX={1} marginTop={1} {...borderColorProp(noColor ? undefined : active ? "magenta" : undefined)}>
      <Text bold>{simple ? "YOU › " : "CHAT "}</Text>
      {simple ? null : <Text>[to: {targetLabel(state.composerTarget)}] </Text>}
      <Text inverse={active}>{active ? state.composerText || " " : "Type a request, or press Ctrl+R to talk to Nova"}</Text>
      {active ? <Text dimColor>{simple ? "  Enter send · Ctrl+R voice · Esc close" : "  Tab target | Enter send | Ctrl+R voice | Esc close"}</Text> : null}
    </Box>
  );
}

function Overlay({state, noColor, ascii}: {readonly state: ProjectRoomState; readonly noColor: boolean; readonly ascii: boolean}): React.JSX.Element | null {
  const overlay = state.overlay;
  if (overlay.kind === "none") return null;
  if (overlay.kind === "composer") return slashMenuVisible(state) ? <SlashCommandMenu state={state} noColor={noColor} ascii={ascii}/> : null;
  const borderColor = noColor ? undefined : "magenta";
  if (overlay.kind === "setup") {
    const choices = [
      {id: "openai", title: "OpenAI", detail: "Use your OpenAI API key"},
      {id: "anthropic", title: "Anthropic", detail: "Use your Anthropic API key"},
      {id: "offline", title: "Offline demo", detail: "Explore without real AI replies"},
    ] as const;
    return (
      <Box flexDirection="column" borderStyle={ascii ? "classic" : "double"} paddingX={1} {...borderColorProp(borderColor)}>
        <Text bold>SET UP SOFTWARE AGENT</Text>
        <Text>Choose how Software Agent should think. It runs independently; only the selected model API is contacted.</Text>
        {choices.map((choice) => (
          <Text key={choice.id} inverse={choice.id === overlay.selected}>
            {choice.id === overlay.selected ? ">" : " "} <Text bold>{choice.title}</Text> — {choice.detail}
          </Text>
        ))}
        <Text dimColor>↑↓ choose · Enter continue · Esc cancel · keys are stored by your operating system</Text>
      </Box>
    );
  }
  if (overlay.kind === "help") return (
    <Box flexDirection="column" borderStyle={ascii ? "classic" : "double"} paddingX={1} {...borderColorProp(borderColor)}>
      <Text bold>SOFTWARE AGENT HELP</Text>
      <Text>Just type what you need and press Enter. Continue naturally with follow-up messages.</Text>
      <Text><Text bold>/voice</Text> or <Text bold>Ctrl+R</Text> talk to Nova · review transcript · Enter sends · Nova speaks the matching committed reply</Text>
      <Text><Text bold>/setup</Text> connect AI · <Text bold>/status</Text> explain current work · <Text bold>/agents</Text> show all specialists</Text>
      <Text><Text bold>/simple</Text> clean chat view · <Text bold>/details</Text> complete control room · <Text bold>/settings</Text> model and budget</Text>
      <Text>When a decision is required, a yellow approval message tells you exactly what needs attention.</Text>
      <Text dimColor>Advanced: 1 Agents · 2 Events · 3 Approvals · 4 Tokens · Ctrl+F live scroll · Esc leave</Text>
    </Box>
  );
  if (overlay.kind === "settings") {
    const settings = state.snapshot?.settings;
    return (
      <Box flexDirection="column" borderStyle={ascii ? "classic" : "double"} paddingX={1} {...borderColorProp(borderColor)}>
        <Text bold>SOFTWARE AGENT SETTINGS</Text>
        <Text wrap="truncate">Project: {settings?.workspace ?? "Loading"}</Text>
        <Text>Model: {settings?.defaultModel ?? "deterministic/local"} | Tokens: {settings?.tokenMode ?? "balanced"}</Text>
        {(settings?.providers.length ?? 0) === 0
          ? <Text dimColor>No AI connected. Type /setup for the guided connection, or continue with the offline demo.</Text>
          : settings?.providers.map((provider) => (
              <Text key={provider.providerId}>{glyph(provider.enabled ? "CONNECTED" : "PAUSED", ascii)} {provider.providerId} | {provider.model} | {provider.enabled ? "CONNECTED" : "DISABLED"} | {provider.credentialReference}</Text>
            ))}
        <Text>Nova voice: {settings?.providers.some((provider) => provider.providerId === "openai" && provider.enabled) === true ? "READY (push-to-talk, AI-generated spoken replies)" : "CONNECT OPENAI TO ENABLE"}</Text>
        <Text dimColor>/setup guided connection | /voice push-to-talk | /model provider/model | /tokens economy|balanced|quality | Enter/Esc close</Text>
      </Box>
    );
  }
  if (overlay.kind === "api-key") {
    const masked = overlay.value.length === 0 ? "(paste key here)" : `${(ascii ? "*" : "•").repeat(Math.min(48, overlay.value.length))} (${overlay.value.length} characters)`;
    return (
      <Box flexDirection="column" borderStyle={ascii ? "classic" : "double"} paddingX={1} {...borderColorProp(noColor ? undefined : "yellow")}>
        <Text bold>CONNECT {overlay.providerId.toUpperCase()} SECURELY</Text>
        <Text>Model: {overlay.providerId}/{overlay.model}</Text>
        <Text>API key: {masked}</Text>
        <Text>The raw key is never rendered, logged, committed, or written to project configuration.</Text>
        <Text dimColor>Paste key | Enter stores in the OS credential manager | Esc discards</Text>
      </Box>
    );
  }
  if (overlay.kind === "voice") {
    const elapsedMs = overlay.startedAt === null ? 0 : Math.max(0, Math.min(overlay.maxDurationMs, state.now - overlay.startedAt));
    const voiceColor = noColor ? undefined : overlay.phase === "recording" ? "red" : overlay.phase === "error" ? "yellow" : "magenta";
    return (
      <Box flexDirection="column" borderStyle={ascii ? "classic" : "double"} paddingX={1} {...borderColorProp(voiceColor)}>
        <Text bold>NOVA VOICE {overlay.phase === "recording" ? "[REC]" : overlay.phase.toUpperCase()}</Text>
        {overlay.phase === "starting" ? <Text>Opening your default microphone...</Text> : null}
        {overlay.phase === "recording" ? (
          <>
            <Text>Listening on {overlay.deviceName ?? "default microphone"} | {formatVoiceDuration(elapsedMs)} / {formatVoiceDuration(overlay.maxDurationMs)}</Text>
            <Text>Speak naturally. Nova will write your words into the chat composer.</Text>
            <Text bold>Press Enter to stop and transcribe | Esc cancels without sending</Text>
          </>
        ) : null}
        {overlay.phase === "transcribing" ? <Text>Recording stopped. Creating an editable transcript with OpenAI...</Text> : null}
        {overlay.phase === "cancelling" ? <Text>Discarding the in-memory recording...</Text> : null}
        {overlay.phase === "error" ? (
          <>
            <Text wrap="wrap">{overlay.message ?? "Voice input could not be completed."}</Text>
            <Text>Type /setup to connect OpenAI, or check Windows microphone permission and try /voice again.</Text>
            <Text bold>Enter or Esc returns to your unchanged draft.</Text>
          </>
        ) : null}
        <Text dimColor>Privacy: push-to-talk only | two-minute limit | audio is kept in memory only | nothing executes until you review the text and press Enter</Text>
        <Text dimColor>Spoken replies use an AI-generated voice.</Text>
      </Box>
    );
  }
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

function SlashCommandMenu({state, noColor, ascii}: {
  readonly state: ProjectRoomState;
  readonly noColor: boolean;
  readonly ascii: boolean;
}): React.JSX.Element {
  const suggestions = slashCommandSuggestions(state.composerText);
  const page = slashCommandPage(suggestions, state.slashSelected, Math.max(5, Math.min(10, state.height - 23)));
  const settings = state.snapshot?.settings;
  const providers = settings?.providers.filter((provider) => provider.enabled).map((provider) => provider.providerId).join(", ") || "offline";
  return (
    <Box flexDirection="column" borderStyle={ascii ? "classic" : "double"} paddingX={1} {...borderColorProp(noColor ? undefined : "magenta")}>
      <Text bold>SOFTWARE AGENT COMMANDS</Text>
      <Text wrap="truncate">Project: {settings?.workspace ?? "Loading"}</Text>
      <Text>Model: {settings?.defaultModel ?? "deterministic/local"} | Tokens: {settings?.tokenMode ?? "balanced"} | API: {providers}</Text>
      <Text>Type a word to search · {suggestions.length} matching command{suggestions.length === 1 ? "" : "s"}</Text>
      {page.items.map(({suggestion, index}) => (
        <Text key={suggestion.command} inverse={index === page.selected}>
          {index === page.selected ? ">" : " "} <Text dimColor>[{suggestion.category}]</Text> <Text bold>{suggestion.usage}</Text> <Text dimColor>— {suggestion.description}</Text>
        </Text>
      ))}
      {suggestions.length === 0 ? <Text>No command matches. Keep typing or press Esc.</Text> : null}
      <Text dimColor>Type to filter | ↑↓ choose | Tab complete | Enter run | Esc close{suggestions.length === 0 ? "" : ` | ${page.start + 1}-${page.end} of ${suggestions.length}`}</Text>
    </Box>
  );
}

function slashCommandPage(suggestions: readonly SlashCommandSuggestion[], selected: number, capacity: number): {
  readonly items: readonly {readonly suggestion: SlashCommandSuggestion; readonly index: number}[];
  readonly selected: number;
  readonly start: number;
  readonly end: number;
} {
  const boundedSelected = Math.max(0, Math.min(selected, Math.max(0, suggestions.length - 1)));
  const start = Math.max(0, Math.min(boundedSelected - capacity + 1, Math.max(0, suggestions.length - capacity)));
  const end = Math.min(suggestions.length, start + capacity);
  return {
    items: suggestions.slice(start, end).map((suggestion, offset) => ({suggestion, index: start + offset})),
    selected: boundedSelected,
    start,
    end,
  };
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
  if (slashMenuVisible(state)) return "Slash commands: type to filter | ↑↓ choose | Tab complete | Enter run | Esc close";
  if (state.overlay.kind === "composer") return state.viewMode === "simple"
    ? "Type your message | Enter send | Ctrl+R voice | / commands | Esc close"
    : "Chat: type a prompt or /command | Tab target | Enter send | Ctrl+R voice | Esc close";
  if (state.overlay.kind === "api-key") return "Secure key entry: paste | Enter connect | Esc discard";
  if (state.overlay.kind === "setup") return "Setup: arrows choose | Enter continue | Esc cancel";
  if (state.overlay.kind === "voice") return state.overlay.phase === "recording" ? "Nova is listening | Enter transcribe | Esc discard" : "Nova voice | please wait | Esc cancel";
  if (state.overlay.kind !== "none") return "Overlay: arrows move | Enter confirm | Esc close";
  if (state.viewMode === "simple") return "Type naturally  Enter Send  Ctrl+R Voice  / Commands  /setup Connect AI  /details More  Esc Leave";
  return "Type naturally  Enter Send  Ctrl+R Voice  / Commands  1 Agents  2 Chat  3 Approvals  4 Tokens  Ctrl+F Live  5 Settings  ? Help  Esc Leave";
}

function plainFooterText(state: ProjectRoomState): string {
  if (slashMenuVisible(state)) return "Slash: type filter | Up/Down choose | Tab complete | Enter run | Esc close";
  if (state.overlay.kind === "composer") return state.viewMode === "simple"
    ? "Type message | Enter Send | Ctrl+R Voice | / Commands | Esc Close"
    : "Type prompt or /command | Tab Target | Enter Send | Ctrl+R Voice | Esc Close";
  if (state.overlay.kind === "api-key") return "Paste key | Enter Connect | Esc Discard";
  if (state.overlay.kind === "setup") return "Arrows Choose | Enter Continue | Esc Cancel";
  if (state.overlay.kind === "voice") return state.overlay.phase === "recording" ? "Nova Listening | Enter Transcribe | Esc Discard" : "Nova Voice | Wait | Esc Cancel";
  if (state.overlay.kind !== "none") return "Arrows Move | Enter Confirm | Esc Close";
  if (state.viewMode === "simple") return "Type naturally | Enter Send | Ctrl+R Voice | / Commands | /details More | Esc Leave";
  return "Type naturally | Enter Send | Ctrl+R Voice | / Commands | Tab Focus | ? Help | Esc Leave";
}

function renderOverlayText(state: ProjectRoomState, width: number, ascii: boolean): readonly string[] {
  const overlay = state.overlay;
  if (overlay.kind === "none") return [];
  if (overlay.kind === "composer") {
    if (!slashMenuVisible(state)) return [];
    const suggestions = slashCommandSuggestions(state.composerText);
    const page = slashCommandPage(suggestions, state.slashSelected, Math.max(5, Math.min(10, state.height - 23)));
    const settings = state.snapshot?.settings;
    const providers = settings?.providers.filter((provider) => provider.enabled).map((provider) => provider.providerId).join(", ") || "offline";
    return [
      "SOFTWARE AGENT COMMANDS",
      clip(`Project: ${settings?.workspace ?? "Loading"}`, width, ascii),
      clip(`Model: ${settings?.defaultModel ?? "deterministic/local"} | Tokens: ${settings?.tokenMode ?? "balanced"} | API: ${providers}`, width, ascii),
      `Type a word to search | ${suggestions.length} matching command${suggestions.length === 1 ? "" : "s"}`,
      ...page.items.map(({suggestion, index}) => clip(`${index === page.selected ? ">" : " "} [${suggestion.category}] ${suggestion.usage} — ${suggestion.description}`, width, ascii)),
      suggestions.length === 0 ? "No command matches. Keep typing or press Esc." : `Type filter | Up/Down choose | Tab complete | Enter run | ${page.start + 1}-${page.end} of ${suggestions.length}`,
    ];
  }
  if (overlay.kind === "setup") return [
    "SET UP SOFTWARE AGENT",
    "Choose how Software Agent should think. It does not depend on another coding app.",
    `${overlay.selected === "openai" ? ">" : " "} OpenAI — use your OpenAI API key`,
    `${overlay.selected === "anthropic" ? ">" : " "} Anthropic — use your Anthropic API key`,
    `${overlay.selected === "offline" ? ">" : " "} Offline demo — explore without real AI replies`,
    "Arrows choose | Enter continue | Esc cancel",
  ];
  if (overlay.kind === "help") return [
    "SOFTWARE AGENT HELP",
    "Type what you need and press Enter. Keep chatting naturally with follow-up messages.",
    "/voice or Ctrl+R Talk to Nova | review transcript | Enter sends | Nova speaks the reply",
    "/setup Connect AI | /status Explain current work | /agents Show all specialists",
    "/simple Clean chat | /details Full control room | /settings Model and budget",
    "Yellow approval messages tell you exactly when a decision is needed.",
  ];
  if (overlay.kind === "settings") {
    const settings = state.snapshot?.settings;
    return [
      "SOFTWARE AGENT SETTINGS",
      `Project: ${settings?.workspace ?? "Loading"}`,
      `Model: ${settings?.defaultModel ?? "deterministic/local"} | Tokens: ${settings?.tokenMode ?? "balanced"}`,
      ...((settings?.providers ?? []).map((provider) => `${provider.providerId}: ${provider.model} | ${provider.enabled ? "CONNECTED" : "DISABLED"} | ${provider.credentialReference}`)),
      `Nova voice: ${settings?.providers.some((provider) => provider.providerId === "openai" && provider.enabled) === true ? "READY" : "CONNECT OPENAI TO ENABLE"}`,
      "/voice | /api connect <provider> [model] | /model provider/model | /tokens 25|50|100",
    ];
  }
  if (overlay.kind === "api-key") return [
    `CONNECT ${overlay.providerId.toUpperCase()} SECURELY`,
    `Model: ${overlay.providerId}/${overlay.model}`,
    `API key: ${overlay.value.length === 0 ? "(paste key here)" : `[MASKED ${overlay.value.length} characters]`}`,
    "Enter stores in the OS credential manager | Esc discards",
  ];
  if (overlay.kind === "voice") {
    const elapsedMs = overlay.startedAt === null ? 0 : Math.max(0, Math.min(overlay.maxDurationMs, state.now - overlay.startedAt));
    return [
      `NOVA VOICE | ${overlay.phase.toUpperCase()}`,
      overlay.phase === "recording"
        ? `Listening on ${overlay.deviceName ?? "default microphone"} | ${formatVoiceDuration(elapsedMs)} / ${formatVoiceDuration(overlay.maxDurationMs)}`
        : overlay.phase === "error"
          ? clip(overlay.message ?? "Voice input failed.", width, ascii)
          : overlay.phase === "transcribing"
            ? "Recording stopped. Creating an editable transcript with OpenAI..."
            : overlay.phase === "cancelling" ? "Discarding the in-memory recording..." : "Opening your default microphone...",
      overlay.phase === "recording" ? "Speak naturally | Enter transcribe | Esc discard" : overlay.phase === "error" ? "Enter/Esc return | /setup connects OpenAI" : "Esc cancel",
      "Push-to-talk only | audio stays in memory | review text before Enter executes | AI-generated spoken replies",
    ];
  }
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

function agentTextGrid(
  agents: readonly ProjectRoomAgent[],
  tasks: readonly ProjectRoomTask[],
  columns: number,
  width: number,
  state: ProjectRoomState,
  ascii: boolean,
): readonly string[] {
  if (agents.length === 0) return [" No active agent sessions."];
  const visible = visibleAgents(agents, state.selectedAgentId, columns);
  const gap = " | ";
  const columnWidth = Math.max(20, Math.floor((width - gap.length * (columns - 1)) / columns));
  const cards = visible.map((agent) => [
    `${agent.id === state.selectedAgentId ? ">" : " "}${glyph(agent.state, ascii)} ${agent.displayName} [${operationalAgentLabel(agent.state)}]`,
    ` ${agentTaskProgressText(tasks, agent.id, ascii)}`,
    ` ${agent.taskTitle}`,
    ` ${isAgentWorking(agent.state) ? "Now" : "Last"}: ${agent.activity}`,
    ` Model: ${agent.provider}/${agent.model}`,
    ` ${formatUsage(agent.tokens)} | ${formatCost(agent.costUsd)}`,
    ` ${agentTimingText(agent, state.now)}`,
  ].map((line) => pad(clip(line, columnWidth, ascii), columnWidth)));
  const rows: string[] = [];
  const rowCount = Math.max(...cards.map((card) => card.length));
  for (let index = 0; index < rowCount; index += 1) rows.push(cards.map((card) => card[index] ?? " ".repeat(columnWidth)).join(gap).trimEnd());
  return rows;
}

function rosterTextGrid(roster: readonly ProjectRoomRosterAgent[], width: number, ascii: boolean): readonly string[] {
  if (roster.length === 0) return [" No roster projection is available."];
  const columns = width >= 110 ? 2 : 1;
  const rows = Math.ceil(roster.length / columns);
  const gap = " | ";
  const columnWidth = Math.max(24, Math.floor((width - gap.length * (columns - 1)) / columns));
  return Array.from({length: rows}, (_, row) => {
    const cells = Array.from({length: columns}, (_, column) => {
      const index = row + column * rows;
      const agent = roster[index];
      if (agent === undefined) return " ".repeat(columnWidth);
      const status = agent.state === "WORKING" ? `WORKING: ${agent.taskTitle}` : agent.status;
      const brackets = ascii ? ["[", "]"] : ["⟦", "⟧"];
      return pad(clip(`${brackets[0]}${(index + 1).toString().padStart(2, "0")} ${glyph(agent.state, ascii)} ${agent.displayName} · ${status}${brackets[1]}`, columnWidth, ascii), columnWidth);
    });
    return cells.join(gap).trimEnd();
  });
}

function visibleAgents(agents: readonly ProjectRoomAgent[], selectedId: string | null, limit: number): readonly ProjectRoomAgent[] {
  if (agents.length <= limit) return agents;
  const index = Math.max(0, agents.findIndex((agent) => agent.id === selectedId));
  const start = Math.min(index, Math.max(0, agents.length - limit));
  return agents.slice(start, start + limit);
}

function targetLabel(target: ComposerTarget): string {
  if (target.kind === "objective" || target.kind === "run") return target.label;
  return `${target.kind}:${target.label}`;
}

function targetKey(target: ComposerTarget): string {
  return target.kind === "objective" ? "objective" : `${target.kind}:${target.id}`;
}

interface TaskProgressSummary {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly running: number;
  readonly waiting: number;
  readonly percent: number;
}

interface AgentProgressSummary {
  readonly working: number;
  readonly waiting: number;
  readonly idle: number;
  readonly done: number;
}

function summarizeTasks(tasks: readonly ProjectRoomTask[]): TaskProgressSummary {
  const current = tasks.filter((task) => task.state !== "CANCELED");
  const passed = current.filter((task) => task.state === "PASSED").length;
  const failed = current.filter((task) => task.state === "FAILED").length;
  const running = current.filter((task) => task.state === "RUNNING").length;
  const waiting = current.filter((task) => task.state === "READY" || task.state === "BLOCKED").length;
  const total = current.length;
  return {total, passed, failed, running, waiting, percent: total === 0 ? 0 : Math.round((passed / total) * 100)};
}

function summarizeAgents(agents: readonly ProjectRoomAgent[]): AgentProgressSummary {
  return {
    working: agents.filter((agent) => isAgentWorking(agent.state)).length,
    waiting: agents.filter((agent) => /WAITING|PAUSED/u.test(agent.state)).length,
    idle: agents.filter((agent) => agent.state === "IDLE").length,
    done: agents.filter((agent) => /SUCCEEDED|FAILED|STOPPED/u.test(agent.state)).length,
  };
}

function operationalRunLabel(run: ProjectRoomRun, progress: TaskProgressSummary, workingAgents: number): string {
  if (run.state === "SUCCEEDED") return "DONE";
  if (run.state === "FAILED") return "FAILED";
  if (run.state === "CANCELED") return "CANCELED";
  if (run.state === "PAUSED" || run.state === "PAUSING") return "PAUSED";
  if (run.state === "RECOVERING") return "RECOVERING";
  if (workingAgents > 0 || progress.running > 0) return "WORKING";
  if (progress.total > 0 && progress.passed === progress.total) return "FINALIZING";
  return "SCHEDULING";
}

function operationalAgentLabel(state: string): string {
  if (isAgentWorking(state)) return "WORKING NOW";
  if (/WAITING_INPUT/u.test(state)) return "WAITING FOR INPUT";
  if (/WAITING_HANDOFF/u.test(state)) return "WAITING FOR HANDOFF";
  if (/PAUSED/u.test(state)) return "PAUSED";
  if (/SUCCEEDED/u.test(state)) return "DONE";
  if (/FAILED/u.test(state)) return "FAILED";
  if (/STOPPED/u.test(state)) return "STOPPED";
  return "IDLE - NOT WORKING";
}

function isAgentWorking(state: string): boolean {
  return /RUNNING|CLAIMED|PLANNING/u.test(state);
}

function progressBar(completed: number, total: number, width: number, ascii: boolean): string {
  const safeTotal = Math.max(0, total);
  const ratio = safeTotal === 0 ? 0 : Math.min(1, Math.max(0, completed / safeTotal));
  const filled = Math.round(ratio * width);
  return `[${(ascii ? "#" : "█").repeat(filled)}${(ascii ? "-" : "░").repeat(width - filled)}]`;
}

function agentTaskProgressText(tasks: readonly ProjectRoomTask[], agentId: string, ascii: boolean): string {
  const progress = summarizeTasks(tasks.filter((task) => task.agentId === agentId));
  return `Tasks ${progressBar(progress.passed, progress.total, 6, ascii)} ${progress.passed}/${progress.total} passed`;
}

function agentTimingText(agent: ProjectRoomAgent, now: number): string {
  if (isAgentWorking(agent.state)) {
    return `Working for ${agePhrase(agent.activitySince, now)} | last update ${agePhrase(agent.lastEventAt, now)} ago`;
  }
  return `Not executing | last update ${agePhrase(agent.lastEventAt, now)} ago`;
}

function agePhrase(timestamp: string | null, now: number): string {
  const age = formatAge(timestamp, now);
  return age === "UNKNOWN" ? "unknown" : age;
}

function runProgressText(run: ProjectRoomRun, ascii: boolean): string {
  const progress = summarizeTasks(run.tasks);
  const agents = summarizeAgents(run.agents);
  const failures = progress.failed === 0 ? "" : ` | ${progress.failed} failed`;
  return `${glyph(run.state, ascii)} RUN ${operationalRunLabel(run, progress, agents.working)} (${run.state}) | Tasks ${progressBar(progress.passed, progress.total, 12, ascii)} ${progress.passed}/${progress.total} passed | ${progress.percent}%${failures} | Agents: ${agents.working} working, ${agents.waiting} waiting, ${agents.idle} idle, ${agents.done} done`;
}

function glyph(state: string, ascii: boolean): string {
  if (/SUCCEEDED|PASSED|COMPLETE|APPROVED|DONE/u.test(state)) return ascii ? "[OK]" : "✓";
  if (/FAILED|CANCELED|DENIED|CRITICAL|ERROR/u.test(state)) return ascii ? "[X]" : "✕";
  if (/BLOCKED|PAUSED|WARN/u.test(state)) return ascii ? "[!]" : "◆";
  if (/RUNNING|CLAIMED|PLANNING|WORKING|INFO/u.test(state)) return ascii ? "[>]" : "●";
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

function formatVoiceDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
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
  if (/SUCCEEDED|PASSED|COMPLETE|DONE/u.test(state)) return "green";
  if (/FAILED|CANCELED|DENIED/u.test(state)) return "red";
  if (/WAITING|BLOCKED|PAUSED/u.test(state)) return "yellow";
  if (/RUNNING|CLAIMED|PLANNING|WORKING/u.test(state)) return "cyan";
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
