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
import { reducedMotionAtom } from "#store/ui";

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
});
