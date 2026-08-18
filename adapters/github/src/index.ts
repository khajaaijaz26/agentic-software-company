import {runConnectorCli, type Connector, type ConnectorInventory, type ConnectorProbe} from "../../../packages/connectors/src/index.js";

export class GitHubConnector implements Connector {
  public readonly manifest = {
    schema: "agent-company.connector-manifest/v1" as const,
    id: "github",
    displayName: "GitHub",
    version: "1.0.0",
    executable: "gh",
    capabilities: ["account:inspect", "repository:inspect", "branch:push", "pull-request:create", "checks:inspect"],
    authMethods: ["github-app", "gh-cli-session", "fine-grained-pat"],
    testedVersions: ">=2.50",
  };

  public async probe(): Promise<ConnectorProbe> {
    try {
      const version = await runConnectorCli("gh", ["--version"]);
      const auth = await runConnectorCli("gh", ["auth", "status", "--hostname", "github.com"]);
      if (auth.exitCode !== 0) {
        const detectedVersion = firstLine(version.stdout);
        return {
          connectorId: "github",
          state: "AUTH_REQUIRED",
          ...(detectedVersion === undefined ? {} : {version: detectedVersion}),
          details: [auth.stderr || auth.stdout],
        };
      }
      const user = await runConnectorCli("gh", ["api", "user"]);
      const account = parseJson(user.stdout)?.login;
      const detectedVersion = firstLine(version.stdout);
      return {
        connectorId: "github",
        state: user.exitCode === 0 ? "CONNECTED" : "DEGRADED",
        ...(detectedVersion === undefined ? {} : {version: detectedVersion}),
        ...(typeof account === "string" ? {account} : {}),
        details: ["Authenticated through the provider-owned GitHub CLI session."],
      };
    } catch (error) {
      return {connectorId: "github", state: "UNAVAILABLE", details: [String(error)]};
    }
  }

  public async inventory(): Promise<ConnectorInventory> {
    const response = await runConnectorCli("gh", ["repo", "list", "--limit", "100", "--json", "nameWithOwner,isPrivate,url,defaultBranchRef"]);
    if (response.exitCode !== 0) throw new Error(response.stderr || "GitHub inventory failed");
    const parsed = JSON.parse(response.stdout) as Record<string, unknown>[];
    return {connectorId: "github", resources: parsed, observedAt: new Date().toISOString()};
  }
}

function firstLine(value: string): string | undefined {
  return value.split("\n").find((line) => line.trim() !== "")?.trim();
}

function parseJson(value: string): Record<string, unknown> | undefined {
  try { return JSON.parse(value) as Record<string, unknown>; } catch { return undefined; }
}
