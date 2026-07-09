import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import type { PluginOption } from "vite";
import { defineConfig } from "vite";

const rootDir = import.meta.dirname;

const isAnalyze = process.env.VITE_BUNDLE_ANALYZE === "true";

async function loadVisualizer(): Promise<PluginOption | undefined> {
  if (!isAnalyze) return undefined;
  const { visualizer } = await import("rollup-plugin-visualizer");
  return visualizer({
    open: true,
    filename: "dist/bundle-stats.html",
    gzipSize: true,
  }) as PluginOption;
}

export default defineConfig(async () => {
  const analyzePlugin = await loadVisualizer();

  return {
    plugins: [
      react({
        babel: { plugins: ["babel-plugin-react-compiler"] },
        jsxRuntime: "automatic",
      }),
      tailwindcss(),
      ...(analyzePlugin ? [analyzePlugin] : []),
    ],

    resolve: {
      alias: {
        "#components": resolve(rootDir, "src/components"),
        "#store": resolve(rootDir, "src/store"),
        "#lib": resolve(rootDir, "src/lib"),
        "#workers": resolve(rootDir, "src/workers"),
        "#hooks": resolve(rootDir, "src/hooks"),
        "#pages": resolve(rootDir, "src/pages"),
        "#styles": resolve(rootDir, "src/styles"),
      },
    },

    build: {
      // Vite 8.0.0 stable — Rolldown is the bundler
      minify: "rolldown",
      sourcemap: true,
      target: "es2026",
      modulePreload: { polyfill: false }, // Chromium 146+ native
      rolldownOptions: {
        output: {
          manualChunks: {
            "react-vendor": ["react", "react-dom"],
            motion: ["framer-motion", "gsap"],
            graph: ["@xyflow/react", "elkjs"],
            terminal: ["@xterm/xterm", "@xterm/addon-fit", "@xterm/addon-webgl"],
            state: ["zustand", "immer", "jotai"],
            ai: ["@anthropic-ai/sdk"],
            charts: ["recharts"],
          },
        },
      },
    },

    optimizeDeps: {
      // Rolldown handles pre-bundling — explicit includes for any CJS compat
      include: ["gsap", "elkjs"],
    },

    worker: {
      format: "es", // ES module workers — Chromium 146+ native
    },

    server: {
      port: 1420,
      strictPort: true,
      watch: {
        ignored: ["**/src-tauri/**", "**/node_modules/**", "**/dist/**", "**/.git/**"],
        usePolling: false,
      },
      fs: { strict: true },
    },
  };
});
