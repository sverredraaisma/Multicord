import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    restoreMocks: true,
    // Tests are fast (mocked I/O), but a busy machine (an emulator, a Gradle build) once pushed
    // a few past the 5 s default under coverage; a hang still fails, just later.
    testTimeout: 15_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // Entry files only call into tested modules; adapter.ts holds types only.
      exclude: ["src/entries/**", "src/shared/adapter.ts"],
      reporter: ["text", "html"],
      thresholds: {
        lines: 95,
        statements: 95,
        functions: 95,
        branches: 95,
        // The logic both the desktop and a mobile host run: fully covered.
        "src/core/**": { lines: 100, statements: 100, functions: 100, branches: 100 },
      },
    },
  },
});
