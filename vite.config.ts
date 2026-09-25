import tailwindcss from "@tailwindcss/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import type { PluginOption, UserConfig } from "vite";
import { defineConfig } from "vite";
import pkg from "./package.json" with { type: "json" };

/**
 * The React Compiler pipeline.
 *
 * Primary: the native Oxc port. `react({ compiler: true })` runs the
 * compiler, TypeScript stripping, JSX and Fast Refresh in one Rust pass
 * through `oxc-transform-react`'s prebuilt N-API binding.
 *
 * Fallback: Windows Smart App Control can refuse to load that binding
 * ("An Application Control policy has blocked this file"), so a failed
 * load drops to the Babel path: `@rolldown/plugin-babel` +
 * `reactCompilerPreset()`, i.e. babel-plugin-react-compiler on
 * @babel/core 7. Babel 8 is not an option there: every published
 * babel-plugin-react-compiler (1.0.0 and the experimental line) silently
 * skips components with a destructured default (`({ size = "md" })`,
 * react#36868) — re-measured 2026-09-25 on @babel/core 8.0.6.
 *
 * `SWARM_REACT_COMPILER=babel` forces the fallback so it can be verified
 * on hosts where Oxc loads. `pnpm check:compiler` fails the build when
 * either path leaves the key UI components uncompiled.
 */
async function reactWithCompiler(): Promise<PluginOption[]> {
  if (process.env.SWARM_REACT_COMPILER === "babel") {
    console.warn("[react-compiler] SWARM_REACT_COMPILER=babel: using the Babel fallback.");
  } else {
    try {
      await import("oxc-transform-react");
      return [react({ compiler: true })];
    } catch (error) {
      console.warn(
        `[react-compiler] Native Oxc binding unavailable (${loadFailureReason(error)}); using the Babel fallback.`,
      );
    }
  }
  const { default: babel } = await import("@rolldown/plugin-babel");
  return [react(), babel({ presets: [reactCompilerPreset()] })];
}

/**
 * The napi-rs loader throws a generic "Cannot find native binding" and
 * chains each attempt's real failure (e.g. the Smart App Control block)
 * through `cause` — surface those, one line each.
 */
function loadFailureReason(error: unknown): string {
  const reasons = new Set<string>();
  for (let e: unknown = error; e != null; e = e instanceof Error ? e.cause : undefined) {
    const line = (e instanceof Error ? e.message : String(e)).split("\n")[0]?.trim();
    if (line && !line.startsWith("Cannot find native binding")) reasons.add(line);
  }
  return reasons.size > 0 ? [...reasons].join("; ") : String(error);
}

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
    plugins: [...(await reactWithCompiler()), tailwindcss(), ...analyzePlugins],

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
