import { useAtomValue } from "jotai";
import { MotionConfig } from "motion/react";
import { Activity, useActionState, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { HistorySearch } from "#components/session/HistorySearch";
import { SessionActions } from "#components/session/SessionActions";
import { SessionList } from "#components/session/SessionList";
import { TemplateSelector } from "#components/session/TemplateSelector";
import { Button } from "#components/ui/Button";
import { exportAsMarkdown, exportMetricsCSV, saveToFile, sessionFileSlug } from "#lib/export";
import { pluralizeWorkers } from "#lib/format";
import { errorMessage } from "#lib/is-error";
import { deleteSessionAfterConfirm, exportSessionToFile } from "#lib/session-lifecycle";
import { createSnapshot } from "#lib/snapshots";
import { applyTemplate, createTemplateFromSession, saveUserTemplate } from "#lib/templates";
import { useSessionStore } from "#store/sessions";
import { useSystemStore } from "#store/system";
import type { Session, SessionTemplate } from "#store/types";
import { reducedMotionAtom } from "#store/ui";

type SessionView = "list" | "search" | "templates";

const VIEWS = [
  { id: "list", label: "List" },
  { id: "search", label: "Search" },
  { id: "templates", label: "Templates" },
] as const satisfies readonly { readonly id: SessionView; readonly label: string }[];

/** A stable (module-level) ref callback, so it runs once per mount — never again on a re-render. */
function focusOnMount(element: HTMLInputElement | null): void {
  element?.focus();
}

// ── Actions (module level: each one owns its try/catch and its toast) ──

async function deleteSession(id: string): Promise<void> {
  const session = useSessionStore.getState().sessions.get(id);
  if (session == null) return;
  try {
    if (await deleteSessionAfterConfirm(session))
      toast.success(`Session "${session.name}" Deleted`);
  } catch (err) {
    toast.error(`Failed To Delete Session: ${errorMessage(err)}`);
  }
}

async function exportSessionJson(id: string): Promise<void> {
  const session = useSessionStore.getState().sessions.get(id);
  if (session == null) return;
  try {
    const path = await exportSessionToFile(session);
    if (path != null) toast.success(`Session Exported To ${path}`);
  } catch (err) {
    toast.error(`Export Failed: ${errorMessage(err)}`);
  }
}

async function exportSessionMarkdown(session: Session): Promise<void> {
  try {
    const markdown = exportAsMarkdown(session);
    const path = await saveToFile(
      markdown,
      `${sessionFileSlug(session.name)}.md`,
      "Markdown",
      "md",
    );
    if (path != null) toast.success(`Session Exported To ${path}`);
  } catch (err) {
    toast.error(`Export Failed: ${errorMessage(err)}`);
  }
}

async function exportMetrics(): Promise<void> {
  try {
    // Read at click time: subscribing would re-render this page on every metrics tick.
    const csv = exportMetricsCSV(useSystemStore.getState().metrics.history);
    const path = await saveToFile(csv, "swarm-metrics.csv", "CSV", "csv");
    if (path != null) toast.success(`Metrics Exported To ${path}`);
  } catch (err) {
    toast.error(`Metrics Export Failed: ${errorMessage(err)}`);
  }
}

async function snapshotSession(session: Session): Promise<void> {
  try {
    await createSnapshot(session);
    toast.success("Snapshot Created");
  } catch (err) {
    toast.error(`Failed To Create Snapshot: ${errorMessage(err)}`);
  }
}

/**
 * Applies `template` (a new session plus one worker per spec) and reports
 * honestly: an empty template, a total spawn failure and a partial one
 * each get their own message rather than a blanket success.
 */
async function applyTemplateWithReport(template: SessionTemplate): Promise<void> {
  const total = template.workerConfigs.length;
  try {
    const { session, workerIds, failures } = await applyTemplate(template);
    useSessionStore.getState().setActiveSession(session.id);
    const spawned = workerIds.length;
    if (total === 0) {
      toast.warning(`Template "${template.name}" Has No Workers — Created An Empty Session`);
    } else if (spawned === 0) {
      toast.error(`Template "${template.name}" Failed — 0 Of ${total} Workers Spawned`, {
        description: failures.join("; "),
      });
    } else if (spawned < total) {
      toast.warning(
        `Template "${template.name}" Partially Applied — ${spawned} Of ${total} Workers Spawned`,
        { description: failures.join("; ") },
      );
    } else {
      toast.success(`Template "${template.name}" Applied — ${pluralizeWorkers(spawned)} Spawned`);
    }
  } catch (err) {
    toast.error(`Failed To Apply Template "${template.name}": ${errorMessage(err)}`);
  }
}

/** What the save-as-template form action leaves behind for the next render. */
interface TemplateFormState {
  readonly error: string | null;
  readonly saved: boolean;
  /** The submitted values, so a failed submit (which resets the form) keeps what was typed. */
  readonly name: string | null;
  readonly description: string;
}

const INITIAL_TEMPLATE_FORM: TemplateFormState = {
  error: null,
  saved: false,
  name: null,
  description: "",
};

async function saveSessionAsTemplate(session: Session, form: FormData): Promise<TemplateFormState> {
  const name = String(form.get("name") ?? "").trim();
  const description = String(form.get("description") ?? "").trim();
  const failure = (error: string): TemplateFormState => ({
    error,
    saved: false,
    name,
    description,
  });

  if (name === "") return failure("Enter A Template Name.");
  const template = createTemplateFromSession(session, { name, description });
  if (template.workerConfigs.length === 0) {
    return failure("This Session Has No Workers To Save As A Template.");
  }
  try {
    await saveUserTemplate(template);
  } catch (err) {
    return failure(`Failed To Save Template: ${errorMessage(err)}`);
  }
  toast.success(`Template "${name}" Saved`);
  return { ...INITIAL_TEMPLATE_FORM, saved: true };
}

// ── Page ─────────────────────────────────────────────

/**
 * Sessions page: the session list, history search and template views,
 * plus session create/import, snapshots and export (Markdown, JSON, and
 * the metrics history as CSV).
 *
 * Each view sits in an `<Activity>`, so switching views hides the others
 * instead of unmounting them — a search query, its date range and the
 * list's scroll position survive a round trip through another view.
 */
export function Sessions(): React.ReactElement {
  const [view, setView] = useState<SessionView>("list");
  const [templateSourceId, setTemplateSourceId] = useState<string | null>(null);
  const templateOpenerRef = useRef<HTMLElement | null>(null);

  // The session menu has already returned focus to its trigger; remember it
  // so closing the form hands focus back instead of dropping it to <body>.
  const openTemplateForm = (id: string): void => {
    templateOpenerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setTemplateSourceId(id);
  };

  const closeTemplateForm = (): void => {
    const opener = templateOpenerRef.current;
    templateOpenerRef.current = null;
    if (opener?.isConnected) opener.focus();
    setTemplateSourceId(null);
  };
  const reducedMotion = useAtomValue(reducedMotionAtom);
  const setActiveSession = useSessionStore((s) => s.setActiveSession);
  const activeSession = useSessionStore((s) =>
    s.activeSessionId == null ? undefined : s.sessions.get(s.activeSessionId),
  );
  const templateSource = useSessionStore((s) =>
    templateSourceId == null ? undefined : s.sessions.get(templateSourceId),
  );

  const handleTemplateSelect = (template: SessionTemplate) => {
    setView("list");
    void applyTemplateWithReport(template);
  };

  const handleSearchResultSelect = (sessionId: string) => {
    setActiveSession(sessionId);
    setView("list");
  };

  return (
    <MotionConfig reducedMotion={reducedMotion ? "always" : "user"}>
      <div className="flex h-full flex-col gap-6 overflow-auto p-6">
        <header>
          <h1 className="text-2xl font-bold tracking-tight text-[oklch(0.95_0.02_220)] font-[family-name:var(--font-display)]">
            Sessions
          </h1>
          <p className="mt-1 text-sm text-fg-dim font-[family-name:var(--font-body)]">
            Active And Historical Worker Sessions.
          </p>
        </header>

        <div
          className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-[oklch(0.25_0.04_220/0.5)] bg-[oklch(0.12_0.02_220/0.6)] p-3"
          style={{ backdropFilter: "blur(12px)" }}
        >
          <SessionActions />

          <div className="flex flex-wrap items-center gap-2">
            <fieldset className="m-0 flex items-center gap-2 border-0 p-0">
              <legend className="sr-only">View</legend>
              {VIEWS.map(({ id, label }) => (
                <ViewToggle
                  key={id}
                  label={label}
                  active={view === id}
                  onClick={() => setView(id)}
                />
              ))}
            </fieldset>

            {/* Actions on the active session */}
            {activeSession != null && (
              <div className="ml-2 flex items-center gap-1 border-l border-[oklch(0.25_0.03_220)] pl-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void snapshotSession(activeSession)}
                >
                  Snapshot
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void exportSessionMarkdown(activeSession)}
                >
                  Export MD
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void exportSessionJson(activeSession.id)}
                >
                  Export JSON
                </Button>
              </div>
            )}
            <Button variant="ghost" size="sm" onClick={() => void exportMetrics()}>
              Export Metrics
            </Button>
          </div>
        </div>

        {templateSource != null && (
          <TemplateForm
            key={templateSource.id}
            session={templateSource}
            onDone={closeTemplateForm}
          />
        )}

        <div className="min-h-0 flex-1">
          <Activity mode={view === "list" ? "visible" : "hidden"}>
            <SessionList
              onDelete={(id) => void deleteSession(id)}
              onExport={(id) => void exportSessionJson(id)}
              onCreateTemplate={openTemplateForm}
            />
          </Activity>
          <Activity mode={view === "search" ? "visible" : "hidden"}>
            <HistorySearch onResultSelect={handleSearchResultSelect} />
          </Activity>
          <Activity mode={view === "templates" ? "visible" : "hidden"}>
            <TemplateSelector onSelect={handleTemplateSelect} onClose={() => setView("list")} />
          </Activity>
        </div>
      </div>
    </MotionConfig>
  );
}

/**
 * The inline "Save As Template" form for one session (keyed by it, so
 * opening it for another session starts fresh and focuses the name).
 * Submission is a form action: while the save is pending the submit
 * button is disabled, so Enter plus a click can never save twice.
 */
function TemplateForm({
  session,
  onDone,
}: {
  readonly session: Session;
  readonly onDone: () => void;
}): React.ReactElement {
  const nameId = useId();
  const descriptionId = useId();
  const errorId = useId();
  const [state, saveAction, saving] = useActionState(
    async (_previous: TemplateFormState, form: FormData) => {
      const next = await saveSessionAsTemplate(session, form);
      if (next.saved) onDone();
      return next;
    },
    INITIAL_TEMPLATE_FORM,
  );

  const labelClass =
    "text-xs font-medium text-[oklch(0.75_0.08_290)] font-[family-name:var(--font-body)]";
  const errorProps =
    state.error != null ? { "aria-invalid": true, "aria-describedby": errorId } : {};

  return (
    <form
      action={saveAction}
      aria-label={`Save "${session.name}" As A Template`}
      className="flex flex-wrap items-center gap-3 rounded-xl border border-[oklch(0.35_0.08_290/0.5)] bg-[oklch(0.14_0.03_290/0.4)] p-3"
      onKeyDown={(e) => {
        if (e.key === "Escape") onDone();
      }}
    >
      <label htmlFor={nameId} className={labelClass}>
        Template Name
      </label>
      <input
        id={nameId}
        name="name"
        type="text"
        required
        ref={focusOnMount}
        defaultValue={state.name ?? session.name}
        className="swarm-input h-8 flex-1 text-sm"
        {...errorProps}
      />
      <label htmlFor={descriptionId} className={labelClass}>
        Description
      </label>
      <input
        id={descriptionId}
        name="description"
        type="text"
        placeholder="Optional"
        defaultValue={state.description}
        className="swarm-input h-8 flex-1 text-sm"
      />
      <Button type="submit" variant="primary" size="sm" loading={saving}>
        Save Template
      </Button>
      <Button variant="ghost" size="sm" onClick={onDone}>
        Cancel
      </Button>
      {state.error != null && (
        <span id={errorId} role="alert" className="basis-full text-xs text-[oklch(0.72_0.20_25)]">
          {state.error}
        </span>
      )}
    </form>
  );
}

function ViewToggle({
  label,
  active,
  onClick,
}: {
  readonly label: string;
  readonly active: boolean;
  readonly onClick: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`cursor-pointer rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors font-[family-name:var(--font-body)] focus-visible:outline-2 focus-visible:outline-plasma ${
        active
          ? "border-[oklch(0.45_0.15_290/0.4)] bg-[oklch(0.25_0.06_290/0.4)] text-[oklch(0.85_0.12_290)]"
          : "border-transparent bg-transparent text-fg-dim hover:text-fg"
      }`}
    >
      {label}
    </button>
  );
}
