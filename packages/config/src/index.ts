import {randomUUID} from "node:crypto";
import {link, mkdir, open, readFile, rm} from "node:fs/promises";
import {homedir, platform} from "node:os";
import {dirname, join, resolve} from "node:path";
import TOML from "@iarna/toml";
import {z} from "zod";

export interface PlatformPaths {
  readonly config: string;
  readonly data: string;
  readonly state: string;
  readonly cache: string;
  readonly runtime: string;
}

export interface ProjectFiles {
  readonly directory: string;
  readonly projectFile: string;
  readonly policyFile: string;
  readonly gitignoreFile: string;
}

const ProjectConfigSchema = z.object({
  schema: z.literal("agent-company.project/v1"),
  mapping_id: z.string().min(1),
  mapping_revision: z.number().int().positive(),
  project: z.object({
    name: z.string().min(1),
    default_profile: z.string().min(1),
  }),
  runtime: z.object({
    max_parallel_agents: z.number().int().min(1).max(12),
    task_timeout_minutes: z.number().int().min(1),
    checkpoint_interval_seconds: z.number().int().min(1),
  }),
  budgets: z.object({
    project_cost_limit_usd: z.number().nonnegative(),
    warn_at_percent: z.number().min(1).max(100),
    require_approval_at_percent: z.number().min(1).max(100),
  }),
  ui: z.object({
    theme: z.string(),
    density: z.string(),
    color: z.string(),
    show_costs: z.boolean(),
  }),
});

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

export function resolvePlatformPaths(environment: NodeJS.ProcessEnv = process.env): PlatformPaths {
  const override = environment.AGENT_COMPANY_HOME;
  if (override) {
    const root = resolve(override);
    return {
      config: join(root, "config"),
      data: join(root, "data"),
      state: join(root, "state"),
      cache: join(root, "cache"),
      runtime: join(root, "runtime"),
    };
  }

  const system = platform();
  if (system === "win32") {
    const roaming = environment.APPDATA ?? join(homedir(), "AppData", "Roaming");
    const local = environment.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
    return {
      config: join(roaming, "AgentCompany"),
      data: join(local, "AgentCompany", "data"),
      state: join(local, "AgentCompany", "state"),
      cache: join(local, "AgentCompany", "cache"),
      runtime: join(local, "AgentCompany", "runtime"),
    };
  }
  if (system === "darwin") {
    const support = join(homedir(), "Library", "Application Support", "AgentCompany");
    return {
      config: join(support, "config"),
      data: join(support, "data"),
      state: join(support, "state"),
      cache: join(homedir(), "Library", "Caches", "AgentCompany"),
      runtime: join(support, "runtime"),
    };
  }
  const config = environment.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  const data = environment.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  const state = environment.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  const cache = environment.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  const runtime = environment.XDG_RUNTIME_DIR ?? join(state, "agent-company", "runtime");
  return {
    config: join(config, "agent-company"),
    data: join(data, "agent-company"),
    state: join(state, "agent-company"),
    cache: join(cache, "agent-company"),
    runtime: join(runtime, "agent-company"),
  };
}

export function projectFiles(workspace: string): ProjectFiles {
  const directory = join(resolve(workspace), ".agent-company");
  return {
    directory,
    projectFile: join(directory, "project.toml"),
    policyFile: join(directory, "policy.toml"),
    gitignoreFile: join(directory, ".gitignore"),
  };
}

export function defaultProjectToml(name: string): string {
  return TOML.stringify({
    schema: "agent-company.project/v1",
    mapping_id: `map_${randomUUID().replaceAll("-", "").slice(0, 16)}`,
    mapping_revision: 1,
    project: {name, default_profile: "balanced"},
    runtime: {
      max_parallel_agents: 4,
      task_timeout_minutes: 30,
      checkpoint_interval_seconds: 15,
    },
    models: {default: "deterministic/local", routes: {}, fallbacks: {}},
    budgets: {
      project_cost_limit_usd: 25,
      warn_at_percent: 70,
      require_approval_at_percent: 90,
    },
    ui: {theme: "system", density: "comfortable", color: "auto", show_costs: true},
  });
}

export function defaultPolicyToml(): string {
  return TOML.stringify({
    schema: "agent-company.policy/v1",
    policy: {
      filesystem: "workspace_only",
      shell: "approval_on_risk",
      network: "allowlisted",
      production: "deny",
      secrets: "explicit_reference_only",
      telemetry: "off",
    },
  });
}

export async function initializeProject(
  workspace: string,
  name: string,
  write = true,
): Promise<{readonly files: ProjectFiles; readonly planned: readonly string[]; readonly created: readonly string[]} > {
  const files = projectFiles(workspace);
  const planned = [files.projectFile, files.policyFile, files.gitignoreFile];
  if (!write) {
    return {files, planned, created: []};
  }
  await mkdir(files.directory, {recursive: true, mode: 0o700});
  const candidates = [
    [files.projectFile, defaultProjectToml(name)],
    [files.policyFile, defaultPolicyToml()],
    [files.gitignoreFile, ["*.sqlite", "*.sqlite-shm", "*.sqlite-wal", "artifacts/", "attachments/", "runtime/", "local.toml", ""].join("\n")],
  ] as const;
  const created: string[] = [];
  for (const [path, content] of candidates) {
    if (await atomicCreate(path, content)) created.push(path);
  }
  return {files, planned, created};
}

export async function loadProjectConfig(workspace: string): Promise<ProjectConfig> {
  const raw = await readFile(projectFiles(workspace).projectFile, "utf8");
  return ProjectConfigSchema.parse(TOML.parse(raw));
}

async function atomicCreate(path: string, content: string): Promise<boolean> {
  await mkdir(dirname(path), {recursive: true});
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content, {encoding: "utf8"});
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporary, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    await rm(temporary, {force: true});
  }
}
