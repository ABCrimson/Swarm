// How #lib/tauri's ship wrappers treat a transport failure whose outcome is
// unknown: the original instance must reach the caller untouched, because
// `isOutcomeUnknown` (and `useShip`'s reconcile path) recognizes it by class.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { gitPush, gitStageCommit, ShipCommandError, shipCompareUrl } from "#lib/tauri";
import { isOutcomeUnknown, RpcConnectionLostError, RpcTimeoutError } from "#lib/transport";

const mockInvoke = vi.hoisted(() => vi.fn());

vi.mock(import("#lib/transport"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, transport: { ...actual.tauriTransport, invoke: mockInvoke } };
});

const WORKER_UUID = "550e8400-e29b-41d4-a716-446655440000";
const SHIP_UUID = "6ba7b810-9dad-41d1-80b4-00c04fd430c8";

const calls: readonly (readonly [string, () => Promise<unknown>])[] = [
  ["gitStageCommit", () => gitStageCommit(WORKER_UUID, SHIP_UUID, "feat: x", "all", false)],
  ["gitPush", () => gitPush(WORKER_UUID, SHIP_UUID, true)],
  [
    "shipCompareUrl",
    () => shipCompareUrl(WORKER_UUID, SHIP_UUID, "abc", "origin/b", "feat: x", "body"),
  ],
];

beforeEach(() => {
  mockInvoke.mockReset();
});

describe.each(calls)("%s", (_name, call) => {
  it("rethrows an RpcTimeoutError as the same instance", async () => {
    const err = new RpcTimeoutError("git_push", 720_000);
    mockInvoke.mockRejectedValue(err);

    const caught = await call().catch((e: unknown) => e);
    expect(caught).toBe(err);
    expect(isOutcomeUnknown(caught)).toBe(true);
  });

  it("rethrows an RpcConnectionLostError as the same instance", async () => {
    const err = new RpcConnectionLostError("git_push");
    mockInvoke.mockRejectedValue(err);

    const caught = await call().catch((e: unknown) => e);
    expect(caught).toBe(err);
    expect(isOutcomeUnknown(caught)).toBe(true);
  });

  it("still turns a ShipError-shaped rejection into a ShipCommandError", async () => {
    const shipError = { kind: "pushRejected", message: "Push Rejected.", remedy: null };
    mockInvoke.mockRejectedValue(shipError);

    const caught = await call().catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(ShipCommandError);
    expect((caught as ShipCommandError).shipError).toEqual(shipError);
    expect(isOutcomeUnknown(caught)).toBe(false);
  });
});
