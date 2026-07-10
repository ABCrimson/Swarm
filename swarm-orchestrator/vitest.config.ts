import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const dirname = import.meta.dirname;

const pkg = JSON.parse(readFileSync(resolve(dirname, "package.json"), "utf8")) as {
  version: string;
};

export default defineConfig({
  // Mirrors vite.config.ts's `define` — components reading __APP_VERSION__
  // (e.g. Settings, Sidebar) need it defined to render under vitest/jsdom.
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
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
      "#components": resolve(dirname, "src/components"),
      "#store": resolve(dirname, "src/store"),
      "#lib": resolve(dirname, "src/lib"),
      "#hooks": resolve(dirname, "src/hooks"),
      "#pages": resolve(dirname, "src/pages"),
      "#workers": resolve(dirname, "src/workers"),
      "#styles": resolve(dirname, "src/styles"),
    },
  },
});
