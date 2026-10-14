// ── "Pipeline can't start" diagnostics ──
//
// Module-level (not component state) so the guard survives re-renders and
// remounts (StrictMode). It fires once per change of reason: the same
// reason recurring (re-renders, remounts, retries after a device loss)
// stays silent, while a retry that surfaces a different reason reports it
// once. Only the last reported reason is remembered.

import { toast } from "sonner";
import type { WebGPUUnavailableReason } from "#lib/webgpu";

let lastWarnedReason: WebGPUUnavailableReason | null = null;

/** Resets the one-time-per-reason guard. Test-only — production code never calls this. */
export function resetParticlesUnavailableWarning(): void {
  lastWarnedReason = null;
}

/** Logs and toasts why the particle background cannot start, unless that reason was the last one reported. */
export function warnParticlesUnavailable(reason: WebGPUUnavailableReason): void {
  if (lastWarnedReason === reason) return;
  lastWarnedReason = reason;

  console.warn(`[particles] Particle Background Unavailable: ${reason}`);
  toast.warning("Particle Background Unavailable", { description: reason });
}
