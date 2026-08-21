// ── ParticleBackground Diagnostics Tests ─────────────
//
// Covers the "particles enabled in Settings but the pipeline can't
// start" gap: with `navigator.gpu` absent (the WebView2 case), the
// component must render its solid OKLCH fallback *and* surface a
// one-time, Title-Cased console.warn + Sonner toast so the failure is
// diagnosable instead of silent.
//
// Only the outer `isWebGPUSupported()` gate is exercised here — once
// that gate passes, ParticleBackground mounts the real `<canvas>` path
// (ParticleCanvas → useWebGPU), which depends on ResizeObserver (not
// implemented by jsdom) and a full WebGPU adapter/device/context object
// graph. That deeper path's reason-propagation is covered at the
// `initWebGPU()` unit level in `__tests__/lib/webgpu.test.ts`; mounting
// it end-to-end is not practical under jsdom (see Task 5 report).

import { cleanup, render, waitFor } from "@testing-library/react";
import { getDefaultStore } from "jotai";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetParticlesUnavailableWarningForTests,
  ParticleBackground,
} from "#components/layout/ParticleBackground";
import { getWebGPUUnavailableReason } from "#lib/webgpu";
import { reducedMotionAtom } from "#store/ui";

// The latch under test is keyed on the *reason value*, not "has ever
// warned" — so retrying (toggling particlesEnabled, which re-runs
// useWebGPU's init effect) after a different failure can still surface a
// genuinely different reason. ParticleBackground's own gate can only ever
// produce "WebGPU Is Not Exposed By This WebView" (see
// `getWebGPUUnavailableReason()` in `#lib/webgpu`), so a second, distinct
// reason is modeled here by overriding that lookup for one render — this
// stands in for the deeper useWebGPU()/initWebGPU() path (covered at the
// unit level in `__tests__/lib/webgpu.test.ts`) producing e.g.
// "No Compatible GPU Adapter Found" on a retry, without needing a full
// WebGPU adapter/device/ResizeObserver mock (see file header).
vi.mock("#lib/webgpu", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#lib/webgpu")>();
  return {
    ...actual,
    getWebGPUUnavailableReason: vi.fn(actual.getWebGPUUnavailableReason),
  };
});

function setNavigatorGpu(value: unknown): void {
  Object.defineProperty(navigator, "gpu", {
    value,
    configurable: true,
    writable: true,
  });
}

describe("ParticleBackground diagnostics", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  // NOTE: `themeAtom` (particlesEnabled) is intentionally NOT overridden in
  // these tests. It's an `atomWithStorage`, whose `onMount` unconditionally
  // resets the value to its hardcoded default on every mount (see
  // `createTauriStorage().getItem`, which always returns `initialValue`) —
  // so a pre-render `store.set()` would just be clobbered when
  // ParticleBackground's `useAtomValue(themeAtom)` (re)subscribes. Its
  // default (`particlesEnabled: true`) is exactly the state these tests
  // want anyway. `reducedMotionAtom` is a plain atom (no such trap), so
  // it's used below to exercise the "intentionally off" bypass instead.
  const store = getDefaultStore();

  beforeEach(() => {
    vi.clearAllMocks();
    _resetParticlesUnavailableWarningForTests();
    store.set(reducedMotionAtom, false);
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    store.set(reducedMotionAtom, false);
    setNavigatorGpu(undefined);
    vi.restoreAllMocks();
  });

  it("renders the OKLCH fallback (not a canvas) when WebGPU is unsupported", () => {
    setNavigatorGpu(undefined);

    const { container } = render(<ParticleBackground />);

    expect(container.querySelector("canvas")).toBeNull();
    const fallback = container.querySelector('[aria-hidden="true"]');
    expect(fallback).toBeTruthy();
    expect(fallback?.tagName).toBe("DIV");
  });

  it("warns and toasts once with the specific unavailability reason", async () => {
    setNavigatorGpu(undefined);

    render(<ParticleBackground />);

    await waitFor(() => {
      expect(toast.warning).toHaveBeenCalledTimes(1);
    });

    expect(toast.warning).toHaveBeenCalledWith(
      "Particle Background Unavailable",
      expect.objectContaining({ description: "WebGPU Is Not Exposed By This WebView" }),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "Particle Background Unavailable: WebGPU Is Not Exposed By This WebView",
      ),
    );
  });

  it("fires the toast/warning at most once per session, even across remounts", async () => {
    setNavigatorGpu(undefined);

    const first = render(<ParticleBackground />);
    await waitFor(() => expect(toast.warning).toHaveBeenCalledTimes(1));

    first.unmount();
    render(<ParticleBackground />);
    render(<ParticleBackground />);

    // Give any (incorrect) second effect a chance to fire before asserting.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("does not warn when reduced motion is on, even though WebGPU is unsupported", async () => {
    // WebGPU is unsupported here too, but since the user (or OS) has
    // opted out of motion, this must NOT be treated as a diagnosable
    // pipeline failure. (Also keeps `shouldRender` false so ParticleCanvas
    // — which needs a ResizeObserver jsdom doesn't implement — never mounts.)
    setNavigatorGpu(undefined);
    store.set(reducedMotionAtom, true);

    const { container } = render(<ParticleBackground />);

    // Let effects flush.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(container.querySelector("canvas")).toBeNull();
    expect(toast.warning).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("warns again exactly once when a genuinely different failure reason follows the first", async () => {
    setNavigatorGpu(undefined);

    const first = render(<ParticleBackground />);
    await waitFor(() => expect(toast.warning).toHaveBeenCalledTimes(1));
    expect(toast.warning).toHaveBeenNthCalledWith(
      1,
      "Particle Background Unavailable",
      expect.objectContaining({ description: "WebGPU Is Not Exposed By This WebView" }),
    );

    first.unmount();

    // Model the retry path from the finding: toggling `particlesEnabled`
    // re-runs useWebGPU's init effect, which can produce a different
    // `failureReason` than the first attempt (e.g. "No Compatible GPU
    // Adapter Found" instead of "not exposed"). A same-session latch keyed
    // only on "have I ever warned" would wrongly swallow this new reason.
    vi.mocked(getWebGPUUnavailableReason).mockReturnValueOnce("No Compatible GPU Adapter Found");

    render(<ParticleBackground />);

    await waitFor(() => expect(toast.warning).toHaveBeenCalledTimes(2));
    expect(toast.warning).toHaveBeenNthCalledWith(
      2,
      "Particle Background Unavailable",
      expect.objectContaining({ description: "No Compatible GPU Adapter Found" }),
    );
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("Particle Background Unavailable: No Compatible GPU Adapter Found"),
    );
  });
});
