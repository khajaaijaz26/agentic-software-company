import {randomUUID} from "node:crypto";
import {constants} from "node:fs";
import {chmod, copyFile, link, mkdir, open, readFile, rename, rm} from "node:fs/promises";
import {homedir, platform} from "node:os";
import {dirname, join, resolve} from "node:path";

import TOML from "@iarna/toml";
import {z} from "zod";

export const SOFTWARE_AGENT_HOME_ENV = "SOFTWARE_AGENT_HOME";
export const DEPRECATED_AGENT_COMPANY_HOME_ENV = "AGENT_COMPANY_HOME";

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

const ModelIdentifierSchema = z.string()
  .min(3)
  .max(256)
  .regex(/^[a-z0-9][a-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:/-]*$/u, "model identifiers must be provider/model")
  .refine((value) => !value.includes("://"), "model identifiers cannot contain endpoints");

const RuntimeSchema = z.object({
  max_parallel_agents: z.number().int().min(1).max(12),
  task_timeout_minutes: z.number().int().min(1),
  checkpoint_interval_seconds: z.number().int().min(1),
}).strict();

const ModelsSchema = z.object({
  default: ModelIdentifierSchema,
  routes: z.record(z.string().min(1).max(128), ModelIdentifierSchema),
  fallbacks: z.record(z.string().min(1).max(256), z.array(ModelIdentifierSchema).max(8)),
}).strict();

const BudgetsSchema = z.object({
  project_cost_limit_usd: z.number().nonnegative(),
  warn_at_percent: z.number().min(1).max(100),
  require_approval_at_percent: z.number().min(1).max(100),
}).strict();

const UiSchema = z.object({
  theme: z.string(),
  density: z.string(),
  color: z.string(),
  show_costs: z.boolean(),
}).strict();

const ProjectBodySchema = {
  mapping_id: z.string().min(1),
  mapping_revision: z.number().int().positive(),
  project: z.object({
    name: z.string().min(1),
    default_profile: z.enum(["economy", "balanced", "quality"]),
  }).strict(),
  runtime: RuntimeSchema,
  models: ModelsSchema,
  budgets: BudgetsSchema,
  ui: UiSchema,
} as const;

const ProjectConfigSchema = z.object({
  schema: z.literal("software-agent.project/v2"),
  ...ProjectBodySchema,
}).strict();

const LegacyProjectConfigSchema = z.object({
  schema: z.literal("agent-company.project/v1"),
  mapping_id: ProjectBodySchema.mapping_id,
  mapping_revision: ProjectBodySchema.mapping_revision,
  project: ProjectBodySchema.project,
  runtime: ProjectBodySchema.runtime,
  models: ModelsSchema.default({default: "deterministic/local", routes: {}, fallbacks: {}}),
  budgets: ProjectBodySchema.budgets,
  ui: ProjectBodySchema.ui,
}).loose();

const CredentialReferenceSchema = z.string().max(512).refine(
  validCredentialReference,
  "credential must be an env://, keychain://, or manager:// secret reference",
);

const UserProviderSchema = z.object({
  enabled: z.boolean(),
  credential: CredentialReferenceSchema,
  defaultModel: z.string().min(1).max(256),
}).strict();

const UserProviderConfigSchema = z.object({
  schema: z.literal("software-agent.providers/v1"),
  revision: z.number().int().positive(),
  providers: z.record(z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/u), UserProviderSchema),
  defaults: z.object({
    model: ModelIdentifierSchema,
    roles: z.record(z.string().min(1).max(128), ModelIdentifierSchema),
  }).strict(),
}).strict();

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
export type UserProviderConfig = z.infer<typeof UserProviderConfigSchema>;

export function resolvePlatformPaths(environment: NodeJS.ProcessEnv = process.env): PlatformPaths {
  const override = environment[SOFTWARE_AGENT_HOME_ENV] ?? environment[DEPRECATED_AGENT_COMPANY_HOME_ENV];
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
      config: join(roaming, "SoftwareAgent"),
      data: join(local, "SoftwareAgent", "data"),
      state: join(local, "SoftwareAgent", "state"),
      cache: join(local, "SoftwareAgent", "cache"),
      runtime: join(local, "SoftwareAgent", "runtime"),
    };
  }
  if (system === "darwin") {
    const support = join(homedir(), "Library", "Application Support", "Software Agent");
    return {
      config: join(support, "config"),
      data: join(support, "data"),
      state: join(support, "state"),
      cache: join(homedir(), "Library", "Caches", "Software Agent"),
      runtime: join(support, "runtime"),
    };
  }
  const config = environment.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  const data = environment.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  const state = environment.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  const cache = environment.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  const runtime = environment.XDG_RUNTIME_DIR ?? join(state, "software-agent", "runtime");
  return {
    config: join(config, "software-agent"),
    data: join(data, "software-agent"),
    state: join(state, "software-agent"),
    cache: join(cache, "software-agent"),
    runtime: join(runtime, "software-agent"),
  };
}

export function projectFiles(workspace: string): ProjectFiles {
  return filesInDirectory(join(resolve(workspace), ".software-agent"));
}

export function legacyProjectFiles(workspace: string): ProjectFiles {
  return filesInDirectory(join(resolve(workspace), ".agent-company"));
}

export function userProviderConfigFile(paths: PlatformPaths = resolvePlatformPaths()): string {
  return join(paths.config, "providers.toml");
}

export function defaultProjectToml(name: string): string {
  return TOML.stringify({
    schema: "software-agent.project/v2",
    mapping_id: `map_${randomUUID().replaceAll("-", "").slice(0, 16)}`,
    mapping_revision: 1,
    project: {name, default_profile: "balanced"},
    runtime: {
      max_parallel_agents: 3,
      task_timeout_minutes: 30,
      checkpoint_interval_seconds: 15,
    },
    models: {default: "deterministic/local", routes: {}, fallbacks: {}},
    budgets: {
      project_cost_limit_usd: 25,
      warn_at_percent: 80,
      require_approval_at_percent: 100,
    },
    ui: {theme: "system", density: "comfortable", color: "auto", show_costs: true},
  });
}

export function defaultPolicyToml(): string {
  return TOML.stringify({
    schema: "software-agent.policy/v2",
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

export function defaultUserProviderConfig(): UserProviderConfig {
  return Object.freeze({
    schema: "software-agent.providers/v1",
    revision: 1,
    providers: Object.freeze({}),
    defaults: Object.freeze({model: "deterministic/local", roles: Object.freeze({})}),
  });
}

export async function initializeProject(
  workspace: string,
  name: string,
  write = true,
): Promise<{readonly files: ProjectFiles; readonly planned: readonly string[]; readonly created: readonly string[]}> {
  const files = projectFiles(workspace);
  const planned = [files.projectFile, files.policyFile, files.gitignoreFile];
  if (!write) return {files, planned, created: []};
  if (await migrateLegacyProjectConfig(workspace)) return {files, planned, created: planned};
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
  const files = projectFiles(workspace);
  let raw: string;
  try {
    raw = await readFile(files.projectFile, "utf8");
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
    const migrated = await migrateLegacyProjectConfig(workspace);
    if (!migrated) throw error;
    raw = await readFile(files.projectFile, "utf8");
  }
  return ProjectConfigSchema.parse(TOML.parse(raw));
}

export async function saveProjectConfig(workspace: string, config: unknown): Promise<ProjectConfig> {
  const parsed = ProjectConfigSchema.parse(config);
  await atomicReplace(projectFiles(workspace).projectFile, TOML.stringify(parsed));
  return parsed;
}

export async function setProjectTokenMode(
  workspace: string,
  mode: ProjectConfig["project"]["default_profile"],
): Promise<ProjectConfig> {
  const current = await loadProjectConfig(workspace);
  return await saveProjectConfig(workspace, {
    ...current,
    mapping_revision: current.mapping_revision + 1,
    project: {...current.project, default_profile: mode},
  });
}

export async function setProjectModel(
  workspace: string,
  model: string,
  role?: string,
): Promise<ProjectConfig> {
  const current = await loadProjectConfig(workspace);
  const models = role === undefined
    ? {...current.models, default: model}
    : {...current.models, routes: {...current.models.routes, [role]: model}};
  return await saveProjectConfig(workspace, {
    ...current,
    mapping_revision: current.mapping_revision + 1,
    models,
  });
}

export async function migrateLegacyProjectConfig(workspace: string): Promise<boolean> {
  const legacy = legacyProjectFiles(workspace);
  const current = projectFiles(workspace);
  try {
    await readFile(current.projectFile, "utf8");
    return false;
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }
  let legacyRaw: string;
  try {
    legacyRaw = await readFile(legacy.projectFile, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }

  const backupDirectory = join(current.directory, "migration-backup", "agent-company-v1");
  await mkdir(backupDirectory, {recursive: true, mode: 0o700});
  await backupIfPresent(legacy.projectFile, join(backupDirectory, "project.toml"));
  await backupIfPresent(legacy.policyFile, join(backupDirectory, "policy.toml"));
  await backupIfPresent(legacy.gitignoreFile, join(backupDirectory, ".gitignore"));

  const legacyConfig = LegacyProjectConfigSchema.parse(TOML.parse(legacyRaw));
  const migrated: ProjectConfig = ProjectConfigSchema.parse({
    mapping_id: legacyConfig.mapping_id,
    mapping_revision: legacyConfig.mapping_revision + 1,
    project: legacyConfig.project,
    runtime: legacyConfig.runtime,
    models: legacyConfig.models,
    budgets: legacyConfig.budgets,
    ui: legacyConfig.ui,
    schema: "software-agent.project/v2",
  });
  await atomicReplace(current.projectFile, TOML.stringify(migrated));

  let legacyPolicy: string;
  try {
    legacyPolicy = await readFile(legacy.policyFile, "utf8");
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
    legacyPolicy = defaultPolicyToml();
  }
  await atomicReplace(current.policyFile, legacyPolicy.replace("agent-company.policy/v1", "software-agent.policy/v2"));
  try {
    await atomicReplace(current.gitignoreFile, await readFile(legacy.gitignoreFile, "utf8"));
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
    await atomicReplace(current.gitignoreFile, "*.sqlite\n*.sqlite-shm\n*.sqlite-wal\n");
  }
  return true;
}

export async function loadUserProviderConfig(paths: PlatformPaths = resolvePlatformPaths()): Promise<UserProviderConfig> {
  try {
    return UserProviderConfigSchema.parse(TOML.parse(await readFile(userProviderConfigFile(paths), "utf8")));
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return defaultUserProviderConfig();
    throw error;
  }
}

export async function saveUserProviderConfig(config: unknown, paths: PlatformPaths = resolvePlatformPaths()): Promise<UserProviderConfig> {
  const parsed = UserProviderConfigSchema.parse(config);
  await atomicReplace(userProviderConfigFile(paths), TOML.stringify(parsed));
  return parsed;
}

function filesInDirectory(directory: string): ProjectFiles {
  return {
    directory,
    projectFile: join(directory, "project.toml"),
    policyFile: join(directory, "policy.toml"),
    gitignoreFile: join(directory, ".gitignore"),
  };
}

async function atomicCreate(path: string, content: string): Promise<boolean> {
  await mkdir(dirname(path), {recursive: true, mode: 0o700});
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
    if (isNodeError(error, "EEXIST")) return false;
    throw error;
  } finally {
    await rm(temporary, {force: true});
  }
}

async function atomicReplace(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), {recursive: true, mode: 0o700});
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content, {encoding: "utf8"});
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await rm(temporary, {force: true});
  }
}

async function backupIfPresent(source: string, target: string): Promise<void> {
  try {
    await copyFile(source, target, constants.COPYFILE_EXCL);
    await chmod(target, 0o600);
  } catch (error) {
    if (!isNodeError(error, "ENOENT") && !isNodeError(error, "EEXIST")) throw error;
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function validCredentialReference(value: string): boolean {
  const match = /^(env|keychain|manager):\/\/(.+)$/u.exec(value);
  const scheme = match?.[1];
  const reference = match?.[2];
  if (!scheme || !reference) return false;
  if (scheme === "env") return /^[A-Z][A-Z0-9_]{1,127}$/u.test(reference);
  return reference.length <= 256 && !hasControlCharacters(reference);
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) return true;
  }
  return false;
}
