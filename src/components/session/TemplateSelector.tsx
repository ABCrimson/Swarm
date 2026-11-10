import { type CSSProperties, use, useId, useSyncExternalStore } from "react";
import { Pill } from "#components/ui/Pill";
import { Reveal } from "#components/ui/Reveal";
import { escapeForDisplay } from "#lib/display-escape";
import { pluralizeWorkers } from "#lib/format";
import { DESKTOP_ONLY_REASON, hasCapability, isTauri } from "#lib/tauri";
import { BUILT_IN_TEMPLATES, subscribeUserTemplates, userTemplatesResource } from "#lib/templates";
import type { SessionTemplate } from "#store/types";

interface TemplateSelectorProps {
  readonly onSelect: (template: SessionTemplate) => void;
  readonly onClose: () => void;
}

/** Cards past this index enter with the last card's delay, so a long template list never waits seconds to appear. */
const MAX_STAGGERED = 8;

/**
 * A card's motion. Entrance: from `@starting-style` (`starting:`) it fades
 * and rises 8 px over 200 ms on the shell's entrance curve, delayed 50 ms per
 * `--i` (the card's capped index, set inline). Hover: colors fade as
 * `transition-colors` does, and an enabled card's lift and press dip spring
 * on `scale` along `--ease-spring`, the same token as SessionCard. The
 * per-property lists keep the stagger delay off hover.
 */
const CARD_MOTION_CLASS =
  "transition-[opacity,translate,color,background-color,border-color,scale] duration-[200ms,200ms,150ms,150ms,150ms,500ms] ease-[var(--ease-out-cubic),var(--ease-out-cubic),cubic-bezier(0.4,0,0.2,1),cubic-bezier(0.4,0,0.2,1),cubic-bezier(0.4,0,0.2,1),var(--ease-spring)] delay-[calc(var(--i)*50ms),calc(var(--i)*50ms),0s,0s,0s,0s] starting:translate-y-2 starting:opacity-0 enabled:hover:scale-[1.02] enabled:active:scale-[0.98]";

const sectionHeadingClass = "mb-3 font-display text-md font-semibold tracking-tight text-fg";

/**
 * Template chooser: the built-in templates render at once; the user's own
 * templates stream in beneath them (the cached `userTemplatesResource`
 * read through `use()`, re-read after every template write), and a store
 * that cannot be read says so instead of silently showing the built-ins
 * alone. User templates are plugin-store files, so without the Tauri bridge
 * the store is never read and that section says why instead. A template's workers are webview
 * workers, so a build without `localAiChat` (the swarmd web page) shows every template that has
 * workers disabled, with the reason.
 */
export function TemplateSelector({ onSelect, onClose }: TemplateSelectorProps): React.ReactElement {
  const spawnReasonId = useId();
  const unavailableReasonId = hasCapability("localAiChat") ? undefined : spawnReasonId;
  return (
    <div className="rounded-lg border border-[oklch(0.28_0.04_220)] bg-[oklch(0.12_0.02_220/0.8)] p-6 backdrop-blur-[16px] backdrop-saturate-150">
      <div className="mb-5 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-[oklch(0.92_0.02_220)] font-display">
          Choose A Template
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close Template Selector"
          className="cursor-pointer rounded-lg p-1 text-[oklch(0.55_0.03_220)] transition-colors hover:bg-border/50"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M4 4l8 8M12 4l-8 8"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>

      <section aria-label="Built-In Templates" className="mb-5">
        <h3 className={sectionHeadingClass}>Built-In</h3>
        {unavailableReasonId != null && (
          <p id={unavailableReasonId} className="mb-3 text-xs text-fg-dim">
            {DESKTOP_ONLY_REASON}
          </p>
        )}
        <div className="grid grid-cols-2 gap-3">
          {BUILT_IN_TEMPLATES.map((template, index) => (
            <TemplateCard
              key={template.id}
              template={template}
              index={index}
              onSelect={onSelect}
              unavailableReasonId={unavailableReasonId}
            />
          ))}
        </div>
      </section>

      {hasCapability("localStores") && isTauri() ? (
        <Reveal
          fallback={
            <p role="status" className="text-xs text-fg-dim">
              Loading Your Templates…
            </p>
          }
        >
          <UserTemplates onSelect={onSelect} unavailableReasonId={unavailableReasonId} />
        </Reveal>
      ) : (
        <section aria-label="Your Templates">
          <h3 className={sectionHeadingClass}>Your Templates</h3>
          <p className="text-xs text-fg-dim">{DESKTOP_ONLY_REASON}</p>
        </section>
      )}
    </div>
  );
}

function UserTemplates({
  onSelect,
  unavailableReasonId,
}: {
  readonly onSelect: (template: SessionTemplate) => void;
  readonly unavailableReasonId: string | undefined;
}): React.ReactElement | null {
  // The cached read, swapped for a fresh one whenever a template is saved
  // or deleted — this stays mounted inside a hidden <Activity> on the
  // Sessions page, so it must not keep showing the list it first read.
  const { templates, failed } = use(
    useSyncExternalStore(subscribeUserTemplates, userTemplatesResource),
  );

  if (failed) {
    return (
      <p role="alert" className="text-xs text-[oklch(0.72_0.20_25)]">
        Could Not Load Your Templates.
      </p>
    );
  }
  if (templates.length === 0) return null;

  return (
    <section aria-label="Your Templates">
      <h3 className={sectionHeadingClass}>Your Templates</h3>
      <div className="grid grid-cols-2 gap-3">
        {templates.map((template, index) => (
          <TemplateCard
            key={template.id}
            template={template}
            index={index + BUILT_IN_TEMPLATES.length}
            onSelect={onSelect}
            unavailableReasonId={unavailableReasonId}
          />
        ))}
      </div>
    </section>
  );
}

function TemplateCard({
  template,
  index,
  onSelect,
  unavailableReasonId,
}: {
  readonly template: SessionTemplate;
  readonly index: number;
  readonly onSelect: (template: SessionTemplate) => void;
  /** Set when applying cannot work here; the element with this id says why. */
  readonly unavailableReasonId: string | undefined;
}): React.ReactElement {
  const unavailable = unavailableReasonId != null && template.workerConfigs.length > 0;
  return (
    <button
      type="button"
      disabled={unavailable}
      aria-describedby={unavailable ? unavailableReasonId : undefined}
      onClick={() => onSelect(template)}
      className={`cursor-pointer disabled:cursor-not-allowed disabled:opacity-60 rounded-lg border border-[oklch(0.26_0.04_220/0.5)] bg-[oklch(0.16_0.03_220/0.6)] p-4 text-left hover:border-border-3 hover:bg-surface-3/60 backdrop-blur-[8px] ${CARD_MOTION_CLASS}`}
      style={{ "--i": Math.min(index, MAX_STAGGERED) } as CSSProperties}
    >
      <span className="mb-1 block text-sm font-semibold text-[oklch(0.88_0.04_220)] font-display">
        {escapeForDisplay(template.name)}
      </span>
      <span className="mb-2 line-clamp-2 text-xs text-fg-dim">{template.description}</span>
      <Pill tone="info" size="sm">
        {pluralizeWorkers(template.workerConfigs.length)}
      </Pill>
    </button>
  );
}
