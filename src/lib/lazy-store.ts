import { LazyStore } from "@tauri-apps/plugin-store";

// The webview's tauri-plugin-store files, one shared `LazyStore` per
// file. plugin-store keeps one in-memory instance per path and applies
// the options of whichever caller loaded it first; later `load()`
// options are ignored. A second handle with different options therefore
// silently changes the first one's behavior (a validation pass that
// loaded with `autoSave: false` used to switch auto-save off for every
// later write). These handles pass no options, so plugin-store's
// defaults apply: auto-save with a 100 ms debounce. Any other `load()`
// of these files must not pass different options.
//
// plugin-store also saves every file it has loaded when the app exits.
// `swarm-config.json` belongs to the Rust side (`read_config` /
// `write_config`), so it must never be opened through plugin-store: the
// exit save would overwrite the config with the copy loaded here.

/** `swarm-settings.json`: persisted UI preferences (see `#store/persisted`). */
export const settingsStore = new LazyStore("swarm-settings.json");

/** `swarm-snapshots.json`: session snapshots, one `swarm:snapshots:<sessionId>` key per session. */
export const snapshotsStore = new LazyStore("swarm-snapshots.json");

/** `swarm-templates.json`: user-created session templates under `swarm:templates`. */
export const templatesStore = new LazyStore("swarm-templates.json");
