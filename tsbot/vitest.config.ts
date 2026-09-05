import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    globals: true,
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
