import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { countWorkers, simParamsFor, useParticleSync } from "#hooks/useParticleSync";
import type { ParticleSystem } from "#lib/particles";
import type { Worker, WorkerState } from "#store/types";
import { useWorkerStore } from "#store/workers";

const { writeSimParams } = vi.hoisted(() => ({ writeSimParams: vi.fn() }));
vi.mock(import("#lib/particles"), async (importOriginal) => ({
  ...(await importOriginal()),
  writeSimParams,
}));

function worker(id: string, state: WorkerState): Worker {
  return { id, state, name: id, startedAt: new Date(0).toISOString() };
}

const counts = (total: number, running: number, paused: number, errored: number) => ({
  total,
  running,
  paused,
  errored,
});

describe("countWorkers", () => {
  it("counts by the states the simulation distinguishes", () => {
    const workers = new Map(
      [
        worker("a", "running"),
        worker("b", "running"),
        worker("c", "paused"),
        worker("d", "error"),
        worker("e", "idle"),
      ].map((w) => [w.id, w]),
    );

    expect(countWorkers(workers)).toEqual(counts(5, 2, 1, 1));
  });
});

describe("simParamsFor", () => {
  it("baseline: plasma hue, running workers as attractors, throughput and queue mapped", () => {
    const params = simParamsFor(counts(3, 2, 0, 0), 250, 4);

    expect(params).toMatchObject({
      deltaHue: 205,
      speedMultiplier: 1,
      workerCount: 3,
      activeWorkers: 2,
      throughput: 0.5,
      errorRate: 0,
      queueDepth: 4,
    });
  });

  it("any error: rose hue, faster, the error share as turbulence", () => {
    expect(simParamsFor(counts(4, 1, 0, 1), 0, 0)).toMatchObject({
      deltaHue: 10,
      speedMultiplier: 2,
      chromaMultiplier: 1.5,
      errorRate: 0.25,
    });
  });

  it("all paused: slowed and desaturated", () => {
    const params = simParamsFor(counts(2, 0, 2, 0), 0, 0);

    expect(params.dt).toBeCloseTo(0.0016);
    expect(params).toMatchObject({ speedMultiplier: 0.3, chromaMultiplier: 0.3 });
  });

  it("saturates throughput at 500 tokens/s", () => {
    expect(simParamsFor(counts(0, 0, 0, 0), 5000, 0).throughput).toBe(1);
  });
});

describe("useParticleSync", () => {
  const device = {} as GPUDevice;
  const system = {} as ParticleSystem;
  let frames: FrameRequestCallback[] = [];

  beforeEach(() => {
    frames = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => frames.push(cb));
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    act(() => useWorkerStore.getState().addWorker(worker("w", "running")));
  });

  afterEach(() => {
    act(() => useWorkerStore.getState().removeWorker("w"));
    vi.restoreAllMocks();
    writeSimParams.mockClear();
  });

  const flushFrames = (): void => {
    const pending = frames;
    frames = [];
    for (const cb of pending) cb(0);
  };

  it("writes on mount and once per frame after a state change", () => {
    renderHook(() => useParticleSync({ device, system }));
    expect(writeSimParams).toHaveBeenCalledTimes(1);

    act(() => {
      useWorkerStore.getState().updateState("w", "paused");
      useWorkerStore.getState().addWorker(worker("x", "error"));
    });
    flushFrames();

    expect(writeSimParams).toHaveBeenCalledTimes(2);
    expect(writeSimParams.mock.lastCall?.[2]).toMatchObject({ deltaHue: 10, workerCount: 2 });
    act(() => useWorkerStore.getState().removeWorker("x"));
  });

  it("schedules nothing for PTY output (worker objects change, counts do not)", () => {
    renderHook(() => useParticleSync({ device, system }));

    act(() => {
      for (let i = 0; i < 5; i++) useWorkerStore.getState().appendOutput("w", `line ${i}\n`);
    });

    expect(frames).toHaveLength(0);
    expect(writeSimParams).toHaveBeenCalledTimes(1);
  });

  it("does nothing without a device and system", () => {
    renderHook(() => useParticleSync({ device: null, system: null }));

    expect(writeSimParams).not.toHaveBeenCalled();
  });
});
