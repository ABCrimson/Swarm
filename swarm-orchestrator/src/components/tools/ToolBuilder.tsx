import { useState } from "react";
import type { CustomToolDef, ToolParam } from "#lib/custom-tools";
import type { HighlightToken } from "#lib/syntax-highlight";
import { tokenizeJson } from "#lib/syntax-highlight";

// Canonical shapes live in #lib/custom-tools (shared with the store and
// the AI request path); re-exported here for existing consumers.
export type { CustomToolDef, ToolParam } from "#lib/custom-tools";

/** Props for the tool builder form. */
interface ToolBuilderProps {
  /** Existing tool to edit, or undefined for a new tool. */
  readonly initialTool?: CustomToolDef;
  /** Callback on save. */
  readonly onSave: (tool: CustomToolDef) => void;
  /** Callback on cancel. */
  readonly onCancel: () => void;
}

const PARAM_TYPES = ["string", "number", "boolean", "object", "array"] as const;

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 12px",
  borderRadius: 8,
  border: "1px solid oklch(0.22 0.04 220)",
  background: "oklch(0.08 0.02 220)",
  color: "oklch(0.82 0.04 220)",
  fontFamily: "var(--font-body)",
  fontSize: "0.8125rem",
  outline: "none",
  transition: "border-color 0.15s ease",
};

const labelStyle: React.CSSProperties = {
  fontFamily: "var(--font-body)",
  fontSize: "0.75rem",
  fontWeight: 600,
  color: "oklch(0.65 0.04 220)",
  marginBottom: 4,
  display: "block",
};

/**
 * Form for creating or editing a custom tool definition.
 *
 * Includes name, description, parameter builder (add/remove params with
 * name, type dropdown, description), execution script textarea, and a
 * live preview panel showing the generated Anthropic tool JSON.
 */
export function ToolBuilder({
  initialTool,
  onSave,
  onCancel,
}: ToolBuilderProps): React.ReactElement {
  const [name, setName] = useState(initialTool?.name ?? "");
  const [description, setDescription] = useState(initialTool?.description ?? "");
  const [params, setParams] = useState<ToolParam[]>(() => [...(initialTool?.params ?? [])]);
  const [script, setScript] = useState(initialTool?.script ?? "// Tool execution script\n");

  // Add parameter
  const handleAddParam = () => {
    setParams((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        name: "",
        type: "string",
        description: "",
      },
    ]);
  };

  // Remove parameter
  const handleRemoveParam = (id: string) => {
    setParams((prev) => prev.filter((p) => p.id !== id));
  };

  // Update parameter field
  const handleParamChange = (id: string, field: keyof Omit<ToolParam, "id">, value: string) => {
    setParams((prev) => prev.map((p) => (p.id === id ? { ...p, [field]: value } : p)));
  };

  // Generate Anthropic tool JSON preview
  const previewJson = (() => {
    const properties: Record<string, { type: string; description: string }> = {};
    const required: string[] = [];

    for (const param of params) {
      if (param.name) {
        properties[param.name] = {
          type: param.type,
          description: param.description,
        };
        required.push(param.name);
      }
    }

    const tool = {
      name: name || "unnamed_tool",
      description: description || "No description",
      input_schema: {
        type: "object",
        properties,
        required,
      },
    };

    return JSON.stringify(tool, null, 2);
  })();

  const previewTokens = tokenizeJson(previewJson);

  // Save handler
  const handleSave = () => {
    const tool: CustomToolDef = {
      id: initialTool?.id ?? crypto.randomUUID(),
      name,
      description,
      params,
      script,
    };
    onSave(tool);
  };

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
      {/* Form */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 16,
          overflow: "auto",
          padding: "16px",
          background: "oklch(0.09 0.02 220 / 0.5)",
          backdropFilter: "blur(12px) saturate(1.5)",
          border: "1px solid oklch(0.22 0.04 220)",
          borderRadius: 12,
        }}
      >
        {/* Name */}
        <div>
          <label htmlFor="tool-name" style={labelStyle}>
            Tool Name
          </label>
          <input
            id="tool-name"
            type="text"
            placeholder="E.g. search_docs"
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={inputStyle}
          />
        </div>

        {/* Description */}
        <div>
          <label htmlFor="tool-desc" style={labelStyle}>
            Description
          </label>
          <textarea
            id="tool-desc"
            placeholder="What Does This Tool Do?"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            style={{
              ...inputStyle,
              resize: "vertical",
              fontFamily: "var(--font-body)",
            }}
          />
        </div>

        {/* Parameters */}
        <div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 8,
            }}
          >
            <span style={labelStyle}>Parameters</span>
            <button
              type="button"
              onClick={handleAddParam}
              style={{
                padding: "3px 10px",
                borderRadius: 6,
                border: "1px solid oklch(0.78 0.18 205 / 0.4)",
                background: "oklch(0.78 0.18 205 / 0.1)",
                color: "oklch(0.78 0.18 205)",
                fontFamily: "var(--font-body)",
                fontSize: "0.6875rem",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              + Add
            </button>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {params.map((param) => (
              <div
                key={param.id}
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr auto 1fr auto",
                  gap: 6,
                  alignItems: "center",
                  padding: 8,
                  borderRadius: 8,
                  background: "oklch(0.10 0.03 220 / 0.5)",
                  border: "1px solid oklch(0.18 0.04 220)",
                }}
              >
                <input
                  type="text"
                  placeholder="Name"
                  value={param.name}
                  onChange={(e) => handleParamChange(param.id, "name", e.target.value)}
                  style={{
                    ...inputStyle,
                    padding: "4px 8px",
                    fontSize: "0.75rem",
                  }}
                />

                <select
                  value={param.type}
                  onChange={(e) => handleParamChange(param.id, "type", e.target.value)}
                  aria-label="Parameter Type"
                  style={{
                    padding: "4px 6px",
                    borderRadius: 6,
                    border: "1px solid oklch(0.22 0.04 220)",
                    background: "oklch(0.10 0.03 220)",
                    color: "oklch(0.72 0.04 220)",
                    fontFamily: "var(--font-mono)",
                    fontSize: "0.6875rem",
                    cursor: "pointer",
                    outline: "none",
                  }}
                >
                  {PARAM_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>

                <input
                  type="text"
                  placeholder="Description"
                  value={param.description}
                  onChange={(e) => handleParamChange(param.id, "description", e.target.value)}
                  style={{
                    ...inputStyle,
                    padding: "4px 8px",
                    fontSize: "0.75rem",
                  }}
                />

                <button
                  type="button"
                  onClick={() => handleRemoveParam(param.id)}
                  aria-label="Remove Parameter"
                  style={{
                    width: 24,
                    height: 24,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    borderRadius: 4,
                    border: "none",
                    background: "oklch(0 0 0 / 0)",
                    color: "oklch(0.72 0.20 10)",
                    cursor: "pointer",
                    fontSize: "0.75rem",
                  }}
                >
                  <svg width={12} height={12} viewBox="0 0 12 12" fill="none" aria-hidden="true">
                    <path
                      d="M2 2l8 8M10 2l-8 8"
                      stroke="currentColor"
                      strokeWidth={1.5}
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        </div>

        {/* Script */}
        <div style={{ flex: 1 }}>
          <label htmlFor="tool-script" style={labelStyle}>
            Execution Script
          </label>
          <textarea
            id="tool-script"
            placeholder="// JavaScript code that runs in a sandboxed context"
            value={script}
            onChange={(e) => setScript(e.target.value)}
            rows={8}
            style={{
              ...inputStyle,
              resize: "vertical",
              fontFamily: "var(--font-mono)",
              fontSize: "0.75rem",
              lineHeight: 1.6,
            }}
          />
        </div>

        {/* Actions */}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button
            type="button"
            onClick={onCancel}
            style={{
              padding: "8px 20px",
              borderRadius: 8,
              border: "1px solid oklch(0.22 0.04 220)",
              background: "oklch(0 0 0 / 0)",
              color: "oklch(0.65 0.04 220)",
              fontFamily: "var(--font-body)",
              fontSize: "0.8125rem",
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!name.trim()}
            style={{
              padding: "8px 20px",
              borderRadius: 8,
              border: "1px solid oklch(0.78 0.18 205 / 0.4)",
              background: "oklch(0.78 0.18 205 / 0.15)",
              color: "oklch(0.78 0.18 205)",
              fontFamily: "var(--font-body)",
              fontSize: "0.8125rem",
              fontWeight: 600,
              cursor: name.trim() ? "pointer" : "not-allowed",
              opacity: name.trim() ? 1 : 0.5,
            }}
          >
            Save Tool
          </button>
        </div>
      </div>

      {/* Preview panel */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          background: "oklch(0.09 0.02 220 / 0.5)",
          backdropFilter: "blur(12px) saturate(1.5)",
          border: "1px solid oklch(0.22 0.04 220)",
          borderRadius: 12,
        }}
      >
        <div
          style={{
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
        </div>
        <pre
          style={{
            flex: 1,
            overflow: "auto",
            padding: 16,
            margin: 0,
            fontFamily: "var(--font-mono)",
            fontSize: "0.75rem",
            lineHeight: 1.6,
          }}
        >
          <PreviewTokens tokens={previewTokens} />
        </pre>
      </div>
    </div>
  );
}

/**
 * Renders syntax-highlighted tokens as colored spans.
 * Tokens are static preview output — order is stable and never reordered,
 * so index keys are acceptable here.
 */
function PreviewTokens({ tokens }: { readonly tokens: HighlightToken[] }): React.ReactElement {
  return (
    <>
      {tokens.map((token, i) => (
        <span key={`tk-${String(i)}`} style={{ color: token.color }}>
          {token.value}
        </span>
      ))}
    </>
  );
}
