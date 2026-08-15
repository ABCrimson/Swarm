import { invoke, isTauri } from "#lib/tauri";

/**
 * A small persisted key-value store, backend-selected by transport —
 * headless-daemon plan Phase 3 item 3. Under Tauri, backed by
 * `tauri-plugin-store` (one JSON file per `storeName`, exactly what
 * `lazy-store.ts`/`templates.ts`/`snapshots.ts`/`store-integrity.ts`
 * already use directly). Under a `wsTransport` connection, backed by
 * the daemon's own `read_config`/`write_config` commands — "remote
 * settings follow the daemon" (the plan's explicit decision): a value
 * written from a browser tab is visible to the desktop app and vice
 * versa, since both read the same `swarm-config.json`.
 *
 * # Migration status
 *
 * This is the abstraction itself, landed and unit-tested in isolation.
 * Rewiring the four existing direct `@tauri-apps/plugin-store` call
 * sites (`lazy-store.ts`, `templates.ts`, `snapshots.ts`,
 * `store-integrity.ts`) onto it is DEFERRED — the plan's own
 * kill-criterion explicitly permits cutting hard here ("12 bypass files
 * eat Phase 3... Five surfaces that work beat twelve that half-work").
 * Wiring one of those four through `createKv` is a small, mechanical,
 * independently-testable follow-up per file; none of them are on the
 * MVP remote surface (Dashboard/Workers/Terminals/Metrics/Agent chat)
 * today.
 */
export interface Kv {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
}

/**
 * `tauri-plugin-store`-backed `Kv`, one JSON file per `storeName` —
 * exactly the on-disk shape the four direct-`@tauri-apps/plugin-store`
 * call sites already produce, so migrating one onto this later changes
 * nothing about its persisted file.
 */
class TauriStoreKv implements Kv {
  constructor(private readonly storeName: string) {}

  async get<T>(key: string): Promise<T | null> {
    if (!isTauri()) return null;
    const { load } = await import("@tauri-apps/plugin-store");
    const store = await load(this.storeName);
    const value = await store.get<T>(key);
    return value ?? null;
  }

  async set<T>(key: string, value: T): Promise<void> {
    if (!isTauri()) return;
    const { load } = await import("@tauri-apps/plugin-store");
    const store = await load(this.storeName);
    await store.set(key, value);
    await store.save();
  }
}

/**
 * `read_config`/`write_config`-backed `Kv` — the daemon's single flat
 * `swarm-config.json`, keyed by `"<storeName>:<key>"` so distinct
 * former store FILES (`lazy-store`/`templates`/`snapshots`/
 * `store-integrity`) don't collide once they share one namespace.
 * Delegates through `#lib/tauri`'s `invoke`, which is itself already
 * transport-selected — under `wsTransport` this is a real `rpc`
 * round-trip to `swarmd`; under a bare browser preview with neither
 * transport connected it inherits `invoke`'s existing graceful
 * `undefined`-on-absent-bridge behavior.
 */
class DaemonConfigKv implements Kv {
  constructor(private readonly storeName: string) {}

  private namespacedKey(key: string): string {
    return `${this.storeName}:${key}`;
  }

  async get<T>(key: string): Promise<T | null> {
    const value = await invoke<T | null>("read_config", { key: this.namespacedKey(key) });
    return value ?? null;
  }

  async set<T>(key: string, value: T): Promise<void> {
    return invoke<void>("write_config", { key: this.namespacedKey(key), value });
  }
}

/**
 * Builds the `Kv` backing `storeName`'s data — `tauri-plugin-store`
 * under Tauri, the daemon's config commands otherwise (`wsTransport`,
 * or a bare browser preview where both gracefully degrade to no-ops).
 */
export function createKv(storeName: string): Kv {
  return isTauri() ? new TauriStoreKv(storeName) : new DaemonConfigKv(storeName);
}
