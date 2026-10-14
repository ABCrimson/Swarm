import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// Explicit, so unmounting does not depend on Testing Library detecting
// a global `afterEach` (vitest.config.ts `globals`).
afterEach(cleanup);

// ── Tauri APIs ──────────────────────────────────────
// jsdom has no Tauri bridge; every module the source imports is stubbed
// here with the members the source actually uses. A test that needs a
// different behavior re-mocks the module (or the #lib wrapper) itself.

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockRejectedValue(new Error("invoke not mocked")),
  // Same probe as the real `isTauri()`: the desktop shell defines
  // `globalThis.isTauri`. A test opts in with `vi.stubGlobal("isTauri", true)`.
  isTauri: () => Boolean(Reflect.get(globalThis, "isTauri")),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: vi.fn().mockResolvedValue(false),
  open: vi.fn().mockResolvedValue(null),
  save: vi.fn().mockResolvedValue(null),
}));

vi.mock("@tauri-apps/plugin-fs", () => ({
  BaseDirectory: { AppData: 14 },
  exists: vi.fn().mockResolvedValue(false),
  readDir: vi.fn().mockResolvedValue([]),
  readTextFile: vi.fn().mockResolvedValue(""),
  remove: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
  writeTextFile: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn().mockResolvedValue(undefined),
  openPath: vi.fn().mockResolvedValue(undefined),
  revealItemsInDir: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/plugin-store", () => {
  function MockStore() {
    return {
      get: vi.fn().mockResolvedValue(undefined),
      set: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(true),
      entries: vi.fn().mockResolvedValue([]),
      save: vi.fn().mockResolvedValue(undefined),
    };
  }
  return {
    LazyStore: vi.fn(MockStore),
    load: vi.fn(async () => MockStore()),
  };
});

// ── sonner ──────────────────────────────────────────
// Every module imports `toast` from sonner directly, so this one mock covers them all.
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  }),
  Toaster: () => null,
}));
