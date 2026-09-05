import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    globals: true,
    testTimeout: process.platform === "linux" ? 60_000 : 5_000,
    server: {
      deps: {
        inline: ["zod"],
      },
    },
    coverage: {
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
    },
  },
});
