import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import type { PluginOption, UserConfig } from "vite";
import { defineConfig } from "vite";
import pkg from "./package.json" with { type: "json" };

// `#components/*`, `#lib/*`, … resolve through package.json `imports` —
// Vite, Vitest and TypeScript all read that map natively, so there is no
// `resolve.alias` block to keep in sync.
export default defineConfig(async ({ mode }): Promise<UserConfig> => {
  const analyzePlugins: PluginOption[] = [];
  if (mode === "analyze") {
    const { visualizer } = await import("rollup-plugin-visualizer");
    analyzePlugins.push(
      visualizer({
        open: true,
        filename: "dist/bundle-stats.html",
        gzipSize: true,
      }) as PluginOption,
    );
  }

  return {
    plugins: [
      // Vite 8: plugin-react is Oxc-based; React Compiler runs via @rolldown/plugin-babel
      react(),
      babel({ presets: [reactCompilerPreset()] }),
      tailwindcss(),
      ...analyzePlugins,
    ],

    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
      // Headless-daemon plan Phase 3: selects `wsTransport` at build
      // time for `pnpm build:web` (`--mode web`, see below); every
      // other mode leaves this undefined, so `#lib/transport`'s
      // `selectTransport()` keeps `tauriTransport` — the existing
      // `tauri dev`/`tauri build`/plain `pnpm dev` behavior is
      // completely unaffected by this define's existence.
      __SWARM_TRANSPORT__: JSON.stringify(mode === "web" ? "ws" : "tauri"),
    },

    build: {
      sourcemap: true,
      // Tauri renders in Chromium 146+ (WebView2/WKWebView) — no downleveling needed;
      // `build:web`'s target is any modern evergreen browser, close enough not to warrant a second target.
      target: "esnext",
      // `build:web` writes to a separate directory so it never collides
      // with (or gets clobbered by) the Tauri bundle's own `dist/` —
      // `swarmd --serve-ui dist-web` points at this one.
      outDir: mode === "web" ? "dist-web" : "dist",
      modulePreload: { polyfill: false },
      rolldownOptions: {
        output: {
          // Vite 8/Rolldown: manualChunks is gone; codeSplitting is the replacement
          codeSplitting: {
            groups: [
              { name: "react-vendor", test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
              { name: "motion", test: /node_modules[\\/]motion[\\/]/ },
              { name: "graph", test: /node_modules[\\/](@xyflow|elkjs)[\\/]/ },
              { name: "terminal", test: /node_modules[\\/]@xterm[\\/]/ },
              { name: "state", test: /node_modules[\\/](zustand|immer|jotai)[\\/]/ },
              { name: "ai", test: /node_modules[\\/]@anthropic-ai[\\/]/ },
              { name: "charts", test: /node_modules[\\/](recharts|d3-[a-z-]+)[\\/]/ },
            ],
          },
        },
      },
    },

    optimizeDeps: {
      // useElkLayout imports only the thin elk-api driver; the layout engine
      // runs in src/workers/elk.worker.ts. The dep scanner never crawls worker
      // entries, so without the explicit elk-worker entry a cold dev server
      // discovers it on first graph render and force-reloads every open page.
      include: ["elkjs/lib/elk-api.js", "elkjs/lib/elk-worker.js"],
    },

    worker: {
      format: "es",
    },

    server: {
      port: 1420,
      strictPort: true,
      watch: {
        // Vite already ignores .git, node_modules, test-results and its cache
        // dir. Cargo's target/ may live under src-tauri/ or at the repo root.
        ignored: [
          "**/src-tauri/**",
          "**/crates/**",
          "**/target/**",
          "**/dist/**",
          "**/dist-web/**",
        ],
      },
    },
  };
});
