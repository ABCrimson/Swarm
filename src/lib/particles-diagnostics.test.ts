import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetParticlesUnavailableWarning,
  warnParticlesUnavailable,
} from "#lib/particles-diagnostics";
import { useLogStore } from "#store/logs";

/** Messages the diagnostics wrote to the log store. */
function particleLogs(): string[] {
  return useLogStore
    .getState()
    .entries.filter((entry) => entry.source === "particles")
    .map((entry) => entry.message);
}

describe("warnParticlesUnavailable", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetParticlesUnavailableWarning();
    useLogStore.getState().clear();
  });

  it("writes a warn entry to the log store and briefly toasts the reason", () => {
    warnParticlesUnavailable("WebGPU Is Not Exposed By This WebView");

    const [entry] = useLogStore.getState().entries;
    expect(entry).toMatchObject({
      level: "warn",
      source: "particles",
      message: "Particle Background Unavailable: WebGPU Is Not Exposed By This WebView",
    });
    expect(toast).toHaveBeenCalledExactlyOnceWith("Particle Background Off", {
      description: "WebGPU Is Not Exposed By This WebView",
      duration: 3000,
    });
  });

  it("reports one reason once, however often it recurs", () => {
    warnParticlesUnavailable("WebGPU Is Not Exposed By This WebView");
    warnParticlesUnavailable("WebGPU Is Not Exposed By This WebView");

    expect(particleLogs()).toHaveLength(1);
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it("reports a different reason, and again after a reset", () => {
    warnParticlesUnavailable("WebGPU Is Not Exposed By This WebView");
    warnParticlesUnavailable("No Compatible GPU Adapter Found");
    expect(toast).toHaveBeenCalledTimes(2);

    resetParticlesUnavailableWarning();
    warnParticlesUnavailable("No Compatible GPU Adapter Found");
    expect(toast).toHaveBeenCalledTimes(3);
    expect(particleLogs()).toHaveLength(3);
  });
});
