// ── Session card live worker count (fix wave, item 13) ──
//
// session.workerIds only ever grows — there is no session_remove_worker
// command in Rust to prune it when a worker is killed — so rendering
// its raw length would climb forever even after every worker in a
// session has been killed. SessionCard now intersects workerIds with
// the live worker store instead.

import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionCard } from "#components/session/SessionCard";
import type { Session } from "#store/types";
import { useWorkerStore } from "#store/workers";

function createSession(overrides?: Partial<Session>): Session {
  return {
    id: crypto.randomUUID(),
    name: "Test Session",
    workerIds: [],
    createdAt: "2026-01-15T10:30:00.000Z",
    updatedAt: "2026-01-15T10:30:00.000Z",
    ...overrides,
  };
}

function resetWorkerStore(): void {
  for (const [id] of useWorkerStore.getState().workers) useWorkerStore.getState().removeWorker(id);
}

describe("SessionCard", () => {
  beforeEach(resetWorkerStore);
  afterEach(resetWorkerStore);

  it("shows a count of only the workerIds that still exist in the live worker store", () => {
    const liveId = "11111111-2222-3333-8444-555555555555";
    const deadId1 = "22222222-3333-4444-8555-666666666666";
    const deadId2 = "33333333-4444-5555-8666-777777777777";
    useWorkerStore.getState().addWorker({
      id: liveId,
      state: "running",
      name: "Still Running",
      startedAt: new Date().toISOString(),
    });

    const session = createSession({ workerIds: [liveId, deadId1, deadId2] });

    render(
      <SessionCard
        session={session}
        isActive={false}
        onActivate={vi.fn()}
        onContextMenu={vi.fn()}
      />,
    );

    // 3 persisted workerIds, only 1 still live — must render "1 Worker", not "3 Workers".
    expect(screen.getByText("1 Worker")).toBeInTheDocument();
    expect(screen.queryByText("3 Workers")).not.toBeInTheDocument();
  });

  it("shows zero when every worker in the session has since been killed", () => {
    const session = createSession({
      workerIds: ["11111111-2222-3333-8444-555555555555", "22222222-3333-4444-8555-666666666666"],
    });

    render(
      <SessionCard
        session={session}
        isActive={false}
        onActivate={vi.fn()}
        onContextMenu={vi.fn()}
      />,
    );

    expect(screen.getByText("0 Workers")).toBeInTheDocument();
  });
});
