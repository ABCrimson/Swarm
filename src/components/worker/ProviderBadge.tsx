import { Pill } from "#components/ui/Pill";
import { PROVIDER_LABELS, type ProviderId } from "#lib/agent-events";
import { escapeForDisplay } from "#lib/display-escape";

/**
 * Categorical provider color — not one of Pill's semantic tones, so it is
 * applied as utility classes (the `utilities` layer wins over the
 * `.swarm-pill[data-tone]` rules in the `components` layer).
 */
const PROVIDER_BADGE_CLASS =
  "border-[oklch(0.45_0.14_290)] bg-[oklch(0.16_0.06_290/0.5)] text-[oklch(0.80_0.14_290)]";

interface ProviderBadgeProps {
  readonly provider: ProviderId;
  /** The session's model; empty when the provider runs its own default. */
  readonly model: string;
}

/**
 * A live agent session's provider and model as one Pill, e.g.
 * "Claude Code, sonnet" — shown in the Workers list and in
 * `WorkerAIPanel`'s toolbar.
 */
export function ProviderBadge({ provider, model }: ProviderBadgeProps): React.ReactElement {
  const label = PROVIDER_LABELS[provider];
  const text = model ? `${label}, ${escapeForDisplay(model)}` : label;
  return (
    <Pill tone="neutral" className={PROVIDER_BADGE_CLASS} maxWidth={220} title={text}>
      {text}
    </Pill>
  );
}
