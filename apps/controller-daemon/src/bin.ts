import {runControllerDaemonCli} from "./index.js";

export * from "./index.js";

try {
  await runControllerDaemonCli();
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`software-agent controller: ${message}\n`);
  process.exitCode = 1;
}
