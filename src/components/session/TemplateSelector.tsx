import { motion } from "motion/react";
import { useEffect, useState } from "react";
import { Pill } from "#components/ui/Pill";
import { pluralizeWorkers } from "#lib/format";
import { BUILT_IN_TEMPLATES, loadUserTemplates } from "#lib/templates";
import type { SessionTemplate } from "#store/types";

interface TemplateSelectorProps {
  readonly onSelect: (template: SessionTemplate) => void;
  readonly onClose: () => void;
}

/**
 * Template chooser displaying built-in and user-created session templates.
 *
 * Templates are displayed as animated cards in a responsive grid.
 */
export function TemplateSelector({ onSelect, onClose }: TemplateSelectorProps): React.ReactElement {
  const [userTemplates, setUserTemplates] = useState<SessionTemplate[]>([]);

  useEffect(() => {
    let cancelled = false;
    void loadUserTemplates()
      .then((templates) => {
        if (!cancelled) setUserTemplates(templates);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSelect = (template: SessionTemplate) => {
    onSelect(template);
  };

  return (
    <div
      className="rounded-xl p-6"
      style={{
        background: "oklch(0.12 0.02 220 / 0.8)",
        backdropFilter: "blur(16px) saturate(1.5)",
        border: "1px solid oklch(0.28 0.04 220)",
      }}
    >
      <div className="flex items-center justify-between mb-5">
        <h2
          className="text-lg font-semibold"
          style={{
            fontFamily: "var(--font-display)",
            color: "oklch(0.92 0.02 220)",
          }}
        >
          Choose A Template
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close Template Selector"
          className="p-1 rounded-lg transition-colors cursor-pointer"
          style={{ color: "oklch(0.55 0.03 220)" }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLElement).style.background = "oklch(0.22 0.04 220 / 0.5)";
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLElement).style.background = "oklch(0 0 0 / 0)";
          }}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <title>Close</title>
            <path
              d="M4 4l8 8M12 4l-8 8"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>

      {/* Built-in templates */}
      <div className="mb-5">
        <h3
          className="text-xs font-semibold uppercase tracking-widest mb-3"
          style={{
            fontFamily: "var(--font-mono, 'JetBrains Mono Variable', monospace)",
            color: "oklch(0.50 0.06 220)",
          }}
        >
          Built-In
        </h3>
        <div className="grid grid-cols-2 gap-3">
          {BUILT_IN_TEMPLATES.map((template, idx) => (
            <TemplateCard
              key={template.id}
              template={template}
              index={idx}
              onSelect={handleSelect}
            />
          ))}
        </div>
      </div>

      {/* User templates */}
      {userTemplates.length > 0 && (
        <div>
          <h3
            className="text-xs font-semibold uppercase tracking-widest mb-3"
            style={{
              fontFamily: "var(--font-mono, 'JetBrains Mono Variable', monospace)",
              color: "oklch(0.50 0.06 220)",
            }}
          >
            Your Templates
          </h3>
          <div className="grid grid-cols-2 gap-3">
            {userTemplates.map((template, idx) => (
              <TemplateCard
                key={template.id}
                template={template}
                index={idx + BUILT_IN_TEMPLATES.length}
                onSelect={handleSelect}
              />
            ))}
          </div>
        </div>
      )}
    </div>
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
      transition={{ delay: index * 0.05, duration: 0.2 }}
      whileHover={{ scale: 1.02 }}
      whileTap={{ scale: 0.98 }}
      onClick={() => onSelect(template)}
      className="text-left rounded-lg p-4 cursor-pointer transition-colors"
      style={{
        background: "oklch(0.16 0.03 220 / 0.6)",
        backdropFilter: "blur(8px)",
        border: "1px solid oklch(0.26 0.04 220 / 0.5)",
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLElement).style.borderColor = "oklch(0.50 0.18 290 / 0.5)";
        (e.currentTarget as HTMLElement).style.background = "oklch(0.18 0.05 290 / 0.3)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.borderColor = "oklch(0.26 0.04 220 / 0.5)";
        (e.currentTarget as HTMLElement).style.background = "oklch(0.16 0.03 220 / 0.6)";
      }}
    >
      <h4
        className="text-sm font-semibold mb-1"
        style={{
          fontFamily: "var(--font-display)",
          color: "oklch(0.88 0.04 220)",
        }}
      >
        {template.name}
      </h4>
      <p
        className="text-xs mb-2 line-clamp-2"
        style={{
          fontFamily: "var(--font-body)",
          color: "oklch(0.55 0.03 220)",
        }}
      >
        {template.description}
      </p>
      <Pill tone="info" size="sm">
        {pluralizeWorkers(template.workerConfigs.length)}
      </Pill>
    </motion.button>
  );
}
