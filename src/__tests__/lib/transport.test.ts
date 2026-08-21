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

  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", {});
  }

  // ── Test-only "server" simulation ────────────────────────────────

  simulateOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open", {});
  }

  simulateServerFrame(frame: unknown): void {
    this.emit("message", { data: JSON.stringify(frame) });
  }

  simulateAbruptClose(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", {});
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

import { initTokenFromLocationHash, WsTransport } from "#lib/transport";

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

describe("wsTransport", () => {
  let transport: WsTransport;

  beforeEach(() => {
    FakeWebSocket.instances = [];
    mockLastSeq = 0;
    transport = new WsTransport();
  });

  afterEach(() => {
    transport.dispose();
    vi.useRealTimers();
  });

  describe("handshake", () => {
    it("sends hello with token from the URL fragment, then scrubs it", async () => {
      window.location.hash = "#t=secret-token-123";
      const replaceStateSpy = vi.spyOn(window.history, "replaceState");
      // Production reads the hash exactly ONCE, at module init
      // (security-review FIX-8 — see `initTokenFromLocationHash`'s
      // doc) — the module already ran it once, before this test set
      // the hash, so it must be re-invoked explicitly to simulate a
      // fresh page load carrying a fresh token fragment.
      initTokenFromLocationHash();

      const connectPromise = transport.connect();
      const socket = latestSocket();
      socket.simulateOpen();

      const hello = socket.lastSentFrame() as {
        frame: string;
        token: string;
        lastSeq: number | null;
      };
      expect(hello.frame).toBe("hello");
      expect(hello.token).toBe("secret-token-123");
      expect(hello.lastSeq).toBeNull();
      expect(replaceStateSpy).toHaveBeenCalled();
      expect(window.location.hash).toBe("");

      socket.simulateServerFrame({ frame: "ready", serverSeq: 0, version: 1, caps: {} });
      await connectPromise;
    });

    it("reuses the stored token from sessionStorage on a later connect with no fragment present", async () => {
      window.sessionStorage.setItem("swarmd.token", "stored-token");
      window.location.hash = "";

      const connectPromise = transport.connect();
      const socket = latestSocket();
      socket.simulateOpen();
      const hello = socket.lastSentFrame() as { token: string };
      expect(hello.token).toBe("stored-token");

      socket.simulateServerFrame({ frame: "ready", serverSeq: 0, version: 1, caps: {} });
      await connectPromise;
    });

    it("sends the CURRENT event-bus lastSeq (not null) when one exists", async () => {
      mockLastSeq = 41;
      const connectPromise = transport.connect();
      const socket = latestSocket();
      socket.simulateOpen();
      const hello = socket.lastSentFrame() as { lastSeq: number | null };
      expect(hello.lastSeq).toBe(41);

      socket.simulateServerFrame({ frame: "ready", serverSeq: 41, version: 1, caps: {} });
      await connectPromise;
    });
  });

  describe("reattach: replays then goes live", () => {
    it("delivers replayed events, ignores replayEnd itself, then continues with live events", async () => {
      const received: number[] = [];
      const unlistenPromise = transport.listen<{ seq: number }>("swarm://events", (e) =>
        received.push(e.seq),
      );
      const socket = openAndReady(0);
      await unlistenPromise;

      // Replay burst: three bare DomainEvent frames (no "frame" key).
      socket.simulateServerFrame({ seq: 1, ts: 1, type: "worker_spawned", payload: {} });
      socket.simulateServerFrame({ seq: 2, ts: 2, type: "worker_spawned", payload: {} });
      socket.simulateServerFrame({ seq: 3, ts: 3, type: "worker_spawned", payload: {} });
      socket.simulateServerFrame({ frame: "replayEnd", seq: 3 });

      // Live events continue arriving on the SAME connection afterward.
      socket.simulateServerFrame({ seq: 4, ts: 4, type: "worker_spawned", payload: {} });
      socket.simulateServerFrame({ seq: 5, ts: 5, type: "worker_spawned", payload: {} });

      expect(received).toEqual([1, 2, 3, 4, 5]);
    });

    it("a cold attach (lastSeq null) still transitions cleanly from ready/replayEnd into live delivery", async () => {
      const received: number[] = [];
      const unlistenPromise = transport.listen<{ seq: number }>("swarm://events", (e) =>
        received.push(e.seq),
      );
      const socket = latestSocket();
      socket.simulateOpen();
      socket.simulateServerFrame({ frame: "ready", serverSeq: 9, version: 1, caps: {} });
      socket.simulateServerFrame({ frame: "replayEnd", seq: 9 }); // empty replay
      await unlistenPromise;

      socket.simulateServerFrame({ seq: 10, ts: 10, type: "worker_spawned", payload: {} });
      expect(received).toEqual([10]);
    });
  });

  describe("dedupe at the replay/live boundary", () => {
    it("never delivers a control frame (ready/replayEnd/rpcResult) to an event listener", async () => {
      const received: unknown[] = [];
      const unlistenPromise = transport.listen("swarm://events", (e) => received.push(e));
      const socket = latestSocket();
      socket.simulateOpen();
      socket.simulateServerFrame({ frame: "ready", serverSeq: 0, version: 1, caps: {} });
      await unlistenPromise;

      socket.simulateServerFrame({ frame: "replayEnd", seq: 0 });
      socket.simulateServerFrame({ frame: "rpcResult", id: "x", ok: true, result: 1 });
      socket.simulateServerFrame({ seq: 1, ts: 1, type: "worker_spawned", payload: {} });

      // Only the ONE real event frame reaches the listener — every
      // control frame (including the two sent before it) is filtered
      // out by the "has a frame key" classification, not merely by
      // accident of shape.
      expect(received).toEqual([{ seq: 1, ts: 1, type: "worker_spawned", payload: {} }]);
    });

    it("a live event whose seq exactly matches replayEnd's own seq is still delivered (transport does not itself dedupe by seq — event-bus owns that)", async () => {
      const received: number[] = [];
      const unlistenPromise = transport.listen<{ seq: number }>("swarm://events", (e) =>
        received.push(e.seq),
      );
      const socket = openAndReady(0);
      await unlistenPromise;

      socket.simulateServerFrame({ seq: 3, ts: 3, type: "worker_spawned", payload: {} });
      socket.simulateServerFrame({ frame: "replayEnd", seq: 3 });
      // A boundary-adjacent live event arriving right after replayEnd.
      socket.simulateServerFrame({ seq: 4, ts: 4, type: "worker_spawned", payload: {} });

      expect(received).toEqual([3, 4]);
    });

    it("listen() on any channel other than swarm://events is a harmless no-op (no connection attempted)", async () => {
      const unlisten = await transport.listen("some://other/channel", () => {});
      expect(FakeWebSocket.instances).toHaveLength(0);
      expect(() => unlisten()).not.toThrow();
    });
  });

  describe("mid-replay disconnect and reconnect", () => {
    it("a close mid-replay (before replayEnd) rejects in-flight rpc calls and schedules a reconnect", async () => {
      vi.useFakeTimers();
      const received: number[] = [];
      void transport
        .listen<{ seq: number }>("swarm://events", (e) => received.push(e.seq))
        .catch(() => {});
      await vi.advanceTimersByTimeAsync(0);
      const socket1 = openAndReady(0);
      await vi.advanceTimersByTimeAsync(0);

      socket1.simulateServerFrame({ seq: 1, ts: 1, type: "worker_spawned", payload: {} });
      // An rpc call in flight when the connection drops.
      const rpcPromise = transport.invoke("list_workers");
      await vi.advanceTimersByTimeAsync(0);

      // Connection drops mid-replay, before replayEnd ever arrived.
      socket1.simulateAbruptClose();

      await expect(rpcPromise).rejects.toThrow(/closed/i);
      expect(received).toEqual([1]);

      // A reconnect is scheduled (backoff timer armed) — advance past
      // it and a SECOND socket must be opened.
      await vi.advanceTimersByTimeAsync(20_000);
      expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(2);
    });

    it("reconnect's hello carries the event-bus lastSeq at reconnect time, not the value from the original connect", async () => {
      vi.useFakeTimers();
      mockLastSeq = 0;
      void transport.connect().catch(() => {});
      await vi.advanceTimersByTimeAsync(0);
      const socket1 = openAndReady(0);
      await vi.advanceTimersByTimeAsync(0);

      // Between the first connect and the reconnect, this tab processed
      // more events (event-bus's cursor advanced).
      mockLastSeq = 77;
      socket1.simulateAbruptClose();

      await vi.advanceTimersByTimeAsync(20_000);
      const socket2 = FakeWebSocket.instances.at(-1);
      expect(socket2).not.toBe(socket1);
      socket2?.simulateOpen();
      const hello = socket2?.lastSentFrame() as { lastSeq: number | null };
      expect(hello.lastSeq).toBe(77);
    });

    it("backoff delay increases across consecutive failures (not a fixed interval)", async () => {
      vi.useFakeTimers();
      void transport.connect().catch(() => {});
      await vi.advanceTimersByTimeAsync(0);

      let lastCount = FakeWebSocket.instances.length;
      const gaps: number[] = [];
      for (let i = 0; i < 3; i++) {
        const socket = FakeWebSocket.instances.at(-1);
        socket?.simulateAbruptClose();
        // Find the smallest advance that produces a new socket.
        let elapsed = 0;
        const step = 100;
        while (FakeWebSocket.instances.length === lastCount && elapsed < 30_000) {
          await vi.advanceTimersByTimeAsync(step);
          elapsed += step;
        }
        gaps.push(elapsed);
        lastCount = FakeWebSocket.instances.length;
      }

      // Each successive gap (backoff ceiling) is >= the previous —
      // exponential backoff, not retried at a constant interval.
      expect(gaps[1]).toBeGreaterThanOrEqual(gaps[0]);
      expect(gaps[2]).toBeGreaterThanOrEqual(gaps[1]);
    });
  });

  describe("auth failure", () => {
    it("a close with no prior ready frame surfaces as a rejected connect()", async () => {
      const connectPromise = transport.connect();
      const socket = latestSocket();
      socket.simulateOpen();
      // Server never sends `ready` — closes the socket outright (wrong
      // token / handshake deadline / Origin-Host refusal already
      // happened at the HTTP-upgrade layer in the real server).
      socket.simulateAbruptClose();

      await expect(connectPromise).rejects.toThrow();
    });

    it("invoke() surfaces the same rejection to its caller rather than hanging forever", async () => {
      const invokePromise = transport.invoke("list_workers");
      const socket = latestSocket();
      socket.simulateOpen();
      socket.simulateAbruptClose();

      await expect(invokePromise).rejects.toThrow();
    });
  });

  describe("rpc round-trip", () => {
    it("resolves invoke() with the matching rpcResult's result, correlated by id", async () => {
      const invokePromise = transport.invoke<{ ok: true }>("get_metrics", { foo: "bar" });
      const socket = openAndReady(0);
      await vi.waitFor(() => expect(socket.sentFrames().length).toBeGreaterThanOrEqual(2));

      const sentRpc = socket.lastSentFrame() as {
        frame: string;
        id: string;
        cmd: string;
        args: unknown;
      };
      expect(sentRpc.frame).toBe("rpc");
      expect(sentRpc.cmd).toBe("get_metrics");
      expect(sentRpc.args).toEqual({ foo: "bar" });

      socket.simulateServerFrame({
        frame: "rpcResult",
        id: sentRpc.id,
        ok: true,
        result: { ok: true },
      });
      await expect(invokePromise).resolves.toEqual({ ok: true });
    });

    it("rejects invoke() when the server responds ok: false", async () => {
      const invokePromise = transport.invoke("kill_worker", { id: "bad" });
      const socket = openAndReady(0);
      await vi.waitFor(() => expect(socket.sentFrames().length).toBeGreaterThanOrEqual(2));
      const sentRpc = socket.lastSentFrame() as { id: string };

      socket.simulateServerFrame({
        frame: "rpcResult",
        id: sentRpc.id,
        ok: false,
        error: "Worker Not Found",
      });
      await expect(invokePromise).rejects.toThrow("Worker Not Found");
    });

    // DIRECTIVE (security-review FIX-8): invoke() must not hang
    // forever when no rpcResult ever arrives — it rejects with a
    // typed RpcTimeoutError after RPC_TIMEOUT_MS (30s).
    it("rejects with RpcTimeoutError when no rpcResult ever arrives", async () => {
      vi.useFakeTimers();
      const invokePromise = transport.invoke("list_workers");
      const socket = latestSocket();
      socket.simulateOpen();
      socket.simulateServerFrame({ frame: "ready", serverSeq: 0, version: 1, caps: {} });
      const assertion = expect(invokePromise).rejects.toThrow(/timed out/i);
      await vi.advanceTimersByTimeAsync(30_001);
      await assertion;
    });
  });

  describe("capabilities", () => {
    it("declares kind: ws and no native-only surfaces", () => {
      expect(transport.capabilities).toEqual({
        kind: "ws",
        workspaceBrowsing: false,
        nativeNotifications: false,
        autoUpdate: false,
        localAiChat: false,
      });
    });
  });
});
