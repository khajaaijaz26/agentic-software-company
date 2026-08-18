import React from "react";
import {Box, Text, render, useStdout} from "ink";
import type {ControllerSnapshot} from "../../control-plane/src/controller.js";
import {sanitizeTerminal} from "../../../packages/observability/src/index.js";

export interface DashboardOptions {
  readonly noColor?: boolean;
  readonly width?: number;
}

export type DashboardLayout = "plain" | "narrow" | "compact" | "standard" | "wide";

export function dashboardLayout(width: number, height = 24): DashboardLayout {
  if (width < 60 || height < 20) return "plain";
  if (width < 80) return "narrow";
  if (width < 110) return "compact";
  if (width < 140) return "standard";
  return "wide";
}

export function Dashboard({snapshot, noColor = false}: {readonly snapshot: ControllerSnapshot; readonly noColor?: boolean}): React.JSX.Element {
  const {stdout} = useStdout();
  const width = stdout.columns || 100;
  const height = stdout.rows || 24;
  const current = snapshot.runs[0];
  const layout = dashboardLayout(width, height);
  if (layout === "plain") {
    return <Text>{renderPlainDashboard(snapshot, width)}</Text>;
  }
  const wide = layout === "wide" || layout === "standard";
  const color = noColor ? undefined : "cyan";
  return (
    <Box flexDirection="column" paddingX={1}>
      <Box borderStyle="round" borderColor={color} paddingX={1} justifyContent="space-between">
        <Text bold {...(color === undefined ? {} : {color})}>AGENT COMPANY</Text>
        <Text>{snapshot.projectName} · {current?.state ?? "NO RUN"}</Text>
        <Text>{current ? `${current.agents.length}/25 active` : "0/25 active"}</Text>
      </Box>
      {current ? (
        <Box flexDirection={wide ? "row" : "column"} gap={1} marginTop={1}>
          <Box flexDirection="column" width={wide ? "58%" : undefined}>
            <Text bold>Agent roster</Text>
            <Box flexWrap="wrap" gap={1}>
              {current.agents.slice(0, wide ? 8 : 4).map((agent) => (
                <Box key={agent.id} borderStyle="single" borderColor={noColor ? undefined : statusColor(agent.state)} paddingX={1} width={wide ? 34 : undefined}>
                  <Box flexDirection="column">
                    <Text bold>{statusGlyph(agent.state, noColor)} {agent.displayName}</Text>
                    <Text dimColor>{agent.state} · {agent.model}</Text>
                    <Text wrap="truncate">{shortId(agent.taskId)}</Text>
                  </Box>
                </Box>
              ))}
            </Box>
            <Text bold>Task graph</Text>
            {current.tasks.map((task) => (
              <Text key={task.id}>{statusGlyph(task.state, noColor)} {task.title} [{task.state}]</Text>
            ))}
          </Box>
          <Box flexDirection="column" width={wide ? "42%" : undefined} borderStyle="single" paddingX={1}>
            <Text bold>Event stream</Text>
            {snapshot.events.slice(-10).reverse().map((event) => (
              <Text key={event.eventId} wrap="truncate">{event.sequence.toString().padStart(4, "0")} {sanitizeTerminal(event.eventType, 80)}</Text>
            ))}
            <Text bold>Approvals: {current.approvalIds.length}</Text>
            <Text>Cost: ${current.costUsd.toFixed(4)} USD</Text>
          </Box>
        </Box>
      ) : <Text>No runs yet. Use: agent-company run "your objective"</Text>}
      <Box marginTop={1} justifyContent="space-between">
        <Text dimColor>1 Dashboard  2 Agents  3 Tasks  4 Approvals  / Search</Text>
        <Text dimColor>q Leave · ? Help</Text>
      </Box>
    </Box>
  );
}

export function renderPlainDashboard(snapshot: ControllerSnapshot, width = 80): string {
  const run = snapshot.runs[0];
  const lines = [
    `AGENT COMPANY | ${safe(snapshot.projectName, width)} | ${run?.state ?? "NO RUN"}`,
    "-".repeat(Math.min(width, 80)),
  ];
  if (!run) return [...lines, "No runs yet.", "Next: agent-company run \"your objective\""].join("\n");
  lines.push(`Run: ${shortId(run.id)} | Active agents: ${run.agents.length}/25 | Approvals: ${run.approvalIds.length}`);
  lines.push(`Objective: ${safe(run.objective, Math.max(20, width - 11))}`);
  lines.push("Tasks:");
  for (const task of run.tasks) lines.push(`  ${statusGlyph(task.state, true)} [${task.state}] ${safe(task.title, Math.max(20, width - 20))}`);
  lines.push("Agents:");
  for (const agent of run.agents.slice(0, width < 70 ? 4 : 12)) lines.push(`  ${statusGlyph(agent.state, true)} ${agent.displayName}: ${agent.state}`);
  lines.push(`Cost: $${run.costUsd.toFixed(4)} USD`);
  lines.push("Next: agent-company approvals list | agent-company events list");
  return lines.join("\n");
}

export function openDashboard(snapshot: ControllerSnapshot, options: DashboardOptions = {}): void {
  if (!process.stdout.isTTY || options.width !== undefined) {
    process.stdout.write(`${renderPlainDashboard(snapshot, (options.width ?? process.stdout.columns) || 80)}\n`);
    return;
  }
  render(<Dashboard snapshot={snapshot} noColor={options.noColor ?? false}/>);
}

function safe(value: string, length: number): string {
  const sanitized = sanitizeTerminal(value, length);
  return sanitized.length <= length ? sanitized : `${sanitized.slice(0, Math.max(1, length - 1))}…`;
}

function shortId(value: string): string {
  return value.length <= 24 ? value : `${value.slice(0, 10)}…${value.slice(-8)}`;
}

function statusGlyph(state: string, plain: boolean): string {
  if (/SUCCEEDED|PASSED|COMPLETE/u.test(state)) return plain ? "[OK]" : "✓";
  if (/FAILED|CANCELED|DENIED/u.test(state)) return plain ? "[X]" : "✕";
  if (/WAITING|BLOCKED|PAUSED/u.test(state)) return plain ? "[!]" : "◆";
  if (/RUNNING|CLAIMED|PLANNING/u.test(state)) return plain ? "[>]" : "●";
  return plain ? "[ ]" : "○";
}

function statusColor(state: string): "green" | "red" | "yellow" | "cyan" | undefined {
  if (/SUCCEEDED|PASSED/u.test(state)) return "green";
  if (/FAILED|CANCELED/u.test(state)) return "red";
  if (/WAITING|BLOCKED|PAUSED/u.test(state)) return "yellow";
  if (/RUNNING|PLANNING/u.test(state)) return "cyan";
  return undefined;
}
