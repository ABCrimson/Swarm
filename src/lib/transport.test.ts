import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Minimal fake `WebSocket` — mimics the browser API surface
 * `WsTransport` actually touches (`addEventListener`/`send`/`close`/
 * `readyState`), with test-only `simulate*` helpers standing in for a
 * real `swarmd` server. `FakeWebSocket.instances` lets a test inspect
 * every socket the transport under test has opened, including across a
 * reconnect (a NEW instance each time, exactly like the real
 * `WebSocket` constructor).
 */
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  readonly url: string;
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Set<(ev: unknown) => void>>();

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, handler: (ev: unknown) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(handler);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, handler: (ev: unknown) => void): void {
    this.listeners.get(type)?.delete(handler);
  }

  send(data: string): void {
    if (this.readyState !== FakeWebSocket.OPEN) {
      throw new Error("FakeWebSocket: send() while not OPEN");
    }
    this.sent.push(data);
  }

  /** Client-initiated close: fires `close` synchronously (a real socket fires it later). */
  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", { code: 1005 });
  }

  // ── Test-only "server" simulation ────────────────────────────────

  simulateOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open", {});
  }

  simulateServerFrame(frame: unknown): void {
    this.emit("message", { data: JSON.stringify(frame) });
  }

  simulateRawMessage(data: string): void {
    this.emit("message", { data });
  }

  /** The server's close frame arrived; the `close` event has not fired yet. */
  simulateClosing(): void {
    this.readyState = FakeWebSocket.CLOSING;
  }

  simulateAbruptClose(code = 1006): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", { code });
  }

  simulateError(): void {
    this.emit("error", {});
  }

  sentFrames(): unknown[] {
    return this.sent.map((s) => JSON.parse(s));
  }

  lastSentFrame(): unknown {
    return this.sentFrames().at(-1);
  }

  private emit(type: string, ev: unknown): void {
    for (const handler of this.listeners.get(type) ?? []) handler(ev);
  }
}

vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);

vi.mock("#lib/event-bus", () => ({
  getLastSeq: () => mockLastSeq,
}));
let mockLastSeq = 0;

import {
  DaemonAuthError,
  DEFAULT_RPC_DEADLINE_MS,
  initTokenFromLocationHash,
  isOutcomeUnknown,
  RpcConnectionLostError,
  RpcTimeoutError,
  rpcDeadlineMs,
  WsTransport,
} from "#lib/transport";

function latestSocket(): FakeWebSocket {
  const s = FakeWebSocket.instances.at(-1);
  if (!s) throw new Error("no FakeWebSocket instance created yet");
  return s;
}

/** Drives a fresh socket through open + `ready` so tests that don't care about the handshake itself can skip straight to the interesting part. */
function openAndReady(serverSeq = 0): FakeWebSocket {
  const socket = latestSocket();
  socket.simulateOpen();
  socket.simulateServerFrame({ frame: "ready", serverSeq, version: 1, caps: {} });
  return socket;
}

/** The last `rpc` frame sent on `socket`. */
function lastRpc(socket: FakeWebSocket): { frame: string; id: string; cmd: string; args: unknown } {
  return socket.lastSentFrame() as { frame: string; id: string; cmd: string; args: unknown };
}

/**
 * Advances fake time by `ms` while the daemon keeps talking (its
 * `system_metrics` heartbeat), so the link watchdog sees a live socket.
 */
async function advanceWithTraffic(socket: FakeWebSocket, ms: number): Promise<void> {
  const STEP_MS = 10_000;
  for (let elapsed = 0; elapsed < ms; elapsed += STEP_MS) {
    await vi.advanceTimersByTimeAsync(Math.min(STEP_MS, ms - elapsed));
    socket.simulateServerFrame(event(++heartbeatSeq));
  }
}
let heartbeatSeq = 0;

const event = (seq: number) => ({ seq, ts: seq, type: "worker_spawned", payload: {} });

describe("wsTransport", () => {
  let transport: WsTransport;

  beforeEach(() => {
    FakeWebSocket.instances = [];
    mockLastSeq = 0;
    window.sessionStorage.clear();
    transport = new WsTransport();
  });

  afterEach(() => {
    transport.dispose();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("token handling", () => {
    it("sends hello with the token from the URL fragment, then scrubs it", async () => {
      window.location.hash = "#t=secret-token-123";
      const replaceStateSpy = vi.spyOn(window.history, "replaceState");
      // Production reads the hash exactly once, at module init — re-run
      // it to simulate a fresh page load carrying a fresh fragment.
      initTokenFromLocationHash();

      const connectPromise = transport.connect();
      const socket = latestSocket();
      socket.simulateOpen();

      expect(socket.lastSentFrame()).toStrictEqual({
        frame: "hello",
        lastSeq: null,
        token: "secret-token-123",
      });
      expect(replaceStateSpy).toHaveBeenCalledOnce();
      expect(window.location.hash).toBe("");

      socket.simulateServerFrame({ frame: "ready", serverSeq: 0, version: 1, caps: {} });
      await connectPromise;
    });

    it("percent-decodes the fragment token", () => {
      window.location.hash = "#t=a%2Fb%20c";
      initTokenFromLocationHash();

      expect(window.sessionStorage.getItem("swarmd.token")).toBe("a/b c");
    });

    it("ignores an undecodable fragment without throwing, and still scrubs it", () => {
      window.sessionStorage.setItem("swarmd.token", "earlier");
      window.location.hash = "#t=abc%E0%A4%A";
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      expect(() => initTokenFromLocationHash()).not.toThrow();
      expect(window.location.hash).toBe("");
      expect(window.sessionStorage.getItem("swarmd.token")).toBe("earlier");
      expect(warn).toHaveBeenCalledWith("[transport] Ignoring an undecodable #t= token fragment.");
    });

    it("reuses the stored token from sessionStorage on a later connect with no fragment present", async () => {
      window.sessionStorage.setItem("swarmd.token", "stored-token");
      window.location.hash = "";

      const connectPromise = transport.connect();
      const socket = latestSocket();
      socket.simulateOpen();
      expect((socket.lastSentFrame() as { token: string }).token).toBe("stored-token");

      socket.simulateServerFrame({ frame: "ready", serverSeq: 0, version: 1, caps: {} });
      await connectPromise;
    });

    it("keeps the token in memory for this tab when sessionStorage throws", async () => {
      vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new DOMException("QuotaExceededError");
      });
      vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
        throw new DOMException("SecurityError");
      });
      window.location.hash = "#t=memory-only";
      initTokenFromLocationHash();

      const connectPromise = transport.connect();
      const socket = latestSocket();
      socket.simulateOpen();
      expect((socket.lastSentFrame() as { token: string }).token).toBe("memory-only");

      socket.simulateServerFrame({ frame: "ready", serverSeq: 0, version: 1, caps: {} });
      await connectPromise;
    });
  });

  describe("handshake", () => {
    it("sends the CURRENT event-bus lastSeq (not null) when one exists", async () => {
      mockLastSeq = 41;
      const connectPromise = transport.connect();
      const socket = latestSocket();
      socket.simulateOpen();
      expect((socket.lastSentFrame() as { lastSeq: number | null }).lastSeq).toBe(41);

      socket.simulateServerFrame({ frame: "ready", serverSeq: 41, version: 1, caps: {} });
      await connectPromise;
    });

    it("shares one socket between concurrent connect() callers", async () => {
      const first = transport.connect();
      const second = transport.connect();
      openAndReady();

      await Promise.all([first, second]);
      expect(FakeWebSocket.instances).toHaveLength(1);
    });

    it("rejects connect() when the socket errors before the handshake", async () => {
      const connectPromise = transport.connect();
      latestSocket().simulateError();

      await expect(connectPromise).rejects.toThrow("WebSocket Connection Failed.");
    });

    it("rejects a stalled handshake instead of hanging, and reconnects", async () => {
      vi.useFakeTimers();
      const invokePromise = transport.invoke("list_workers");
      const assertion = expect(invokePromise).rejects.toThrow(
        "The SWARM Daemon Did Not Complete The Handshake In Time.",
      );
      latestSocket().simulateOpen(); // the server accepts, then never sends `ready`

      await vi.advanceTimersByTimeAsync(30_000);
      await assertion;
      expect(latestSocket().readyState).toBe(FakeWebSocket.CLOSED);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(FakeWebSocket.instances).toHaveLength(2);
    });
  });

  describe("auth failure", () => {
    it("a close with no prior ready frame rejects connect()", async () => {
      const connectPromise = transport.connect();
      const socket = latestSocket();
      socket.simulateOpen();
      socket.simulateAbruptClose();

      await expect(connectPromise).rejects.toThrow(
        "WebSocket Closed Before The Handshake Completed.",
      );
    });

    it("invoke() surfaces the same rejection to its caller rather than hanging forever", async () => {
      const invokePromise = transport.invoke("list_workers");
      const socket = latestSocket();
      socket.simulateOpen();
      socket.simulateAbruptClose();

      await expect(invokePromise).rejects.toThrow(
        "WebSocket Closed Before The Handshake Completed.",
      );
    });

    it("stops reconnecting when swarmd refuses the token (close code 4401)", async () => {
      vi.useFakeTimers();
      const connectPromise = transport.connect();
      const assertion = expect(connectPromise).rejects.toBeInstanceOf(DaemonAuthError);
      latestSocket().simulateOpen();
      latestSocket().simulateAbruptClose(4401);
      await assertion;

      await vi.advanceTimersByTimeAsync(60_000);
      expect(FakeWebSocket.instances).toHaveLength(1);

      // An explicit call still tries again (e.g. after a fresh #t= link).
      void transport.connect().catch(() => {});
      expect(FakeWebSocket.instances).toHaveLength(2);
    });
  });

  describe("event delivery", () => {
    it("delivers replayed events, ignores replayEnd itself, then continues with live events", async () => {
      const received: number[] = [];
      await transport.listen<{ seq: number }>("swarm://events", (e) => received.push(e.seq));
      const socket = openAndReady(0);

      socket.simulateServerFrame(event(1));
      socket.simulateServerFrame(event(2));
      socket.simulateServerFrame(event(3));
      socket.simulateServerFrame({ frame: "replayEnd", seq: 3 });
      socket.simulateServerFrame(event(4));
      socket.simulateServerFrame(event(5));

      expect(received).toStrictEqual([1, 2, 3, 4, 5]);
    });

    it("never delivers a control frame or a malformed frame to an event listener", async () => {
      const received: unknown[] = [];
      await transport.listen("swarm://events", (e) => received.push(e));
      const socket = openAndReady(0);

      socket.simulateServerFrame({ frame: "replayEnd", seq: 0 });
      socket.simulateServerFrame({ frame: "rpcResult", id: "unknown", ok: true, result: 1 });
      socket.simulateRawMessage("{not json");
      socket.simulateServerFrame(event(1));

      expect(received).toStrictEqual([event(1)]);
    });

    it("does not dedupe by seq — the event bus owns that", async () => {
      const received: number[] = [];
      await transport.listen<{ seq: number }>("swarm://events", (e) => received.push(e.seq));
      const socket = openAndReady(0);

      socket.simulateServerFrame(event(3));
      socket.simulateServerFrame({ frame: "replayEnd", seq: 3 });
      socket.simulateServerFrame(event(4));

      expect(received).toStrictEqual([3, 4]);
    });

    it("stops delivering to a listener once it unlistens", async () => {
      const received: number[] = [];
      const unlisten = await transport.listen<{ seq: number }>("swarm://events", (e) =>
        received.push(e.seq),
      );
      const socket = openAndReady(0);
      socket.simulateServerFrame(event(1));

      unlisten();
      socket.simulateServerFrame(event(2));

      expect(received).toStrictEqual([1]);
    });

    it("listen() on any other channel is a no-op that opens no connection", async () => {
      const unlisten = await transport.listen("some://other/channel", () => {});
      expect(FakeWebSocket.instances).toHaveLength(0);
      expect(() => unlisten()).not.toThrow();
    });

    it("a listener registered while the first handshake fails still receives events after the reconnect", async () => {
      vi.useFakeTimers();
      vi.spyOn(Math, "random").mockReturnValue(0);
      const received: number[] = [];

      const unlisten = transport.listen<{ seq: number }>("swarm://events", (e) =>
        received.push(e.seq),
      );
      latestSocket().simulateOpen();
      latestSocket().simulateAbruptClose(); // daemon restarting while the page loads
      await expect(unlisten).resolves.toBeTypeOf("function");

      await vi.advanceTimersByTimeAsync(500);
      const socket2 = openAndReady(0);
      socket2.simulateServerFrame(event(1));

      expect(received).toStrictEqual([1]);
    });
  });

  describe("reconnect", () => {
    it("a close mid-replay rejects in-flight rpc calls and schedules a reconnect", async () => {
      vi.useFakeTimers();
      const received: number[] = [];
      await transport.listen<{ seq: number }>("swarm://events", (e) => received.push(e.seq));
      const socket1 = openAndReady(0);
      await vi.advanceTimersByTimeAsync(0);

      socket1.simulateServerFrame(event(1));
      const rpcPromise = transport.invoke("list_workers");
      await vi.advanceTimersByTimeAsync(0);
      socket1.simulateAbruptClose();

      await expect(rpcPromise).rejects.toThrow("WebSocket Connection Closed.");
      expect(received).toStrictEqual([1]);

      await vi.advanceTimersByTimeAsync(20_000);
      expect(FakeWebSocket.instances).toHaveLength(2);
    });

    it("reconnect's hello carries the event-bus lastSeq at reconnect time", async () => {
      vi.useFakeTimers();
      void transport.connect().catch(() => {});
      const socket1 = openAndReady(0);
      await vi.advanceTimersByTimeAsync(0);

      mockLastSeq = 77; // this tab processed more events since the first connect
      socket1.simulateAbruptClose();

      await vi.advanceTimersByTimeAsync(20_000);
      const socket2 = latestSocket();
      expect(socket2).not.toBe(socket1);
      socket2.simulateOpen();
      expect((socket2.lastSentFrame() as { lastSeq: number | null }).lastSeq).toBe(77);
    });

    it("backs off exponentially from 500 ms, capped at 15 s", async () => {
      vi.useFakeTimers();
      vi.spyOn(Math, "random").mockReturnValue(0);
      void transport.connect().catch(() => {});

      const gaps: number[] = [];
      for (let i = 0; i < 8; i++) {
        const count = FakeWebSocket.instances.length;
        latestSocket().simulateAbruptClose();
        let elapsed = 0;
        while (FakeWebSocket.instances.length === count && elapsed < 30_000) {
          await vi.advanceTimersByTimeAsync(100);
          elapsed += 100;
        }
        gaps.push(elapsed);
      }

      expect(gaps).toStrictEqual([500, 1000, 2000, 4000, 8000, 15_000, 15_000, 15_000]);
    });

    it("resets the backoff after a successful handshake", async () => {
      vi.useFakeTimers();
      vi.spyOn(Math, "random").mockReturnValue(0);
      void transport.connect().catch(() => {});
      latestSocket().simulateAbruptClose();
      await vi.advanceTimersByTimeAsync(500);
      latestSocket().simulateAbruptClose();
      await vi.advanceTimersByTimeAsync(1000);
      openAndReady(0);
      await vi.advanceTimersByTimeAsync(0);

      latestSocket().simulateAbruptClose();
      await vi.advanceTimersByTimeAsync(499);
      expect(FakeWebSocket.instances).toHaveLength(3);
      await vi.advanceTimersByTimeAsync(1);
      expect(FakeWebSocket.instances).toHaveLength(4);
    });

    it("a late close from a replaced socket neither fails the new socket's calls nor duplicates events", async () => {
      const received: number[] = [];
      await transport.listen<{ seq: number }>("swarm://events", (e) => received.push(e.seq));
      const socketA = openAndReady(0);
      await Promise.resolve();

      // The server sent its close frame; the `close` event has not fired yet.
      socketA.simulateClosing();
      const rpc = transport.invoke("worker_input", { id: "w", data: "x" });
      await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
      const socketB = openAndReady(0);
      await vi.waitFor(() => expect(lastRpc(socketB).cmd).toBe("worker_input"));

      socketA.simulateAbruptClose(); // A's close finally fires
      socketB.simulateServerFrame(event(1));
      socketB.simulateServerFrame({ frame: "rpcResult", id: lastRpc(socketB).id, ok: true });

      await expect(rpc).resolves.toBeUndefined();
      expect(received).toStrictEqual([1]);
      expect(FakeWebSocket.instances).toHaveLength(2);
    });
  });

  describe("rpc round-trip", () => {
    it("resolves invoke() with the matching rpcResult's result, correlated by id", async () => {
      const invokePromise = transport.invoke<{ ok: true }>("get_metrics", { foo: "bar" });
      const socket = openAndReady(0);
      await vi.waitFor(() => expect(socket.sentFrames()).toHaveLength(2));

      const sent = lastRpc(socket);
      expect(sent).toMatchObject({ frame: "rpc", cmd: "get_metrics", args: { foo: "bar" } });

      socket.simulateServerFrame({ frame: "rpcResult", id: "not-mine", ok: true, result: 0 });
      socket.simulateServerFrame({
        frame: "rpcResult",
        id: sent.id,
        ok: true,
        result: { ok: true },
      });
      await expect(invokePromise).resolves.toStrictEqual({ ok: true });
    });

    it("rejects with the daemon's error value unchanged, as Tauri IPC does", async () => {
      const invokePromise = transport.invoke("kill_worker", { id: "bad" });
      const socket = openAndReady(0);
      await vi.waitFor(() => expect(socket.sentFrames()).toHaveLength(2));

      socket.simulateServerFrame({
        frame: "rpcResult",
        id: lastRpc(socket).id,
        ok: false,
        error: "Worker Not Found",
      });
      await expect(invokePromise).rejects.toBe("Worker Not Found");
    });

    it("keeps a structured error (e.g. a ship error) structured", async () => {
      const shipError = { kind: "pushRejected", message: "Rejected.", remedy: "fetchAndRebase" };
      const invokePromise = transport.invoke("git_push", {});
      const socket = openAndReady(0);
      await vi.waitFor(() => expect(socket.sentFrames()).toHaveLength(2));

      socket.simulateServerFrame({
        frame: "rpcResult",
        id: lastRpc(socket).id,
        ok: false,
        error: shipError,
      });
      await expect(invokePromise).rejects.toStrictEqual(shipError);
    });

    it("rejects with RpcTimeoutError when no rpcResult ever arrives", async () => {
      vi.useFakeTimers();
      const invokePromise = transport.invoke("list_workers");
      openAndReady(0);
      const assertion = expect(invokePromise).rejects.toThrow(
        'RPC "list_workers" Timed Out After 30000ms.',
      );
      await vi.advanceTimersByTimeAsync(30_001);
      await assertion;
    });

    it("closes a silent (half-open) socket on an RPC timeout, so the reconnect loop replaces it", async () => {
      vi.useFakeTimers();
      vi.spyOn(Math, "random").mockReturnValue(0);
      const invokePromise = transport.invoke("list_workers");
      const assertion = expect(invokePromise).rejects.toThrow(
        'RPC "list_workers" Timed Out After 30000ms.',
      );
      const socket = openAndReady(0);

      await vi.advanceTimersByTimeAsync(30_000);
      await assertion;
      expect(socket.readyState).toBe(FakeWebSocket.CLOSED);

      await vi.advanceTimersByTimeAsync(500);
      expect(FakeWebSocket.instances).toHaveLength(2);
    });

    it("keeps a socket that is still receiving frames when one RPC times out", async () => {
      vi.useFakeTimers();
      const invokePromise = transport.invoke("list_workers");
      const assertion = expect(invokePromise).rejects.toThrow(
        'RPC "list_workers" Timed Out After 30000ms.',
      );
      const socket = openAndReady(0);
      await vi.advanceTimersByTimeAsync(10_000);
      socket.simulateServerFrame(event(1));

      await vi.advanceTimersByTimeAsync(20_000);
      await assertion;
      expect(socket.readyState).toBe(FakeWebSocket.OPEN);
      expect(FakeWebSocket.instances).toHaveLength(1);
    });

    it("keeps a git_push rpc pending past 30 s and accepts its late rpcResult", async () => {
      vi.useFakeTimers();
      const invokePromise = transport.invoke<{ pushedRef: string }>("git_push", { shipId: "s" });
      const settled = vi.fn();
      invokePromise.then(settled, settled);
      const socket = openAndReady(0);
      await advanceWithTraffic(socket, 45_000);
      expect(settled).not.toHaveBeenCalled();

      socket.simulateServerFrame({
        frame: "rpcResult",
        id: lastRpc(socket).id,
        ok: true,
        result: { pushedRef: "origin/x" },
      });
      await expect(invokePromise).resolves.toStrictEqual({ pushedRef: "origin/x" });
      expect(socket.readyState).toBe(FakeWebSocket.OPEN);
    });

    it("rejects git_stage_commit with RpcTimeoutError only at its own deadline", async () => {
      vi.useFakeTimers();
      const deadline = rpcDeadlineMs("git_stage_commit");
      const outcome = transport.invoke("git_stage_commit").then(
        () => null,
        (err: unknown) => err,
      );
      const settled = vi.fn();
      void outcome.then(settled);
      const socket = openAndReady(0);

      await advanceWithTraffic(socket, deadline - 1);
      expect(settled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      const err = await outcome;
      expect(err).toBeInstanceOf(RpcTimeoutError);
      expect(err).toMatchObject({ cmd: "git_stage_commit", deadlineMs: deadline });
      expect(isOutcomeUnknown(err)).toBe(true);
    });

    it("rejects a pending rpc with RpcConnectionLostError when the socket closes", async () => {
      vi.useFakeTimers();
      const outcome = transport.invoke("git_push").then(
        () => null,
        (err: unknown) => err,
      );
      const socket = openAndReady(0);
      await vi.advanceTimersByTimeAsync(0);
      socket.simulateAbruptClose();

      const err = await outcome;
      expect(err).toBeInstanceOf(RpcConnectionLostError);
      expect(err).toMatchObject({ cmd: "git_push", message: "WebSocket Connection Closed." });
      expect(isOutcomeUnknown(err)).toBe(true);
    });

    it("treats a failure before the frame is sent as a definite failure, not an unknown outcome", async () => {
      const notConnected = transport.invoke("git_push");
      const socket = openAndReady(0);
      socket.simulateAbruptClose();
      const notConnectedErr = await notConnected.catch((err: unknown) => err);
      expect(notConnectedErr).toMatchObject({ message: "Not Connected To The SWARM Daemon." });
      expect(isOutcomeUnknown(notConnectedErr)).toBe(false);

      expect(isOutcomeUnknown(new DaemonAuthError())).toBe(false);
      expect(isOutcomeUnknown({ kind: "pushRejected" })).toBe(false);
      expect(isOutcomeUnknown(new Error("WebSocket Closed Before The Handshake Completed."))).toBe(
        false,
      );
    });

    describe("link watchdog", () => {
      it("closes a socket that goes silent under a long git_push and rejects it as connection lost", async () => {
        vi.useFakeTimers();
        vi.spyOn(Math, "random").mockReturnValue(0);
        const outcome = transport.invoke("git_push").then(
          () => null,
          (err: unknown) => err,
        );
        const socket = openAndReady(0);
        await vi.advanceTimersByTimeAsync(DEFAULT_RPC_DEADLINE_MS * 2);

        expect(await outcome).toBeInstanceOf(RpcConnectionLostError);
        expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
        await vi.advanceTimersByTimeAsync(500);
        expect(FakeWebSocket.instances).toHaveLength(2);
      });

      it("leaves a long git_push pending while the socket keeps receiving frames", async () => {
        vi.useFakeTimers();
        const settled = vi.fn();
        transport.invoke("git_push").then(settled, settled);
        const socket = openAndReady(0);
        for (let seq = 1; seq <= 8; seq++) {
          await vi.advanceTimersByTimeAsync(10_000);
          socket.simulateServerFrame(event(seq));
        }

        expect(settled).not.toHaveBeenCalled();
        expect(socket.readyState).toBe(FakeWebSocket.OPEN);
        expect(FakeWebSocket.instances).toHaveLength(1);
      });

      it("leaves no timer behind once the last pending rpc has settled", async () => {
        vi.useFakeTimers();
        const invokePromise = transport.invoke("git_push");
        const socket = openAndReady(0);
        await vi.advanceTimersByTimeAsync(0);
        socket.simulateServerFrame({
          frame: "rpcResult",
          id: lastRpc(socket).id,
          ok: true,
          result: null,
        });
        await invokePromise;

        expect(vi.getTimerCount()).toBe(0);
      });
    });

    it("fails fast when the socket drops between the handshake and the send", async () => {
      const invokePromise = transport.invoke("list_workers");
      const socket = openAndReady(0);
      socket.simulateAbruptClose();

      await expect(invokePromise).rejects.toThrow("Not Connected To The SWARM Daemon.");
    });
  });

  describe("capabilities", () => {
    it("declares kind: ws and no native-only surfaces", () => {
      expect(transport.capabilities).toStrictEqual({
        kind: "ws",
        workspaceBrowsing: false,
        nativeNotifications: false,
        autoUpdate: false,
        localAiChat: false,
      });
    });
  });
});
