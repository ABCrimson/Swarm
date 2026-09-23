import { LazyStore } from "@tauri-apps/plugin-store";
import { describe, expect, it, vi } from "vitest";
import "#lib/lazy-store";

// Captured at import time, before any per-test mock reset.
const constructed = vi.mocked(LazyStore).mock.calls.map((args) => [...args]);

// Every source module, as text (Vite's raw import).
const sources = import.meta.glob<string>(["/src/**/*.{ts,tsx}", "!/src/**/*.test.{ts,tsx}"], {
  query: "?raw",
  import: "default",
  eager: true,
});

describe("#lib/lazy-store", () => {
  it("opens each webview file once, with plugin-store's default (auto-save) options", () => {
    expect(constructed).toStrictEqual([
      ["swarm-settings.json"],
      ["swarm-snapshots.json"],
      ["swarm-templates.json"],
    ]);
  });

  it("no module opens the Rust-owned swarm-config.json through plugin-store", () => {
    // plugin-store saves every file it loaded when the app exits, which
    // would overwrite the config Rust wrote with the stale loaded copy.
    const opener = /\b(?:load|LazyStore|Store\.load)\s*\(\s*["'`][^"'`]*swarm-config\.json/;
    const offenders = Object.entries(sources)
      .filter(([, text]) => opener.test(text))
      .map(([path]) => path);

    expect(Object.keys(sources).length).toBeGreaterThan(50);
    expect(offenders).toStrictEqual([]);
  });

  it("no module opens a plugin-store file with auto-save switched off", () => {
    // plugin-store keeps the options of whichever caller loaded a file
    // first, so one `autoSave: false` load disables auto-save for every
    // later write to that file, all session long.
    const noAutoSave = /\b(?:load|LazyStore)\s*\([^)]*autoSave\s*:\s*false/;
    const offenders = Object.entries(sources)
      .filter(([, text]) => noAutoSave.test(text))
      .map(([path]) => path);

    expect(offenders).toStrictEqual([]);
  });
});
