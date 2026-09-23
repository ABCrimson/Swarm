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
  private readonly storeName: string;

  constructor(storeName: string) {
    this.storeName = storeName;
  }

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
 *
 * # Suffix-rule read/write asymmetry (latent until wired)
 *
 * `read_config`/`write_config` are both `RemotePolicy::SecretFiltered`
 * over WS — a request is denied identically for `get` and `set` when
 * its namespaced key (`"<storeName>:<key>"`) matches
 * `config::is_secret_key`'s suffix rule (`_key`/`_token`/`_secret`, or
 * the literal `anthropic_api_key`). The `storeName:` prefix never
 * defeats that suffix match (it only extends the string, never
 * truncates it), so filtering IS symmetric between `get` and `set`
 * for any one `Kv` instance today. The real asymmetry this section
 * exists to flag is TRANSPORT-shaped, not verb-shaped:
 * `TauriStoreKv` applies no filtering at all (by design — see
 * `commands::config`'s module doc, the local desktop IPC path is not
 * a network boundary), so a future migrated call site whose key
 * happens to end in `_key`/`_token`/`_secret` for reasons unrelated to
 * being an actual secret (e.g. a hypothetical `"favorite_key"`
 * setting) would succeed silently under Tauri and be denied — on both
 * `get` and `set` — the moment the exact same call runs over
 * `wsTransport`. Currently inert (`createKv` has no real call site
 * yet, per the migration-status note above); worth checking against
 * this rule before wiring the first one.
 */
class DaemonConfigKv implements Kv {
  private readonly storeName: string;

  constructor(storeName: string) {
    this.storeName = storeName;
  }

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
