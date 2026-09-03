import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    allowOnly: false,
    globals: true,
    setupFiles: ["./test/setup.ts"],
    include: [
      "src/**/*.test.ts",
      "test/**/*.integration.test.ts",
      "test/package-contract.test.ts",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/tui.tsx"],
    },
  },
});
