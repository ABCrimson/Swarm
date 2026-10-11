import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import type { PluginOption, UserConfig } from "vite";
import { defineConfig } from "vite";
import pkg from "./package.json" with { type: "json" };

/**
 * The React Compiler runs as the Oxc port: `react({ compiler: true })`
 * does the compiler, TypeScript stripping, JSX and Fast Refresh in one
 * Rust pass through `oxc-transform-react`. Its loader prefers the
 * prebuilt N-API binding and falls back to the WASI build
 * (`@oxc-transform-react/binding-wasm32-wasip1`, a devDependency) when
 * the native one cannot load — e.g. Windows Smart App Control refusing
 * it ("An Application Control policy has blocked this file").
 * `NAPI_RS_FORCE_WASI=true pnpm check:compiler` exercises that path on
 * any host; `pnpm check:compiler` fails the build when the key UI
 * components ship uncompiled either way. The dev server also surfaces
 * the compiler's recoverable bail-out diagnostics (`reportDiagnostics`).
 */
const reactWithCompiler = (dev: boolean): PluginOption[] =>
  react({ compiler: dev ? { reportDiagnostics: true } : true });

// `#components/*`, `#lib/*`, … resolve through package.json `imports` —
// Vite, Vitest and TypeScript all read that map natively, so there is no
// `resolve.alias` block to keep in sync.
export default defineConfig(async ({ mode, command }): Promise<UserConfig> => {
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
    // Keep the terminal history visible: `tauri dev` prints Rust build output alongside Vite's.
    clearScreen: false,
    plugins: [...reactWithCompiler(command === "serve"), tailwindcss(), ...analyzePlugins],

    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
      // Selects `wsTransport` at build time for `pnpm build:web`
      // (`--mode web`); every other mode sets it to "tauri", so
      // `#lib/transport`'s `selectTransport()` picks `tauriTransport`.
      __SWARM_TRANSPORT__: JSON.stringify(mode === "web" ? "ws" : "tauri"),
    },

    build: {
      sourcemap: true,
      // Tauri renders in WebView2 (Chromium, evergreen) on Windows, WKWebView on macOS (the system WebKit, updated with the OS or a standalone Safari update) and WebKitGTK on Linux (follows the distro). No syntax downleveling (target esnext), so the floor is set by the APIs the code calls unguarded: Safari/WebKit 18.4 (iterator helpers, Error.isError, RegExp.escape). macOS 15.4 is the oldest macOS that guarantees it (Safari 18.4 also installs on 13/14, but Info.plist can only require an OS version), and `bundle.macOS.minimumSystemVersion` in tauri.conf.json enforces it. Temporal is polyfilled at boot (src/boot.ts).
      // `build:web`'s target is any modern evergreen browser, close enough not to warrant a second target.
      target: "esnext",
      // `build:web` writes to a separate directory so it never collides
      // with (or gets clobbered by) the Tauri bundle's own `dist/` —
      // `swarmd --serve-ui dist-web` points at this one.
      outDir: mode === "web" ? "dist-web" : "dist",
      modulePreload: { polyfill: false },
      rolldownOptions: {
        output: {
          // Rolldown's codeSplitting groups define the vendor chunks.
          codeSplitting: {
            groups: [
              { name: "react-vendor", test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
              { name: "motion", test: /node_modules[\\/]motion[\\/]/ },
              { name: "graph", test: /node_modules[\\/](@xyflow|elkjs)[\\/]/ },
              { name: "terminal", test: /node_modules[\\/]@xterm[\\/]/ },
              { name: "state", test: /node_modules[\\/](zustand|immer|jotai)[\\/]/ },
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
      // boot.ts loads the app through `import("./main.tsx")` and PageHost
      // lazy-loads every page; Vite pre-transforms only static imports, so a
      // cold server would transform each of these on first request. Pages are
      // named one by one: a `*.tsx` glob also matches the colocated
      // `*.test.tsx` files and pulls vitest and Testing Library into the dev
      // dep optimizer, which re-bundles and reloads the page.
      warmup: {
        clientFiles: [
          "./src/main.tsx",
          "./src/pages/Dashboard.tsx",
          "./src/pages/Workers.tsx",
          "./src/pages/Sessions.tsx",
          "./src/pages/Metrics.tsx",
          "./src/pages/Logs.tsx",
          "./src/pages/Tools.tsx",
          "./src/pages/Workspace.tsx",
          "./src/pages/Settings.tsx",
        ],
      },
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
