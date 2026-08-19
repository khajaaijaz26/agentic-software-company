import {existsSync, readFileSync, readdirSync} from "node:fs";
import {basename, dirname, join, resolve} from "node:path";

import {describe, expect, it} from "vitest";

import {
  AGENT_SESSION_STATES,
  SOFTWARE_AGENT_ROLES,
} from "../../packages/domain/src/index.js";
import {
  CONTROLLER_METHODS,
  IPC_PROTOCOL_MAX,
  IPC_PROTOCOL_MIN,
} from "../../packages/ipc/src/index.js";
import {PROJECT_ROOM_SNAPSHOT_SCHEMA} from "../../apps/operator-console/src/project-room-state.js";

type JsonObject = Record<string, unknown>;

const SCHEMA_DIRECTORY = resolve("schemas/vnext");

function schema(name: string): JsonObject {
  return JSON.parse(readFileSync(join(SCHEMA_DIRECTORY, name), "utf8")) as JsonObject;
}

function object(value: unknown): JsonObject {
  expect(value).not.toBeNull();
  expect(typeof value).toBe("object");
  expect(Array.isArray(value)).toBe(false);
  return value as JsonObject;
}

function atPointer(document: unknown, fragment: string): unknown {
  if (fragment === "" || fragment === "#") return document;
  expect(fragment.startsWith("#/"), `unsupported JSON pointer: ${fragment}`).toBe(true);
  return fragment.slice(2).split("/").reduce<unknown>((current, token) => {
    const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
    return object(current)[key];
  }, document);
}

function visit(value: unknown, visitor: (candidate: JsonObject) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) visit(item, visitor);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  const candidate = value as JsonObject;
  visitor(candidate);
  for (const item of Object.values(candidate)) visit(item, visitor);
}

describe("v0.7 public schema contracts", () => {
  it("declares unique Draft 2020-12 identities and resolvable local references", () => {
    const names = readdirSync(SCHEMA_DIRECTORY).filter((name) => name.endsWith(".json")).sort();
    const identities = new Set<string>();
    expect(names.length).toBeGreaterThanOrEqual(30);
    for (const name of names) {
      const document = schema(name);
      expect(document.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
      expect(document.$id).toBe(`https://schemas.software-agent.dev/vnext/${name}`);
      expect(identities.has(String(document.$id))).toBe(false);
      identities.add(String(document.$id));
      visit(document, (candidate) => {
        if (typeof candidate.$ref !== "string") return;
        const [referencePath = "", fragment = ""] = candidate.$ref.split("#", 2);
        const targetName = referencePath === "" ? name : basename(referencePath);
        const targetPath = referencePath === "" ? join(SCHEMA_DIRECTORY, name) : resolve(dirname(join(SCHEMA_DIRECTORY, name)), referencePath);
        expect(existsSync(targetPath), `${name} -> ${candidate.$ref}`).toBe(true);
        expect(resolve(dirname(targetPath))).toBe(SCHEMA_DIRECTORY);
        expect(basename(targetPath)).toBe(targetName);
        expect(atPointer(schema(targetName), fragment === "" ? "" : `#${fragment}`), `${name} -> ${candidate.$ref}`).not.toBeUndefined();
      });
    }
  });

  it("tracks the exact registered IPC method set and protocol range", () => {
    const request = schema("ipc-request.schema.json");
    const requestProperties = object(request.properties);
    expect(object(requestProperties.protocolVersion).enum).toEqual([IPC_PROTOCOL_MIN, IPC_PROTOCOL_MAX]);
    expect(object(requestProperties.method).enum).toEqual([...CONTROLLER_METHODS]);

    const descriptor = schema("controller-descriptor.schema.json");
    const descriptorProperties = object(descriptor.properties);
    const protocol = object(object(descriptorProperties.protocol).properties);
    expect(object(protocol.min).const).toBe(IPC_PROTOCOL_MIN);
    expect(object(protocol.max).const).toBe(IPC_PROTOCOL_MAX);
  });

  it("tracks runtime roles, session states, and project-room identity", () => {
    const task = schema("task.schema.json");
    const taskProperties = object(task.properties);
    expect(object(taskProperties.role).enum).toEqual([...SOFTWARE_AGENT_ROLES]);

    const run = schema("run.schema.json");
    const definitions = object(run.$defs);
    expect(object(definitions.role).enum).toEqual([...SOFTWARE_AGENT_ROLES]);
    expect(object(object(object(definitions.session).properties).state).enum).toEqual([...AGENT_SESSION_STATES]);

    const room = schema("project-room.schema.json");
    expect(object(object(room.properties).schema).const).toBe(PROJECT_ROOM_SNAPSHOT_SCHEMA);
  });

  it("isolates old product identifiers in explicitly named legacy reader schemas", () => {
    for (const name of readdirSync(SCHEMA_DIRECTORY).filter((entry) => entry.endsWith(".json"))) {
      const text = readFileSync(join(SCHEMA_DIRECTORY, name), "utf8");
      if (!text.includes("agent-company.")) continue;
      expect(name.startsWith("legacy-"), `${name} contains a legacy product schema`).toBe(true);
    }
  });
});
