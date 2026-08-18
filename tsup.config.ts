import {defineConfig} from "tsup";

export default defineConfig({
  entry: {
    cli: "apps/cli/src/index.ts",
    controller: "apps/controller-daemon/src/index.ts",
    worker: "apps/worker-runtime/src/index.ts",
  },
  format: ["esm"],
  target: "node22",
  platform: "node",
  external: ["node:sqlite"],
  removeNodeProtocol: false,
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  banner: {
    js: "#!/usr/bin/env node",
  },
});
