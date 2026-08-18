export interface DagNode {
  readonly id: string;
  readonly dependsOn: readonly string[];
}

export const NODE_EXECUTION_STATUSES = TASK_STATUSES;
export type NodeExecutionStatus = TaskStatus;

export interface DagReadiness {
  readonly ready: readonly string[];
  readonly waiting: readonly string[];
  readonly blocked: readonly string[];
}

export class DagValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "DagValidationError";
  }
}

function exactIdentifier(value: string): boolean {
  return value.length > 0 && value.trim() === value;
}

function indexNodes(nodes: readonly DagNode[]): ReadonlyMap<string, DagNode> {
  const byId = new Map<string, DagNode>();
  for (const node of nodes) {
    if (!exactIdentifier(node.id)) {
      throw new DagValidationError("DAG node IDs must be non-empty and exact");
    }
    if (byId.has(node.id)) {
      throw new DagValidationError(`duplicate DAG node: ${node.id}`);
    }
    if (new Set(node.dependsOn).size !== node.dependsOn.length) {
      throw new DagValidationError(`duplicate dependency on node: ${node.id}`);
    }
    byId.set(node.id, node);
  }

  for (const node of nodes) {
    for (const dependency of node.dependsOn) {
      if (!byId.has(dependency)) {
        throw new DagValidationError(`unknown dependency '${dependency}' on node '${node.id}'`);
      }
      if (dependency === node.id) {
        throw new DagValidationError(`self dependency on node: ${node.id}`);
      }
    }
  }
  return byId;
}

export function topologicalOrder(nodes: readonly DagNode[]): readonly string[] {
  const byId = indexNodes(nodes);
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const node of nodes) {
    indegree.set(node.id, node.dependsOn.length);
    for (const dependency of node.dependsOn) {
      const children = dependents.get(dependency) ?? [];
      children.push(node.id);
      dependents.set(dependency, children);
    }
  }

  const ready = [...byId.keys()].filter((id) => indegree.get(id) === 0).sort();
  const ordered: string[] = [];
  while (ready.length > 0) {
    const current = ready.shift();
    if (current === undefined) {
      break;
    }
    ordered.push(current);
    for (const dependent of (dependents.get(current) ?? []).sort()) {
      const next = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, next);
      if (next === 0) {
        ready.push(dependent);
        ready.sort();
      }
    }
  }

  if (ordered.length !== nodes.length) {
    const cycleMembers = [...byId.keys()].filter((id) => !ordered.includes(id)).sort();
    throw new DagValidationError(`dependency cycle detected among: ${cycleMembers.join(", ")}`);
  }
  return Object.freeze(ordered);
}

export function validateDag(nodes: readonly DagNode[]): void {
  topologicalOrder(nodes);
}

export function getDagReadiness(
  nodes: readonly DagNode[],
  statuses: Readonly<Record<string, NodeExecutionStatus>>,
): DagReadiness {
  const byId = indexNodes(nodes);
  topologicalOrder(nodes);
  for (const id of Object.keys(statuses)) {
    if (!byId.has(id)) {
      throw new DagValidationError(`status supplied for unknown node: ${id}`);
    }
  }

  const statusOf = (id: string): NodeExecutionStatus => statuses[id] ?? "PROPOSED";
  const ready: string[] = [];
  const waiting: string[] = [];
  const blocked: string[] = [];

  for (const node of nodes) {
    if (statusOf(node.id) !== "PROPOSED" && statusOf(node.id) !== "BLOCKED") {
      continue;
    }
    const dependencyStatuses = node.dependsOn.map(statusOf);
    if (dependencyStatuses.some((status) => status === "FAILED" || status === "CANCELED")) {
      blocked.push(node.id);
    } else if (dependencyStatuses.every((status) => status === "PASSED" || status === "SKIPPED")) {
      ready.push(node.id);
    } else {
      waiting.push(node.id);
    }
  }

  return Object.freeze({
    ready: Object.freeze(ready.sort()),
    waiting: Object.freeze(waiting.sort()),
    blocked: Object.freeze(blocked.sort()),
  });
}

export function readyNodeIds(
  nodes: readonly DagNode[],
  completed: ReadonlySet<string>,
): readonly string[] {
  const statuses: Record<string, NodeExecutionStatus> = {};
  for (const id of completed) {
    statuses[id] = "PASSED";
  }
  return getDagReadiness(nodes, statuses).ready;
}
import { TASK_STATUSES, type TaskStatus } from "./state-machines.js";
