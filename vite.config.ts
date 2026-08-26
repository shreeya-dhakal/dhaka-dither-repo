import { defineConfig } from "vitest/config";

export default defineConfig({
  // Relative, so `dist/` works when opened from any static file server path.
  base: "./",
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
