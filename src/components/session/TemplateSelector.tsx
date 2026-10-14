import { motion } from "motion/react";
import { Suspense, use, useSyncExternalStore } from "react";
import { Pill } from "#components/ui/Pill";
import { pluralizeWorkers } from "#lib/format";
import { DESKTOP_ONLY_REASON, hasCapability, isTauri } from "#lib/tauri";
import { BUILT_IN_TEMPLATES, subscribeUserTemplates, userTemplatesResource } from "#lib/templates";
import type { SessionTemplate } from "#store/types";

interface TemplateSelectorProps {
  readonly onSelect: (template: SessionTemplate) => void;
  readonly onClose: () => void;
}

/** Entrance stagger per card, capped so a long template list never waits seconds to appear. */
const STAGGER_S = 0.05;
const MAX_STAGGERED = 8;

const sectionHeadingClass =
  "mb-3 text-xs font-semibold tracking-widest text-fg-dim uppercase font-[family-name:var(--font-mono)]";

/**
 * Template chooser: the built-in templates render at once; the user's own
 * templates stream in beneath them (the cached `userTemplatesResource`
 * read through `use()`, re-read after every template write), and a store
 * that cannot be read says so instead of silently showing the built-ins
 * alone. User templates are plugin-store files, so without the Tauri bridge
 * the store is never read and that section says why instead.
 */
export function TemplateSelector({ onSelect, onClose }: TemplateSelectorProps): React.ReactElement {
  return (
    <div
      className="rounded-xl border border-[oklch(0.28_0.04_220)] bg-[oklch(0.12_0.02_220/0.8)] p-6"
      style={{ backdropFilter: "blur(16px) saturate(1.5)" }}
    >
      <div className="mb-5 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-[oklch(0.92_0.02_220)] font-[family-name:var(--font-display)]">
          Choose A Template
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close Template Selector"
          className="cursor-pointer rounded-lg p-1 text-[oklch(0.55_0.03_220)] transition-colors hover:bg-[oklch(0.22_0.04_220/0.5)] focus-visible:outline-2 focus-visible:outline-plasma"
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
        <div className="grid grid-cols-2 gap-3">
          {BUILT_IN_TEMPLATES.map((template, index) => (
            <TemplateCard key={template.id} template={template} index={index} onSelect={onSelect} />
          ))}
        </div>
      </section>

      {hasCapability("localStores") && isTauri() ? (
        <Suspense
          fallback={
            <p role="status" className="text-xs text-fg-dim font-[family-name:var(--font-body)]">
              Loading Your Templates…
            </p>
          }
        >
          <UserTemplates onSelect={onSelect} />
        </Suspense>
      ) : (
        <section aria-label="Your Templates">
          <h3 className={sectionHeadingClass}>Your Templates</h3>
          <p className="text-xs text-fg-dim font-[family-name:var(--font-body)]">
            {DESKTOP_ONLY_REASON}
          </p>
        </section>
      )}
    </div>
  );
}

function UserTemplates({
  onSelect,
}: {
  readonly onSelect: (template: SessionTemplate) => void;
}): React.ReactElement | null {
  // The cached read, swapped for a fresh one whenever a template is saved
  // or deleted — this stays mounted inside a hidden <Activity> on the
  // Sessions page, so it must not keep showing the list it first read.
  const { templates, failed } = use(
    useSyncExternalStore(subscribeUserTemplates, userTemplatesResource),
  );

  if (failed) {
    return (
      <p
        role="alert"
        className="text-xs text-[oklch(0.72_0.20_25)] font-[family-name:var(--font-body)]"
      >
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
}: {
  readonly template: SessionTemplate;
  readonly index: number;
  readonly onSelect: (template: SessionTemplate) => void;
}): React.ReactElement {
  return (
    <motion.button
      type="button"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index, MAX_STAGGERED) * STAGGER_S, duration: 0.2 }}
      whileHover={{ scale: 1.02 }}
      whileTap={{ scale: 0.98 }}
      onClick={() => onSelect(template)}
      className="cursor-pointer rounded-lg border border-[oklch(0.26_0.04_220/0.5)] bg-[oklch(0.16_0.03_220/0.6)] p-4 text-left transition-colors hover:border-[oklch(0.50_0.18_290/0.5)] hover:bg-[oklch(0.18_0.05_290/0.3)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-plasma"
      style={{ backdropFilter: "blur(8px)" }}
    >
      <span className="mb-1 block text-sm font-semibold text-[oklch(0.88_0.04_220)] font-[family-name:var(--font-display)]">
        {template.name}
      </span>
      <span className="mb-2 line-clamp-2 text-xs text-fg-dim font-[family-name:var(--font-body)]">
        {template.description}
      </span>
      <Pill tone="info" size="sm">
        {pluralizeWorkers(template.workerConfigs.length)}
      </Pill>
    </motion.button>
  );
}
