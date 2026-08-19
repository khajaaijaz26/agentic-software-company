import {defineConfig} from "tsup";

export default defineConfig({
  entry: {
    cli: "apps/cli/src/bin.ts",
    "compat-agent-company": "apps/cli/src/compat-agent-company.ts",
    controller: "apps/controller-daemon/src/bin.ts",
    worker: "apps/worker-runtime/src/bin.ts",
  },
  format: ["esm"],
  target: "node22",
  platform: "node",
  external: ["node:sqlite"],
  removeNodeProtocol: false,
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: true,
  banner: {
    js: "#!/usr/bin/env node",
  },
});
