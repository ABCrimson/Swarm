// ── Test-Only ELK Worker Fake ────────────────────────
// jsdom has no Worker (and cannot evaluate a module worker script), so
// the layout tests stub the global `Worker` with this class. Imported
// only by tests (useElkLayout, WorkerGraph).

import { vi } from "vitest";

/**
 * A stand-in for the DOM `Worker` that `useElkLayout`'s `workerFactory`
 * constructs. Records every instance; tests fire `onerror` /
 * `onmessageerror` on it to exercise failure handling.
 *
 * With {@link MockElkWorker.autoRespondLayout} set, `postMessage` speaks
 * just enough of elkjs's own `{cmd, id}` request/response protocol (see
 * elkjs's `PromisedWorker`) to resolve an `elk.layout()` call: child `i`
 * is placed at `((i + 1) × 100, (i + 1) × 50)`.
 */
export class MockElkWorker {
  static instances: MockElkWorker[] = [];
  static autoRespondLayout = false;

  /** Clears recorded instances and turns auto-response off (call in `beforeEach`). */
  static reset(autoRespondLayout = false): void {
    MockElkWorker.instances = [];
    MockElkWorker.autoRespondLayout = autoRespondLayout;
  }

  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: ErrorEvent) => void) | null = null;
  onmessageerror: ((ev: MessageEvent) => void) | null = null;
  postMessage = vi.fn(
    (msg: { id: number; cmd?: string; graph?: { children?: { id: string }[] } }) => {
      if (!MockElkWorker.autoRespondLayout || msg.cmd !== "layout") return;
      const children = (msg.graph?.children ?? []).map((child, i) => ({
        id: child.id,
        x: (i + 1) * 100,
        y: (i + 1) * 50,
      }));
      this.onmessage?.({ data: { id: msg.id, data: { id: "root", children } } } as MessageEvent);
    },
  );
  terminate = vi.fn();

  constructor() {
    MockElkWorker.instances.push(this);
  }
}
