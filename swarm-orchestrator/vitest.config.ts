import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/__tests__/setup.ts"],
    include: ["src/__tests__/**/*.test.{ts,tsx}"],
    css: false,
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/__tests__/**", "src/workers/**", "src/vite-env.d.ts"],
      thresholds: {
        statements: 40,
        branches: 40,
        functions: 40,
        lines: 40,
      },
    },
  },
  resolve: {
    alias: {
      "#components": resolve(__dirname, "src/components"),
      "#store": resolve(__dirname, "src/store"),
      "#lib": resolve(__dirname, "src/lib"),
      "#hooks": resolve(__dirname, "src/hooks"),
      "#pages": resolve(__dirname, "src/pages"),
      "#workers": resolve(__dirname, "src/workers"),
      "#styles": resolve(__dirname, "src/styles"),
    },
  },
});
