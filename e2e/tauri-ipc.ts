/// <reference lib="dom" />
// The init script and `page.evaluate` callbacks run in the browser: type them against the DOM lib.
import type { Page } from "@playwright/test";

/**
 * A stand-in for the desktop shell's IPC bridge, installed before any app
 * code runs. `@tauri-apps/api` reaches the shell only through
 * `window.__TAURI_INTERNALS__` (`invoke`, `transformCallback`) and
 * `isTauri()` reads `globalThis.isTauri`, so defining them makes the
 * production bundle take its desktop path unchanged: `tauriTransport`,
 * `connectEventBus` listening on `swarm://events` through
 * `plugin:event|listen`, every command through `invoke`. Nothing in `src/`
 * knows it is under test.
 *
 * Commands answer from {@link IpcScript} layered over a fresh backend
 * (`FRESH_BACKEND`); any other command resolves `null`. Events are
 * delivered with {@link emitEvents} in the Rust `DomainEvent` envelope,
 * the frames the shell emits, and reach listeners as Tauri's
 * `{ event, id, payload }` callback argument.
 */
export interface IpcScript {
  /** Fixed results per command name. */
  readonly replies?: Readonly<Record<string, unknown>>;
  /** `read_config` results per config key (`swarm-config.json`, or the keychain for the API key). */
  readonly config?: Readonly<Record<string, unknown>>;
}

/** The Rust `DomainEvent` envelope (`#lib/event-bus`'s `DomainEventSchema`). */
export interface DomainEventFrame {
  readonly seq: number;
  readonly ts: number;
  readonly type: string;
  readonly payload: Record<string, unknown>;
  readonly originWorker?: string;
  readonly causeSeq?: number;
}

/**
 * A fresh backend: no workers, no sessions, an empty event log, and empty
 * plugin-store files (`plugin:store|load` returns the store's resource id).
 */
const FRESH_BACKEND: Readonly<Record<string, unknown>> = {
  "plugin:store|load": 1,
  "plugin:store|entries": [],
  list_workers: [],
  list_sessions: [],
  events_since: [],
};

/** What the init script leaves on `window` for the spec side. */
interface IpcProbe {
  readonly calls: Array<{ cmd: string; args: unknown }>;
  emit(event: string, payload: unknown): void;
}

declare global {
  interface Window {
    __swarmIpc?: IpcProbe;
  }
}

/** Installs the bridge on every document the page loads; call before `page.goto`. */
export async function installTauriIpc(page: Page, script: IpcScript = {}): Promise<void> {
  await page.addInitScript(
    ({ replies, config }) => {
      type Callback = (data: unknown) => void;
      const callbacks = new Map<number, Callback>();
      const listeners = new Map<string, Set<number>>();
      const calls: IpcProbe["calls"] = [];
      let nextId = 1;

      const unregisterCallback = (id: number): void => {
        callbacks.delete(id);
        for (const ids of listeners.values()) ids.delete(id);
      };

      const invoke = async (cmd: string, args: Record<string, unknown> = {}): Promise<unknown> => {
        calls.push({ cmd, args });
        switch (cmd) {
          case "plugin:event|listen": {
            const { event: eventName, handler: callbackId } = args;
            const event = String(eventName);
            const handler = Number(callbackId);
            const ids = listeners.get(event) ?? new Set<number>();
            listeners.set(event, ids.add(handler));
            return handler;
          }
          case "plugin:event|unlisten": {
            const { eventId } = args;
            unregisterCallback(Number(eventId));
            return null;
          }
          case "read_config": {
            const { key } = args;
            return structuredClone(config[String(key)] ?? null);
          }
          default:
            return structuredClone(replies[cmd] ?? null);
        }
      };

      Object.assign(window, {
        isTauri: true,
        __TAURI_INTERNALS__: {
          metadata: {
            currentWindow: { label: "main" },
            currentWebview: { windowLabel: "main", label: "main" },
          },
          invoke,
          transformCallback(callback: Callback | undefined, once = false): number {
            const id = nextId++;
            callbacks.set(id, (data) => {
              if (once) unregisterCallback(id);
              callback?.(data);
            });
            return id;
          },
          unregisterCallback,
          runCallback(id: number, data: unknown): void {
            callbacks.get(id)?.(data);
          },
          convertFileSrc: (path: string): string => path,
        },
        __TAURI_EVENT_PLUGIN_INTERNALS__: {
          unregisterListener: (_event: string, id: number): void => unregisterCallback(id),
        },
        __swarmIpc: {
          calls,
          emit(event: string, payload: unknown): void {
            for (const id of listeners.get(event) ?? []) {
              callbacks.get(id)?.({ event, id, payload });
            }
          },
        } satisfies IpcProbe,
      });
    },
    { replies: { ...FRESH_BACKEND, ...script.replies }, config: script.config ?? {} },
  );
}

/** Delivers `events` on `swarm://events`, in order, in one task (as one IPC batch would). */
export async function emitEvents(page: Page, events: readonly DomainEventFrame[]): Promise<void> {
  await page.evaluate((frames) => {
    for (const frame of frames) window.__swarmIpc?.emit("swarm://events", frame);
  }, events);
}
