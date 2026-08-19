import {runCli} from "./index.js";

process.stderr.write(
  "Deprecated: 'agent-company' was renamed to 'software-agent'. " +
  "This compatibility alias will be removed after v0.3.\n",
);
process.exitCode = await runCli(process.argv);
