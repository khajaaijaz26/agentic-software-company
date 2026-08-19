import {runConnectorCli, type Connector, type ConnectorInventory, type ConnectorProbe} from "../../../packages/connectors/src/index.js";

export class VercelConnector implements Connector {
  public constructor(private readonly runCli: typeof runConnectorCli = runConnectorCli) {}

  public readonly manifest = {
    schema: "software-agent.connector-manifest/v1" as const,
    id: "vercel",
    displayName: "Vercel",
    version: "1.0.0",
    executable: "vercel",
    capabilities: ["account:inspect", "project:inspect", "deployment:preview", "deployment:production", "deployment:rollback"],
    authMethods: ["oauth-integration", "vercel-cli-session", "explicit-token"],
    testedVersions: ">=40",
  };

  public async probe(): Promise<ConnectorProbe> {
    try {
      const version = await this.runCli("vercel", ["--version"]);
      const identity = await this.runCli("vercel", ["whoami"], {timeoutMs: 30_000});
      if (identity.exitCode !== 0) {
        return {connectorId: "vercel", state: "AUTH_REQUIRED", version: version.stdout.trim(), details: [identity.stderr || identity.stdout]};
      }
      const account = identity.stdout.trim();
      return {
        connectorId: "vercel",
        state: "CONNECTED",
        version: version.stdout.trim(),
        ...(account === "" ? {} : {account}),
        details: ["Authenticated through the provider-owned Vercel CLI session."],
      };
    } catch (error) {
      return {connectorId: "vercel", state: "UNAVAILABLE", details: [String(error)]};
    }
  }

  public async inventory(): Promise<ConnectorInventory> {
    const response = await this.runCli("vercel", ["project", "list"], {timeoutMs: 30_000});
    if (response.exitCode !== 0) throw new Error(response.stderr || "Vercel inventory failed");
    const resources = response.stdout.split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("Vercel CLI") && !line.startsWith("Fetching") && !line.startsWith(">"))
      .map((line) => ({summary: line}));
    return {connectorId: "vercel", resources, observedAt: new Date().toISOString()};
  }
}
