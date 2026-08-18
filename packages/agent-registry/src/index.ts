export interface AgentDefinition {
  readonly id: string;
  readonly displayName: string;
  readonly promptFile: string;
  readonly capabilities: readonly string[];
  readonly triggers: readonly string[];
}

export interface AgentActivationDecision {
  readonly definition: AgentDefinition;
  readonly why: string;
  readonly modelClass: "reasoning" | "coding" | "fast";
  readonly estimatedCostUsd: number | "UNKNOWN";
  readonly scopes: readonly string[];
  readonly deactivateWhen: string;
}

const DEFINITIONS: readonly AgentDefinition[] = [
  role("client-intake-account", "Client Intake and Account", ["intake", "clarification"], ["request", "client", "objective"]),
  role("sales-qualification", "Sales and Qualification", ["qualification"], ["sales", "lead", "proposal"]),
  role("discovery-business-analyst", "Discovery Business Analyst", ["analysis"], ["workflow", "requirement", "discovery"]),
  role("product-manager", "Product Manager", ["planning"], ["feature", "product", "acceptance"]),
  role("project-manager", "Project and Delivery Manager", ["scheduling"], ["plan", "delivery", "milestone"]),
  role("ux-researcher", "UX Researcher", ["research"], ["user research", "interview", "persona"]),
  role("ux-ui-designer", "UX/UI Designer", ["design"], ["ui", "ux", "screen", "design"]),
  role("solution-architect", "Solution Architect", ["architecture"], ["integration", "system", "architecture"]),
  role("risk-compliance-advisor", "Risk and Compliance Advisor", ["risk"], ["regulated", "compliance", "privacy"]),
  role("finops-commercial", "FinOps and Commercial Analyst", ["budget"], ["cost", "budget", "commercial"]),
  role("technical-lead", "Technical Lead / Software Architect", ["architecture", "review"], ["code", "bug", "api", "architecture"]),
  role("frontend-engineer", "Frontend Engineer", ["workspace:write", "test"], ["frontend", "react", "css", "page", "ui"]),
  role("backend-engineer", "Backend Engineer", ["workspace:write", "test"], ["backend", "api", "server", "authentication"]),
  role("data-database-engineer", "Data / Database Engineer", ["database:plan"], ["database", "sql", "migration", "schema"]),
  role("integration-engineer", "Integration Engineer", ["connector:plan"], ["integration", "webhook", "github", "vercel", "supabase"]),
  role("code-reviewer", "Code Reviewer", ["review"], ["code", "change", "review"]),
  role("qa-strategist", "QA Strategist / Quality Lead", ["verification"], ["test", "quality", "acceptance"]),
  role("test-automation-engineer", "Test Automation Engineer", ["test"], ["test", "automation", "regression"]),
  role("security-engineer", "Security Engineer", ["security:review"], ["auth", "secret", "security", "permission", "production"]),
  role("performance-reliability", "Performance and Reliability Engineer", ["reliability"], ["performance", "load", "latency", "reliability"]),
  role("devops-platform", "DevOps / Platform Engineer", ["deployment:plan"], ["deploy", "infrastructure", "docker", "ci"]),
  role("release-manager", "Release Manager", ["release:plan"], ["release", "production", "publish"]),
  role("sre-incident-manager", "SRE / Incident Manager", ["incident"], ["incident", "outage", "rollback"]),
  role("technical-writer", "Technical Writer / Documentation Engineer", ["documentation"], ["docs", "documentation", "readme"]),
  role("customer-support-success", "Customer Support and Customer Success", ["support"], ["support", "customer", "handoff"]),
] as const;

export const ORCHESTRATOR: AgentDefinition = {
  id: "orchestrator",
  displayName: "Master Orchestrator",
  promptFile: "prompts/master-orchestrator.md",
  capabilities: ["plan", "schedule", "delegate"],
  triggers: ["always"],
};

export class AgentRegistry {
  readonly #byId = new Map(DEFINITIONS.map((definition) => [definition.id, definition]));

  public list(): readonly AgentDefinition[] {
    return DEFINITIONS;
  }

  public get(id: string): AgentDefinition | undefined {
    return id === ORCHESTRATOR.id ? ORCHESTRATOR : this.#byId.get(id);
  }

  public activateFor(objective: string): readonly AgentDefinition[] {
    const normalized = objective.toLowerCase();
    const required = new Set<string>(["client-intake-account", "product-manager", "project-manager", "technical-lead", "code-reviewer", "qa-strategist"]);
    for (const definition of DEFINITIONS) {
      if (definition.triggers.some((trigger) => normalized.includes(trigger))) required.add(definition.id);
    }
    if (/frontend|react|ui|screen|page/u.test(normalized)) required.add("frontend-engineer");
    if (/backend|api|server|auth/u.test(normalized)) required.add("backend-engineer");
    if (/code|bug|fix|implement|build/u.test(normalized) && !required.has("frontend-engineer")) required.add("backend-engineer");
    if (/production|secret|auth|payment|customer data/u.test(normalized)) required.add("security-engineer");
    return DEFINITIONS.filter((definition) => required.has(definition.id));
  }

  public activationPlan(objective: string): readonly AgentActivationDecision[] {
    const normalized = objective.toLowerCase();
    return this.activateFor(objective).map((definition) => Object.freeze({
      definition,
      why: definition.triggers.find((trigger) => normalized.includes(trigger)) === undefined
        ? "required governance role for the bounded delivery lifecycle"
        : `objective matched the '${definition.triggers.find((trigger) => normalized.includes(trigger))}' activation signal`,
      modelClass: definition.capabilities.some((capability) => capability.includes("write") || capability === "test")
        ? "coding"
        : definition.capabilities.some((capability) => capability.includes("architecture") || capability.includes("security"))
          ? "reasoning"
          : "fast",
      estimatedCostUsd: 0,
      scopes: Object.freeze([...definition.capabilities]),
      deactivateWhen: "assigned task is terminal and all required evidence has been recorded",
    }));
  }
}

function role(
  id: string,
  displayName: string,
  capabilities: readonly string[],
  triggers: readonly string[],
): AgentDefinition {
  return {id, displayName, promptFile: `prompts/roles/${id}.md`, capabilities, triggers};
}
