import { Pill, type PillSize } from "#components/ui/Pill";
import { PROVIDER_LABELS, type ProviderId } from "#lib/agent-events";

/**
 * Categorical provider color — not one of Pill's semantic tones, so it
 * is applied as a style override (inline style wins over the
 * `.swarm-pill[data-tone]` rule).
 */
const PROVIDER_BADGE_COLOR = {
  background: "oklch(0.16 0.06 290 / 0.5)",
  color: "oklch(0.80 0.14 290)",
  borderColor: "oklch(0.45 0.14 290)",
};

interface ProviderBadgeProps {
  readonly provider: ProviderId;
  /** The session's model; empty when the provider runs its own default. */
  readonly model: string;
  readonly size?: PillSize;
}

/**
 * A live agent session's provider and model as one Pill, e.g.
 * "Claude Code · sonnet" — shown in the Workers list and in
 * `WorkerAIPanel`'s toolbar.
 */
export function ProviderBadge({ provider, model, size }: ProviderBadgeProps): React.ReactElement {
  const label = PROVIDER_LABELS[provider];
  const text = model ? `${label} · ${model}` : label;
  return (
    <Pill
      tone="neutral"
      size={size ?? "sm"}
      style={PROVIDER_BADGE_COLOR}
      maxWidth={220}
      title={text}
    >
      {text}
    </Pill>
  );
}
