import type { CSSProperties } from "react";
import { useId, useState } from "react";
import { HighlightedJson } from "#components/ai/HighlightedJson";
import { Button } from "#components/ui/Button";
import { Input } from "#components/ui/Input";
import {
  type CustomToolDef,
  customToolIssues,
  customToolToAnthropic,
  hasNoIssues,
  PARAM_TYPES,
  type ToolParam,
} from "#lib/custom-tools";

/** Props for the tool builder form. */
interface ToolBuilderProps {
  /** Existing tool to edit, or undefined for a new tool. */
  readonly initialTool?: CustomToolDef;
  /**
   * Names this tool may not take: every built-in tool plus every other
   * custom tool. A taken name would be saved but silently never offered
   * to the model (the runtime keeps the first owner of a name).
   */
  readonly takenNames: ReadonlySet<string>;
  /** Callback on save. */
  readonly onSave: (tool: CustomToolDef) => void;
  /** Callback on cancel. */
  readonly onCancel: () => void;
}

const labelStyle: CSSProperties = {
  fontFamily: "var(--font-body)",
  fontSize: "0.75rem",
  fontWeight: 600,
  color: "oklch(0.65 0.04 220)",
  marginBottom: 4,
  display: "block",
};

const errorTextStyle: CSSProperties = {
  display: "block",
  marginTop: 4,
  fontFamily: "var(--font-body)",
  fontSize: "0.6875rem",
  color: "oklch(0.72 0.20 10)",
};

const invalidBorder: CSSProperties = { borderColor: "oklch(0.55 0.14 10)" };

const textareaStyle: CSSProperties = {
  height: "auto",
  padding: "8px 12px",
  resize: "vertical",
  fieldSizing: "content",
};

const panelStyle: CSSProperties = {
  background: "oklch(0.09 0.02 220 / 0.5)",
  backdropFilter: "blur(12px) saturate(1.5)",
  border: "1px solid oklch(0.22 0.04 220)",
  borderRadius: 12,
};

/**
 * Form for creating or editing a custom tool definition: name,
 * description, a parameter builder (name, JSON type, description per
 * row), the execution script, and a live preview of the exact Anthropic
 * tool JSON `customToolToAnthropic` will send.
 *
 * Save stays disabled while the name or any named parameter would be
 * rejected by the API or shadowed by another tool; each problem is shown
 * inline next to its field (`aria-invalid` + `aria-describedby`).
 */
export function ToolBuilder({
  initialTool,
  takenNames,
  onSave,
  onCancel,
}: ToolBuilderProps): React.ReactElement {
  const [name, setName] = useState(initialTool?.name ?? "");
  const [description, setDescription] = useState(initialTool?.description ?? "");
  const [params, setParams] = useState<readonly ToolParam[]>(initialTool?.params ?? []);
  const [script, setScript] = useState(initialTool?.script ?? "// Tool execution script\n");
  const idPrefix = useId();

  const draft: CustomToolDef = {
    id: initialTool?.id ?? "",
    name,
    description,
    params,
    script,
  };
  const issues = customToolIssues(draft, takenNames);
  const canSave = hasNoIssues(issues);

  const updateParam = (id: string, patch: Partial<Omit<ToolParam, "id">>) => {
    setParams((prev) => prev.map((param) => (param.id === id ? { ...param, ...patch } : param)));
  };

  const save = () => {
    if (!canSave) return;
    onSave({ ...draft, id: initialTool?.id ?? crypto.randomUUID() });
  };

  const nameErrorId = `${idPrefix}-name-error`;

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: 16,
        height: "100%",
        overflow: "hidden",
      }}
    >
      <form
        action={save}
        aria-label={initialTool ? `Edit ${initialTool.name}` : "New Tool"}
        style={{
          ...panelStyle,
          display: "flex",
          flexDirection: "column",
          gap: 16,
          overflow: "auto",
          padding: 16,
        }}
      >
        <div>
          <label htmlFor={`${idPrefix}-name`} style={labelStyle}>
            Tool Name
          </label>
          <Input
            id={`${idPrefix}-name`}
            placeholder="E.g. search_docs"
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-invalid={name !== "" && issues.name !== undefined}
            aria-describedby={name !== "" && issues.name ? nameErrorId : undefined}
            style={name !== "" && issues.name ? invalidBorder : undefined}
          />
          {name !== "" && issues.name && (
            <span id={nameErrorId} style={errorTextStyle}>
              {issues.name}
            </span>
          )}
        </div>

        <div>
          <label htmlFor={`${idPrefix}-desc`} style={labelStyle}>
            Description
          </label>
          <textarea
            id={`${idPrefix}-desc`}
            className="swarm-input"
            placeholder="What Does This Tool Do?"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            style={textareaStyle}
          />
        </div>

        <fieldset
          aria-labelledby={`${idPrefix}-params`}
          style={{ border: "none", margin: 0, padding: 0, minWidth: 0 }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 8,
            }}
          >
            <span id={`${idPrefix}-params`} style={{ ...labelStyle, marginBottom: 0 }}>
              Parameters
            </span>
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                setParams((prev) => [
                  ...prev,
                  { id: crypto.randomUUID(), name: "", type: "string", description: "" },
                ])
              }
            >
              + Add Parameter
            </Button>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {params.map((param, index) => {
              const error = issues.params.get(param.id);
              const errorId = `${idPrefix}-param-${param.id}-error`;
              const rowLabel = param.name || `Parameter ${index + 1}`;
              return (
                <div
                  key={param.id}
                  style={{
                    padding: 8,
                    borderRadius: 8,
                    background: "oklch(0.10 0.03 220 / 0.5)",
                    border: "1px solid oklch(0.18 0.04 220)",
                  }}
                >
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1fr auto 1fr auto",
                      gap: 6,
                      alignItems: "center",
                    }}
                  >
                    <Input
                      placeholder="Name"
                      aria-label={`Parameter ${index + 1} Name`}
                      value={param.name}
                      onChange={(e) => updateParam(param.id, { name: e.target.value })}
                      aria-invalid={error !== undefined}
                      aria-describedby={error ? errorId : undefined}
                      style={{ height: 28, ...(error ? invalidBorder : undefined) }}
                    />
                    <select
                      value={param.type}
                      onChange={(e) =>
                        updateParam(param.id, {
                          type: PARAM_TYPES.find((t) => t === e.target.value) ?? "string",
                        })
                      }
                      aria-label={`${rowLabel} Type`}
                      className="swarm-input"
                      style={{
                        height: 28,
                        width: "auto",
                        padding: "0 6px",
                        fontFamily: "var(--font-mono)",
                        fontSize: "0.6875rem",
                        cursor: "pointer",
                      }}
                    >
                      {PARAM_TYPES.map((type) => (
                        <option key={type} value={type}>
                          {type}
                        </option>
                      ))}
                    </select>
                    <Input
                      placeholder="Description"
                      aria-label={`${rowLabel} Description`}
                      value={param.description}
                      onChange={(e) => updateParam(param.id, { description: e.target.value })}
                      style={{ height: 28 }}
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setParams((prev) => prev.filter((p) => p.id !== param.id))}
                      aria-label={`Remove ${rowLabel}`}
                    >
                      <svg
                        width={12}
                        height={12}
                        viewBox="0 0 12 12"
                        fill="none"
                        aria-hidden="true"
                      >
                        <path
                          d="M2 2l8 8M10 2l-8 8"
                          stroke="currentColor"
                          strokeWidth={1.5}
                          strokeLinecap="round"
                        />
                      </svg>
                    </Button>
                  </div>
                  {error && (
                    <span id={errorId} style={errorTextStyle}>
                      {error}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </fieldset>

        <div style={{ flex: 1 }}>
          <label htmlFor={`${idPrefix}-script`} style={labelStyle}>
            Execution Script
          </label>
          <textarea
            id={`${idPrefix}-script`}
            className="swarm-input"
            placeholder="// JavaScript That Runs In A Sandboxed Worker; `input` Holds The Arguments"
            value={script}
            onChange={(e) => setScript(e.target.value)}
            rows={8}
            spellCheck={false}
            style={{
              ...textareaStyle,
              fontFamily: "var(--font-mono)",
              fontSize: "0.75rem",
              lineHeight: 1.6,
            }}
          />
        </div>

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!canSave}>
            Save Tool
          </Button>
        </div>
      </form>

      <section
        aria-labelledby={`${idPrefix}-preview`}
        style={{ ...panelStyle, display: "flex", flexDirection: "column", overflow: "hidden" }}
      >
        <h2
          id={`${idPrefix}-preview`}
          style={{
            margin: 0,
            padding: "10px 16px",
            borderBottom: "1px solid oklch(0.22 0.04 220)",
            fontFamily: "var(--font-display)",
            fontSize: "0.75rem",
            fontWeight: 700,
            letterSpacing: "0.04em",
            color: "oklch(0.65 0.04 220)",
            textTransform: "uppercase",
          }}
        >
          Anthropic Tool Preview
        </h2>
        <HighlightedJson
          data={customToolToAnthropic(draft)}
          style={{ flex: 1, overflow: "auto", padding: 16, fontSize: "0.75rem", lineHeight: 1.6 }}
        />
      </section>
    </div>
  );
}
