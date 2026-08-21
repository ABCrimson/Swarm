import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import type { PluginOption } from "vite";
import { defineConfig } from "vite";

const rootDir = import.meta.dirname;

const pkg = JSON.parse(readFileSync(resolve(rootDir, "package.json"), "utf8")) as {
  version: string;
};

export default defineConfig(async ({ mode }) => {
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
      minify: "oxc",
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
              { name: "motion", test: /node_modules[\\/](motion|gsap)[\\/]/ },
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
      include: ["gsap", "elkjs"],
    },

    worker: {
      format: "es",
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
