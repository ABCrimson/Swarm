/// <reference types="vite/client" />
/// <reference types="@webgpu/types" />

// Build-time constants from vite.config.ts `define`.

/** App version, from package.json. */
declare const __APP_VERSION__: string;

/**
 * Which backend transport `#lib/transport` uses: `"ws"` for the
 * `pnpm build:web` build that swarmd serves, `"tauri"` otherwise.
 * Undefined under Vitest, whose config does not define it.
 */
declare const __SWARM_TRANSPORT__: "ws" | "tauri" | undefined;
