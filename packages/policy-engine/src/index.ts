import {
  EXTERNAL_CONNECTORS,
  hasOperationIntegrity,
  type Environment,
  type ExternalConnector,
  type OperationCandidate,
} from "../../contracts/src/index.js";

export const APPROVAL_CLASSES = [
  "A0_OBSERVE",
  "A1_LOCAL_REVERSIBLE",
  "A2_REMOTE_REVERSIBLE",
  "A3_SHARED_MUTATION",
  "A4_PRODUCTION_OR_SECURITY",
  "A5_DESTRUCTIVE_OR_IRREVERSIBLE",
] as const;
export type ApprovalClass = (typeof APPROVAL_CLASSES)[number];

export const RISK_CLASSES = [
  "observe",
  "local_reversible",
  "remote_reversible",
  "shared_mutation",
  "production_or_security",
  "destructive_or_irreversible",
  "hard_denied",
  "unknown",
] as const;
export type RiskClass = (typeof RISK_CLASSES)[number];

export interface PolicyDecision {
  readonly permitted: boolean;
  readonly hardDenied: boolean;
  readonly requiresApproval: boolean;
  readonly approvalClass: ApprovalClass | null;
  readonly risk: RiskClass;
  readonly reason: string;
  readonly operationHash: string;
}

interface Rule {
  readonly approvalClass: ApprovalClass;
  readonly risk: Exclude<RiskClass, "hard_denied" | "unknown">;
  readonly reason: string;
}

const A0: Rule = {
  approvalClass: "A0_OBSERVE",
  risk: "observe",
  reason: "read-only connector discovery",
};
const A2: Rule = {
  approvalClass: "A2_REMOTE_REVERSIBLE",
  risk: "remote_reversible",
  reason: "reversible mutation of an isolated remote resource",
};
const A3: Rule = {
  approvalClass: "A3_SHARED_MUTATION",
  risk: "shared_mutation",
  reason: "mutation of a shared non-production resource",
};
const A4: Rule = {
  approvalClass: "A4_PRODUCTION_OR_SECURITY",
  risk: "production_or_security",
  reason: "production, protected-branch, or security-sensitive mutation",
};
const A5: Rule = {
  approvalClass: "A5_DESTRUCTIVE_OR_IRREVERSIBLE",
  risk: "destructive_or_irreversible",
  reason: "destructive or irreversible mutation; denied by default",
};

const STATIC_RULES: Readonly<Record<ExternalConnector, Readonly<Record<string, Rule>>>> = {
  github: {
    auth_status: A0,
    account: A0,
    list_repositories: A0,
    get_repository: A0,
    read_file: A0,
    list_branches: A0,
    status: A0,
    diff: A0,
    create_branch: A2,
    push: A2,
    create_pull_request: A2,
    open_draft_pull_request: A2,
    mark_pull_request_ready: A3,
    request_reviewers: A3,
    create_comment: A3,
    delete_branch: A3,
    merge_pull_request: A4,
    force_push: A4,
    transfer_repository: A4,
    delete_repository: A5,
  },
  vercel: {
    auth_status: A0,
    account: A0,
    list_projects: A0,
    get_project: A0,
    list_deployments: A0,
    deployment_status: A0,
    logs: A0,
    deploy_preview: A2,
    delete_deployment: A3,
    deploy_production: A4,
    promote_to_production: A4,
    rollback_production: A4,
    set_environment_variable: A4,
    delete_project: A5,
  },
  supabase: {
    auth_status: A0,
    account: A0,
    list_projects: A0,
    get_project: A0,
    inspect_schema: A0,
    schema_diff: A0,
    list_migrations: A0,
    apply_migration: A2,
    seed_database: A2,
    set_secret: A3,
    reset_database: A5,
    delete_function: A5,
    delete_database: A5,
    delete_project: A5,
  },
};

function denied(
  operation: OperationCandidate,
  reason: string,
  hardDenied: boolean,
  approvalClass: ApprovalClass | null = null,
): PolicyDecision {
  return Object.freeze({
    permitted: false,
    hardDenied,
    requiresApproval: false,
    approvalClass,
    risk: hardDenied ? "hard_denied" : approvalClass === A5.approvalClass
      ? "destructive_or_irreversible"
      : "unknown",
    reason,
    operationHash: operation.operationHash,
  });
}

function isProduction(environment: Environment): boolean {
  return environment === "production";
}

function isProtectedGitHubTarget(operation: OperationCandidate): boolean {
  return operation.parameters.protected === true || operation.parameters.defaultBranch === true;
}

function dynamicRule(operation: OperationCandidate, base: Rule): Rule {
  if (operation.connector === "github") {
    if (operation.action === "force_push" && isProtectedGitHubTarget(operation)) {
      return A5;
    }
    if (operation.action === "push" && (isProduction(operation.environment) || isProtectedGitHubTarget(operation))) {
      return A4;
    }
  }

  if (
    operation.connector === "vercel" &&
    operation.action === "delete_deployment" &&
    isProduction(operation.environment)
  ) {
    return A5;
  }

  if (operation.connector === "supabase") {
    if (operation.action === "apply_migration") {
      if (isProduction(operation.environment)) {
        return A4;
      }
      if (operation.environment === "staging") {
        return A3;
      }
    }
    if (operation.action === "set_secret" && isProduction(operation.environment)) {
      return A4;
    }
  }

  return base;
}

export function evaluateConnectorOperation(operation: OperationCandidate): PolicyDecision {
  if (!hasOperationIntegrity(operation)) {
    return denied(operation, "operation hash does not match canonical candidate", true);
  }

  if (!(EXTERNAL_CONNECTORS as readonly string[]).includes(operation.connector)) {
    return denied(operation, "local control-boundary actions are not connector operations", false);
  }

  if (
    isProduction(operation.environment) &&
    ["copy_secret", "copy_secrets", "copy_environment_secrets"].includes(operation.action)
  ) {
    return denied(
      operation,
      "copying secrets into production is prohibited",
      true,
      "A5_DESTRUCTIVE_OR_IRREVERSIBLE",
    );
  }

  if (
    operation.connector === "supabase" &&
    isProduction(operation.environment) &&
    (operation.action === "reset_database" || operation.action === "seed_database")
  ) {
    return denied(
      operation,
      `Supabase production ${operation.action} is prohibited`,
      true,
      "A5_DESTRUCTIVE_OR_IRREVERSIBLE",
    );
  }

  const connector = operation.connector as ExternalConnector;
  const base = STATIC_RULES[connector][operation.action];
  if (base === undefined) {
    return denied(
      operation,
      `unknown ${operation.connector} operation '${operation.action}' is denied by default`,
      false,
    );
  }

  const rule = dynamicRule(operation, base);
  if (rule.approvalClass === "A5_DESTRUCTIVE_OR_IRREVERSIBLE") {
    return denied(operation, rule.reason, false, rule.approvalClass);
  }

  return Object.freeze({
    permitted: true,
    hardDenied: false,
    requiresApproval:
      rule.approvalClass !== "A0_OBSERVE" && rule.approvalClass !== "A1_LOCAL_REVERSIBLE",
    approvalClass: rule.approvalClass,
    risk: rule.risk,
    reason: rule.reason,
    operationHash: operation.operationHash,
  });
}
