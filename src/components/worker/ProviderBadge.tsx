// ── ProviderBadge ────────────────────────────────────
// Shared Pill presentation for a live agent_session_started session —
// provider + model — used by both the Workers list row and
// WorkerAIPanel's toolbar. Previously two independent hand-rolled
// <span> badges: the list row's showed "Claude Code" with no model at
// all, and the toolbar's only surfaced the model via a hover title
// (never visible at a glance).

import { Pill, type PillSize } from "#components/ui/Pill";
import type { ProviderId } from "#lib/agent-events";

/** Title Case display label per `ProviderId` — mirrors Rust's `ProviderId` wire values. */
const PROVIDER_LABELS: Record<ProviderId, string> = {
  claude_code: "Claude Code",
  codex: "Codex",
  open_code: "Open Code",
  gemini: "Gemini",
  webview_anthropic: "Webview Anthropic",
};

// Decorative/categorical color (not one of Pill's five semantic
// tones) — same purple both hand-rolled badges already used, applied
// via a style override per Pill's own documented pattern (inline
// style wins over the `.swarm-pill[data-tone]` class rule).
const PROVIDER_BADGE_COLOR = {
  background: "oklch(0.16 0.06 290 / 0.5)",
  color: "oklch(0.80 0.14 290)",
  borderColor: "oklch(0.45 0.14 290)",
};

interface ProviderBadgeProps {
  readonly provider: ProviderId;
  readonly model: string;
  readonly size?: PillSize;
}

/** Pill badge showing a live agent session's provider + model, e.g. "Claude Code · sonnet". */
export function ProviderBadge({
  provider,
  model,
  size = "sm",
}: ProviderBadgeProps): React.ReactElement {
  const label = PROVIDER_LABELS[provider];
  return (
    <Pill
      tone="neutral"
      size={size}
      style={PROVIDER_BADGE_COLOR}
      maxWidth={220}
      title={`${label} — ${model}`}
    >
      {label} · {model}
    </Pill>
  );
}
