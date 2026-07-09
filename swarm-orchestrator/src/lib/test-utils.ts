import type { UnlistenFn } from "@tauri-apps/api/event";
import type { Worker, WorkerState } from "#store/types";
import { useWorkerStore } from "#store/workers";

// ── Mock invoke ──────────────────────────────────────

type InvokeHandler = (cmd: string, args?: Record<string, unknown>) => unknown;

let mockInvokeHandler: InvokeHandler | null = null;

/**
 * Sets a mock handler for `invoke()` calls during tests.
 *
 * @param handler - Function that receives cmd and args, returns the mock result
 * @returns Cleanup function to restore the original behavior
 */
export function mockInvoke(handler: InvokeHandler): () => void {
  mockInvokeHandler = handler;
  return () => {
    mockInvokeHandler = null;
  };
}

/**
 * Returns the currently registered mock invoke handler, or null.
 * Used internally by test-aware invoke wrappers.
 */
export function getMockInvokeHandler(): InvokeHandler | null {
  return mockInvokeHandler;
}

// ── Mock listen ──────────────────────────────────────

type EventEmitter = (payload: unknown) => void;

const mockEventListeners = new Map<string, Set<EventEmitter>>();

/**
 * Sets up a mock event listener for tests.
 *
 * Returns an `UnlistenFn` just like the real Tauri `listen()`.
 *
 * @param event - Event name to listen for
 * @param handler - Handler that receives the payload
 * @returns Promise resolving to an unlisten function
 */
export async function mockListen<T>(
  event: string,
  handler: (payload: T) => void,
): Promise<UnlistenFn> {
  let listeners = mockEventListeners.get(event);
  if (!listeners) {
    listeners = new Set();
    mockEventListeners.set(event, listeners);
  }

  const wrappedHandler = handler as EventEmitter;
  listeners.add(wrappedHandler);

  return () => {
    listeners?.delete(wrappedHandler);
    if (listeners?.size === 0) {
      mockEventListeners.delete(event);
    }
  };
}

/**
 * Emits a mock event to all registered listeners.
 * Use in tests to simulate Tauri backend events.
 *
 * @param event - Event name
 * @param payload - Event payload
 */
export function emitMockEvent<T>(event: string, payload: T): void {
  const listeners = mockEventListeners.get(event);
  if (listeners) {
    for (const handler of listeners) {
      handler(payload);
    }
  }
}

/**
 * Clears all mock event listeners. Call in test teardown.
 */
export function clearMockListeners(): void {
  mockEventListeners.clear();
}

// ── waitForEvent ─────────────────────────────────────

/**
 * Returns a promise that resolves when a specific mock event fires.
 * Useful for asserting that events have been emitted in tests.
 *
 * @param event - Event name to wait for
 * @param timeoutMs - Timeout in milliseconds (default: 5000)
 * @returns Promise resolving to the event payload
 */
export function waitForEvent<T>(event: string, timeoutMs = 5000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`waitForEvent("${event}") timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    let cleanupFn: (() => void) | undefined;

    const cleanup = (): void => {
      clearTimeout(timeout);
      cleanupFn?.();
    };

    mockListen<T>(event, (payload) => {
      cleanup();
      resolve(payload);
    }).then((unlisten) => {
      cleanupFn = unlisten;
    });
  });
}

// ── Mock worker store ────────────────────────────────

/**
 * Creates a mock worker for testing.
 */
export function createMockWorker(overrides?: Partial<Worker>): Worker {
  return {
    id: crypto.randomUUID(),
    state: "idle" as WorkerState,
    name: "test-worker",
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Populates the worker store with mock workers for testing.
 *
 * @param count - Number of mock workers to create
 * @returns Array of created mock workers
 */
export function mockWorkerStore(count = 3): Worker[] {
  const workers: Worker[] = [];
  const { addWorker } = useWorkerStore.getState();

  for (let i = 0; i < count; i++) {
    const worker = createMockWorker({
      name: `worker-${i}`,
      state: i === 0 ? "running" : "idle",
    });
    addWorker(worker);
    workers.push(worker);
  }

  return workers;
}

/**
 * Resets the worker store to its initial empty state.
 */
export function resetWorkerStore(): void {
  const state = useWorkerStore.getState();
  for (const [id] of state.workers) {
    state.removeWorker(id);
  }
}
