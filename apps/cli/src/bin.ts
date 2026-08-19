import {runCli} from "./index.js";

export {runCli};

process.exitCode = await runCli(process.argv);
