import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetParticlesUnavailableWarning,
  warnParticlesUnavailable,
} from "#lib/particles-diagnostics";

describe("warnParticlesUnavailable", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetParticlesUnavailableWarning();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("warns and toasts with the reason", () => {
    warnParticlesUnavailable("WebGPU Is Not Exposed By This WebView");

    expect(warnSpy).toHaveBeenCalledExactlyOnceWith(
      "[particles] Particle Background Unavailable: WebGPU Is Not Exposed By This WebView",
    );
    expect(toast.warning).toHaveBeenCalledExactlyOnceWith("Particle Background Unavailable", {
      description: "WebGPU Is Not Exposed By This WebView",
    });
  });

  it("reports one reason once, however often it recurs", () => {
    warnParticlesUnavailable("WebGPU Is Not Exposed By This WebView");
    warnParticlesUnavailable("WebGPU Is Not Exposed By This WebView");

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(toast.warning).toHaveBeenCalledTimes(1);
  });

  it("reports a different reason, and again after a reset", () => {
    warnParticlesUnavailable("WebGPU Is Not Exposed By This WebView");
    warnParticlesUnavailable("No Compatible GPU Adapter Found");
    expect(toast.warning).toHaveBeenCalledTimes(2);

    resetParticlesUnavailableWarning();
    warnParticlesUnavailable("No Compatible GPU Adapter Found");
    expect(toast.warning).toHaveBeenCalledTimes(3);
  });
});
