import { useAtom } from "jotai";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Pill } from "#components/ui/Pill";
import { alertThresholdsAtom } from "#lib/alerts";
import {
  CLAUDE_MODELS,
  formatContextLabel,
  formatMaxOutputLabel,
  type ModelKey,
} from "#lib/models";
import { readConfig, writeConfig } from "#lib/tauri";
import { selectedModelAtom, themeAtom } from "#store/ui";

/** Config key under which the Anthropic API key is persisted (see #lib/anthropic). */
const ANTHROPIC_API_KEY_CONFIG_KEY = "anthropic_api_key";

const SECTION_STYLE: React.CSSProperties = {
  background: "oklch(0.10 0.02 220)",
  border: "1px solid oklch(0.20 0.03 220)",
  borderRadius: 12,
  padding: "24px 28px",
};

const LABEL_STYLE: React.CSSProperties = {
  fontFamily: "var(--font-body)",
  fontSize: "0.82rem",
  fontWeight: 500,
  color: "oklch(0.75 0.03 220)",
  display: "block",
  marginBottom: 6,
};

const DESCRIPTION_STYLE: React.CSSProperties = {
  fontFamily: "var(--font-body)",
  fontSize: "0.72rem",
  color: "oklch(0.48 0.03 220)",
  marginTop: 4,
  lineHeight: 1.4,
};

const TEXT_INPUT_STYLE: React.CSSProperties = {
  width: "100%",
  padding: "8px 12px",
  borderRadius: 6,
  border: "1px solid oklch(0.35 0.04 220)",
  background: "oklch(0.08 0.015 220)",
  color: "oklch(0.85 0.03 220)",
  fontFamily: "var(--font-mono)",
  fontSize: "0.82rem",
  outline: "none",
  transition: "border-color 0.12s ease",
};

const SAVE_BUTTON_STYLE: React.CSSProperties = {
  fontFamily: "var(--font-body)",
  fontSize: "0.75rem",
  fontWeight: 500,
  color: "oklch(0.95 0 0)",
  background: "oklch(0.78 0.18 205)",
  border: "none",
  borderRadius: 6,
  padding: "5px 14px",
  cursor: "pointer",
};

function Toggle({
  checked,
  onChange,
  label,
  description,
}: {
  readonly checked: boolean;
  readonly onChange: (v: boolean) => void;
  readonly label: string;
  readonly description?: string;
}): React.ReactElement {
  return (
    <label
      style={{
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "space-between",
        gap: 16,
        cursor: "pointer",
        padding: "10px 0",
      }}
    >
      <div>
        <span style={LABEL_STYLE}>{label}</span>
        {description && <span style={DESCRIPTION_STYLE}>{description}</span>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        style={{
          position: "relative",
          width: 44,
          height: 24,
          borderRadius: 12,
          border: "none",
          cursor: "pointer",
          flexShrink: 0,
          marginTop: 2,
          background: checked ? "oklch(0.78 0.18 205)" : "oklch(0.22 0.03 220)",
          transition: "background 0.2s ease",
          outline: "none",
        }}
      >
        <span
          style={{
            position: "absolute",
            top: 3,
            left: checked ? 23 : 3,
            width: 18,
            height: 18,
            borderRadius: "50%",
            background: checked ? "oklch(0.98 0 0)" : "oklch(0.50 0.03 220)",
            transition: "left 0.2s cubic-bezier(0.4, 0, 0.2, 1), background 0.2s ease",
            boxShadow: "0 1px 3px oklch(0 0 0 / 0.3)",
          }}
        />
      </button>
    </label>
  );
}

function ModelCard({
  id,
  name,
  description,
  context,
  gated,
  selected,
  onSelect,
}: {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly context: string;
  readonly gated: boolean;
  readonly selected: boolean;
  readonly onSelect: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      data-model-id={id}
      aria-pressed={selected}
      onClick={onSelect}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        padding: "14px 18px",
        borderRadius: 10,
        border: selected ? "1.5px solid oklch(0.78 0.18 205)" : "1px solid oklch(0.20 0.03 220)",
        background: selected ? "oklch(0.12 0.03 210)" : "oklch(0.08 0.015 220)",
        cursor: "pointer",
        textAlign: "left",
        transition: "all 0.15s ease",
        outline: "none",
        boxShadow: selected ? "0 0 12px oklch(0.78 0.18 205 / 0.15)" : "none",
        flex: 1,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: selected ? "oklch(0.78 0.18 205)" : "oklch(0.30 0.03 220)",
            flexShrink: 0,
            transition: "background 0.15s ease",
          }}
        />
        <span
          style={{
            fontFamily: "var(--font-display)",
            fontSize: "0.9rem",
            fontWeight: 700,
            color: selected ? "oklch(0.95 0.03 205)" : "oklch(0.70 0.03 220)",
            letterSpacing: "-0.01em",
          }}
        >
          {name}
        </span>
        {gated && (
          <Pill tone="warning" size="sm">
            Requires Project Glasswing
          </Pill>
        )}
      </div>
      <span style={{ ...DESCRIPTION_STYLE, marginTop: 0 }}>{description}</span>
      <Pill tone="neutral" size="sm" style={{ alignSelf: "flex-start" }}>
        {context}
      </Pill>
    </button>
  );
}

/** Settings page for application configuration and preferences. */
export function Settings(): React.ReactElement {
  const [theme, setTheme] = useAtom(themeAtom);
  const [selectedModel, setSelectedModel] = useAtom(selectedModelAtom);
  const [thresholds, setThresholds] = useAtom(alertThresholdsAtom);
  const [editingThresholds, setEditingThresholds] = useState(false);
  const [tempThresholds, setTempThresholds] = useState(thresholds);

  // ── API key (read on mount, written on Save via #lib/tauri) ──
  // The key itself is never logged, traced, or included in a toast —
  // only the static "saved"/"failed" messages below are shown.
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [apiKeySaved, setApiKeySaved] = useState<string | null>(null);
  const [savingApiKey, setSavingApiKey] = useState(false);

  useEffect(() => {
    let cancelled = false;
    readConfig<string>(ANTHROPIC_API_KEY_CONFIG_KEY)
      .then((key) => {
        if (cancelled || typeof key !== "string" || key.length === 0) return;
        setApiKeyDraft(key);
        setApiKeySaved(key);
      })
      .catch(() => {
        // No config file yet (fresh install) or IPC unavailable — leave the field empty.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const apiKeyDirty = apiKeyDraft !== (apiKeySaved ?? "");

  const handleSaveApiKey = async (): Promise<void> => {
    setSavingApiKey(true);
    try {
      await writeConfig(ANTHROPIC_API_KEY_CONFIG_KEY, apiKeyDraft);
      setApiKeySaved(apiKeyDraft);
      toast.success("API Key Saved");
    } catch {
      toast.error("Failed To Save API Key");
    } finally {
      setSavingApiKey(false);
    }
  };

  return (
    <div className="flex flex-col gap-6 p-6" style={{ maxWidth: 720 }}>
      {/* Header */}
      <div>
        <h1
          className="text-2xl font-bold tracking-tight"
          style={{
            fontFamily: "var(--font-display)",
            color: "oklch(0.95 0.02 220)",
            letterSpacing: "-0.02em",
          }}
        >
          Settings
        </h1>
        <p style={DESCRIPTION_STYLE}>
          Configure AI Models, Visual Preferences, And Alert Thresholds.
        </p>
      </div>

      {/* AI Connectivity */}
      <section style={SECTION_STYLE}>
        <h2
          style={{
            fontFamily: "var(--font-display)",
            fontSize: "0.95rem",
            fontWeight: 700,
            color: "oklch(0.88 0.04 220)",
            marginBottom: 16,
            letterSpacing: "-0.01em",
          }}
        >
          AI Connectivity
        </h2>
        <label htmlFor="anthropic-api-key" style={LABEL_STYLE}>
          API Key
        </label>
        <input
          id="anthropic-api-key"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={apiKeyDraft}
          onChange={(e) => setApiKeyDraft(e.target.value)}
          placeholder="Enter Your Anthropic API Key"
          style={TEXT_INPUT_STYLE}
        />
        <p style={DESCRIPTION_STYLE}>
          Your Anthropic API Key. Required To Use AI Chat. Stored Locally In Plaintext At App Data —
          Never Logged Or Displayed In Clear Text.
        </p>
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
          <button
            type="button"
            onClick={() => void handleSaveApiKey()}
            disabled={!apiKeyDirty || savingApiKey}
            style={{
              ...SAVE_BUTTON_STYLE,
              opacity: !apiKeyDirty || savingApiKey ? 0.5 : 1,
              cursor: !apiKeyDirty || savingApiKey ? "default" : "pointer",
            }}
          >
            {savingApiKey ? "Saving…" : "Save"}
          </button>
        </div>
      </section>

      {/* AI Model Selection */}
      <section style={SECTION_STYLE}>
        <h2
          style={{
            fontFamily: "var(--font-display)",
            fontSize: "0.95rem",
            fontWeight: 700,
            color: "oklch(0.88 0.04 220)",
            marginBottom: 16,
            letterSpacing: "-0.01em",
          }}
        >
          AI Model
        </h2>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          {(
            Object.entries(CLAUDE_MODELS) as Array<[ModelKey, (typeof CLAUDE_MODELS)[ModelKey]]>
          ).map(([key, model]) => (
            <ModelCard
              key={key}
              id={model.id}
              name={model.label}
              description={model.description}
              context={`${formatContextLabel(model.contextWindow)} · ${formatMaxOutputLabel(model.maxOutputTokens)}`}
              gated={model.gated !== undefined}
              selected={selectedModel === key}
              onSelect={() => {
                setSelectedModel(key);
                toast.success(`Switched To ${model.label}`);
              }}
            />
          ))}
        </div>
      </section>

      {/* Visual Preferences */}
      <section style={SECTION_STYLE}>
        <h2
          style={{
            fontFamily: "var(--font-display)",
            fontSize: "0.95rem",
            fontWeight: 700,
            color: "oklch(0.88 0.04 220)",
            marginBottom: 8,
            letterSpacing: "-0.01em",
          }}
        >
          Visual Preferences
        </h2>
        <div style={{ borderBottom: "1px solid oklch(0.16 0.02 220)", paddingBottom: 4 }}>
          <Toggle
            checked={theme.particlesEnabled}
            onChange={(v) => setTheme({ ...theme, particlesEnabled: v })}
            label="Particle Background"
            description="GPU-Accelerated WebGPU Particle System Behind The Workspace. Disable To Reduce GPU Usage."
          />
        </div>
        <div>
          <Toggle
            checked={theme.gpuOverlay}
            onChange={(v) => setTheme({ ...theme, gpuOverlay: v })}
            label="GPU Frame Time Overlay"
            description="Display GPU Frame Timing In The Status Bar For Performance Monitoring."
          />
        </div>
      </section>

      {/* Alert Thresholds */}
      <section style={SECTION_STYLE}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 16,
          }}
        >
          <h2
            style={{
              fontFamily: "var(--font-display)",
              fontSize: "0.95rem",
              fontWeight: 700,
              color: "oklch(0.88 0.04 220)",
              letterSpacing: "-0.01em",
            }}
          >
            Alert Thresholds
          </h2>
          {!editingThresholds ? (
            <button
              type="button"
              onClick={() => {
                setTempThresholds(thresholds);
                setEditingThresholds(true);
              }}
              style={{
                fontFamily: "var(--font-body)",
                fontSize: "0.75rem",
                fontWeight: 500,
                color: "oklch(0.78 0.18 205)",
                background: "oklch(0.12 0.04 210)",
                border: "1px solid oklch(0.78 0.18 205 / 0.3)",
                borderRadius: 6,
                padding: "5px 14px",
                cursor: "pointer",
                transition: "all 0.12s ease",
              }}
            >
              Edit
            </button>
          ) : (
            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                onClick={() => setEditingThresholds(false)}
                style={{
                  fontFamily: "var(--font-body)",
                  fontSize: "0.75rem",
                  color: "oklch(0.55 0.03 220)",
                  background: "none",
                  border: "1px solid oklch(0.25 0.03 220)",
                  borderRadius: 6,
                  padding: "5px 14px",
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  setThresholds(tempThresholds);
                  setEditingThresholds(false);
                  toast.success("Alert Thresholds Updated");
                }}
                style={{
                  fontFamily: "var(--font-body)",
                  fontSize: "0.75rem",
                  fontWeight: 500,
                  color: "oklch(0.95 0 0)",
                  background: "oklch(0.78 0.18 205)",
                  border: "none",
                  borderRadius: 6,
                  padding: "5px 14px",
                  cursor: "pointer",
                }}
              >
                Save
              </button>
            </div>
          )}
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: "12px 24px",
          }}
        >
          {[
            {
              key: "cpuWarning" as const,
              label: "CPU Warning",
              unit: "%",
              color: "oklch(0.82 0.16 85)",
            },
            {
              key: "cpuCritical" as const,
              label: "CPU Critical",
              unit: "%",
              color: "oklch(0.72 0.20 25)",
            },
            {
              key: "memoryWarning" as const,
              label: "Memory Warning",
              unit: "%",
              color: "oklch(0.82 0.16 85)",
            },
            {
              key: "memoryCritical" as const,
              label: "Memory Critical",
              unit: "%",
              color: "oklch(0.72 0.20 25)",
            },
          ].map(({ key, label, unit, color }) => (
            <div key={key}>
              <label htmlFor={`threshold-${key}`} style={{ ...LABEL_STYLE, fontSize: "0.72rem" }}>
                {label}
              </label>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <input
                  id={`threshold-${key}`}
                  type="number"
                  min={0}
                  max={100}
                  value={editingThresholds ? tempThresholds[key] : thresholds[key]}
                  disabled={!editingThresholds}
                  onChange={(e) =>
                    setTempThresholds({ ...tempThresholds, [key]: Number(e.target.value) })
                  }
                  style={{
                    width: 72,
                    padding: "6px 10px",
                    borderRadius: 6,
                    border: editingThresholds
                      ? `1px solid oklch(0.35 0.04 220)`
                      : "1px solid oklch(0.20 0.03 220)",
                    background: editingThresholds
                      ? "oklch(0.08 0.015 220)"
                      : "oklch(0.06 0.01 220)",
                    color: color,
                    fontFamily: "var(--font-mono)",
                    fontSize: "0.82rem",
                    fontWeight: 600,
                    outline: "none",
                    transition: "border-color 0.12s ease",
                  }}
                />
                <span
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: "0.72rem",
                    color: "oklch(0.45 0.03 220)",
                  }}
                >
                  {unit}
                </span>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* About */}
      <section style={SECTION_STYLE}>
        <h2
          style={{
            fontFamily: "var(--font-display)",
            fontSize: "0.95rem",
            fontWeight: 700,
            color: "oklch(0.88 0.04 220)",
            marginBottom: 12,
            letterSpacing: "-0.01em",
          }}
        >
          About
        </h2>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "auto 1fr",
            gap: "6px 20px",
            fontFamily: "var(--font-mono)",
            fontSize: "0.72rem",
          }}
        >
          <span style={{ color: "oklch(0.50 0.03 220)" }}>Version</span>
          <span style={{ color: "oklch(0.78 0.18 205)" }}>{__APP_VERSION__}</span>
          <span style={{ color: "oklch(0.50 0.03 220)" }}>Runtime</span>
          <span style={{ color: "oklch(0.70 0.03 220)" }}>Tauri + React</span>
          <span style={{ color: "oklch(0.50 0.03 220)" }}>Backend</span>
          <span style={{ color: "oklch(0.70 0.03 220)" }}>Rust + Tokio</span>
          <span style={{ color: "oklch(0.50 0.03 220)" }}>AI</span>
          <span style={{ color: "oklch(0.70 0.03 220)" }}>Anthropic SDK</span>
          <span style={{ color: "oklch(0.50 0.03 220)" }}>License</span>
          <span style={{ color: "oklch(0.70 0.03 220)" }}>MIT</span>
        </div>
      </section>
    </div>
  );
}
