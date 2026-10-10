import { isTauri, invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen, type UnlistenFn } from "@tauri-apps/api/event";
import { getLastSeq } from "#lib/event-bus";

/**
 * What a transport can honestly promise. Feature-gated call sites
 * (fs/dialog-backed file browsing, OS notifications, the auto-updater,
 * the webview-direct AI chat path) read it to render a Title Case
 * empty state instead of a silent no-op when the active transport
 * cannot support them.
 */
export interface TransportCapabilities {
  readonly kind: "tauri" | "ws";
  /** Local filesystem browsing (FileTree/FileViewer/export) — plugin-fs/plugin-dialog-backed, Tauri-only. */
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
  /**
   * Runs one backend command. Rejects with the command's own error
   * value (a string, or a structured object such as a ship error) on
   * failure, exactly as Tauri IPC does, and with an `Error` for a
   * transport failure.
   */
  invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T>;
  /** Subscribes to a backend event channel. Never rejects for a transport that reconnects on its own. */
  listen<T>(event: string, handler: (payload: T) => void): Promise<UnlistenFn>;
  /** Idempotent. Establishes (or confirms) connectivity; a no-op for `tauriTransport`. */
  connect(): Promise<void>;
  readonly capabilities: TransportCapabilities;
}

const noopUnlisten: UnlistenFn = () => {};

// ── tauriTransport ───────────────────────────────────────────────────

/**
 * Tauri IPC. Outside the desktop shell (a plain `pnpm dev` browser
 * preview) every command resolves `undefined` and every subscription is
 * a no-op, so the UI renders its empty states instead of crashing.
 */
export const tauriTransport: Transport = {
  async invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    if (!isTauri()) return undefined as T;
    return tauriInvoke<T>(cmd, args);
  },
  async listen<T>(event: string, handler: (payload: T) => void): Promise<UnlistenFn> {
    if (!isTauri()) return noopUnlisten;
    return tauriListen<T>(event, (e) => handler(e.payload));
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
 * Bound on every wait for the daemon: the `hello` → `ready` handshake
 * and each `rpc` → `rpcResult` round trip (security-review FIX-8). A
 * hung daemon, a lost response or a proxy that holds the upgrade open
 * rejects the caller instead of leaving it pending forever.
 */
const RPC_TIMEOUT_MS = 30_000;
/** Close code `swarmd` sends when the `hello` token is missing or wrong (`crates/swarmd/src/ws.rs`). */
const UNAUTHORIZED_CLOSE_CODE = 4401;

/**
 * Thrown by {@link WsTransport.invoke} when no `rpcResult` arrives within
 * {@link RPC_TIMEOUT_MS}. When nothing at all arrived on the socket in
 * that window, the socket is also closed so the reconnect loop replaces it.
 */
class RpcTimeoutError extends Error {
  constructor(cmd: string) {
    super(`RPC "${cmd}" Timed Out After ${RPC_TIMEOUT_MS}ms.`);
    this.name = "RpcTimeoutError";
  }
}

/**
 * Thrown when `swarmd` refuses the access token (close code 4401).
 * Automatic reconnects stop: retrying the same token cannot succeed. The
 * next `invoke`/`connect` tries once more, e.g. after the page is
 * reopened with a fresh `#t=` link.
 */
export class DaemonAuthError extends Error {
  constructor() {
    super("The SWARM Daemon Rejected The Access Token. Reopen The Link Printed By swarmd.");
    this.name = "DaemonAuthError";
  }
}

/** In-memory fallback for when `sessionStorage` throws (private-mode Safari, etc.) — keeps the CURRENT tab working even though a reload would lose it. */
let inMemoryToken: string | null = null;

/**
 * Reads a token out of `location.hash`, if present, persists it to
 * `sessionStorage`, and immediately scrubs the fragment, so it never
 * lingers in browser history, a shared screenshot, or a
 * `Referer`-leaking outbound request.
 *
 * Called once at module init (bottom of this file), before any network
 * I/O (security-review FIX-8): a lazy first-connect read left the token
 * in the visible URL for the whole first connect attempt. The fragment
 * is scrubbed even when it cannot be decoded, and a malformed one never
 * throws: this runs at import time, where an exception would stop the
 * app from booting. Exported so tests can re-run it after changing
 * `location.hash`.
 */
export function initTokenFromLocationHash(): void {
  if (typeof window === "undefined") return;
  const hash = window.location.hash;
  if (!hash.startsWith("#t=")) return;

  try {
    const token = decodeURIComponent(hash.slice(3));
    inMemoryToken = token;
    try {
      window.sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
    } catch {
      // sessionStorage unavailable — `inMemoryToken` still covers this tab.
    }
  } catch {
    console.warn("[transport] Ignoring an undecodable #t= token fragment.");
  } finally {
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
  }
}

/**
 * The daemon token for a `hello`: `sessionStorage` first (populated by
 * {@link initTokenFromLocationHash}), then `inMemoryToken` when
 * `sessionStorage` has none or throws.
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
  readonly resolve: (value: unknown) => void;
  /** A command error value (as the daemon sent it) or a transport `Error`. */
  readonly reject: (error: unknown) => void;
}

/** One socket and the RPCs sent on it — a stale socket's close only fails its own calls. */
interface Connection {
  readonly ws: WebSocket;
  readonly pending: Map<string, PendingRpc>;
  /** Frames received so far; an RPC timeout with no change since its send means the link is dead. */
  framesReceived: number;
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

/**
 * Backs `#lib/tauri`'s `invoke`/`listen` in the `pnpm build:web` build
 * that `swarmd --serve-ui` serves (`__SWARM_TRANSPORT__ === "ws"`).
 *
 * One shared socket for the whole tab: `rpc` calls and the live
 * `swarm://events` subscription share it (PTY input is a command per
 * keystroke; an HTTP request per keystroke would flood the connection
 * count and lose cross-request ordering). Reconnects with capped,
 * jittered exponential backoff; every reconnect's `hello` carries the
 * event bus's `lastSeq`, so the daemon replays only what this tab
 * missed. Exported (besides the {@link wsTransport} singleton) so tests
 * can construct isolated instances against a fake `WebSocket`.
 */
export class WsTransport implements Transport {
  private connection: Connection | null = null;
  private connectPromise: Promise<void> | null = null;
  private readonly listeners = new Set<(payload: unknown) => void>();
  private reconnectAttempt = 0;
  /** Correlates `rpc` with `rpcResult`; unique for the life of the tab (an opaque string to the daemon). */
  private lastRpcId = 0;
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
    if (this.connection?.ws.readyState === WebSocket.OPEN) return;
    this.connectPromise ??= this.openOnce().finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  private openOnce(): Promise<void> {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    let settled = false;
    const settle = (outcome: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(handshakeTimer);
      outcome();
    };

    // A socket from an earlier attempt that is still closing must not
    // deliver events or clobber this one when its `close` finally fires.
    const previous = this.connection;
    this.connection = null;
    previous?.ws.close();

    let ws: WebSocket;
    try {
      ws = new WebSocket(this.wsUrl());
    } catch (err) {
      this.armReconnect();
      return Promise.reject(Error.isError(err) ? err : new Error(String(err)));
    }
    const conn: Connection = { ws, pending: new Map(), framesReceived: 0 };
    this.connection = conn;

    const handshakeTimer = setTimeout(() => {
      settle(() => reject(new Error("The SWARM Daemon Did Not Complete The Handshake In Time.")));
      ws.close();
    }, RPC_TIMEOUT_MS);

    ws.addEventListener("open", () => {
      const lastSeq = getLastSeq();
      ws.send(
        JSON.stringify({
          frame: "hello",
          lastSeq: lastSeq > 0 ? lastSeq : null,
          token: readToken(),
        }),
      );
    });

    ws.addEventListener("message", (ev) => {
      if (this.connection !== conn) return;
      conn.framesReceived++;
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
          const pending = conn.pending.get(raw.id);
          if (pending) {
            conn.pending.delete(raw.id);
            if (raw.ok) pending.resolve(raw.result);
            else pending.reject(raw.error);
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

    ws.addEventListener("close", (ev) => {
      for (const pending of conn.pending.values()) {
        pending.reject(new Error("WebSocket Connection Closed."));
      }
      conn.pending.clear();
      const unauthorized = !settled && ev.code === UNAUTHORIZED_CLOSE_CODE;
      settle(() =>
        reject(
          unauthorized
            ? new DaemonAuthError()
            : new Error("WebSocket Closed Before The Handshake Completed."),
        ),
      );
      if (this.connection !== conn) return;
      this.connection = null;
      if (!this.disposed && !unauthorized) this.armReconnect();
    });

    ws.addEventListener("error", () => {
      settle(() => reject(new Error("WebSocket Connection Failed.")));
    });

    return promise;
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

  async invoke<T = unknown>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
    await this.connect();
    const conn = this.connection;
    if (conn?.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Not Connected To The SWARM Daemon.");
    }
    const id = `r${++this.lastRpcId}`;
    const { promise, resolve, reject } = Promise.withResolvers<T>();
    const framesAtSend = conn.framesReceived;
    // security-review FIX-8: bounded — see RPC_TIMEOUT_MS's doc.
    const timer = setTimeout(() => {
      conn.pending.delete(id);
      reject(new RpcTimeoutError(cmd));
      // Not one frame (no result, no event) in the whole window: the
      // socket is half-open (laptop sleep, a NAT timeout) even though
      // `readyState` still says OPEN. Closing it starts a reconnect now
      // instead of whenever the browser notices the dead TCP link.
      if (conn.framesReceived === framesAtSend && this.connection === conn) conn.ws.close();
    }, RPC_TIMEOUT_MS);
    conn.pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value as T);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    conn.ws.send(JSON.stringify({ frame: "rpc", id, cmd, args }));
    return promise;
  }

  /**
   * Subscribes to `swarm://events` at once, whether or not the socket is
   * up yet: a failed first handshake only delays delivery until the
   * reconnect loop gets through. Any other channel is a no-op.
   */
  async listen<T>(event: string, handler: (payload: T) => void): Promise<UnlistenFn> {
    if (event !== EVENT_CHANNEL_NAME) return noopUnlisten;
    const listener = (payload: unknown): void => handler(payload as T);
    this.listeners.add(listener);
    this.connect().catch(() => {
      // Reported by `invoke`; a non-auth failure is retried by the reconnect loop.
    });
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Test-only: tears down the socket and stops reconnecting. */
  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    const conn = this.connection;
    this.connection = null;
    conn?.pending.clear();
    conn?.ws.close();
    this.listeners.clear();
  }
}

// Runs once, at import time — see `initTokenFromLocationHash`'s doc
// (security-review FIX-8) for why this must not wait for the first
// connect attempt.
initTokenFromLocationHash();

export const wsTransport: Transport = new WsTransport();

// ── Selection ────────────────────────────────────────────────────────

/**
 * `wsTransport` only in the `pnpm build:web` build (`vite --mode web`
 * defines `__SWARM_TRANSPORT__` as `"ws"`); `tauriTransport` for every
 * other build and under Vitest, which does not define it. Never
 * auto-detected at runtime, so a `pnpm dev` browser preview never
 * attempts a doomed `ws://localhost:1420/ws` connection against the
 * Vite dev server itself.
 */
function selectTransport(): Transport {
  return typeof __SWARM_TRANSPORT__ !== "undefined" && __SWARM_TRANSPORT__ === "ws"
    ? wsTransport
    : tauriTransport;
}

export const transport: Transport = selectTransport();
