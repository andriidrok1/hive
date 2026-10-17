import { defineConfig } from "vitest/config";

// Only bench/test/** are bench tests. scenarios/extra/*.test.ts are acceptance tests
// that run inside a demo-app copy, never here.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});
