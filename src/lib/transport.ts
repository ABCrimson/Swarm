import { invoke as tauriInvokeRaw } from "@tauri-apps/api/core";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { listen as tauriListenRaw } from "@tauri-apps/api/event";
import { getLastSeq } from "#lib/event-bus";

export type { UnlistenFn };

/**
 * What a transport can honestly promise. Consumed by feature-gated call
 * sites (fs/dialog/shell-backed file browsing, OS notifications, the
 * auto-updater, the webview-direct AI chat path) to render a real Title
 * Case empty-state instead of a silent no-op when the active transport
 * cannot support them — see the headless-daemon plan's "MVP remote
 * surface = Dashboard/Workers/Terminals/Metrics/Agent chat" scope.
 */
export interface TransportCapabilities {
  readonly kind: "tauri" | "ws";
  /** Local filesystem browsing (FileTree/FileViewer/export/workspace watcher) — plugin-fs/plugin-dialog-backed, Tauri-only. */
  readonly workspaceBrowsing: boolean;
  /** Native OS notifications (`tauri-plugin-notification`). */
  readonly nativeNotifications: boolean;
  /** The in-app auto-updater (`tauri-plugin-updater`). */
  readonly autoUpdate: boolean;
  /** The webview-direct AI chat path (`AIChat.tsx`, `dangerouslyAllowBrowser` fetch straight to Anthropic) — never available remotely; remote AI goes through the agent-adapter RPC surface instead. */
  readonly localAiChat: boolean;
}

/** The seam every backend call and event subscription crosses. */
export interface Transport {
  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
  listen<T>(event: string, handler: (payload: T) => void): Promise<UnlistenFn>;
  /** Idempotent. Establishes (or confirms) connectivity; a no-op for `tauriTransport`. */
  connect(): Promise<void>;
  readonly capabilities: TransportCapabilities;
}

const noopUnlisten: UnlistenFn = () => {};

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

// ── tauriTransport — today's `#lib/tauri` invoke/listen, moved intact ──

export const tauriTransport: Transport = {
  async invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    if (!isTauriRuntime()) return undefined as T;
    return tauriInvokeRaw<T>(cmd, args);
  },
  async listen<T>(event: string, handler: (payload: T) => void): Promise<UnlistenFn> {
    if (!isTauriRuntime()) return noopUnlisten;
    return tauriListenRaw<T>(event, (e) => handler(e.payload));
  },
  async connect(): Promise<void> {
    // Tauri IPC has no connection lifecycle to establish.
  },
  capabilities: {
    kind: "tauri",
    workspaceBrowsing: true,
    nativeNotifications: true,
    autoUpdate: true,
    localAiChat: true,
  },
};

// ── wsTransport ──────────────────────────────────────────────────────
//
// Wire protocol mirrors `swarm_core::protocol` exactly (see that
// module's doc): every frame is one JSON text message; five kinds carry
// a `"frame"` tag (`hello`/`ready`/`replayEnd`/`rpc`/`rpcResult`); the
// sixth (`event`) is a BARE `DomainEvent` — no wrapper — distinguished
// from every control frame by the absence of a `"frame"` key.

const TOKEN_STORAGE_KEY = "swarmd.token";
const EVENT_CHANNEL_NAME = "swarm://events";
const BASE_RECONNECT_DELAY_MS = 500;
const MAX_RECONNECT_DELAY_MS = 15_000;
const JITTER_FRACTION = 0.3;
/**
 * security-review FIX-8: without a bound, a `swarmd` connection that
 * never resolves an `rpc` call (server hung, response lost, the
 * daemon killed mid-request) left `invoke()`'s promise pending
 * forever — which is also what made `hasTransport()`'s optimistic
 * "ws is configured, assume reachable" pre-check (`#lib/tauri`) a real
 * footgun: a caller had no way to distinguish "still working" from
 * "will never resolve." Every `wsTransport.invoke()` call now rejects
 * with a typed timeout error after this many milliseconds if no
 * matching `rpcResult` arrives.
 */
const RPC_TIMEOUT_MS = 30_000;

/** Thrown by {@link WsTransport.invoke} when no `rpcResult` arrives within {@link RPC_TIMEOUT_MS}. */
export class RpcTimeoutError extends Error {
  constructor(cmd: string) {
    super(`RPC "${cmd}" Timed Out After ${RPC_TIMEOUT_MS}ms.`);
    this.name = "RpcTimeoutError";
  }
}

/** In-memory fallback for when `sessionStorage` throws (private-mode Safari, etc.) — keeps the CURRENT tab working even though a reload would lose it. */
let inMemoryToken: string | null = null;

/**
 * Reads a token out of `location.hash`, if present, persists it to
 * `sessionStorage`, and IMMEDIATELY scrubs the fragment — never left in
 * browser history, a shared screenshot, or a `Referer`-leaking outbound
 * request (headless-daemon plan: "Token: URL fragment ...
 * never transmitted/logged" — the same must hold once it lands in the
 * browser).
 *
 * Called once at MODULE INIT (bottom of this file), not lazily from
 * inside the WS `open` handler (security-review FIX-8): the earlier
 * lazy-on-first-connect version left the raw token sitting in the
 * visible URL for the ENTIRE first-connect-attempt window — a slow
 * network, or a connection that fails and retries, stretched that
 * window well past "a single synchronous tick." Scrubbing at import
 * time (synchronous, before any network I/O) minimizes it to
 * effectively zero. Exported (not `#`-private) so tests can re-invoke
 * it after mutating `location.hash` to simulate a fresh page load,
 * since the module itself only runs it the one time it's first
 * imported.
 */
export function initTokenFromLocationHash(): void {
  if (typeof window === "undefined") return;
  const hash = window.location.hash;
  if (!hash.startsWith("#t=")) return;

  const token = decodeURIComponent(hash.slice(3));
  inMemoryToken = token;
  try {
    window.sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
  } catch {
    // sessionStorage unavailable — `inMemoryToken` still covers this tab.
  }
  const scrubbed = window.location.pathname + window.location.search;
  window.history.replaceState(null, "", scrubbed);
}

/**
 * Reads the daemon token for a `hello`/reconnect: from `sessionStorage`
 * (the authoritative, freshest persisted value — populated by
 * {@link initTokenFromLocationHash}), falling back to `inMemoryToken`
 * only when `sessionStorage` itself throws. Never touches
 * `location.hash` — that happens exactly once, at module init.
 */
function readToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const stored = window.sessionStorage.getItem(TOKEN_STORAGE_KEY);
    if (stored !== null) return stored;
  } catch {
    // fall through to inMemoryToken below
  }
  return inMemoryToken;
}

interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface ReadyFrame {
  frame: "ready";
  serverSeq: number;
  version: number;
  caps: unknown;
}
interface ReplayEndFrame {
  frame: "replayEnd";
  seq: number;
}
interface RpcResultFrame {
  frame: "rpcResult";
  id: string;
  ok: boolean;
  result?: unknown;
  error?: unknown;
}
type ServerControlFrame = ReadyFrame | ReplayEndFrame | RpcResultFrame;

function isControlFrame(raw: unknown): raw is ServerControlFrame {
  return typeof raw === "object" && raw !== null && "frame" in raw;
}

function errorMessage(raw: unknown): string {
  if (typeof raw === "string") return raw;
  try {
    return JSON.stringify(raw);
  } catch {
    return "Unknown Error.";
  }
}

/**
 * Backs `#lib/tauri`'s `invoke`/`listen` when the active transport is
 * WebSocket-based (`__SWARM_TRANSPORT__ === "ws"`, the `pnpm build:web`
 * build served by `swarmd --serve-ui`).
 *
 * One shared socket for the whole tab: `rpc` calls and the live
 * `swarm://events` subscription share it, matching the plan's "one
 * WebSocket, both directions" decision (PTY input is a command per
 * keystroke — separate HTTP requests per keystroke would both flood
 * the connection count and lose cross-request ordering).
 */
/**
 * Exported (not just the singleton instance below) so
 * `__tests__/lib/transport.test.ts` can construct isolated instances
 * against a fake `WebSocket` rather than sharing/resetting one global.
 */
export class WsTransport implements Transport {
  private socket: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private readonly pending = new Map<string, PendingRpc>();
  private readonly listeners = new Set<(payload: unknown) => void>();
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  readonly capabilities: TransportCapabilities = {
    kind: "ws",
    workspaceBrowsing: false,
    nativeNotifications: false,
    autoUpdate: false,
    localAiChat: false,
  };

  private wsUrl(): string {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${window.location.host}/ws`;
  }

  async connect(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.openOnce().finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  private openOnce(): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void) => {
        if (!settled) {
          settled = true;
          fn();
        }
      };

      let ws: WebSocket;
      try {
        ws = new WebSocket(this.wsUrl());
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        this.armReconnect();
        return;
      }
      this.socket = ws;

      ws.addEventListener("open", () => {
        const token = readToken();
        const lastSeq = getLastSeq();
        ws.send(
          JSON.stringify({
            frame: "hello",
            lastSeq: lastSeq > 0 ? lastSeq : null,
            token,
          }),
        );
      });

      ws.addEventListener("message", (ev) => {
        let raw: unknown;
        try {
          raw = JSON.parse(String(ev.data));
        } catch {
          return; // malformed frame — ignore, never crash the socket loop
        }

        if (isControlFrame(raw)) {
          if (raw.frame === "ready") {
            this.reconnectAttempt = 0;
            settle(resolve);
          } else if (raw.frame === "rpcResult") {
            const pending = this.pending.get(raw.id);
            if (pending) {
              this.pending.delete(raw.id);
              if (raw.ok) pending.resolve(raw.result);
              else pending.reject(new Error(errorMessage(raw.error)));
            }
          }
          // `replayEnd` needs no bookkeeping here — the `event` frames
          // it concludes were already delivered to listeners as they
          // arrived, in order, on the SAME lane (see the protocol doc).
          return;
        }

        // Bare `DomainEvent` — deliver to every `swarm://events` listener.
        for (const listener of this.listeners) listener(raw);
      });

      ws.addEventListener("close", () => {
        this.socket = null;
        for (const pending of this.pending.values()) {
          pending.reject(new Error("WebSocket Connection Closed."));
        }
        this.pending.clear();
        settle(() => reject(new Error("WebSocket Closed Before The Handshake Completed.")));
        if (!this.disposed) this.armReconnect();
      });

      ws.addEventListener("error", () => {
        settle(() => reject(new Error("WebSocket Connection Failed.")));
      });
    });
  }

  private armReconnect(): void {
    if (this.reconnectTimer !== null) return;
    const attempt = this.reconnectAttempt++;
    const backoff = Math.min(MAX_RECONNECT_DELAY_MS, BASE_RECONNECT_DELAY_MS * 2 ** attempt);
    const jitter = Math.random() * backoff * JITTER_FRACTION;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch(() => {
        // `close`'s handler already re-armed the NEXT attempt.
      });
    }, backoff + jitter);
  }

  async invoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
    await this.connect();
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("Not Connected To The SWARM Daemon.");
    }
    const id =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return new Promise<T>((resolve, reject) => {
      // security-review FIX-8: bounded — see RPC_TIMEOUT_MS's doc.
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcTimeoutError(cmd));
      }, RPC_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          (resolve as (v: unknown) => void)(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      socket.send(JSON.stringify({ frame: "rpc", id, cmd, args }));
    });
  }

  async listen<T>(event: string, handler: (payload: T) => void): Promise<UnlistenFn> {
    if (event !== EVENT_CHANNEL_NAME) return noopUnlisten;
    await this.connect();
    const wrapped = (payload: unknown) => handler(payload as T);
    this.listeners.add(wrapped);
    return () => {
      this.listeners.delete(wrapped);
    };
  }

  /** Test-only: tears down the socket and stops reconnecting. */
  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.socket?.close();
    this.listeners.clear();
    this.pending.clear();
  }
}

// Runs once, at import time — see `initTokenFromLocationHash`'s doc
// (security-review FIX-8) for why this must not wait for the first
// connect attempt.
initTokenFromLocationHash();

export const wsTransport: Transport = new WsTransport();

// ── Selection ────────────────────────────────────────────────────────

/**
 * Vite `define` (see `vite.config.ts`), set to `"ws"` only by `pnpm
 * build:web`; undefined for every other build (`pnpm dev`, `tauri
 * dev`/`tauri build`) — those keep
 * `tauriTransport` unconditionally, preserving today's exact behavior
 * (including the graceful no-op when previewing in a plain browser with
 * no Tauri bridge, e.g. `pnpm dev`). `wsTransport` is chosen ONLY when
 * explicitly built for it — never auto-detected at runtime — so a
 * `pnpm dev` browser preview never attempts a doomed `ws://localhost:1420/ws`
 * connection against the Vite dev server itself.
 */
declare const __SWARM_TRANSPORT__: string | undefined;

function selectTransport(): Transport {
  const declared = typeof __SWARM_TRANSPORT__ !== "undefined" ? __SWARM_TRANSPORT__ : undefined;
  return declared === "ws" ? wsTransport : tauriTransport;
}

export const transport: Transport = selectTransport();
