import { useCallback, useRef, useState } from "react";
import { HistorySearch } from "#components/session/HistorySearch";
import { SessionActions, useSessionLifecycle } from "#components/session/SessionActions";
import { SessionList } from "#components/session/SessionList";
import { TemplateSelector } from "#components/session/TemplateSelector";
import { Button } from "#components/ui/Button";
import { toast } from "sonner";
import { exportAsJSON, exportAsMarkdown, exportMetricsCSV, saveToFile } from "#lib/export";
import { createSnapshot } from "#lib/snapshots";
import { createTemplateFromSession, saveUserTemplate } from "#lib/templates";
import { useSessionStore } from "#store/sessions";
import { useSystemStore } from "#store/system";
import type { SessionTemplate } from "#store/types";

type SessionView = "list" | "search" | "templates";

/** State for the inline template creation form (replaces blocking prompt()). */
interface TemplateFormState {
  readonly sessionId: string;
  readonly defaultName: string;
  step: "name" | "description";
  name: string;
  description: string;
}

/**
 * Sessions page with list, search, and template views.
 *
 * Supports session CRUD, snapshots, and export in Markdown, JSON, and CSV.
 */
export function Sessions(): React.ReactElement {
  const [view, setView] = useState<SessionView>("list");
  const [templateForm, setTemplateForm] = useState<TemplateFormState | null>(null);
  const templateInputRef = useRef<HTMLInputElement>(null);
  const sessions = useSessionStore((s) => s.sessions);
  const setActiveSession = useSessionStore((s) => s.setActiveSession);
  const { deleteWithConfirm, exportSession } = useSessionLifecycle();

  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const activeSession = activeSessionId ? sessions.get(activeSessionId) : undefined;
  const metrics = useSystemStore((s) => s.metrics);

  const handleDelete = (id: string) => {
    deleteWithConfirm(id);
  };

  const handleExport = (id: string) => {
    exportSession(id);
  };

  const handleCreateTemplate = (id: string) => {
    const session = sessions.get(id);
    if (!session) return;

    setTemplateForm({
      sessionId: id,
      defaultName: session.name,
      step: "name",
      name: session.name,
      description: "",
    });
  };

  const handleTemplateFormSubmit = useCallback(async () => {
    if (!templateForm) return;

    if (templateForm.step === "name") {
      if (!templateForm.name.trim()) {
        setTemplateForm(null);
        return;
      }
      setTemplateForm({ ...templateForm, step: "description" });
      return;
    }

    // step === "description" — save the template
    const template = createTemplateFromSession(templateForm.name, templateForm.description, []);
    try {
      await saveUserTemplate(template);
      toast.success(`Template "${templateForm.name}" saved`);
    } catch {
      toast.error("Failed to save template");
    }
    setTemplateForm(null);
  }, [templateForm]);

  const handleTemplateSelect = (_template: SessionTemplate) => {
    // Template selection creates a new session from the template
    setView("list");
    toast.success(`Template "${_template.name}" selected — create a session to apply it`);
  };

  const handleSearchResultSelect = (sessionId: string) => {
    setActiveSession(sessionId);
    setView("list");
  };

  const handleSnapshot = async () => {
    if (!activeSession) {
      toast.error("No active session to snapshot");
      return;
    }

    try {
      await createSnapshot(activeSession);
      toast.success("Snapshot created");
    } catch {
      toast.error("Failed to create snapshot");
    }
  };

  const handleExportMarkdown = async () => {
    if (!activeSession) {
      toast.error("No active session to export");
      return;
    }

    try {
      const md = exportAsMarkdown(activeSession);
      const path = await saveToFile(
        md,
        `${activeSession.name.replaceAll(/\s+/g, "-").toLowerCase()}.md`,
        "Markdown",
        "md",
      );
      if (path) toast.success("Exported as Markdown");
    } catch {
      toast.error("Export failed");
    }
  };

  const handleExportJSON = async () => {
    if (!activeSession) {
      toast.error("No active session to export");
      return;
    }

    try {
      const json = exportAsJSON(activeSession);
      const path = await saveToFile(
        json,
        `${activeSession.name.replaceAll(/\s+/g, "-").toLowerCase()}.json`,
        "JSON",
        "json",
      );
      if (path) toast.success("Exported as JSON");
    } catch {
      toast.error("Export failed");
    }
  };

  const handleExportMetrics = async () => {
    try {
      const csv = exportMetricsCSV(metrics.history);
      const path = await saveToFile(csv, "swarm-metrics.csv", "CSV", "csv");
      if (path) toast.success("Metrics exported as CSV");
    } catch {
      toast.error("Metrics export failed");
    }
  };

  return (
    <div className="flex flex-col gap-6 p-6 h-full overflow-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1
            className="text-2xl font-bold tracking-tight"
            style={{
              fontFamily: "var(--font-display)",
              color: "oklch(0.95 0.02 220)",
            }}
          >
            Sessions
          </h1>
          <p
            className="text-sm mt-1"
            style={{
              fontFamily: "var(--font-body)",
              color: "oklch(0.55 0.04 220)",
            }}
          >
            Active and historical worker sessions.
          </p>
        </div>
      </div>

      {/* Toolbar */}
      <div
        className="flex items-center justify-between gap-4 rounded-xl p-3"
        style={{
          background: "oklch(0.12 0.02 220 / 0.6)",
          backdropFilter: "blur(12px)",
          border: "1px solid oklch(0.25 0.04 220 / 0.5)",
        }}
      >
        <SessionActions />

        <div className="flex items-center gap-2">
          <ViewToggle label="List" active={view === "list"} onClick={() => setView("list")} />
          <ViewToggle label="Search" active={view === "search"} onClick={() => setView("search")} />
          <ViewToggle
            label="Templates"
            active={view === "templates"}
            onClick={() => setView("templates")}
          />

          {/* Export dropdown for active session */}
          {activeSession && (
            <div
              className="flex items-center gap-1 ml-2 pl-2"
              style={{ borderLeft: "1px solid oklch(0.25 0.03 220)" }}
            >
              <Button variant="ghost" size="sm" onClick={() => void handleSnapshot()}>
                Snapshot
              </Button>
              <Button variant="ghost" size="sm" onClick={() => void handleExportMarkdown()}>
                Export MD
              </Button>
              <Button variant="ghost" size="sm" onClick={() => void handleExportJSON()}>
                Export JSON
              </Button>
              <Button variant="ghost" size="sm" onClick={() => void handleExportMetrics()}>
                Export Metrics
              </Button>
            </div>
          )}
        </div>
      </div>

      {/* Inline template creation form (replaces blocking prompt()) */}
      {templateForm && (
        <div
          className="flex items-center gap-3 rounded-xl p-3"
          style={{
            background: "oklch(0.14 0.03 290 / 0.4)",
            border: "1px solid oklch(0.35 0.08 290 / 0.5)",
          }}
        >
          <label
            className="text-xs font-medium"
            style={{ color: "oklch(0.75 0.08 290)", fontFamily: "var(--font-body)" }}
          >
            {templateForm.step === "name" ? "Template name:" : "Description:"}
          </label>
          <input
            ref={templateInputRef}
            type="text"
            className="flex-1 rounded-lg px-3 py-1.5 text-sm"
            style={{
              background: "oklch(0.10 0.02 220)",
              border: "1px solid oklch(0.30 0.04 220)",
              color: "oklch(0.90 0.02 220)",
              fontFamily: "var(--font-body)",
              outline: "none",
            }}
            value={templateForm.step === "name" ? templateForm.name : templateForm.description}
            onChange={(e) =>
              setTemplateForm({
                ...templateForm,
                [templateForm.step === "name" ? "name" : "description"]: e.target.value,
              })
            }
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleTemplateFormSubmit();
              if (e.key === "Escape") setTemplateForm(null);
            }}
            autoFocus
            placeholder={templateForm.step === "name" ? "Enter template name" : "Enter description (optional)"}
          />
          <Button variant="ghost" size="sm" onClick={() => void handleTemplateFormSubmit()}>
            {templateForm.step === "name" ? "Next" : "Save"}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setTemplateForm(null)}>
            Cancel
          </Button>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 min-h-0">
        {view === "list" && (
          <SessionList
            onDelete={handleDelete}
            onExport={handleExport}
            onCreateTemplate={handleCreateTemplate}
          />
        )}

        {view === "search" && <HistorySearch onResultSelect={handleSearchResultSelect} />}

        {view === "templates" && (
          <TemplateSelector onSelect={handleTemplateSelect} onClose={() => setView("list")} />
        )}
      </div>
    </div>
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
      onClick={onClick}
      className="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer"
      style={{
        fontFamily: "var(--font-body)",
        background: active ? "oklch(0.25 0.06 290 / 0.4)" : "transparent",
        color: active ? "oklch(0.85 0.12 290)" : "oklch(0.55 0.03 220)",
        border: active ? "1px solid oklch(0.45 0.15 290 / 0.4)" : "1px solid transparent",
      }}
    >
      {label}
    </button>
  );
}
