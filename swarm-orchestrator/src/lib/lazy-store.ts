import { LazyStore } from "@tauri-apps/plugin-store";

/** Shared singleton for the swarm-settings.json Tauri plugin-store. */
export const settingsStore = new LazyStore("swarm-settings.json");
