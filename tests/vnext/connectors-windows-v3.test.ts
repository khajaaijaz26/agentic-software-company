import {mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

import {afterAll, describe, expect, it} from "vitest";

import {VercelConnector} from "../../adapters/vercel/src/index.js";
import {runConnectorCli} from "../../packages/connectors/src/index.js";

const describeWindows = process.platform === "win32" ? describe : describe.skip;

describeWindows("Windows connector CLI resolution", () => {
  const root = mkdtempSync(join(tmpdir(), "software-agent-connector-shim-"));

  afterAll(() => rmSync(root, {recursive: true, force: true}));

  it("invokes an npm-style PowerShell shim without interpreting argument text", async () => {
    const shim = join(root, "connector-fixture.ps1");
    writeFileSync(shim, "[Console]::Out.Write(($args -join [Environment]::NewLine))\n", "utf8");
    const hostileLiteral = "hello; [Console]::Out.Write('INJECTED')";

    const result = await runConnectorCli("connector-fixture", ["--value", hostileLiteral], {
      environment: {...process.env, PATH: root, Path: root},
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.split(/\r?\n/u)).toEqual(["--value", hostileLiteral]);
  });
});

describe("Vercel connector discovery", () => {
  it("uses the direct identity command instead of parsing a slow team table", async () => {
    const calls: string[][] = [];
    const runCli: typeof runConnectorCli = async (_executable, args) => {
      calls.push([...args]);
      return args[0] === "--version"
        ? {exitCode: 0, stdout: "58.11.0\n", stderr: "", timedOut: false}
        : {exitCode: 0, stdout: "khajaaijaz26\n", stderr: "", timedOut: false};
    };

    const probe = await new VercelConnector(runCli).probe();

    expect(calls).toEqual([["--version"], ["whoami"]]);
    expect(probe).toMatchObject({
      connectorId: "vercel",
      state: "CONNECTED",
      version: "58.11.0",
      account: "khajaaijaz26",
    });
  });
});
