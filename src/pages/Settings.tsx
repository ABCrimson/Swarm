import { useAtom, useAtomValue } from "jotai";
import {
  useEffect,
  useEffectEvent,
  useId,
  useOptimistic,
  useRef,
  useState,
  useTransition,
} from "react";
import { flushSync } from "react-dom";
import { toast } from "sonner";
import * as z from "zod";
import { Button } from "#components/ui/Button";
import { Input } from "#components/ui/Input";
import { Pill } from "#components/ui/Pill";
import { type AlertThresholds, alertThresholdsAtom } from "#lib/alerts";
import { ANTHROPIC_API_KEY_CONFIG_KEY } from "#lib/anthropic-config";
import { errorMessage } from "#lib/is-error";
import { bindingFromEvent, formatBinding, type Keybindings } from "#lib/keybindings";
import {
  CLAUDE_MODELS,
  formatContextLabel,
  formatMaxOutputLabel,
  type ModelKey,
  warnIfModelGated,
} from "#lib/models";
import {
  checkForUpdates,
  DESKTOP_ONLY_REASON,
  hasCapability,
  readConfig,
  setMaxWorkers,
  writeConfig,
} from "#lib/tauri";
import {
  AI_CONCURRENT_LIMIT_MAX,
  AI_CONCURRENT_LIMIT_MIN,
  type AppSettings,
  agentConcurrencySyncAtom,
  appSettingsAtom,
  keybindingsAtom,
  selectedModelAtom,
  themeAtom,
} from "#store/ui";

/** Worker registry cap shown until the persisted value loads (the backend default). */
const DEFAULT_MAX_WORKERS = 64;

/**
 * Parses typed numeric input and clamps it to `[min, max]`. Blank or
 * non-numeric input keeps `fallback`: `Number("")` is 0, which must never
 * be committed as if the user had typed it.
 */
export function clampNumberInput(raw: string, min: number, max: number, fallback: number): number {
  const n = raw.trim() === "" ? Number.NaN : Number(raw);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

type ThresholdKey = keyof AlertThresholds;

/** An unusable pair of alert thresholds: what is wrong, and which fields. */
export interface ThresholdsProblem {
  readonly message: string;
  /** The fields to mark invalid (the offending warning/critical pair). */
  readonly keys: ReadonlySet<ThresholdKey>;
}

/**
 * The first warning/critical pair whose warning level is not below its
 * critical level, or `null` when every pair is valid.
 */
export function thresholdsError(thresholds: AlertThresholds): ThresholdsProblem | null {
  if (thresholds.cpuWarning >= thresholds.cpuCritical) {
    return {
      message: "CPU Warning Must Be Below CPU Critical",
      keys: new Set(["cpuWarning", "cpuCritical"]),
    };
  }
  if (thresholds.memoryWarning >= thresholds.memoryCritical) {
    return {
      message: "Memory Warning Must Be Below Memory Critical",
      keys: new Set(["memoryWarning", "memoryCritical"]),
    };
  }
  return null;
}

// ── Layout primitives ────────────────────────────────

function SettingsSection({
  title,
  action,
  children,
}: {
  readonly title: string;
  /** Controls shown next to the heading. */
  readonly action?: React.ReactNode;
  readonly children: React.ReactNode;
}): React.ReactElement {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      className="rounded-lg border border-border bg-surface-1 px-7 py-6"
    >
      <div className="mb-3 flex items-center justify-between gap-4">
        <h2 id={headingId} className="font-display text-lg font-bold tracking-tight text-fg-bright">
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

/**
 * One setting: its name and description on the left, the control on the
 * right. The description is a block paragraph the control references via
 * `aria-describedby` (`${id}-description`), so it is announced as the
 * description, not merged into the control's name. `feedback` is a
 * state message (applying, failed, unavailable) shown under the
 * description.
 */
function SettingRow({
  id,
  label,
  description,
  controlId,
  feedback,
  children,
}: {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly feedback?: React.ReactNode;
  /** The labelled control's id; without it the name is plain text (the control names itself). */
  readonly controlId?: string;
  readonly children: React.ReactNode;
}): React.ReactElement {
  const labelClass = "block text-md font-medium text-fg";
  return (
    <div className="flex items-start justify-between gap-4 py-2.5">
      <div>
        {controlId ? (
          <label id={`${id}-label`} htmlFor={controlId} className={labelClass}>
            {label}
          </label>
        ) : (
          <span id={`${id}-label`} className={labelClass}>
            {label}
          </span>
        )}
        {description && (
          <p id={`${id}-description`} className="mt-1 text-xs text-fg-dim">
            {description}
          </p>
        )}
        {feedback !== undefined && <div id={`${id}-feedback`}>{feedback}</div>}
      </div>
      <div className="mt-0.5 flex shrink-0 items-center gap-1.5">{children}</div>
    </div>
  );
}

// ── Controls ─────────────────────────────────────────

function Toggle({
  checked,
  onChange,
  label,
  description,
  unavailableReason,
}: {
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly label: string;
  readonly description?: string;
  /** Why the switch cannot be used in this build; when set it is disabled and the reason describes it. */
  readonly unavailableReason?: string;
}): React.ReactElement {
  const id = useId();
  const describedBy =
    [description && `${id}-description`, unavailableReason && `${id}-feedback`]
      .filter(Boolean)
      .join(" ") || undefined;
  return (
    <SettingRow
      id={id}
      label={label}
      description={description}
      controlId={`${id}-switch`}
      feedback={
        unavailableReason === undefined ? undefined : (
          <p className="mt-1 text-xs text-fg-dim">{unavailableReason}</p>
        )
      }
    >
      <button
        id={`${id}-switch`}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={`${id}-label`}
        aria-describedby={describedBy}
        disabled={unavailableReason !== undefined}
        onClick={() => onChange(!checked)}
        className="group relative h-6 w-11 cursor-pointer rounded-full disabled:cursor-not-allowed disabled:opacity-50 border border-border-control bg-surface-3 transition-colors aria-checked:border-plasma aria-checked:bg-plasma"
      >
        <span
          aria-hidden="true"
          className="absolute top-0.5 left-0.5 size-4.5 rounded-full bg-fg-dim shadow-sm transition-[translate,background-color] group-aria-checked:translate-x-5 group-aria-checked:bg-void forced-colors:bg-[CanvasText]"
        />
      </button>
    </SettingRow>
  );
}

/**
 * Numeric setting with a unit.
 *
 * Edits are staged in a local draft and committed only on blur or Enter,
 * clamped to [min, max] (blank input restores the current value). Never
 * commits per keystroke: several consumers apply values destructively the
 * moment they change (log retention trims entries, the history cap evicts
 * workers), so a half-typed "1" on the way to "1000" must never reach them.
 */
function NumberField({
  label,
  description,
  unit,
  min,
  max,
  value,
  onChange,
  busy = false,
  feedback,
}: {
  readonly label: string;
  readonly description: string;
  readonly unit: string;
  readonly min: number;
  readonly max: number;
  readonly value: number;
  readonly onChange: (value: number) => void;
  /** Marks the field busy while a change is being applied. */
  readonly busy?: boolean;
  /** A state message shown under the description and announced with it. */
  readonly feedback?: React.ReactNode;
}): React.ReactElement {
  const id = useId();
  /** The text being typed; `null` while the field shows `value`. */
  const [draft, setDraft] = useState<string | null>(null);

  const commit = (raw: string): void => {
    setDraft(null);
    const next = clampNumberInput(raw, min, max, value);
    if (next !== value) onChange(next);
  };

  return (
    <SettingRow
      id={id}
      label={label}
      description={description}
      controlId={`${id}-input`}
      feedback={feedback}
    >
      <Input
        id={`${id}-input`}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        aria-describedby={
          feedback === undefined ? `${id}-description` : `${id}-description ${id}-feedback`
        }
        aria-busy={busy || undefined}
        value={draft ?? String(value)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit(e.currentTarget.value);
          }
        }}
        className="h-8 w-22 font-mono"
      />
      <span className="min-w-13 font-mono text-xs text-fg-dim">{unit}</span>
    </SettingRow>
  );
}

/**
 * Keybinding capture row: click the chip, press the new combination
 * (must include a modifier or be a function key), Escape cancels.
 * `onChange` returns whether the binding was accepted (the parent
 * rejects duplicates with its own toast).
 */
function KeybindingField({
  label,
  description,
  value,
  onChange,
}: {
  readonly label: string;
  readonly description: string;
  readonly value: string;
  readonly onChange: (binding: string) => boolean;
}): React.ReactElement {
  const id = useId();
  const [listening, setListening] = useState(false);

  const onCaptured = useEffectEvent((binding: string): void => {
    if (onChange(binding)) toast.success(`${label} Bound To ${formatBinding(binding)}`);
  });

  useEffect(() => {
    if (!listening) return;

    const handleKeyDown = (e: KeyboardEvent): void => {
      // Plain Tab / Shift+Tab can never be a binding (bindingFromEvent needs
      // Ctrl, Alt or Meta), so let it move focus; onBlur ends listening.
      if (e.key === "Tab" && !e.ctrlKey && !e.metaKey && !e.altKey) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setListening(false);
        return;
      }
      const binding = bindingFromEvent(e);
      if (binding) {
        setListening(false);
        onCaptured(binding);
      }
    };

    // Capture phase so the app's own shortcut listeners never see the
    // keystroke being assigned.
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [listening]);

  return (
    <SettingRow id={id} label={label} description={description}>
      <button
        type="button"
        onClick={() => setListening(true)}
        onBlur={() => setListening(false)}
        aria-label={`Change Shortcut For ${label}`}
        aria-describedby={`${id}-binding ${id}-description`}
        data-listening={listening || undefined}
        className="min-w-32.5 cursor-pointer rounded-md border border-plasma/30 bg-plasma/10 px-3.5 py-1.25 font-mono text-sm font-semibold text-plasma transition-colors hover:bg-plasma/15 data-listening:border-amber data-listening:bg-amber/15 data-listening:text-amber"
      >
        <span id={`${id}-binding`}>{listening ? "Press Keys…" : formatBinding(value)}</span>
      </button>
      <span role="status" className="sr-only">
        {listening ? `Press The New Shortcut For ${label}, Escape Cancels` : ""}
      </span>
    </SettingRow>
  );
}

/**
 * The model catalog as a native radio group (one choice): arrow keys move
 * the selection, and each card is a `<label>` styled from its radio's
 * state with `:has()`. The radio is named by the model name alone; the
 * description and limits are its description.
 */
function ModelPicker({ labelledBy }: { readonly labelledBy: string }): React.ReactElement {
  const id = useId();
  const [selectedModel, setSelectedModel] = useAtom(selectedModelAtom);
  const models = Object.entries(CLAUDE_MODELS) as Array<
    [ModelKey, (typeof CLAUDE_MODELS)[ModelKey]]
  >;

  return (
    <div role="radiogroup" aria-labelledby={labelledBy} className="flex flex-wrap gap-3">
      {models.map(([key, model]) => {
        const cardId = `${id}-${key}`;
        return (
          <label
            key={key}
            data-model-id={model.id}
            className="group flex flex-1 cursor-pointer flex-col gap-1.5 rounded-[10px] border border-border bg-surface-0 px-4.5 py-3.5 transition-colors hover:border-border-3 has-checked:border-plasma has-checked:bg-plasma/8 has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-plasma forced-colors:has-checked:outline-2 forced-colors:has-checked:outline-[Highlight]"
          >
            <input
              type="radio"
              name={`${id}-model`}
              value={key}
              checked={selectedModel === key}
              onChange={() => {
                setSelectedModel(key);
                // A gated model gets its warning toast instead of the plain
                // "switched" toast — one toast per selection (see #lib/models).
                if (!warnIfModelGated(model)) toast.success(`Switched To ${model.label}`);
              }}
              aria-labelledby={`${cardId}-name`}
              aria-describedby={`${cardId}-description ${cardId}-limits`}
              className="sr-only"
            />
            <span className="flex flex-wrap items-center gap-2">
              <span
                aria-hidden="true"
                className="size-2 shrink-0 rounded-full bg-border-2 transition-colors group-has-checked:bg-plasma"
              />
              <span
                id={`${cardId}-name`}
                className="font-display text-md font-bold tracking-tight text-fg-muted group-has-checked:text-fg-bright"
              >
                {model.label}
              </span>
              {model.gated !== undefined && (
                <Pill tone="warning" size="sm">
                  Requires Project Glasswing
                </Pill>
              )}
            </span>
            <span id={`${cardId}-description`} className="text-xs text-fg-dim">
              {model.description}
            </span>
            <Pill id={`${cardId}-limits`} tone="neutral" size="sm" className="self-start">
              {`${formatContextLabel(model.contextWindow)} · ${formatMaxOutputLabel(model.maxOutputTokens)}`}
            </Pill>
          </label>
        );
      })}
    </div>
  );
}

const THRESHOLD_FIELDS: ReadonlyArray<{
  readonly key: ThresholdKey;
  readonly label: string;
  readonly tone: "warning" | "critical";
}> = [
  { key: "cpuWarning", label: "CPU Warning", tone: "warning" },
  { key: "cpuCritical", label: "CPU Critical", tone: "critical" },
  { key: "memoryWarning", label: "Memory Warning", tone: "warning" },
  { key: "memoryCritical", label: "Memory Critical", tone: "critical" },
];

/**
 * The four alert thresholds, edited as a form: Edit stages drafts, each
 * field is clamped to 0–100 when it loses focus (blank restores the saved
 * value), and Save refuses a warning level at or above its critical level
 * (that would silently disable the warning tier).
 */
function AlertThresholdsSection({
  children,
}: {
  readonly children: React.ReactNode;
}): React.ReactElement {
  const id = useId();
  const [thresholds, setThresholds] = useAtom(alertThresholdsAtom);
  /** Typed values while editing; `null` when not editing. */
  const [draft, setDraft] = useState<Record<ThresholdKey, string> | null>(null);
  const [error, setError] = useState<ThresholdsProblem | null>(null);
  const editing = draft !== null;
  const errorId = `${id}-error`;
  const firstFieldRef = useRef<HTMLInputElement>(null);
  const editButtonRef = useRef<HTMLButtonElement>(null);

  const parsed = (values: Record<ThresholdKey, string>): AlertThresholds => ({
    cpuWarning: clampNumberInput(values.cpuWarning, 0, 100, thresholds.cpuWarning),
    cpuCritical: clampNumberInput(values.cpuCritical, 0, 100, thresholds.cpuCritical),
    memoryWarning: clampNumberInput(values.memoryWarning, 0, 100, thresholds.memoryWarning),
    memoryCritical: clampNumberInput(values.memoryCritical, 0, 100, thresholds.memoryCritical),
  });

  // The Edit and Cancel/Save buttons swap places, so the activated button
  // unmounts: commit synchronously, then move focus to the control that
  // replaced it instead of letting it fall to <body>.
  const startEditing = (): void => {
    flushSync(() => {
      setError(null);
      setDraft({
        cpuWarning: String(thresholds.cpuWarning),
        cpuCritical: String(thresholds.cpuCritical),
        memoryWarning: String(thresholds.memoryWarning),
        memoryCritical: String(thresholds.memoryCritical),
      });
    });
    firstFieldRef.current?.focus();
  };

  const stopEditing = (): void => {
    flushSync(() => {
      setDraft(null);
      setError(null);
    });
    editButtonRef.current?.focus();
  };

  const save = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!draft) return;
    const next = parsed(draft);
    const problem = thresholdsError(next);
    if (problem) {
      setError(problem);
      toast.error(problem.message);
      return;
    }
    setThresholds(next);
    stopEditing();
    toast.success("Alert Thresholds Updated");
  };

  return (
    <form onSubmit={save} noValidate>
      <SettingsSection
        title="Alert Thresholds"
        action={
          editing ? (
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" onClick={stopEditing}>
                Cancel
              </Button>
              <Button type="submit" size="sm">
                Save Thresholds
              </Button>
            </div>
          ) : (
            <Button ref={editButtonRef} variant="secondary" size="sm" onClick={startEditing}>
              Edit Thresholds
            </Button>
          )
        }
      >
        <div className="grid grid-cols-2 gap-x-6 gap-y-3">
          {THRESHOLD_FIELDS.map(({ key, label, tone }, index) => {
            const invalid = editing && error?.keys.has(key) === true;
            return (
              <div key={key}>
                <label
                  htmlFor={`${id}-${key}`}
                  className="mb-1.5 block text-sm font-medium text-fg"
                >
                  {label}
                </label>
                <div className="flex items-center gap-1.5">
                  <Input
                    id={`${id}-${key}`}
                    ref={index === 0 ? firstFieldRef : undefined}
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={100}
                    value={draft?.[key] ?? String(thresholds[key])}
                    disabled={!editing}
                    aria-invalid={invalid || undefined}
                    aria-describedby={invalid ? errorId : undefined}
                    onChange={(e) => {
                      const value = e.target.value;
                      setDraft((prev) => (prev ? { ...prev, [key]: value } : prev));
                    }}
                    onBlur={(e) => {
                      const value = String(
                        clampNumberInput(e.target.value, 0, 100, thresholds[key]),
                      );
                      setDraft((prev) => (prev ? { ...prev, [key]: value } : prev));
                    }}
                    data-tone={tone}
                    className="h-8 w-18 font-mono font-semibold data-[tone=critical]:text-rose data-[tone=warning]:text-amber aria-invalid:border-rose"
                  />
                  <span className="font-mono text-xs text-fg-dim">%</span>
                </div>
              </div>
            );
          })}
        </div>
        {error && editing && (
          <p id={errorId} role="alert" className="mt-3 text-sm text-rose">
            {error.message}
          </p>
        )}
        <div className="mt-4 divide-y divide-border border-t border-border">{children}</div>
      </SettingsSection>
    </form>
  );
}

// ── Page ─────────────────────────────────────────────

/** Settings page for application configuration and preferences. */
export function Settings(): React.ReactElement {
  const modelHeadingId = useId();
  const [theme, setTheme] = useAtom(themeAtom);
  const [appSettings, setAppSettings] = useAtom(appSettingsAtom);
  const agentConcurrencySync = useAtomValue(agentConcurrencySyncAtom);
  const canCheckForUpdates = hasCapability("autoUpdate");
  // Only the webview-direct Anthropic client reads the API key, and a swarmd
  // page is denied secret-shaped config keys, so there it can be neither read nor saved.
  const canUseWebviewChat = hasCapability("localAiChat");
  const apiKeyReasonId = useId();
  const updatesReasonId = useId();
  const [keybindings, setKeybindings] = useAtom(keybindingsAtom);
  const [checkingUpdates, startUpdateCheck] = useTransition();
  const [savingApiKey, startSavingApiKey] = useTransition();
  const [, startMaxWorkersUpdate] = useTransition();

  const patchSettings = (patch: Partial<AppSettings>): void =>
    setAppSettings((prev) => ({ ...prev, ...patch }));

  const patchKeybinding = (key: keyof Keybindings, binding: string): boolean => {
    const taken = Object.entries(keybindings).some(
      ([other, existing]) => other !== key && existing === binding,
    );
    if (taken) {
      toast.error(`${formatBinding(binding)} Is Already Assigned To Another Shortcut`);
      return false;
    }
    setKeybindings((prev) => ({ ...prev, [key]: binding }));
    return true;
  };

  const handleCheckForUpdates = (): void =>
    startUpdateCheck(async () => {
      try {
        const result = await checkForUpdates();
        if (result.available) {
          toast.info(`Update Available: Version ${result.version ?? "Unknown"}`);
        } else {
          toast.success("You Are On The Latest Version");
        }
      } catch (err) {
        toast.error("Update Check Failed", { description: errorMessage(err) });
      }
    });

  // The bridge (#hooks/useSettingsBridge) pushes the cap to the backend and
  // rolls the field back when the push fails; Retry re-applies the request.
  const agentConcurrencyFeedback =
    agentConcurrencySync.status === "pending" ? (
      <p role="status" className="mt-1 text-xs text-fg-dim">
        Applying…
      </p>
    ) : agentConcurrencySync.status === "failed" ? (
      <div role="alert" className="mt-1 flex items-center gap-2 text-xs text-rose">
        <span>{`Could Not Apply ${agentConcurrencySync.requested} Streams — ${agentConcurrencySync.message}`}</span>
        <Button variant="ghost" size="sm" onClick={agentConcurrencySync.retry}>
          Retry
        </Button>
      </div>
    ) : undefined;

  // ── API key (read on mount, written on Save via #lib/tauri) ──
  // The key itself is never logged, traced, or included in a toast; a failed
  // save shows the backend's error text, which never contains the value.
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [apiKeySaved, setApiKeySaved] = useState("");

  useEffect(() => {
    if (!canUseWebviewChat) return;
    let cancelled = false;
    readConfig(ANTHROPIC_API_KEY_CONFIG_KEY, z.string().min(1))
      .then((key) => {
        if (cancelled || key === null) return;
        setApiKeyDraft(key);
        setApiKeySaved(key);
      })
      .catch((err: unknown) => {
        // Unset resolves null; a rejection means the backend could not answer (transport
        // down, or a swarmd page, which is denied secret-shaped keys). It never carries the key.
        console.warn("[settings] Could not read the saved API key:", err);
      });
    return () => {
      cancelled = true;
    };
  }, [canUseWebviewChat]);

  const apiKeyDirty = apiKeyDraft !== apiKeySaved;

  const handleSaveApiKey = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!apiKeyDirty || savingApiKey) return;
    const key = apiKeyDraft;
    startSavingApiKey(async () => {
      try {
        await writeConfig(ANTHROPIC_API_KEY_CONFIG_KEY, key);
        setApiKeySaved(key);
        toast.success("API Key Saved");
      } catch (err) {
        toast.error("Failed To Save API Key", { description: errorMessage(err) });
      }
    });
  };

  // ── Worker registry cap (backend-persisted via set_max_workers) ──
  const [maxWorkers, setMaxWorkersState] = useState(DEFAULT_MAX_WORKERS);
  // Shows a new cap immediately; reverts on its own if the backend refuses it.
  const [shownMaxWorkers, showMaxWorkers] = useOptimistic(maxWorkers);

  useEffect(() => {
    let cancelled = false;
    readConfig("max_workers", z.int().min(1))
      .then((v) => {
        if (!cancelled && v !== null) setMaxWorkersState(v);
      })
      .catch((err: unknown) => {
        // Unset resolves null; a rejection means the backend could not answer — keep the default.
        console.warn("[settings] Could not read the saved worker registry cap:", err);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSetMaxWorkers = (v: number): void =>
    startMaxWorkersUpdate(async () => {
      showMaxWorkers(v);
      try {
        await setMaxWorkers(v);
        startMaxWorkersUpdate(() => setMaxWorkersState(v));
        toast.success(`Worker Registry Cap Set To ${v}`);
      } catch (err) {
        toast.error("Failed To Update Worker Registry Cap", { description: errorMessage(err) });
      }
    });

  return (
    <div className="flex max-w-180 flex-col gap-6 p-6">
      <header>
        <h1 className="font-display text-2xl font-bold tracking-tight text-fg-bright">Settings</h1>
        <p className="mt-1 text-sm text-fg-dim">
          Configure AI Models, Visual Preferences, And Alert Thresholds.
        </p>
      </header>

      <form onSubmit={handleSaveApiKey}>
        <SettingsSection title="AI Connectivity">
          <label htmlFor="anthropic-api-key" className="mb-1.5 block text-md font-medium text-fg">
            API Key
          </label>
          <Input
            id="anthropic-api-key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={apiKeyDraft}
            onChange={(e) => setApiKeyDraft(e.target.value)}
            placeholder="Enter Your Anthropic API Key"
            disabled={!canUseWebviewChat}
            aria-describedby={
              canUseWebviewChat
                ? "anthropic-api-key-description"
                : `anthropic-api-key-description ${apiKeyReasonId}`
            }
            className="font-mono"
          />
          <p id="anthropic-api-key-description" className="mt-1 text-xs text-fg-dim">
            Your Anthropic API Key. Required To Use Webview AI Chat. Stored Locally In Plaintext At
            App Data — Never Logged Or Displayed In Clear Text.
          </p>
          {!canUseWebviewChat && (
            <p id={apiKeyReasonId} className="mt-1 text-xs text-fg-dim">
              {DESKTOP_ONLY_REASON}
            </p>
          )}
          <div className="mt-3 flex justify-end">
            <Button
              type="submit"
              size="sm"
              disabled={!canUseWebviewChat || !apiKeyDirty}
              loading={savingApiKey}
            >
              Save API Key
            </Button>
          </div>
        </SettingsSection>
      </form>

      <section
        aria-labelledby={modelHeadingId}
        className="rounded-lg border border-border bg-surface-1 px-7 py-6"
      >
        <h2
          id={modelHeadingId}
          className="mb-4 font-display text-lg font-bold tracking-tight text-fg-bright"
        >
          AI Model
        </h2>
        <ModelPicker labelledBy={modelHeadingId} />
      </section>

      <SettingsSection title="Visual Preferences">
        <div className="divide-y divide-border">
          <Toggle
            checked={theme.particlesEnabled}
            onChange={(v) => setTheme((prev) => ({ ...prev, particlesEnabled: v }))}
            label="Particle Background"
            description="GPU-Accelerated WebGPU Particle System Behind The Workspace. Disable To Reduce GPU Usage."
          />
          <Toggle
            checked={theme.gpuOverlay}
            onChange={(v) => setTheme((prev) => ({ ...prev, gpuOverlay: v }))}
            label="GPU Frame Time Overlay"
            description="Display GPU Frame Timing In The Status Bar For Performance Monitoring."
          />
        </div>
      </SettingsSection>

      <SettingsSection title="Workers & AI">
        <div className="divide-y divide-border">
          <NumberField
            label="AI Concurrent Stream Limit"
            description="Maximum Simultaneous AI Streams Across All Workers."
            unit="Streams"
            min={AI_CONCURRENT_LIMIT_MIN}
            max={AI_CONCURRENT_LIMIT_MAX}
            value={appSettings.aiConcurrentLimit}
            onChange={(v) => patchSettings({ aiConcurrentLimit: v })}
            busy={agentConcurrencySync.status === "pending"}
            feedback={agentConcurrencyFeedback}
          />
          <NumberField
            label="Chat History Worker Cap"
            description="How Many Workers Keep Chat History In Memory — Least-Recently-Used Workers Are Evicted Past The Cap."
            unit="Workers"
            min={5}
            max={200}
            value={appSettings.historyMaxWorkers}
            onChange={(v) => patchSettings({ historyMaxWorkers: v })}
          />
          <NumberField
            label="Worker Registry Cap"
            description="Backend Limit On Simultaneous Worker Processes — Applies Immediately To New Spawns And Persists Across Restarts."
            unit="Workers"
            min={1}
            max={256}
            value={shownMaxWorkers}
            onChange={handleSetMaxWorkers}
          />
        </div>
      </SettingsSection>

      <SettingsSection title="Sessions & Logs">
        <div className="divide-y divide-border">
          <NumberField
            label="Auto-Snapshot Interval"
            description="How Often The Active Session Is Snapshotted Automatically."
            unit="Minutes"
            min={1}
            max={120}
            value={appSettings.snapshotIntervalMin}
            onChange={(v) => patchSettings({ snapshotIntervalMin: v })}
          />
          <NumberField
            label="Log Retention"
            description="Maximum Log Entries Kept In Memory — The Oldest Are Evicted Past The Cap."
            unit="Entries"
            min={100}
            max={100_000}
            value={appSettings.logMaxEntries}
            onChange={(v) => patchSettings({ logMaxEntries: v })}
          />
        </div>
      </SettingsSection>

      <SettingsSection title="Keybindings">
        <div className="divide-y divide-border">
          <KeybindingField
            label="Command Palette"
            description="Open The Global Command Palette."
            value={keybindings.commandPalette}
            onChange={(b) => patchKeybinding("commandPalette", b)}
          />
          <KeybindingField
            label="Graph / List Toggle"
            description="Switch The Workers Page Between Graph And List View."
            value={keybindings.graphToggle}
            onChange={(b) => patchKeybinding("graphToggle", b)}
          />
          <KeybindingField
            label="Performance Overlay"
            description="Toggle The FPS / GPU Frame-Time Overlay (Dev Builds)."
            value={keybindings.perfOverlay}
            onChange={(b) => patchKeybinding("perfOverlay", b)}
          />
        </div>
      </SettingsSection>

      <AlertThresholdsSection>
        <NumberField
          label="Alert Cooldown"
          description="Minimum Time Between Repeat Alerts For The Same Metric."
          unit="Seconds"
          min={5}
          max={600}
          value={appSettings.alertCooldownSec}
          onChange={(v) => patchSettings({ alertCooldownSec: v })}
        />
        <Toggle
          checked={appSettings.nativeAlertNotifications}
          onChange={(v) => patchSettings({ nativeAlertNotifications: v })}
          label="Native Alert Notifications"
          description="Also Send An OS Notification When An Alert Fires — Visible Even When The App Is In The Background."
          unavailableReason={hasCapability("nativeNotifications") ? undefined : DESKTOP_ONLY_REASON}
        />
      </AlertThresholdsSection>

      <SettingsSection title="About">
        <dl className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-1.5 font-mono text-xs">
          <dt className="text-fg-dim">Version</dt>
          <dd className="text-plasma">{__APP_VERSION__}</dd>
          <dt className="text-fg-dim">Runtime</dt>
          <dd className="text-fg-muted">Tauri + React</dd>
          <dt className="text-fg-dim">Backend</dt>
          <dd className="text-fg-muted">Rust + Tokio</dd>
          <dt className="text-fg-dim">AI</dt>
          <dd className="text-fg-muted">Anthropic SDK</dd>
          <dt className="text-fg-dim">License</dt>
          <dd className="text-fg-muted">MIT</dd>
        </dl>
        <div className="mt-4 border-t border-border">
          <Toggle
            checked={appSettings.updateCheckOnLaunch}
            onChange={(v) => patchSettings({ updateCheckOnLaunch: v })}
            label="Check For Updates On Launch"
            description="Query The Update Endpoint Once Each Time The App Starts."
            unavailableReason={canCheckForUpdates ? undefined : DESKTOP_ONLY_REASON}
          />
        </div>
        <div className="flex items-center justify-end gap-3">
          {!canCheckForUpdates && (
            <span id={updatesReasonId} className="text-xs text-fg-dim">
              {DESKTOP_ONLY_REASON}
            </span>
          )}
          <Button
            size="sm"
            loading={checkingUpdates}
            disabled={!canCheckForUpdates}
            aria-describedby={canCheckForUpdates ? undefined : updatesReasonId}
            onClick={handleCheckForUpdates}
          >
            Check For Updates
          </Button>
        </div>
      </SettingsSection>
    </div>
  );
}
