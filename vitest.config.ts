import {defineConfig} from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/vnext/**/*.test.ts", "tests/vnext/**/*.test.tsx"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
    },
  },
});
