// ── One-time-per-reason "pipeline can't start" diagnostics ──
//
// Module-level (not component state) so the warning/toast fires at most
// once per *distinct reason* per app session, however often the
// component re-renders, remounts (StrictMode) or retries after a device
// loss. Keyed on the reason, not a boolean: a retry (e.g. toggling
// particles in Settings) can surface a different, more current reason,
// which should still be reported once.

import { toast } from "sonner";
import type { WebGPUUnavailableReason } from "#lib/webgpu";

let lastWarnedReason: WebGPUUnavailableReason | null = null;

/** Resets the one-time-per-reason guard. Test-only — production code never calls this. */
export function resetParticlesUnavailableWarning(): void {
  lastWarnedReason = null;
}

/** Logs and toasts why the particle background cannot start, once per distinct reason. */
export function warnParticlesUnavailable(reason: WebGPUUnavailableReason): void {
  if (lastWarnedReason === reason) return;
  lastWarnedReason = reason;

  console.warn(`[particles] Particle Background Unavailable: ${reason}`);
  toast.warning("Particle Background Unavailable", { description: reason });
}
