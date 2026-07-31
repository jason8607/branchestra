import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/private/**/*.test.ts"],
    restoreMocks: true,
    testTimeout: 120_000,
  },
});
