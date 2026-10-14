import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    restoreMocks: true,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // Entry files only call into tested modules; adapter.ts holds types only.
      exclude: ["src/entries/**", "src/shared/adapter.ts"],
      reporter: ["text", "html"],
      thresholds: { lines: 95, statements: 95, functions: 95, branches: 95 },
    },
  },
});
