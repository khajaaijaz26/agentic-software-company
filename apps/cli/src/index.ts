import {existsSync} from "node:fs";
import {mkdir} from "node:fs/promises";
import {homedir} from "node:os";
import {basename, dirname, join, resolve} from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";
import {Command, CommanderError, Option} from "commander";
import {GitHubConnector} from "../../../adapters/github/src/index.js";
import {SupabaseConnector} from "../../../adapters/supabase/src/index.js";
import {VercelConnector} from "../../../adapters/vercel/src/index.js";
import type {ControllerSnapshot, RunView} from "../../control-plane/src/controller.js";
import type {StartedControllerDaemon} from "../../controller-daemon/src/index.js";
import {
  createInitialProjectRoomState,
  openProjectRoom,
  projectRoomReducer,
  renderProjectRoomText,
} from "../../operator-console/src/dashboard.js";
import {ArtifactStore} from "../../../packages/artifact-store/src/index.js";
import {AttachmentError, AttachmentService} from "../../../packages/attachments/src/index.js";
import {createAction, runConnectorCli, type Connector} from "../../../packages/connectors/src/index.js";
import {
  initializeProject,
  loadProjectConfig,
  loadUserProviderConfig,
  projectFiles,
  resolvePlatformPaths,
  saveUserProviderConfig,
  setProjectModel,
  setProjectTokenMode,
  userProviderConfigFile,
} from "../../../packages/config/src/index.js";
import {commandPalette} from "../../../packages/command-registry/src/index.js";
import {
  AnthropicMessagesAdapter,
  ModelGateway,
  OpenAIResponsesAdapter,
  ProviderGatewayError,
  parseModelIdentifier,
} from "../../../packages/model-gateway/src/index.js";
import {sanitizeTerminal} from "../../../packages/observability/src/index.js";
import {ControllerIpcClient, ControllerIpcError} from "../../../packages/ipc/src/index.js";
import {
  EnvironmentCredentialBackend,
  SecretBackendBroker,
  SecretUnavailableError,
  UnsupportedCredentialBackendError,
  createPlatformCredentialBackend,
  parseSecretReference,
} from "../../../packages/secret-broker/src/index.js";
import {
  DEFAULT_SPEECH_MODEL,
  DEFAULT_TRANSCRIPTION_MODEL,
  VOICE_ASSISTANT_NAME,
} from "../../../packages/voice-input/src/index.js";
import {EXIT_CODES, emit, emitError, processIo, type Io, type OutputMode} from "./output.js";
import {IpcProjectRoomSource, softwareAgentSnapshotToProjectRoom} from "./project-room-source.js";

const VERSION = "0.7.0";
const BUILD = "software-agent-v0.7.0";
const CLI_NAME = "software-agent";

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
      emitError(io, mode(program.opts()), "USAGE_ERROR", error.message, `${CLI_NAME} help`);
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
    .name(CLI_NAME)
    .description("A visible, governed, voice-enabled team of AI software agents in your terminal")
    .version(`${VERSION} (${BUILD}; schema v1; plugin API v1)`, "-V, --version")
    .option("-p, --project <id-or-path>", "select a project path")
    .option("-r, --run <run-id>", "select a run")
    .option("--workspace <name>", "reserved workspace selector (rejected in v0.7)")
    .option("--profile <name>", "reserved profile selector (rejected in v0.7)")
    .option("--config <path>", "reserved override path (rejected in v0.7)")
    .option("--json", "emit one JSON result")
    .option("--ndjson", "emit newline-delimited events/results")
    .option("--plain", "stable output without cursor control")
    .option("--no-color", "disable ANSI color")
    .addOption(new Option("--unicode <mode>", "symbol mode").choices(["auto", "on", "off"]).default("auto"))
    .option("--non-interactive", "never prompt")
    .option("--offline", "block provider/network use")
    .option("--timeout <duration>", "reserved foreground timeout (rejected in v0.7)")
    .option("--log-level <level>", "reserved diagnostic level (rejected in v0.7)")
    .option("--trace-id <id>", "reserved correlation ID (rejected in v0.7)")
    .option("--redact <level>", "redaction level", "standard")
    .option("-y, --yes", "accept ordinary local confirmations only")
    .action(async (_options: unknown, command: Command) => {
      const globals = global(command);
      await ensureInitialized(workspace(globals));
      await withController(globals, async (controller) => {
        const source = await controller.projectRoomSource({
          branch: await currentBranch(workspace(globals)),
          offline: globals.offline === true,
          ...(globals.run === undefined ? {} : {runId: globals.run}),
        });
        try {
          await presentProjectRoom(runtime, globals, source);
        } finally {
          await source.dispose();
        }
      });
    });

  program.command("open [target]")
    .description("open a local project or securely check out a GitHub repository")
    .option("--github", "treat OWNER/REPO as a GitHub repository")
    .option("--destination <path>", "local destination for a GitHub checkout")
    .action(async (target: string | undefined, options: {github?: boolean; destination?: string}, command: Command) => {
      const globals = global(command);
      const selectedWorkspace = await resolveOpenWorkspace(target ?? globals.project ?? process.cwd(), options);
      await ensureInitialized(selectedWorkspace);
      const selectedGlobals: GlobalOptions = {...globals, project: selectedWorkspace};
      await withController(selectedGlobals, async (controller) => {
        const source = await controller.projectRoomSource({branch: await currentBranch(selectedWorkspace), offline: globals.offline === true});
        try {
          await presentProjectRoom(runtime, selectedGlobals, source);
        } finally {
          await source.dispose();
        }
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
        throw new CliError("CAPABILITY_UNAVAILABLE", "init mode, repository mode, and git strategy overrides are reserved in v0.7", EXIT_CODES.CAPABILITY_UNAVAILABLE);
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
        next: options.write ? `${CLI_NAME} --project "${workspace}" start` : "rerun without --no-write",
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
      .action(async (request: string[], options: {file?: string; stdin?: boolean; planOnly?: boolean; background?: boolean; budget?: string; maxParallel?: string}, command: Command) => {
        const globals = global(command);
        if (options.planOnly) {
          throw new CliError("CAPABILITY_UNAVAILABLE", "--plan-only is not available in the live v0.7 scheduler yet", EXIT_CODES.CAPABILITY_UNAVAILABLE);
        }
        if (options.budget !== undefined && !["economy", "balanced", "quality"].includes(options.budget)) {
          throw new CliError("BUDGET_MODE_INVALID", "--budget must be economy, balanced, or quality", EXIT_CODES.USAGE);
        }
        const maxParallel = parseIntegerOption(options.maxParallel, 1, 3, "--max-parallel") ?? 3;
        const objective = await resolveRequest(request, options, globals);
        await ensureInitialized(workspace(globals));
        await withController(globals, async (controller) => {
          const source = await controller.projectRoomSource({
            branch: await currentBranch(workspace(globals)),
            offline: globals.offline === true,
            maxParallel,
            ...(options.budget === undefined ? {} : {tokenMode: options.budget as "economy" | "balanced" | "quality"}),
          });
          try {
            const before = await source.load(new AbortController().signal);
            await source.execute({type: "objective.create", text: objective, expectedCursor: before.cursor}, new AbortController().signal);
            let snapshot = await source.load(new AbortController().signal);
            if (name === "start" && !options.background) {
              await presentProjectRoom(runtime, globals, source);
              return;
            }
            if (name === "run" && !options.background) snapshot = await waitForTerminalSnapshot(source, snapshot);
            const waitingApproval = snapshot.approvals.some((approval) => approval.status === "PENDING");
            emit(runtime.io, mode(globals), waitingApproval ? "run.waiting-approval" : name === "run" ? "run.completed" : "run.started", snapshot.run);
            if (waitingApproval) runtime.exitCode = EXIT_CODES.APPROVAL_REQUIRED;
            if (snapshot.run?.state === "FAILED" || snapshot.run?.state === "CANCELED") runtime.exitCode = EXIT_CODES.ACTION_FAILED;
          } finally {
            await source.dispose();
          }
        });
      });
  }

  for (const name of ["resume", "pause", "cancel"] as const) {
    program.command(`${name} [run-id]`)
      .description(`${name} a persisted run`)
      .action(async (runId: string | undefined, _options: unknown, command: Command) => {
        const globals = global(command);
        await ensureInitialized(workspace(globals));
        await withController(globals, async (controller) => {
          const requestedRunId = runId ?? globals.run;
          const source = await controller.projectRoomSource({
            branch: await currentBranch(workspace(globals)),
            offline: globals.offline === true,
            ...(requestedRunId === undefined ? {} : {runId: requestedRunId}),
          });
          try {
            const snapshot = await source.load(new AbortController().signal);
            const selected = runId ?? globals.run ?? snapshot.run?.id;
            if (!selected) throw new CliError("RUN_REQUIRED", "no run was selected", EXIT_CODES.USAGE);
            await source.changeRunState(selected, name, snapshot.cursor, new AbortController().signal);
            emit(runtime.io, mode(globals), `run.${name}d`, (await source.load(new AbortController().signal)).run);
          } finally {
            await source.dispose();
          }
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
  addProviderModelCommands(program, runtime);
  addUtilityCommands(program, runtime);
  return program;
}

function addProjectCommands(program: Command, runtime: Runtime): void {
  const projects = program.command("projects").description("manage Software Agent projects");
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
  const agents = program.command("agents").description("inspect all 26 named roles and their live allocation state");
  agents.command("list").action(async (_options: unknown, command: Command) => {
    const globals = global(command);
    await withController(globals, async (controller) => {
      const [snapshot, approvals, branch] = await Promise.all([
        controller.snapshotV2(),
        controller.listApprovals(),
        currentBranch(workspace(globals)),
      ]);
      const room = softwareAgentSnapshotToProjectRoom(snapshot, approvals, {branch, control: false});
      emit(runtime.io, mode(globals), "agents", room.roster);
    });
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

function addProviderModelCommands(program: Command, runtime: Runtime): void {
  const providers = program.command("providers").description("configure API-native BYOK providers without storing raw keys");
  providers.command("list").description("list configured provider references").action(async (_options: unknown, command: Command) => {
    const globals = global(command);
    const config = await loadUserProviderConfig(resolvePlatformPaths());
    emit(runtime.io, mode(globals), "providers", Object.entries(config.providers).map(([providerId, provider]) => ({
      providerId,
      enabled: provider.enabled,
      defaultModel: `${providerId}/${provider.defaultModel}`,
      credential: provider.credential,
      secretValueExposed: false,
    })));
  });
  providers.command("add <provider>")
    .description("add OpenAI or Anthropic using a secret reference")
    .requiredOption("--model <model-id>", "provider model ID")
    .requiredOption("--credential <reference>", "env://, keychain://, or manager:// reference")
    .action(async (providerId: string, options: {model: string; credential: string}, command: Command) => {
      const globals = global(command);
      const normalizedProvider = supportedProvider(providerId);
      const fullModel = normalizeProviderModel(normalizedProvider, options.model);
      parseSecretReference(options.credential);
      const paths = resolvePlatformPaths();
      const current = await loadUserProviderConfig(paths);
      const updated = await saveUserProviderConfig({
        ...current,
        revision: current.revision + 1,
        providers: {
          ...current.providers,
          [normalizedProvider]: {
            enabled: true,
            credential: options.credential,
            defaultModel: parseModelIdentifier(fullModel).modelId,
          },
        },
        defaults: {
          ...current.defaults,
          model: current.defaults.model === "deterministic/local" ? fullModel : current.defaults.model,
        },
      }, paths);
      emit(runtime.io, mode(globals), "provider.configured", {
        providerId: normalizedProvider,
        model: fullModel,
        credential: updated.providers[normalizedProvider]?.credential,
        enabled: true,
        rawSecretStored: false,
        next: `${CLI_NAME} providers test ${normalizedProvider}`,
      });
    });
  providers.command("show <provider>").action(async (providerId: string, _options: unknown, command: Command) => {
    const globals = global(command);
    const normalizedProvider = supportedProvider(providerId);
    const item = (await loadUserProviderConfig(resolvePlatformPaths())).providers[normalizedProvider];
    if (!item) throw new CliError("PROVIDER_NOT_FOUND", `provider ${normalizedProvider} is not configured`, EXIT_CODES.USAGE);
    emit(runtime.io, mode(globals), "provider", {
      providerId: normalizedProvider,
      enabled: item.enabled,
      model: `${normalizedProvider}/${item.defaultModel}`,
      credential: item.credential,
      secretValueExposed: false,
    });
  });
  providers.command("test <provider>").description("verify the credential and fetch the provider model catalog")
    .action(async (providerId: string, _options: unknown, command: Command) => {
      const globals = global(command);
      if (globals.offline) throw new CliError("OFFLINE_MODE", "provider tests are unavailable in offline mode", EXIT_CODES.CAPABILITY_UNAVAILABLE);
      emit(runtime.io, mode(globals), "provider.test", await discoverConfiguredProvider(supportedProvider(providerId)));
    });
  for (const action of ["enable", "disable"] as const) {
    providers.command(`${action} <provider>`).action(async (providerId: string, _options: unknown, command: Command) => {
      const globals = global(command);
      const normalizedProvider = supportedProvider(providerId);
      const paths = resolvePlatformPaths();
      const current = await loadUserProviderConfig(paths);
      const item = current.providers[normalizedProvider];
      if (!item) throw new CliError("PROVIDER_NOT_FOUND", `provider ${normalizedProvider} is not configured`, EXIT_CODES.USAGE);
      await saveUserProviderConfig({
        ...current,
        revision: current.revision + 1,
        providers: {...current.providers, [normalizedProvider]: {...item, enabled: action === "enable"}},
      }, paths);
      emit(runtime.io, mode(globals), `provider.${action}d`, {providerId: normalizedProvider, enabled: action === "enable"});
    });
  }
  providers.command("remove <provider>").action(async (providerId: string, _options: unknown, command: Command) => {
    const globals = global(command);
    const normalizedProvider = supportedProvider(providerId);
    const paths = resolvePlatformPaths();
    const current = await loadUserProviderConfig(paths);
    if (!current.providers[normalizedProvider]) throw new CliError("PROVIDER_NOT_FOUND", `provider ${normalizedProvider} is not configured`, EXIT_CODES.USAGE);
    const retainedProviders = Object.fromEntries(Object.entries(current.providers).filter(([id]) => id !== normalizedProvider));
    const retainedRoles = Object.fromEntries(Object.entries(current.defaults.roles).filter(([, model]) => !model.startsWith(`${normalizedProvider}/`)));
    await saveUserProviderConfig({
      ...current,
      revision: current.revision + 1,
      providers: retainedProviders,
      defaults: {
        model: current.defaults.model.startsWith(`${normalizedProvider}/`) ? "deterministic/local" : current.defaults.model,
        roles: retainedRoles,
      },
    }, paths);
    emit(runtime.io, mode(globals), "provider.removed", {providerId: normalizedProvider, secretDeleted: false});
  });

  const models = program.command("models").description("inspect and switch model routes");
  models.command("list").description("show project routes and configured provider models")
    .option("--refresh <provider>", "fetch a live model catalog from one configured provider")
    .action(async (options: {refresh?: string}, command: Command) => {
      const globals = global(command);
      await ensureInitialized(workspace(globals));
      const [project, user] = await Promise.all([
        loadProjectConfig(workspace(globals)),
        loadUserProviderConfig(resolvePlatformPaths()),
      ]);
      const refreshed = options.refresh === undefined
        ? undefined
        : await discoverConfiguredProvider(supportedProvider(options.refresh));
      emit(runtime.io, mode(globals), "models", {
        projectDefault: project.models.default,
        roleRoutes: project.models.routes,
        userDefault: user.defaults.model,
        providers: Object.entries(user.providers).map(([providerId, item]) => ({
          providerId,
          model: `${providerId}/${item.defaultModel}`,
          enabled: item.enabled,
        })),
        ...(refreshed === undefined ? {} : {refreshed}),
      });
    });
  models.command("use <provider-model>").description("select the default or role-specific model for this project")
    .option("--role <role-id>", "route only one Software Agent role")
    .action(async (model: string, options: {role?: string}, command: Command) => {
      const globals = global(command);
      await ensureInitialized(workspace(globals));
      const parsed = parseModelIdentifier(model);
      if (parsed.providerId !== "deterministic") {
        const provider = (await loadUserProviderConfig(resolvePlatformPaths())).providers[parsed.providerId];
        if (!provider) throw new CliError("PROVIDER_NOT_FOUND", `configure ${parsed.providerId} before selecting ${model}`, EXIT_CODES.USAGE, `${CLI_NAME} providers add ${parsed.providerId} --model ${parsed.modelId} --credential env://YOUR_API_KEY`);
        if (!provider.enabled) throw new CliError("PROVIDER_DISABLED", `provider ${parsed.providerId} is disabled`, EXIT_CODES.CAPABILITY_UNAVAILABLE);
      }
      const role = options.role === undefined ? undefined : validateRoleId(options.role);
      const config = await setProjectModel(workspace(globals), model, role);
      emit(runtime.io, mode(globals), "model.selected", {
        model,
        scope: role === undefined ? "project" : "role",
        ...(role === undefined ? {} : {role}),
        mappingRevision: config.mapping_revision,
      });
    });

  const tokens = program.command("tokens").description("control and inspect token-saving modes");
  tokens.command("mode [mode]").description("show or set economy (25%), balanced (50%), or quality (100%)")
    .action(async (selected: string | undefined, _options: unknown, command: Command) => {
      const globals = global(command);
      await ensureInitialized(workspace(globals));
      if (selected === undefined) {
        const config = await loadProjectConfig(workspace(globals));
        emit(runtime.io, mode(globals), "token.mode", tokenModeDescription(config.project.default_profile));
        return;
      }
      if (!isTokenMode(selected)) throw new CliError("TOKEN_MODE_INVALID", "mode must be economy, balanced, or quality", EXIT_CODES.USAGE);
      const config = await setProjectTokenMode(workspace(globals), selected);
      emit(runtime.io, mode(globals), "token.mode.selected", {...tokenModeDescription(selected), mappingRevision: config.mapping_revision});
    });
  tokens.command("status [run-id]").action(async (runId: string | undefined, _options: unknown, command: Command) => {
    const globals = global(command);
    await ensureInitialized(workspace(globals));
    await withController(globals, async (controller) => {
      const snapshot = await controller.snapshotV2();
      const selected = runId ?? globals.run ?? snapshot.runs[0]?.id;
      const account = selected === undefined ? undefined : snapshot.tokenBudgets.find((candidate) => candidate.runId === selected);
      emit(runtime.io, mode(globals), "token.status", account ?? {
        runId: selected ?? null,
        configuredMode: (await loadProjectConfig(workspace(globals))).project.default_profile,
        state: selected === undefined ? "NO_RUN" : "UNMETERED",
      });
    });
  });

  const secrets = program.command("secrets").description("inspect secret references; values are never printed");
  secrets.command("list").action(async (_options: unknown, command: Command) => {
    const globals = global(command);
    const config = await loadUserProviderConfig(resolvePlatformPaths());
    emit(runtime.io, mode(globals), "secret.references", Object.entries(config.providers).map(([providerId, item]) => ({
      providerId,
      reference: item.credential,
      value: "[NEVER DISPLAYED]",
    })));
  });
  secrets.command("test <provider>").action(async (providerId: string, _options: unknown, command: Command) => {
    const globals = global(command);
    const result = await resolveConfiguredSecret(supportedProvider(providerId));
    emit(runtime.io, mode(globals), "secret.test", result);
  });

  program.command("setup").description("show the shortest secure BYOK setup for this platform").action((_options: unknown, command: Command) => {
    const globals = global(command);
    emit(runtime.io, mode(globals), "setup", {
      providerConfig: userProviderConfigFile(resolvePlatformPaths()),
      steps: [
        `Interactive: enter your project, run ${CLI_NAME}, type /setup, choose OpenAI or Anthropic, and press Enter.`,
        "Paste the key only into the masked Software Agent field; it moves to the OS credential store.",
        "Type your request normally and press Enter; use /details only when you want the full control room.",
        "Voice: connect OpenAI, then type /voice or press Ctrl+R. Speak, press Enter, review the transcript, and press Enter again to send.",
        "Automation alternative: set OPENAI_API_KEY or ANTHROPIC_API_KEY in the terminal environment.",
        `${CLI_NAME} providers add openai --model <model-id> --credential env://OPENAI_API_KEY`,
        `${CLI_NAME} providers test openai`,
        `${CLI_NAME} models use openai/<model-id>`,
        `${CLI_NAME} tokens mode balanced`,
        `${CLI_NAME} start "Describe the change you want"`,
      ],
      defaultTokenMode: "balanced (50% of the full run allowance)",
      rawKeysStoredInConfig: false,
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
    const providers = await loadUserProviderConfig(resolvePlatformPaths());
    emit(runtime.io, mode(globals), "doctor", {
      healthy: tools[0]?.exitCode === 0,
      node: process.version,
      platform: process.platform,
      git: tools[0] ? tools[0].stdout.trim() : "unavailable",
      connectors: globals.offline
        ? Object.keys(CONNECTOR_MAP).map((connectorId) => ({connectorId, state: "UNAVAILABLE", details: ["offline mode: probe not attempted"]}))
        : tools.slice(1),
      runtime: {
        mode: "standalone",
        controller: "bundled local daemon",
        workers: "bundled Software Agent worker processes",
        eventStore: "built-in SQLite",
        requiresEditor: false,
        requiresExternalCodingCli: false,
      },
      voice: {
        assistant: VOICE_ASSISTANT_NAME,
        mode: "explicit push-to-talk",
        openaiConfigured: providers.providers.openai?.enabled === true,
        availableInCurrentMode: globals.offline !== true && providers.providers.openai?.enabled === true,
        blockedByOffline: globals.offline === true,
        transcriptionModel: DEFAULT_TRANSCRIPTION_MODEL,
        speechModel: DEFAULT_SPEECH_MODEL,
        microphoneProbe: "not attempted (privacy: the microphone opens only after /voice or Ctrl+R)",
        capturePlatformSupported: ["win32", "darwin", "linux"].includes(process.platform),
        audioRetention: "in-memory recording is erased after transcription or cancellation",
        executesBeforeTranscriptConfirmation: false,
      },
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
    emit(runtime.io, mode(globals), "completion", `Completion generation for ${shell} is reserved by the command registry; use '${CLI_NAME} help' today.`);
  });
}

type SupportedProvider = "openai" | "anthropic";

function supportedProvider(value: string): SupportedProvider {
  const normalized = value.trim().toLowerCase();
  if (normalized !== "openai" && normalized !== "anthropic") {
    throw new CliError("PROVIDER_UNSUPPORTED", "provider must be openai or anthropic", EXIT_CODES.CAPABILITY_UNAVAILABLE);
  }
  return normalized;
}

function normalizeProviderModel(providerId: SupportedProvider, value: string): string {
  const candidate = value.startsWith(`${providerId}/`) ? value : `${providerId}/${value}`;
  const parsed = parseModelIdentifier(candidate);
  if (parsed.providerId !== providerId) throw new CliError("MODEL_PROVIDER_MISMATCH", `model ${value} does not belong to ${providerId}`, EXIT_CODES.USAGE);
  return `${parsed.providerId}/${parsed.modelId}`;
}

async function configuredProvider(providerId: SupportedProvider) {
  const item = (await loadUserProviderConfig(resolvePlatformPaths())).providers[providerId];
  if (!item) throw new CliError("PROVIDER_NOT_FOUND", `provider ${providerId} is not configured`, EXIT_CODES.USAGE);
  if (!item.enabled) throw new CliError("PROVIDER_DISABLED", `provider ${providerId} is disabled`, EXIT_CODES.CAPABILITY_UNAVAILABLE);
  return item;
}

function providerSecretBroker(): SecretBackendBroker {
  return new SecretBackendBroker([
    new EnvironmentCredentialBackend(process.env, false),
    createPlatformCredentialBackend(),
  ]);
}

async function resolveConfiguredSecret(providerId: SupportedProvider): Promise<{
  readonly providerId: SupportedProvider;
  readonly credential: string;
  readonly available: true;
  readonly valueExposed: false;
}> {
  const item = await configuredProvider(providerId);
  const reference = parseSecretReference(item.credential);
  const lease = await providerSecretBroker().resolve(reference, `${providerId} credential test`, 30);
  lease.value = "";
  return {providerId, credential: item.credential, available: true, valueExposed: false};
}

async function discoverConfiguredProvider(providerId: SupportedProvider): Promise<{
  readonly providerId: SupportedProvider;
  readonly credential: string;
  readonly connected: true;
  readonly modelCount: number;
  readonly models: readonly string[];
  readonly truncated: boolean;
}> {
  const item = await configuredProvider(providerId);
  const reference = parseSecretReference(item.credential);
  const broker = providerSecretBroker();
  const gateway = new ModelGateway();
  gateway.register(providerId === "openai"
    ? new OpenAIResponsesAdapter({secretBroker: broker, credential: reference})
    : new AnthropicMessagesAdapter({secretBroker: broker, credential: reference}));
  const models = await gateway.discover(new AbortController().signal);
  return {
    providerId,
    credential: item.credential,
    connected: true,
    modelCount: models.length,
    models: models.slice(0, 50).map((model) => `${model.providerId}/${model.modelId}`),
    truncated: models.length > 50,
  };
}

function validateRoleId(value: string): "master-orchestrator" | "software-engineer" | "reviewer-qa" {
  if (value === "master-orchestrator" || value === "software-engineer" || value === "reviewer-qa") return value;
  throw new CliError("ROLE_INVALID", "role must be master-orchestrator, software-engineer, or reviewer-qa", EXIT_CODES.USAGE);
}

function isTokenMode(value: string): value is "economy" | "balanced" | "quality" {
  return value === "economy" || value === "balanced" || value === "quality";
}

function tokenModeDescription(value: "economy" | "balanced" | "quality") {
  const percent = value === "economy" ? 25 : value === "balanced" ? 50 : 100;
  return {mode: value, percentOfFullAllowance: percent, savesUpToPercent: 100 - percent};
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
  public constructor(
    private readonly client: ControllerIpcClient,
    private readonly selectedWorkspace: string,
  ) {}

  public async projectRoomSource(options: {
    readonly branch: string;
    readonly maxParallel?: number;
    readonly offline?: boolean;
    readonly runId?: string;
    readonly tokenMode?: "economy" | "balanced" | "quality";
  }): Promise<IpcProjectRoomSource> {
    const source = new IpcProjectRoomSource(this.client, {workspace: this.selectedWorkspace, ...options});
    await source.initialize();
    return source;
  }

  public snapshot(): Promise<ControllerSnapshot> {
    return this.client.request("snapshot", {});
  }

  public snapshotV2() {
    return this.client.request("snapshot.get", {recentEventLimit: 250});
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
      const {ensureControllerDaemon, startControllerDaemon} = await import("../../controller-daemon/src/index.js");
      if (embeddedControllerMode()) {
        daemon = await startControllerDaemon({workspace: selectedWorkspace, heartbeatIntervalMs: 1_000});
      } else {
        await ensureControllerDaemon({workspace: selectedWorkspace, heartbeatIntervalMs: 1_000});
      }
    } catch (startError) {
      if (!(startError instanceof ControllerIpcError) || startError.code !== "CONTROLLER_ALREADY_RUNNING") throw startError;
    }
    client = await connectWithRetry(selectedWorkspace, connectError);
  }
  client = await replaceOutdatedController(selectedWorkspace, client);
  try {
    return await callback(new ControllerClientFacade(client, selectedWorkspace));
  } finally {
    await client.close();
    await daemon?.close();
  }
}

async function replaceOutdatedController(workspacePath: string, client: ControllerIpcClient): Promise<ControllerIpcClient> {
  if (embeddedControllerMode() || client.descriptor.buildVersion === VERSION) return client;
  const previousInstanceId = client.descriptor.instanceId;
  const previousBuild = client.descriptor.buildVersion;
  try {
    await client.request("daemon.stop", {});
  } finally {
    await client.close();
  }
  const {controllerDaemonStatus, ensureControllerDaemon} = await import("../../controller-daemon/src/index.js");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const status = await controllerDaemonStatus({workspace: workspacePath});
    if (!status.running || status.descriptor?.instanceId !== previousInstanceId) break;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  const remaining = await controllerDaemonStatus({workspace: workspacePath});
  if (remaining.running && remaining.descriptor?.instanceId === previousInstanceId) {
    throw new CliError(
      "CONTROLLER_UPGRADE_TIMEOUT",
      `controller ${previousBuild} did not stop during upgrade to ${VERSION}`,
      EXIT_CODES.TRANSIENT_FAILURE,
      "Close other Software Agent terminals for this project and retry.",
    );
  }
  await ensureControllerDaemon({workspace: workspacePath, heartbeatIntervalMs: 1_000, buildVersion: VERSION});
  return await connectWithRetry(workspacePath, new Error(`replacing controller ${previousBuild} with ${VERSION}`));
}

async function presentProjectRoom(
  runtime: Runtime,
  globals: GlobalOptions,
  source: IpcProjectRoomSource,
): Promise<void> {
  if (machine(globals)) {
    emit(runtime.io, mode(globals), "project-room", await source.load(new AbortController().signal));
    return;
  }
  if (globals.plain || !process.stdout.isTTY || runtime.io !== processIo) {
    const snapshot = await source.load(new AbortController().signal);
    const width = process.stdout.columns || 100;
    const height = process.stdout.rows || 30;
    const state = projectRoomReducer(createInitialProjectRoomState({width, height}), {type: "snapshot.received", snapshot});
    runtime.io.stdout(`${renderProjectRoomText(state, {width, height, noColor: true, ascii: true, interactive: false})}\n`);
    return;
  }
  await openProjectRoom(source, {noColor: globals.color === false, ascii: globals.unicode === "off"});
}

async function waitForTerminalSnapshot(
  source: IpcProjectRoomSource,
  initial: Awaited<ReturnType<IpcProjectRoomSource["load"]>>,
): Promise<Awaited<ReturnType<IpcProjectRoomSource["load"]>>> {
  let snapshot = initial;
  const deadline = Date.now() + 60 * 60 * 1_000;
  while (snapshot.run !== null && !["SUCCEEDED", "FAILED", "CANCELED"].includes(snapshot.run.state)) {
    if (snapshot.approvals.some((approval) => approval.status === "PENDING")) return snapshot;
    if (Date.now() >= deadline) throw new CliError("RUN_TIMEOUT", "the run did not finish within one hour", EXIT_CODES.TRANSIENT_FAILURE);
    const update = await source.nextCommitted(snapshot.cursor, new AbortController().signal);
    snapshot = update.snapshot;
  }
  return snapshot;
}

async function resolveOpenWorkspace(
  target: string,
  options: {readonly github?: boolean; readonly destination?: string},
): Promise<string> {
  const requested = target.trim();
  if (requested === "") throw new CliError("PROJECT_REQUIRED", "a local path or GitHub repository is required", EXIT_CODES.USAGE);
  const repository = githubRepositorySlug(requested, options.github === true);
  if (repository === null) {
    const local = resolve(requested);
    if (!existsSync(local)) {
      throw new CliError(
        "PROJECT_NOT_FOUND",
        `local project does not exist: ${local}`,
        EXIT_CODES.USAGE,
        "Use a full https://github.com/OWNER/REPO URL or add --github for OWNER/REPO.",
      );
    }
    return local;
  }

  const [repositoryOwner, repositoryName] = repository.split("/");
  if (repositoryOwner === undefined || repositoryName === undefined) throw new CliError("GITHUB_REPOSITORY_INVALID", "GitHub repository must be OWNER/REPO", EXIT_CODES.USAGE);
  const destination = resolve(options.destination ?? join(homedir(), "SoftwareAgentProjects", repositoryOwner, repositoryName));
  if (existsSync(destination)) {
    if (!existsSync(join(destination, ".git"))) {
      throw new CliError("PROJECT_DESTINATION_OCCUPIED", `destination exists but is not a Git checkout: ${destination}`, EXIT_CODES.ACTION_FAILED);
    }
    return destination;
  }
  await mkdir(dirname(destination), {recursive: true});
  const result = await runConnectorCli("gh", ["repo", "clone", repository, destination], {
    timeoutMs: 5 * 60_000,
    maxBytes: 4 * 1_048_576,
  });
  if (result.exitCode !== 0) {
    throw new CliError(
      "GITHUB_CLONE_FAILED",
      result.stderr || result.stdout || `GitHub could not check out ${repository}`,
      EXIT_CODES.TRANSIENT_FAILURE,
      "Run software-agent doctor and confirm that gh auth status is connected.",
    );
  }
  return destination;
}

function githubRepositorySlug(target: string, forced: boolean): string | null {
  const shorthand = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/u.exec(target);
  if (forced) {
    if (shorthand === null) throw new CliError("GITHUB_REPOSITORY_INVALID", "--github requires OWNER/REPO", EXIT_CODES.USAGE);
    return `${shorthand[1]}/${shorthand[2]}`;
  }
  const ssh = /^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/u.exec(target);
  if (ssh !== null) return `${ssh[1]}/${ssh[2]}`;
  try {
    const url = new URL(target);
    if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") return null;
    const parts = url.pathname.replace(/^\/+|\/+$/gu, "").replace(/\.git$/u, "").split("/");
    if (parts.length !== 2 || !parts.every((part) => /^[A-Za-z0-9_.-]+$/u.test(part))) {
      throw new CliError("GITHUB_REPOSITORY_INVALID", "GitHub URL must identify exactly one OWNER/REPO", EXIT_CODES.USAGE);
    }
    return `${parts[0]}/${parts[1]}`;
  } catch (error) {
    if (error instanceof CliError) throw error;
    return null;
  }
}

async function ensureInitialized(root: string): Promise<void> {
  await initializeProject(root, basename(root), true);
}

async function currentBranch(root: string): Promise<string> {
  try {
    const result = await runConnectorCli("git", ["branch", "--show-current"], {cwd: root});
    return result.exitCode === 0 && result.stdout.trim() !== "" ? result.stdout.trim() : "detached HEAD";
  } catch {
    return "not a Git repository";
  }
}

function embeddedControllerMode(): boolean {
  return process.env.SOFTWARE_AGENT_CONTROLLER_MODE === "embedded" || process.env.VITEST === "true" || process.env.NODE_ENV === "test";
}

function parseIntegerOption(value: string | undefined, minimum: number, maximum: number, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/u.test(value)) throw new CliError("USAGE_ERROR", `${name} must be an integer`, EXIT_CODES.USAGE);
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new CliError("USAGE_ERROR", `${name} must be from ${minimum} through ${maximum}`, EXIT_CODES.USAGE);
  }
  return parsed;
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
    throw new CliError("CAPABILITY_UNAVAILABLE", `${reserved[0]} is reserved but not active in v0.7`, EXIT_CODES.CAPABILITY_UNAVAILABLE);
  }
  if (options.unicode !== undefined && options.unicode !== "auto") {
    throw new CliError("CAPABILITY_UNAVAILABLE", "explicit Unicode mode is reserved in v0.7", EXIT_CODES.CAPABILITY_UNAVAILABLE);
  }
  if (options.redact !== undefined && options.redact !== "standard") {
    throw new CliError("CAPABILITY_UNAVAILABLE", "only the standard redaction policy is available in v0.7", EXIT_CODES.CAPABILITY_UNAVAILABLE);
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
    return {code: error.code, message: error.message, exitCode, next: error.code === "APPROVAL_REQUIRED" ? `${CLI_NAME} approvals list` : `${CLI_NAME} doctor`};
  }
  if (error instanceof SecretUnavailableError) {
    return {
      code: error.code,
      message: error.message,
      exitCode: EXIT_CODES.AUTH_REQUIRED,
      next: "set the referenced credential, then run software-agent providers test <provider>",
    };
  }
  if (error instanceof UnsupportedCredentialBackendError) {
    return {code: error.code, message: error.message, exitCode: EXIT_CODES.CAPABILITY_UNAVAILABLE, next: `${CLI_NAME} setup`};
  }
  if (error instanceof ProviderGatewayError) {
    const authFailure = error.code === "PROVIDER_HTTP_ERROR" && (error.status === 401 || error.status === 403);
    const transient = error.code === "PROVIDER_TIMEOUT"
      || error.code === "PROVIDER_TRANSPORT_ERROR"
      || error.code === "PROVIDER_HTTP_ERROR" && (error.status === 408 || error.status === 429 || (error.status ?? 0) >= 500);
    const exitCode = authFailure
      ? EXIT_CODES.AUTH_REQUIRED
      : error.code === "PROVIDER_CANCELED"
        ? EXIT_CODES.CANCELED
        : transient
          ? EXIT_CODES.TRANSIENT_FAILURE
          : EXIT_CODES.ACTION_FAILED;
    return {
      code: authFailure ? "PROVIDER_AUTH_REQUIRED" : error.code,
      message: error.message,
      exitCode,
      next: authFailure ? `${CLI_NAME} providers test ${error.providerId}` : `${CLI_NAME} doctor`,
    };
  }
  if (error instanceof AttachmentError) return {code: error.code, message: error.message, exitCode: EXIT_CODES.POLICY_DENIED, next: `${CLI_NAME} attachments scan <path>`};
  if ((error as NodeJS.ErrnoException).code === "ENOENT") return {code: "PROJECT_NOT_INITIALIZED", message: "project configuration was not found", exitCode: EXIT_CODES.USAGE, next: `${CLI_NAME} init`};
  return {code: "UNEXPECTED_FAILURE", message: sanitizeTerminal(String(error)), exitCode: EXIT_CODES.ACTION_FAILED, next: `${CLI_NAME} doctor`};
}

async function main(): Promise<void> {
  process.exitCode = await runCli();
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
const moduleFilename = basename(fileURLToPath(import.meta.url));
if (["index.ts", "cli.js"].includes(moduleFilename) && import.meta.url === invoked) void main();
