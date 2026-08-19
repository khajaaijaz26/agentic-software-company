import {mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

import {afterEach, describe, expect, it, vi} from "vitest";

import {
  WorkspaceEnvironment,
  WorkspaceEnvironmentError,
  type MutationAuthority,
} from "../../packages/workspace-environment/src/index.js";

const temporaryDirectories: string[] = [];
const authority: MutationAuthority = {
  leaseId: "lease_workspace",
  fencingEpoch: 7,
  operationId: "operation_write",
};

function temporaryDirectory(prefix = "software-agent-environment-"): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0).reverse()) {
    rmSync(directory, {recursive: true, force: true});
  }
});

describe("Software Agent workspace environment", () => {
  it("lists and reads bounded text without traversing state or dependency directories", async () => {
    const root = temporaryDirectory();
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, ".software-agent"));
    mkdirSync(join(root, "node_modules"));
    writeFileSync(join(root, "src", "index.ts"), "export const answer = 42;\n");
    writeFileSync(join(root, ".software-agent", "secret"), "hidden");
    writeFileSync(join(root, "node_modules", "dependency.js"), "hidden");
    const environment = await WorkspaceEnvironment.open(root);

    expect(await environment.listFiles()).toEqual(["src/index.ts"]);
    await expect(environment.readText("src/index.ts")).resolves.toMatchObject({
      content: "export const answer = 42;\n",
      sizeBytes: 26,
    });
    await expect(environment.readText("../outside.txt")).rejects.toBeInstanceOf(WorkspaceEnvironmentError);
  });

  it("retrieves bounded repository context without exposing ignored or secret files", async () => {
    const root = temporaryDirectory();
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "one.ts"), "export function visibleFeature() { return 1; }\n");
    writeFileSync(join(root, "src", "two.ts"), "// VISIBLEFEATURE is referenced here\n");
    writeFileSync(join(root, ".env"), "VISIBLEFEATURE=secret\n");
    const environment = await WorkspaceEnvironment.open(root);

    await expect(environment.searchText({query: "visibleFeature", path: "src", maxResults: 10})).resolves.toEqual([
      {path: "src/one.ts", line: 1, column: 17, preview: "export function visibleFeature() { return 1; }"},
      {path: "src/two.ts", line: 1, column: 4, preview: "// VISIBLEFEATURE is referenced here"},
    ]);
  });

  it("refuses symlink escapes", async () => {
    const root = temporaryDirectory();
    const outside = temporaryDirectory("software-agent-environment-outside-");
    writeFileSync(join(outside, "secret.txt"), "outside");
    try {
      symlinkSync(outside, join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    const environment = await WorkspaceEnvironment.open(root);
    await expect(environment.readText("escape/secret.txt")).rejects.toMatchObject({code: "PATH_SYMLINK"});
    expect(await environment.listFiles()).toEqual([]);
  });

  it("requires a fenced authority and exact expected digest before an atomic write", async () => {
    const root = temporaryDirectory();
    writeFileSync(join(root, "README.md"), "before\n");
    const authorizeMutation = vi.fn();
    const environment = await WorkspaceEnvironment.open(root, {authorizeMutation});
    const current = await environment.readText("README.md");

    await expect(environment.writeText({
      path: "README.md",
      content: "after\n",
      expectedSha256: "0".repeat(64),
      authority,
    })).rejects.toMatchObject({code: "FILE_REVISION_CONFLICT"});
    expect(readFileSync(join(root, "README.md"), "utf8")).toBe("before\n");

    const receipt = await environment.writeText({
      path: "README.md",
      content: "after\n",
      expectedSha256: current.sha256,
      authority,
    });
    expect(receipt).toMatchObject({path: "README.md", previousSha256: current.sha256, sizeBytes: 6});
    expect(authorizeMutation).toHaveBeenCalledOnce();
    expect(readFileSync(join(root, "README.md"), "utf8")).toBe("after\n");
  });

  it("uses null expected revision only for a new file and does not overwrite by accident", async () => {
    const root = temporaryDirectory();
    const environment = await WorkspaceEnvironment.open(root, {authorizeMutation: () => undefined});
    await environment.writeText({path: "src/new.ts", content: "new\n", expectedSha256: null, authority});
    await expect(environment.writeText({
      path: "src/new.ts",
      content: "replacement\n",
      expectedSha256: null,
      authority,
    })).rejects.toMatchObject({code: "FILE_REVISION_CONFLICT"});
  });

  it("spawns exact argv without a shell, scrubs secrets, and returns a bounded receipt", async () => {
    const root = temporaryDirectory();
    const authorizeCommand = vi.fn();
    const environment = await WorkspaceEnvironment.open(root, {
      authorizeCommand,
      sourceEnvironment: {
        PATH: process.env.PATH,
        Path: process.env.Path,
        PATHEXT: process.env.PATHEXT,
        SystemRoot: process.env.SystemRoot,
        OPENAI_API_KEY: "must-not-leak",
      },
    });
    const script = "process.stdout.write(JSON.stringify({arg:process.argv[1],secret:process.env.OPENAI_API_KEY??null}))";
    const result = await environment.runCommand({
      executable: process.execPath,
      args: ["-e", script, "value;not-a-shell-command"],
      authority,
    });

    expect(JSON.parse(result.stdout)).toEqual({arg: "value;not-a-shell-command", secret: null});
    expect(result).toMatchObject({exitCode: 0, timedOut: false, truncated: false});
    expect(authorizeCommand).toHaveBeenCalledOnce();
  });

  it("terminates a command as soon as its combined output exceeds the receipt limit", async () => {
    const root = temporaryDirectory();
    const environment = await WorkspaceEnvironment.open(root, {authorizeCommand: () => undefined});
    const started = Date.now();
    const result = await environment.runCommand({
      executable: process.execPath,
      args: ["-e", "setInterval(() => process.stdout.write('x'.repeat(4096)), 0)"],
      authority,
      maxOutputBytes: 512,
      timeoutMs: 30_000,
    });

    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(512);
    expect(result).toMatchObject({timedOut: false, truncated: true});
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("fails closed when mutation or command authorization is absent", async () => {
    const root = temporaryDirectory();
    const environment = await WorkspaceEnvironment.open(root);
    await expect(environment.writeText({path: "x.txt", content: "x", expectedSha256: null, authority}))
      .rejects.toMatchObject({code: "AUTHORIZATION_REQUIRED"});
    await expect(environment.runCommand({executable: process.execPath, args: ["--version"], authority}))
      .rejects.toMatchObject({code: "AUTHORIZATION_REQUIRED"});
  });
});
