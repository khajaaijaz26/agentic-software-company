import {runConnectorCli, type Connector, type ConnectorInventory, type ConnectorProbe} from "../../../packages/connectors/src/index.js";

export class SupabaseConnector implements Connector {
  public readonly manifest = {
    schema: "software-agent.connector-manifest/v1" as const,
    id: "supabase",
    displayName: "Supabase",
    version: "1.0.0",
    executable: "supabase",
    capabilities: ["project:inspect", "migration:plan", "migration:staging", "edge:deploy", "secret:metadata"],
    authMethods: ["oauth", "supabase-cli-session", "personal-access-token"],
    testedVersions: ">=2",
  };

  public async probe(): Promise<ConnectorProbe> {
    try {
      const version = await runConnectorCli("supabase", ["--version"]);
      const projects = await runConnectorCli("supabase", ["projects", "list", "--output", "json"]);
      if (projects.exitCode !== 0) {
        return {connectorId: "supabase", state: "AUTH_REQUIRED", version: version.stdout.trim(), details: [projects.stderr || projects.stdout]};
      }
      const parsed = JSON.parse(projects.stdout) as Record<string, unknown>[];
      return {
        connectorId: "supabase",
        state: "CONNECTED",
        version: version.stdout.trim(),
        details: [`${parsed.length} accessible project(s); credentials remain owned by Supabase CLI.`],
      };
    } catch (error) {
      return {connectorId: "supabase", state: "UNAVAILABLE", details: [String(error)]};
    }
  }

  public async inventory(): Promise<ConnectorInventory> {
    const response = await runConnectorCli("supabase", ["projects", "list", "--output", "json"]);
    if (response.exitCode !== 0) throw new Error(response.stderr || "Supabase inventory failed");
    const parsed = JSON.parse(response.stdout) as Record<string, unknown>[];
    const resources = parsed.map((project) => ({
      id: project.id,
      name: project.name,
      region: project.region,
      status: project.status,
      organization_id: project.organization_id,
    }));
    return {connectorId: "supabase", resources, observedAt: new Date().toISOString()};
  }
}
