import { act, render } from "@testing-library/react";
import { StrictMode, useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_RECOVERIES,
  RECOVERY_DELAY_MS,
  type UseWebGPUResult,
  useWebGPU,
} from "#hooks/useWebGPU";
import type { WebGPUContext, WebGPUInitResult } from "#lib/webgpu";
import { initWebGPU } from "#lib/webgpu";

vi.mock("#lib/webgpu", () => ({
  isWebGPUSupported: () => true,
  initWebGPU: vi.fn(),
}));

class StubResizeObserver {
  observe(): void {}
  disconnect(): void {}
}

function fakeContext(): WebGPUContext {
  return {
    device: { destroy: vi.fn() } as unknown as GPUDevice,
    adapter: {} as GPUAdapter,
    context: {} as GPUCanvasContext,
    format: "bgra8unorm",
  };
}

/** Every context handed out by the mocked `initWebGPU`, in call order. */
let created: WebGPUContext[] = [];
/** The `onDeviceLost` callback of each `initWebGPU` call, in call order. */
let lostCallbacks: Array<() => void> = [];
let latest: UseWebGPUResult | null = null;

function Probe(): React.ReactElement {
  const gpu = useWebGPU();
  const { canvasRef } = gpu;
  useEffect(() => {
    latest = gpu;
  });
  return <canvas ref={canvasRef} />;
}

/** Lets the serialized init chain (a few promise hops) settle. */
async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

describe("useWebGPU", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("ResizeObserver", StubResizeObserver);
    created = [];
    lostCallbacks = [];
    latest = null;
    vi.mocked(initWebGPU).mockImplementation(async (_canvas, onDeviceLost) => {
      const value = fakeContext();
      created.push(value);
      lostCallbacks.push(onDeviceLost ?? (() => {}));
      return { ok: true, value } satisfies WebGPUInitResult;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.mocked(initWebGPU).mockReset();
  });

  it("initializes exactly once under StrictMode and keeps that device", async () => {
    render(
      <StrictMode>
        <Probe />
      </StrictMode>,
    );
    await settle();

    // The mount → unmount → mount double effect: the first init is
    // abandoned before it starts (the chain checks disposal first), the
    // second one runs and its device stays up.
    expect(latest?.isReady).toBe(true);
    expect(created).toHaveLength(1);
    expect(created[0]?.device.destroy).not.toHaveBeenCalled();
    expect(latest?.device).toBe(created[0]?.device);
  });

  it("destroys a device whose init finishes after the effect was disposed", async () => {
    let finish: (() => void) | undefined;
    vi.mocked(initWebGPU).mockImplementationOnce(
      (_canvas, onDeviceLost) =>
        new Promise((resolve) => {
          finish = () => {
            const value = fakeContext();
            created.push(value);
            lostCallbacks.push(onDeviceLost ?? (() => {}));
            resolve({ ok: true, value });
          };
        }),
    );
    const { unmount } = render(<Probe />);
    await settle();
    unmount();
    finish?.();
    await settle();

    expect(created[0]?.device.destroy).toHaveBeenCalledTimes(1);
  });

  it("re-initializes after an accidental device loss", async () => {
    render(<Probe />);
    await settle();
    expect(latest?.isReady).toBe(true);

    act(() => lostCallbacks[0]?.());
    expect(latest?.isReady).toBe(false);

    await act(async () => {
      vi.advanceTimersByTime(RECOVERY_DELAY_MS);
    });
    await settle();

    expect(initWebGPU).toHaveBeenCalledTimes(2);
    expect(latest?.isReady).toBe(true);
    expect(latest?.device).toBe(created[1]?.device);
  });

  it("does not recover a device it destroyed itself on unmount", async () => {
    const { unmount } = render(<Probe />);
    await settle();

    unmount();
    expect(created[0]?.device.destroy).toHaveBeenCalledTimes(1);
    // `device.lost` resolves after our own destroy().
    lostCallbacks[0]?.();
    await act(async () => {
      vi.advanceTimersByTime(RECOVERY_DELAY_MS * 2);
    });
    expect(initWebGPU).toHaveBeenCalledTimes(1);
  });

  it(`gives up after ${MAX_RECOVERIES} losses in a row`, async () => {
    render(<Probe />);
    await settle();

    for (let loss = 0; loss <= MAX_RECOVERIES; loss++) {
      act(() => lostCallbacks.at(-1)?.());
      await act(async () => {
        vi.advanceTimersByTime(RECOVERY_DELAY_MS);
      });
      await settle();
    }

    expect(initWebGPU).toHaveBeenCalledTimes(MAX_RECOVERIES + 1);
    expect(latest?.isReady).toBe(false);
    expect(latest?.failureReason).toBe("GPU Device Request Failed");
  });

  it("surfaces an initialization failure reason", async () => {
    vi.mocked(initWebGPU).mockResolvedValue({
      ok: false,
      reason: "No Compatible GPU Adapter Found",
    });
    render(<Probe />);
    await settle();

    expect(latest?.isReady).toBe(false);
    expect(latest?.failureReason).toBe("No Compatible GPU Adapter Found");
  });
});
