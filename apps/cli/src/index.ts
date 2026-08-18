import {basename, join, resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {Command, CommanderError, Option} from "commander";
import {GitHubConnector} from "../../../adapters/github/src/index.js";
import {SupabaseConnector} from "../../../adapters/supabase/src/index.js";
import {VercelConnector} from "../../../adapters/vercel/src/index.js";
import type {ControllerSnapshot, RunView} from "../../control-plane/src/controller.js";
import {startControllerDaemon, type StartedControllerDaemon} from "../../controller-daemon/src/index.js";
import {openDashboard, renderPlainDashboard} from "../../operator-console/src/dashboard.js";
import {ArtifactStore} from "../../../packages/artifact-store/src/index.js";
import {AttachmentError, AttachmentService} from "../../../packages/attachments/src/index.js";
import {createAction, runConnectorCli, type Connector} from "../../../packages/connectors/src/index.js";
import {initializeProject, projectFiles, resolvePlatformPaths} from "../../../packages/config/src/index.js";
import {commandPalette} from "../../../packages/command-registry/src/index.js";
import {sanitizeTerminal} from "../../../packages/observability/src/index.js";
import {ControllerIpcClient, ControllerIpcError} from "../../../packages/ipc/src/index.js";
import {EXIT_CODES, emit, emitError, processIo, type Io, type OutputMode} from "./output.js";

const VERSION = "0.2.0";
const BUILD = "blueprint-v0.2";

interface Runtime {
  exitCode: number;
  readonly io: Io;
}

interface GlobalOptions {
  readonly project?: string;
  readonly run?: string;
  readonly workspace?: string;
  readonly profile?: string;
  readonly config?: string;
  readonly json?: boolean;
  readonly ndjson?: boolean;
  readonly plain?: boolean;
  readonly color?: boolean;
  readonly unicode?: "auto" | "on" | "off";
  readonly nonInteractive?: boolean;
  readonly offline?: boolean;
  readonly timeout?: string;
  readonly logLevel?: string;
  readonly traceId?: string;
  readonly redact?: string;
}

const CONNECTOR_MAP: Readonly<Record<string, Connector>> = {
  github: new GitHubConnector(),
  vercel: new VercelConnector(),
  supabase: new SupabaseConnector(),
};

export async function runCli(argv: readonly string[] = process.argv, io: Io = processIo): Promise<number> {
  const runtime: Runtime = {exitCode: EXIT_CODES.SUCCESS, io};
  const program = buildProgram(runtime);
  program.exitOverride();
  try {
    await program.parseAsync([...argv], {from: "node"});
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.code === "commander.helpDisplayed" || error.code === "commander.version") return runtime.exitCode;
      emitError(io, mode(program.opts()), "USAGE_ERROR", error.message, "agent-company help");
      return EXIT_CODES.USAGE;
    }
    const normalized = normalizeError(error);
    emitError(io, mode(program.opts()), normalized.code, normalized.message, normalized.next);
    return normalized.exitCode;
  }
  return runtime.exitCode;
}

function buildProgram(runtime: Runtime): Command {
  const program = new Command();
  program
    .name("agent-company")
    .description("A visible, governed software-delivery organization in your terminal")
    .version(`${VERSION} (${BUILD}; schema v1; plugin API v1)`, "-V, --version")
    .option("-p, --project <id-or-path>", "select a project path")
    .option("-r, --run <run-id>", "select a run")
    .option("--workspace <name>", "reserved workspace selector (rejected in v0.2)")
    .option("--profile <name>", "reserved profile selector (rejected in v0.2)")
    .option("--config <path>", "reserved override path (rejected in v0.2)")
    .option("--json", "emit one JSON result")
    .option("--ndjson", "emit newline-delimited events/results")
    .option("--plain", "stable output without cursor control")
    .option("--no-color", "disable ANSI color")
    .addOption(new Option("--unicode <mode>", "symbol mode").choices(["auto", "on", "off"]).default("auto"))
    .option("--non-interactive", "never prompt")
    .option("--offline", "block provider/network use")
    .option("--timeout <duration>", "reserved foreground timeout (rejected in v0.2)")
    .option("--log-level <level>", "reserved diagnostic level (rejected in v0.2)")
    .option("--trace-id <id>", "reserved correlation ID (rejected in v0.2)")
    .option("--redact <level>", "redaction level", "standard")
    .option("-y, --yes", "accept ordinary local confirmations only")
    .action(async (_options: unknown, command: Command) => {
      const globals = global(command);
      await withController(globals, async (controller) => {
        const snapshot = await controller.snapshot();
        if (machine(globals)) emit(runtime.io, mode(globals), "snapshot", snapshot);
        else if (globals.plain || !process.stdout.isTTY) runtime.io.stdout(`${renderPlainDashboard(snapshot, process.stdout.columns || 80)}\n`);
        else openDashboard(snapshot, {noColor: globals.color === false});
      });
    });

  program.command("init [path]")
    .description("preview or create project configuration")
    .option("--name <name>", "project name")
    .option("--mode <mode>", "reserved supervision mode override")
    .option("--repo <mode>", "reserved repository mode override")
    .option("--git-strategy <strategy>", "reserved workspace strategy override")
    .option("--no-write", "preview without writing")
    .action(async (path: string | undefined, options: {name?: string; write: boolean; mode?: string; repo?: string; gitStrategy?: string}, command: Command) => {
      const globals = global(command);
      if (options.mode !== undefined || options.repo !== undefined || options.gitStrategy !== undefined) {
        throw new CliError("CAPABILITY_UNAVAILABLE", "init mode, repository mode, and git strategy overrides are reserved in v0.2", EXIT_CODES.CAPABILITY_UNAVAILABLE);
      }
      const workspace = resolve(path ?? globals.project ?? process.cwd());
      const name = options.name ?? basename(workspace);
      const result = await initializeProject(workspace, name, options.write);
      emit(runtime.io, mode(globals), options.write ? "project.initialized" : "project.preview", {
        project: name,
        workspace,
        files: result.planned,
        wroteFiles: result.created,
        alreadyInitialized: options.write && result.created.length === 0,
        secretsStored: false,
        next: options.write ? `agent-company --project "${workspace}" start` : "rerun without --no-write",
      });
    });

  for (const name of ["start", "run"] as const) {
    program.command(`${name} [request...]`)
      .description(name === "start" ? "create a run and open its project room" : "create a headless run")
      .option("--file <path>", "use a scanned attachment as the request")
      .option("--stdin", "read the request from stdin")
      .option("--plan-only", "stop at the plan approval")
      .option("--budget <amount>", "run budget")
      .option("--max-parallel <count>", "maximum parallel tasks")
      .option("--background", "print the run ID without opening the TUI")
      .action(async (request: string[], options: {file?: string; stdin?: boolean; background?: boolean; budget?: string; maxParallel?: string}, command: Command) => {
        const globals = global(command);
        if (options.budget !== undefined || options.maxParallel !== undefined) {
          throw new CliError("CAPABILITY_UNAVAILABLE", "run-scoped budget and parallelism overrides are reserved in v0.2", EXIT_CODES.CAPABILITY_UNAVAILABLE);
        }
        const objective = await resolveRequest(request, options, globals);
        await withController(globals, async (controller) => {
          const run = await controller.createRun(objective);
          if (name === "start" && !machine(globals) && !options.background) {
            openDashboard(await controller.snapshot(), {noColor: globals.color === false});
          } else {
            emit(runtime.io, mode(globals), "run.created", run);
          }
          runtime.exitCode = EXIT_CODES.APPROVAL_REQUIRED;
          if (!machine(globals)) runtime.io.stderr(`Plan approval required: agent-company approvals show ${run.approvalIds[0] ?? "<id>"}\n`);
        });
      });
  }

  for (const name of ["resume", "pause", "cancel"] as const) {
    program.command(`${name} [run-id]`)
      .description(`${name} a persisted run`)
      .action(async (runId: string | undefined, _options: unknown, command: Command) => {
        const globals = global(command);
        await withController(globals, async (controller) => {
          const selected = runId ?? globals.run ?? (await controller.snapshot()).runs[0]?.id;
          if (!selected) throw new CliError("RUN_REQUIRED", "no run was selected", EXIT_CODES.USAGE);
          const result = name === "resume" ? await controller.resume(selected) : name === "pause" ? await controller.pause(selected) : await controller.cancel(selected);
          emit(runtime.io, mode(globals), `run.${name}d`, result);
        });
      });
  }

  addProjectCommands(program, runtime);
  addRunTaskAgentCommands(program, runtime);
  addApprovalCommands(program, runtime);
  addAttachmentCommands(program, runtime);
  addArtifactCommands(program, runtime);
  addChangeCommands(program, runtime);
  addIntegrationCommands(program, runtime);
  addConnectedOperationCommands(program, runtime);
  addInspectionCommands(program, runtime);
  addUtilityCommands(program, runtime);
  return program;
}

function addProjectCommands(program: Command, runtime: Runtime): void {
  const projects = program.command("projects").description("manage Agent Company projects");
  projects.command("show [project]").action(async (_project: string | undefined, _options: unknown, command: Command) => {
    const globals = global(command);
    await withController(globals, async (controller) => {
      const snapshot = await controller.snapshot();
      emit(runtime.io, mode(globals), "project", {id: snapshot.projectId, name: snapshot.projectName, path: workspace(globals)});
    });
  });
  projects.command("list").action((_options: unknown, command: Command) => {
    const globals = global(command);
    emit(runtime.io, mode(globals), "projects", [{path: workspace(globals), selected: true}]);
  });
  const project = program.command("project").description("inspect connected project mapping");
  project.command("inspect").action((_options: unknown, command: Command) => {
    const globals = global(command);
    const files = projectFiles(workspace(globals));
    emit(runtime.io, mode(globals), "project.mapping", {workspace: workspace(globals), projectFile: files.projectFile, policyFile: files.policyFile});
  });
}

function addRunTaskAgentCommands(program: Command, runtime: Runtime): void {
  const runs = program.command("runs").description("inspect runs");
  runs.command("list").action(async (_options: unknown, command: Command) => {
    const globals = global(command);
    await withController(globals, async (controller) => emit(runtime.io, mode(globals), "runs", (await controller.snapshot()).runs));
  });
  runs.command("show [run-id]").action(async (runId: string | undefined, _options: unknown, command: Command) => {
    const globals = global(command);
    await withController(globals, async (controller) => {
      const snapshot = await controller.snapshot();
      emit(runtime.io, mode(globals), "run", await controller.getRun(runId ?? globals.run ?? snapshot.runs[0]?.id ?? ""));
    });
  });
  const tasks = program.command("tasks").description("inspect task DAG");
  tasks.command("list").action(async (_options: unknown, command: Command) => {
    const globals = global(command);
    await withController(globals, async (controller) => emit(runtime.io, mode(globals), "tasks", (await controller.snapshot()).runs[0]?.tasks ?? []));
  });
  tasks.command("graph [run-id]").action(async (runId: string | undefined, _options: unknown, command: Command) => {
    const globals = global(command);
    await withController(globals, async (controller) => {
      const snapshot = await controller.snapshot();
      const run = await controller.getRun(runId ?? globals.run ?? snapshot.runs[0]?.id ?? "");
      emit(runtime.io, mode(globals), "task.graph", run.tasks.map((task) => ({id: task.id, state: task.state, dependsOn: task.dependsOn})));
    });
  });
  const agents = program.command("agents").description("inspect the 25-agent catalog and instances");
  agents.command("list").action(async (_options: unknown, command: Command) => {
    const globals = global(command);
    await withController(globals, async (controller) => emit(runtime.io, mode(globals), "agents", (await controller.snapshot()).runs[0]?.agents ?? []));
  });
}

function addApprovalCommands(program: Command, runtime: Runtime): void {
  const approvals = program.command("approvals").description("review exact human decisions");
  approvals.command("list").action(async (_options: unknown, command: Command) => {
    const globals = global(command);
    await withController(globals, async (controller) => emit(runtime.io, mode(globals), "approvals", await controller.listApprovals()));
  });
  approvals.command("show <approval-id>").action(async (id: string, _options: unknown, command: Command) => {
    const globals = global(command);
    await withController(globals, async (controller) => {
      const approval = (await controller.listApprovals()).find((candidate) => candidate.approvalId === id);
      if (!approval) throw new CliError("APPROVAL_NOT_FOUND", `unknown approval: ${id}`, EXIT_CODES.USAGE);
      emit(runtime.io, mode(globals), "approval", approval);
    });
  });
  approvals.command("approve <approval-id>").option("--reason <reason>").action(async (id: string, options: {reason?: string}, command: Command) => {
    const globals = global(command);
    await withController(globals, async (controller) => emit(runtime.io, mode(globals), "approval.approved", await controller.approve(id, options.reason)));
  });
  approvals.command("deny <approval-id>").option("--reason <reason>").action(async (id: string, options: {reason?: string}, command: Command) => {
    const globals = global(command);
    await withController(globals, async (controller) => emit(runtime.io, mode(globals), "approval.denied", await controller.deny(id, options.reason)));
  });
}

function addAttachmentCommands(program: Command, runtime: Runtime): void {
  const attachments = program.command("attachments").description("ingest local files without implicit transfer");
  attachments.command("add <path>").action(async (path: string, _options: unknown, command: Command) => {
    const globals = global(command);
    const service = attachmentService(globals);
    emit(runtime.io, mode(globals), "attachment.receipt", await service.ingestFile(path));
  });
  attachments.command("add-dir <path>").action(async (path: string, _options: unknown, command: Command) => {
    const globals = global(command);
    const service = attachmentService(globals);
    emit(runtime.io, mode(globals), "attachment.receipt", await service.ingestDirectory(path));
  });
  attachments.command("scan <path>").action(async (path: string, _options: unknown, command: Command) => {
    const globals = global(command);
    const service = attachmentService(globals);
    emit(runtime.io, mode(globals), "attachment.scan", await service.ingestFile(path));
  });
}

function addArtifactCommands(program: Command, runtime: Runtime): void {
  const artifacts = program.command("artifacts").description("inspect immutable local artifacts");
  artifacts.command("list").action(async (_options: unknown, command: Command) => {
    const globals = global(command);
    emit(runtime.io, mode(globals), "artifacts", await artifactStore(globals).list());
  });
  artifacts.command("show <artifact-id>").action(async (artifactId: string, _options: unknown, command: Command) => {
    const globals = global(command);
    emit(runtime.io, mode(globals), "artifact", await artifactStore(globals).getManifest(artifactId));
  });
  artifacts.command("verify <artifact-id>").action(async (artifactId: string, _options: unknown, command: Command) => {
    const globals = global(command);
    const store = artifactStore(globals);
    const manifest = await store.getManifest(artifactId);
    const valid = await store.verify(manifest.sha256);
    emit(runtime.io, mode(globals), "artifact.verification", {artifactId, sha256: manifest.sha256, valid});
    if (!valid) runtime.exitCode = EXIT_CODES.ACTION_FAILED;
  });
}

function addChangeCommands(program: Command, runtime: Runtime): void {
  const changes = program.command("changes").description("inspect repository changes without granting mutation authority");
  changes.command("status").action(async (_options: unknown, command: Command) => {
    const globals = global(command);
    const result = await runConnectorCli("git", ["status", "--short", "--branch"], {cwd: workspace(globals)});
    emit(runtime.io, mode(globals), "changes.status", {exitCode: result.exitCode, output: result.stdout || result.stderr});
  });
  changes.command("diff").option("--staged", "show staged changes").action(async (options: {staged?: boolean}, command: Command) => {
    const globals = global(command);
    const args = ["diff", "--no-ext-diff", "--no-color", ...(options.staged ? ["--cached"] : [])];
    const result = await runConnectorCli("git", args, {cwd: workspace(globals), maxBytes: 4 * 1024 * 1024});
    emit(runtime.io, mode(globals), "changes.diff", {exitCode: result.exitCode, patch: result.stdout || result.stderr});
  });
  changes.command("files").action(async (_options: unknown, command: Command) => {
    const globals = global(command);
    const result = await runConnectorCli("git", ["status", "--porcelain=v1", "-z"], {cwd: workspace(globals)});
    const files = result.stdout.split("\0").filter(Boolean).map((entry) => ({status: entry.slice(0, 2), path: entry.slice(3)}));
    emit(runtime.io, mode(globals), "changes.files", {exitCode: result.exitCode, files});
  });
}

function addIntegrationCommands(program: Command, runtime: Runtime): void {
  const integrations = program.command("integrations").description("connected-platform catalog");
  integrations.command("catalog").action((_options: unknown, command: Command) => {
    const globals = global(command);
    emit(runtime.io, mode(globals), "integrations.catalog", Object.values(CONNECTOR_MAP).map((connector) => connector.manifest));
  });
  integrations.command("test <connector>").action(async (id: string, _options: unknown, command: Command) => {
    const globals = global(command);
    if (globals.offline) throw new CliError("OFFLINE_MODE", "connector tests are unavailable in offline mode", EXIT_CODES.CAPABILITY_UNAVAILABLE);
    emit(runtime.io, mode(globals), "integration.probe", await connector(id).probe());
  });
  integrations.command("list [connector]").action(async (id: string | undefined, _options: unknown, command: Command) => {
    const globals = global(command);
    if (globals.offline) throw new CliError("OFFLINE_MODE", "remote inventory is unavailable in offline mode", EXIT_CODES.CAPABILITY_UNAVAILABLE);
    if (id) emit(runtime.io, mode(globals), "integration.inventory", await connector(id).inventory());
    else emit(runtime.io, mode(globals), "integrations", await Promise.all(Object.values(CONNECTOR_MAP).map((item) => item.probe())));
  });
}

function addConnectedOperationCommands(program: Command, runtime: Runtime): void {
  const repo = program.command("repo").description("governed repository operations");
  repo.command("status").action(async (_options: unknown, command: Command) => {
    const globals = global(command);
    const result = await runConnectorCli("git", ["status", "--short", "--branch"], {cwd: workspace(globals)});
    emit(runtime.io, mode(globals), "repo.status", {exitCode: result.exitCode, output: result.stdout || result.stderr});
  });
  repo.command("branch").action(async (_options: unknown, command: Command) => {
    const globals = global(command);
    const result = await runConnectorCli("git", ["branch", "--show-current"], {cwd: workspace(globals)});
    emit(runtime.io, mode(globals), "repo.branch", {branch: result.stdout.trim()});
  });
  repo.command("push").option("--plan", "plan only").option("--remote <remote>", "remote", "origin").option("--branch <branch>").action((options: {plan?: boolean; remote: string; branch?: string}, command: Command) => {
    const globals = global(command);
    const action = createAction({connectorId: "github", capability: "branch:push", targetRef: `${options.remote}/${options.branch ?? "HEAD"}`, arguments: options});
    emit(runtime.io, mode(globals), "connector.action.plan", action);
    if (!options.plan) runtime.exitCode = EXIT_CODES.APPROVAL_REQUIRED;
  });
  const pr = program.command("pr").description("governed pull-request operations");
  for (const leaf of ["plan", "open", "update", "checks", "comment", "request-review", "merge"]) {
    pr.command(`${leaf} [target]`).action((target: string | undefined, _options: unknown, command: Command) => plannedOperation(runtime, command, "github", `pull-request:${leaf}`, target ?? "current-repository", ["plan", "checks"].includes(leaf) ? "A0_OBSERVE" : undefined));
  }
  const deploy = program.command("deploy").description("governed Vercel operations");
  for (const leaf of ["plan", "preview", "staging", "production", "promote", "status", "logs", "cancel", "rollback"]) {
    deploy.command(`${leaf} [target]`).action((target: string | undefined, _options: unknown, command: Command) => plannedOperation(runtime, command, "vercel", `deployment:${leaf}`, target ?? "bound-project", ["status", "logs", "plan"].includes(leaf) ? "A0_OBSERVE" : undefined, ["production", "promote", "rollback"].includes(leaf) ? "production" : "preview"));
  }
  const database = program.command("database").description("governed Supabase database operations");
  for (const leaf of ["diff", "lint", "plan", "rehearse", "migrate", "verify", "rollback", "ledger"]) {
    database.command(`${leaf} [target]`).option("--environment <environment>", "environment", "staging").action((target: string | undefined, options: {environment: string}, command: Command) => plannedOperation(runtime, command, "supabase", `migration:${leaf}`, target ?? "bound-project", ["diff", "lint", "plan", "verify", "ledger"].includes(leaf) ? "A0_OBSERVE" : undefined, options.environment));
  }
}

function addInspectionCommands(program: Command, runtime: Runtime): void {
  const events = program.command("events").description("inspect append-only events");
  events.command("list [run-id]").action(async (runId: string | undefined, _options: unknown, command: Command) => {
    const globals = global(command);
    await withController(globals, async (controller) => {
      const all = (await controller.snapshot()).events;
      emit(runtime.io, mode(globals), "events", runId ? all.filter((event) => event.streamId === runId) : all);
    });
  });
  const cost = program.command("cost").description("inspect metered usage");
  cost.command("summary [run-id]").action(async (runId: string | undefined, _options: unknown, command: Command) => {
    const globals = global(command);
    await withController(globals, async (controller) => {
      const snapshot = await controller.snapshot();
      const run = await controller.getRun(runId ?? globals.run ?? snapshot.runs[0]?.id ?? "");
      emit(runtime.io, mode(globals), "cost.summary", {runId: run.id, actualUsd: run.costUsd, unpricedUsage: false, currency: "USD"});
    });
  });
  const state = program.command("state").description("check and recover durable state");
  state.command("check").action(async (_options: unknown, command: Command) => {
    const globals = global(command);
    await withController(globals, async (controller) => {
      const snapshot = await controller.snapshot();
      emit(runtime.io, mode(globals), "state.check", {healthy: true, projectId: snapshot.projectId, eventCount: snapshot.events.length, runCount: snapshot.runs.length});
    });
  });
}

function addUtilityCommands(program: Command, runtime: Runtime): void {
  program.command("commands [query]").description("search the shared command registry").action((query: string | undefined, _options: unknown, command: Command) => {
    const globals = global(command);
    emit(runtime.io, mode(globals), "commands", commandPalette(query));
  });
  program.command("doctor").description("run non-mutating environment diagnostics").action(async (_options: unknown, command: Command) => {
    const globals = global(command);
    const tools = await Promise.all([
      runConnectorCli("git", ["--version"]).catch(() => undefined),
      ...(globals.offline ? [] : Object.values(CONNECTOR_MAP).map((item) => item.probe())),
    ]);
    emit(runtime.io, mode(globals), "doctor", {
      healthy: tools[0]?.exitCode === 0,
      node: process.version,
      platform: process.platform,
      git: tools[0] ? tools[0].stdout.trim() : "unavailable",
      connectors: globals.offline
        ? Object.keys(CONNECTOR_MAP).map((connectorId) => ({connectorId, state: "UNAVAILABLE", details: ["offline mode: probe not attempted"]}))
        : tools.slice(1),
      telemetry: "off",
      secretsPrinted: false,
    });
  });
  program.command("version").action((_options: unknown, command: Command) => {
    const globals = global(command);
    emit(runtime.io, mode(globals), "version", {version: VERSION, build: BUILD, schemaVersion: 1, pluginApiVersion: 1, node: process.version});
  });
  const config = program.command("config").description("inspect effective configuration");
  config.command("path").action((_options: unknown, command: Command) => {
    const globals = global(command);
    emit(runtime.io, mode(globals), "config.paths", {platform: resolvePlatformPaths(), project: projectFiles(workspace(globals))});
  });
  program.command("completion <shell>").description("print shell completion guidance").action((shell: string, _options: unknown, command: Command) => {
    const globals = global(command);
    emit(runtime.io, mode(globals), "completion", `Completion generation for ${shell} is reserved by the command registry; use 'agent-company help' today.`);
  });
}

function plannedOperation(
  runtime: Runtime,
  command: Command,
  connectorId: string,
  capability: string,
  targetRef: string,
  risk?: Parameters<typeof createAction>[0]["risk"],
  environment = "preview",
): void {
  const globals = global(command);
  const action = createAction({connectorId, capability, targetRef, environment, ...(risk ? {risk} : {})});
  emit(runtime.io, mode(globals), "connector.action.plan", action);
  if (action.risk.class !== "A0_OBSERVE") runtime.exitCode = EXIT_CODES.APPROVAL_REQUIRED;
}

async function resolveRequest(
  positional: readonly string[],
  options: {readonly file?: string; readonly stdin?: boolean},
  globals: GlobalOptions,
): Promise<string> {
  const sources = Number(positional.length > 0) + Number(options.file !== undefined) + Number(options.stdin === true);
  if (sources !== 1) throw new CliError("REQUEST_SOURCE", "provide exactly one of request text, --file, or --stdin", EXIT_CODES.USAGE);
  if (options.file) {
    const service = attachmentService(globals);
    const receipt = await service.ingestFile(options.file);
    if (receipt.state !== "READY") throw new CliError("ATTACHMENT_BLOCKED", `request attachment is ${receipt.state}`, EXIT_CODES.POLICY_DENIED);
    return `Use local attachment ${receipt.attachment_id} (${receipt.source.display_name}); no external transfer is authorized.`;
  }
  if (options.stdin) return readStdin();
  return positional.join(" ");
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin as AsyncIterable<Buffer | string>) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

class ControllerClientFacade {
  public constructor(private readonly client: ControllerIpcClient) {}

  public snapshot(): Promise<ControllerSnapshot> {
    return this.client.request("snapshot", {});
  }

  public async getRun(runId: string): Promise<RunView> {
    const run = (await this.snapshot()).runs.find((candidate) => candidate.id === runId);
    if (!run) throw new CliError("RUN_NOT_FOUND", `unknown run: ${runId}`, EXIT_CODES.USAGE);
    return run;
  }

  public createRun(objective: string) {
    return this.client.request("createRun", {objective});
  }

  public listApprovals(runId?: string) {
    return this.client.request("listApprovals", runId === undefined ? {} : {runId});
  }

  public approve(approvalId: string, reason?: string) {
    return this.client.request("approve", reason === undefined ? {approvalId} : {approvalId, reason});
  }

  public deny(approvalId: string, reason?: string) {
    return this.client.request("deny", reason === undefined ? {approvalId} : {approvalId, reason});
  }

  public resume(runId: string) {
    return this.client.request("resume", {runId}, {timeoutMs: 60 * 60 * 1000});
  }

  public pause(runId: string) {
    return this.client.request("pause", {runId});
  }

  public cancel(runId: string) {
    return this.client.request("cancel", {runId});
  }
}

async function withController<T>(globals: GlobalOptions, callback: (controller: ControllerClientFacade) => Promise<T> | T): Promise<T> {
  const selectedWorkspace = workspace(globals);
  let daemon: StartedControllerDaemon | undefined;
  let client: ControllerIpcClient;
  try {
    client = await ControllerIpcClient.connect({workspace: selectedWorkspace});
  } catch (connectError) {
    try {
      daemon = await startControllerDaemon({workspace: selectedWorkspace, heartbeatIntervalMs: 1_000});
    } catch (startError) {
      if (!(startError instanceof ControllerIpcError) || startError.code !== "CONTROLLER_ALREADY_RUNNING") throw startError;
    }
    client = await connectWithRetry(selectedWorkspace, connectError);
  }
  try {
    return await callback(new ControllerClientFacade(client));
  } finally {
    await client.close();
    await daemon?.close();
  }
}

async function connectWithRetry(selectedWorkspace: string, originalError: unknown): Promise<ControllerIpcClient> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      return await ControllerIpcClient.connect({workspace: selectedWorkspace});
    } catch {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    }
  }
  throw originalError;
}

function attachmentService(globals: GlobalOptions): AttachmentService {
  const root = workspace(globals);
  return new AttachmentService(artifactStore(globals), {allowedRoots: [root]});
}

function artifactStore(globals: GlobalOptions): ArtifactStore {
  const root = workspace(globals);
  return new ArtifactStore(join(projectFiles(root).directory, "artifacts"));
}

function connector(id: string): Connector {
  const item = CONNECTOR_MAP[id];
  if (!item) throw new CliError("UNKNOWN_CONNECTOR", `unknown connector: ${id}`, EXIT_CODES.USAGE);
  return item;
}

function workspace(options: GlobalOptions): string {
  return resolve(options.project ?? process.cwd());
}

function global(command: Command): GlobalOptions {
  const options = command.optsWithGlobals<GlobalOptions>();
  const reserved = [
    ["--workspace", options.workspace],
    ["--profile", options.profile],
    ["--config", options.config],
    ["--timeout", options.timeout],
    ["--log-level", options.logLevel],
    ["--trace-id", options.traceId],
  ].find(([, value]) => value !== undefined);
  if (reserved !== undefined) {
    throw new CliError("CAPABILITY_UNAVAILABLE", `${reserved[0]} is reserved but not active in v0.2`, EXIT_CODES.CAPABILITY_UNAVAILABLE);
  }
  if (options.unicode !== undefined && options.unicode !== "auto") {
    throw new CliError("CAPABILITY_UNAVAILABLE", "explicit Unicode mode is reserved in v0.2", EXIT_CODES.CAPABILITY_UNAVAILABLE);
  }
  if (options.redact !== undefined && options.redact !== "standard") {
    throw new CliError("CAPABILITY_UNAVAILABLE", "only the standard redaction policy is available in v0.2", EXIT_CODES.CAPABILITY_UNAVAILABLE);
  }
  return options;
}

function machine(options: GlobalOptions): boolean {
  return options.json === true || options.ndjson === true;
}

function mode(options: GlobalOptions): OutputMode {
  return {json: options.json === true, ndjson: options.ndjson === true, plain: options.plain === true};
}

class CliError extends Error {
  public constructor(public readonly code: string, message: string, public readonly exitCode: number, public readonly next?: string) {
    super(message);
    this.name = "CliError";
  }
}

function normalizeError(error: unknown): {code: string; message: string; exitCode: number; next?: string} {
  if (error instanceof CliError) return {code: error.code, message: error.message, exitCode: error.exitCode, ...(error.next ? {next: error.next} : {})};
  if (error instanceof ControllerIpcError) {
    const exitCode = error.code === "APPROVAL_REQUIRED" ? EXIT_CODES.APPROVAL_REQUIRED : error.code.includes("NOT_FOUND") ? EXIT_CODES.USAGE : error.retryable ? EXIT_CODES.TRANSIENT_FAILURE : EXIT_CODES.ACTION_FAILED;
    return {code: error.code, message: error.message, exitCode, next: error.code === "APPROVAL_REQUIRED" ? "agent-company approvals list" : "agent-company doctor"};
  }
  if (error instanceof AttachmentError) return {code: error.code, message: error.message, exitCode: EXIT_CODES.POLICY_DENIED, next: "agent-company attachments scan <path>"};
  if ((error as NodeJS.ErrnoException).code === "ENOENT") return {code: "PROJECT_NOT_INITIALIZED", message: "project configuration was not found", exitCode: EXIT_CODES.USAGE, next: "agent-company init"};
  return {code: "UNEXPECTED_FAILURE", message: sanitizeTerminal(String(error)), exitCode: EXIT_CODES.ACTION_FAILED, next: "agent-company doctor"};
}

async function main(): Promise<void> {
  process.exitCode = await runCli();
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invoked) void main();
