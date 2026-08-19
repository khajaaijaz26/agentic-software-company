import {mkdtempSync, readFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

import {afterEach, describe, expect, it} from "vitest";

import {runCli} from "../../apps/cli/src/index.js";
import {initializeProject, loadProjectConfig, loadUserProviderConfig, resolvePlatformPaths} from "../../packages/config/src/index.js";

const temporaryDirectories: string[] = [];
const originalSoftwareAgentHome = process.env.SOFTWARE_AGENT_HOME;

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  if (originalSoftwareAgentHome === undefined) delete process.env.SOFTWARE_AGENT_HOME;
  else process.env.SOFTWARE_AGENT_HOME = originalSoftwareAgentHome;
  for (const directory of temporaryDirectories.splice(0).reverse()) rmSync(directory, {recursive: true, force: true});
});

describe("Software Agent setup CLI", () => {
  it("stores only a credential reference and switches the project model", async () => {
    const home = temporaryDirectory("software-agent-cli-home-");
    const workspace = temporaryDirectory("software-agent-cli-workspace-");
    process.env.SOFTWARE_AGENT_HOME = home;
    await initializeProject(workspace, "Configuration test", true);
    const output: string[] = [];
    const io = {stdout: (value: string) => output.push(value), stderr: () => undefined};

    expect(await runCli([
      "node", "software-agent", "--json", "providers", "add", "openai",
      "--model", "gpt-test", "--credential", "env://OPENAI_API_KEY",
    ], io)).toBe(0);
    expect(JSON.parse(output.join("")).data).toMatchObject({
      providerId: "openai",
      model: "openai/gpt-test",
      rawSecretStored: false,
    });
    const providers = await loadUserProviderConfig(resolvePlatformPaths());
    expect(providers.providers.openai).toMatchObject({credential: "env://OPENAI_API_KEY", enabled: true});
    expect(readFileSync(join(resolvePlatformPaths().config, "providers.toml"), "utf8")).not.toContain("sk-");

    output.length = 0;
    expect(await runCli([
      "node", "software-agent", "--project", workspace, "--json", "models", "use", "openai/gpt-test",
      "--role", "software-engineer",
    ], io)).toBe(0);
    expect((await loadProjectConfig(workspace)).models.routes["software-engineer"]).toBe("openai/gpt-test");
  });

  it("persists the token-saving mode and explains the secure setup", async () => {
    const home = temporaryDirectory("software-agent-cli-home-");
    const workspace = temporaryDirectory("software-agent-cli-workspace-");
    process.env.SOFTWARE_AGENT_HOME = home;
    await initializeProject(workspace, "Token mode test", true);
    const output: string[] = [];
    const io = {stdout: (value: string) => output.push(value), stderr: () => undefined};

    expect(await runCli(["node", "software-agent", "--project", workspace, "--json", "tokens", "mode", "economy"], io)).toBe(0);
    expect(JSON.parse(output.join("")).data).toMatchObject({mode: "economy", percentOfFullAllowance: 25, savesUpToPercent: 75});
    expect((await loadProjectConfig(workspace)).project.default_profile).toBe("economy");

    output.length = 0;
    expect(await runCli(["node", "software-agent", "--json", "setup"], io)).toBe(0);
    const setup = JSON.parse(output.join("")).data as {steps: string[]; rawKeysStoredInConfig: boolean};
    expect(setup.rawKeysStoredInConfig).toBe(false);
    expect(setup.steps.join(" ")).toContain("env://OPENAI_API_KEY");
  });

  it("returns an authentication-required envelope when a referenced key is missing", async () => {
    const home = temporaryDirectory("software-agent-cli-home-");
    process.env.SOFTWARE_AGENT_HOME = home;
    delete process.env.SOFTWARE_AGENT_TEST_MISSING_KEY;
    const output: string[] = [];
    const io = {stdout: (value: string) => output.push(value), stderr: () => undefined};

    expect(await runCli([
      "node", "software-agent", "--json", "providers", "add", "openai",
      "--model", "gpt-test", "--credential", "env://SOFTWARE_AGENT_TEST_MISSING_KEY",
    ], io)).toBe(0);
    output.length = 0;

    expect(await runCli(["node", "software-agent", "--json", "providers", "test", "openai"], io)).toBe(5);
    expect(JSON.parse(output.join("")).data).toMatchObject({
      code: "SECRET_UNAVAILABLE",
    });
  });
});
