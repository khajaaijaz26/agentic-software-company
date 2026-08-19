import {runCli} from "./index.js";

process.stderr.write(
  "Deprecated: 'agent-company' was renamed to 'software-agent'. " +
  "This compatibility alias is deprecated and will be removed in a future major release.\n",
);
process.exitCode = await runCli(process.argv);
