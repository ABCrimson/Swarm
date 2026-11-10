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
  readonly initialTool?: CustomToolDef | undefined;
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

const LABEL_TEXT = "block font-body text-[length:var(--text-sm)] font-semibold text-fg-muted";
const LABEL = `mb-1 ${LABEL_TEXT}`;
const ERROR_TEXT = "mt-1 block font-body text-[length:var(--text-xs)] text-rose";
/** Not a token: a rose between `--color-rose` and the border ramp. */
const INVALID_BORDER = "border-[oklch(0.55_0.14_10)]";
const TEXTAREA = "h-auto resize-y px-3 py-2 field-sizing-content";
const PANEL =
  "rounded-lg border border-border bg-[oklch(0.09_0.02_220/0.5)] [backdrop-filter:blur(12px)_saturate(1.5)]";

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
    <div className="grid h-full grid-cols-[1fr_1fr] gap-4 overflow-hidden">
      <form
        action={save}
        aria-label={initialTool ? `Edit ${initialTool.name}` : "New Tool"}
        className={`${PANEL} flex flex-col gap-4 overflow-auto p-4`}
      >
        <div>
          <label htmlFor={`${idPrefix}-name`} className={LABEL}>
            Tool Name
          </label>
          <Input
            id={`${idPrefix}-name`}
            placeholder="E.g. search_docs"
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-invalid={name !== "" && issues.name !== undefined}
            aria-describedby={name !== "" && issues.name ? nameErrorId : undefined}
            className={name !== "" && issues.name ? INVALID_BORDER : undefined}
          />
          {name !== "" && issues.name && (
            <span id={nameErrorId} className={ERROR_TEXT}>
              {issues.name}
            </span>
          )}
        </div>

        <div>
          <label htmlFor={`${idPrefix}-desc`} className={LABEL}>
            Description
          </label>
          <textarea
            id={`${idPrefix}-desc`}
            placeholder="What Does This Tool Do?"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className={`swarm-input ${TEXTAREA}`}
            rows={3}
          />
        </div>

        <fieldset aria-labelledby={`${idPrefix}-params`} className="m-0 min-w-0 border-none p-0">
          <div className="mb-2 flex items-center justify-between">
            <span id={`${idPrefix}-params`} className={LABEL_TEXT}>
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

          <div className="flex flex-col gap-2">
            {params.map((param, index) => {
              const error = issues.params.get(param.id);
              const errorId = `${idPrefix}-param-${param.id}-error`;
              const rowLabel = param.name || `Parameter ${index + 1}`;
              return (
                <div key={param.id} className="rounded-md border border-border bg-surface-1/50 p-2">
                  <div className="grid grid-cols-[1fr_auto_1fr_auto] items-center gap-1.5">
                    <Input
                      placeholder="Name"
                      aria-label={`Parameter ${index + 1} Name`}
                      value={param.name}
                      onChange={(e) => updateParam(param.id, { name: e.target.value })}
                      aria-invalid={error !== undefined}
                      aria-describedby={error ? errorId : undefined}
                      className={error ? `h-7 ${INVALID_BORDER}` : "h-7"}
                    />
                    <select
                      value={param.type}
                      onChange={(e) =>
                        updateParam(param.id, {
                          type: PARAM_TYPES.find((t) => t === e.target.value) ?? "string",
                        })
                      }
                      aria-label={`${rowLabel} Type`}
                      className="swarm-input h-7 w-auto cursor-pointer px-1.5 font-mono text-[length:var(--text-xs)]"
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
                      className="h-7"
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
                    <span id={errorId} className={ERROR_TEXT}>
                      {error}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </fieldset>

        <div className="flex-1">
          <label htmlFor={`${idPrefix}-script`} className={LABEL}>
            Execution Script
          </label>
          <textarea
            id={`${idPrefix}-script`}
            className={`swarm-input ${TEXTAREA} font-mono text-[length:var(--text-sm)] leading-[1.6]`}
            placeholder="// JavaScript That Runs In A Sandboxed Worker; `input` Holds The Arguments"
            value={script}
            onChange={(e) => setScript(e.target.value)}
            rows={8}
            spellCheck={false}
          />
        </div>

        <div className="flex justify-end gap-2">
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
        className={`${PANEL} flex flex-col overflow-hidden`}
      >
        <h2
          id={`${idPrefix}-preview`}
          className="m-0 border-b border-border px-4 py-2.5 font-display text-[length:var(--text-md)] font-semibold tracking-[-0.01em] text-fg-muted"
        >
          Anthropic Tool Preview
        </h2>
        <HighlightedJson
          data={customToolToAnthropic(draft)}
          className="flex-1 overflow-auto p-4 text-[0.75rem] leading-[1.6]"
        />
      </section>
    </div>
  );
}
