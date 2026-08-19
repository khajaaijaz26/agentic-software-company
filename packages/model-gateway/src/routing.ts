import {hasControlCharacters} from "./types.js";

export type ModelRouteSource = "RUN" | "NEXT_RUN" | "ROLE" | "PROJECT" | "USER" | "EXPLICIT_CHANGE";

export interface ModelRoutingRevision {
  readonly schema: "software-agent.model-route/v1";
  readonly revision: number;
  readonly providerId: string;
  readonly modelId: string;
  readonly source: ModelRouteSource;
  readonly changedAt?: string;
}

export interface ModelRouteSelection {
  readonly runOverride?: string;
  readonly nextRunSelection?: string;
  readonly roleId?: string;
  readonly roleRoutes?: Readonly<Record<string, string>>;
  readonly projectDefault?: string;
  readonly userDefault?: string;
  readonly revision: number;
}

export function resolveModelRoute(selection: ModelRouteSelection): ModelRoutingRevision {
  if (!Number.isSafeInteger(selection.revision) || selection.revision < 1) throw new Error("model routing revision must be positive");
  const role = selection.roleId === undefined ? undefined : selection.roleRoutes?.[selection.roleId];
  const candidates: readonly [string | undefined, Exclude<ModelRouteSource, "EXPLICIT_CHANGE">][] = [
    [selection.runOverride, "RUN"],
    [selection.nextRunSelection, "NEXT_RUN"],
    [role, "ROLE"],
    [selection.projectDefault, "PROJECT"],
    [selection.userDefault, "USER"],
  ];
  for (const [identifier, source] of candidates) {
    if (identifier !== undefined) {
      const parsed = parseModelIdentifier(identifier);
      return Object.freeze({schema: "software-agent.model-route/v1", revision: selection.revision, ...parsed, source});
    }
  }
  throw new Error("no model route is configured");
}

export function createModelRoutingRevision(
  current: ModelRoutingRevision,
  identifier: string,
  changedAt: string,
): ModelRoutingRevision {
  if (!Number.isFinite(Date.parse(changedAt))) throw new Error("routing revision timestamp must be valid ISO time");
  const parsed = parseModelIdentifier(identifier);
  return Object.freeze({
    schema: "software-agent.model-route/v1",
    revision: current.revision + 1,
    ...parsed,
    source: "EXPLICIT_CHANGE",
    changedAt,
  });
}

export function parseModelIdentifier(identifier: string): {readonly providerId: string; readonly modelId: string} {
  const separator = identifier.indexOf("/");
  const providerId = separator < 0 ? "" : identifier.slice(0, separator);
  const modelId = separator < 0 ? "" : identifier.slice(separator + 1);
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(providerId)) throw new Error("invalid model provider ID");
  if (modelId.length < 1 || modelId.length > 256 || hasControlCharacters(modelId) || modelId.includes("://")) {
    throw new Error("invalid model ID");
  }
  return Object.freeze({providerId, modelId});
}
