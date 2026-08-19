export type CommandAvailability = "implemented" | "planned";

export interface CommandDefinition {
  readonly path: string;
  readonly summary: string;
  readonly mutates: boolean;
  readonly connected: boolean;
  readonly availability: CommandAvailability;
}

const implemented = new Set([
  "init", "start", "run", "resume", "pause", "cancel",
  "projects list", "projects show", "runs list", "runs show",
  "tasks list", "tasks graph", "agents list",
  "approvals list", "approvals show", "approvals approve", "approvals deny",
  "attachments add", "attachments add-dir", "attachments scan",
  "integrations catalog", "integrations test", "integrations list",
  "project inspect", "repo status", "repo branch", "repo push",
  "pr plan", "pr open", "pr update", "pr checks", "pr comment", "pr request-review", "pr merge",
  "deploy plan", "deploy preview", "deploy staging", "deploy production", "deploy promote", "deploy status", "deploy logs", "deploy cancel", "deploy rollback",
  "database diff", "database lint", "database plan", "database rehearse", "database migrate", "database verify", "database rollback", "database ledger",
  "events list", "cost summary", "state check", "doctor", "version", "config path",
  "commands", "artifacts list", "artifacts show", "artifacts verify",
  "changes status", "changes diff", "changes files",
  "providers list", "providers add", "providers show", "providers test", "providers enable", "providers disable", "providers remove",
  "models list", "models use", "tokens mode", "tokens status", "secrets list", "secrets test", "setup",
]);

const mutationPrefixes = [
  "start", "run", "resume", "pause", "cancel", "projects create", "projects use", "projects archive",
  "projects import", "tasks retry", "tasks cancel", "tasks take", "tasks release", "tasks message",
  "agents activate", "agents stop", "agents message", "approvals approve", "approvals deny",
  "approvals request-changes", "artifacts export", "changes patch", "tests run", "cost set-budget",
  "providers add", "providers enable", "providers disable", "providers remove", "config set", "config unset",
  "models use", "tokens mode",
  "secrets add", "secrets remove", "notifications add", "notifications mute", "notifications unmute",
  "notifications remove", "plugin add", "plugin disable", "state restore", "telemetry enable", "telemetry disable",
  "attachments add", "attachments add-dir", "repo push", "pr open", "pr update", "pr comment",
  "pr request-review", "pr merge", "deploy preview", "deploy staging", "deploy production", "deploy promote",
  "deploy cancel", "deploy rollback", "database rehearse", "database migrate", "database rollback",
  "edge deploy", "env set", "webhooks add", "webhooks remove", "remote reconcile", "remote cancel",
];

const connectedPrefixes = [
  "integrations", "bindings", "remote", "repo", "pr", "deploy", "database", "edge", "env", "webhooks",
  "project import", "project link", "project inspect",
];

const catalog: ReadonlyArray<readonly [string, string]> = [
  ["init", "Initialize or preview project configuration"],
  ["start", "Create a run and open the project room"],
  ["run", "Create a non-interactive run"],
  ["session join", "Join a controller session"],
  ["resume", "Resume a persisted run"], ["pause", "Pause a running run"], ["cancel", "Cancel a run"],
  ...family("projects", ["list", "create", "show", "use", "archive", "export", "import"]),
  ...family("runs", ["list", "show", "watch", "export", "archive"]),
  ...family("tasks", ["list", "show", "graph", "retry", "cancel", "take", "release", "message"]),
  ...family("agents", ["list", "show", "activate", "stop", "message", "logs"]),
  ...family("approvals", ["list", "show", "approve", "deny", "request-changes", "watch"]),
  ...family("artifacts", ["list", "show", "open", "export", "verify"]),
  ...family("changes", ["status", "diff", "files", "patch"]),
  ...family("tests", ["list", "show", "run", "watch"]),
  ...family("cost", ["summary", "budget", "set-budget", "export"]),
  ...family("providers", ["list", "add", "show", "test", "enable", "disable", "remove"]),
  ...family("models", ["list", "use", "test", "aliases", "policy"]),
  ...family("tokens", ["mode", "status"]),
  ...family("config", ["path", "get", "set", "unset", "edit", "validate", "export"]),
  ...family("policy", ["show", "validate", "explain"]),
  ...family("secrets", ["list", "add", "test", "remove"]),
  ...family("notifications", ["list", "add", "test", "mute", "unmute", "remove"]),
  ...family("events", ["list", "watch", "export"]),
  ...family("logs", ["show", "follow", "export"]),
  ...family("eval", ["run", "report"]),
  ...family("plugin", ["add", "verify", "list", "doctor", "disable"]),
  ...family("state", ["check", "backup", "restore"]),
  ...family("telemetry", ["status", "preview", "enable", "disable"]),
  ["setup", "Show the shortest secure BYOK setup"],
  ["support-bundle", "Create a redacted diagnostics bundle"], ["doctor", "Run local diagnostics"],
  ["commands", "Search the shared CLI and TUI command registry"],
  ["completion", "Generate shell completion"], ["update check", "Check compatibility updates"],
  ["update instructions", "Show safe update instructions"], ["version", "Show build and protocol versions"],
  ...family("attachments", ["add", "add-dir", "scan"]),
  ...family("integrations", ["catalog", "test", "list"]),
  ...family("bindings", ["list", "show", "verify", "remove"]),
  ...family("project", ["import", "link", "inspect"]),
  ...family("remote", ["inventory", "status", "operations", "reconcile", "cancel", "attest"]),
  ...family("repo", ["status", "branch", "push"]),
  ...family("pr", ["plan", "open", "update", "checks", "comment", "request-review", "merge"]),
  ...family("deploy", ["plan", "preview", "staging", "production", "promote", "status", "logs", "cancel", "rollback"]),
  ...family("database", ["diff", "lint", "plan", "rehearse", "migrate", "verify", "rollback", "ledger"]),
  ...family("edge", ["list", "plan", "deploy", "logs"]),
  ...family("env", ["list", "show", "set", "remove"]),
  ...family("webhooks", ["list", "add", "test", "remove"]),
] as const;

export const COMMANDS: readonly CommandDefinition[] = Object.freeze(catalog.map(([path, summary]) => Object.freeze({
  path,
  summary,
  mutates: mutationPrefixes.some((prefix) => path === prefix || path.startsWith(`${prefix} `)),
  connected: connectedPrefixes.some((prefix) => path === prefix || path.startsWith(`${prefix} `)),
  availability: implemented.has(path) ? "implemented" : "planned",
})));

export function commandByPath(path: string): CommandDefinition | undefined {
  return COMMANDS.find((command) => command.path === path.trim().replace(/\s+/gu, " "));
}

export function commandPalette(query = ""): readonly CommandDefinition[] {
  const normalized = query.trim().toLowerCase();
  return COMMANDS.filter((command) => normalized === "" || `${command.path} ${command.summary}`.toLowerCase().includes(normalized));
}

function family(name: string, children: readonly string[]): ReadonlyArray<readonly [string, string]> {
  return children.map((child) => [`${name} ${child}`, `${title(child)} ${title(name)}`] as const);
}

function title(value: string): string {
  return value.replaceAll("-", " ").replace(/^./u, (character) => character.toUpperCase());
}
