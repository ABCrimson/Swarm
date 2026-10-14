import { useActionState, useId, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "#components/ui/Button";
import { Input } from "#components/ui/Input";
import { escapeForDisplay } from "#lib/display-escape";
import { errorMessage } from "#lib/is-error";
import { createAndActivateSession, importSessionFromFile } from "#lib/session-lifecycle";
import { DESKTOP_ONLY_REASON, hasCapability } from "#lib/tauri";

/** What the create-session form action leaves behind for the next render. */
interface CreateFormState {
  /** The Title Case failure to show under the field, or `null`. */
  readonly error: string | null;
  /** The submitted name, so a failed submit (which resets the form) keeps what was typed. */
  readonly name: string;
  readonly created: boolean;
}

const INITIAL_FORM_STATE: CreateFormState = { error: null, name: "", created: false };

/** Validates the name, creates the session (made active, see `createAndActivateSession`) and toasts. */
async function submitNewSession(form: FormData): Promise<CreateFormState> {
  const name = String(form.get("name") ?? "").trim();
  if (name === "") return { error: "Enter A Session Name.", name, created: false };
  try {
    const session = await createAndActivateSession(name);
    toast.success(`Session "${escapeForDisplay(session.name)}" Created`);
    return { error: null, name: "", created: true };
  } catch (err) {
    return { error: `Failed To Create Session: ${errorMessage(err)}`, name, created: false };
  }
}

async function importSession(): Promise<void> {
  try {
    const session = await importSessionFromFile();
    if (session != null) toast.success(`Session "${escapeForDisplay(session.name)}" Imported`);
  } catch (err) {
    toast.error(`Import Failed: ${errorMessage(err)}`);
  }
}

/**
 * Action bar for creating and importing sessions: "New Session" opens an
 * inline form, "Import" reads a session JSON file through the native
 * dialog (`#lib/session-lifecycle`) and is disabled while one is running,
 * and for good, with the reason beside it, on a transport without native
 * file dialogs (the `pnpm build:web` page).
 */
export function SessionActions(): React.ReactElement {
  const [naming, setNaming] = useState(false);
  const [importing, startImport] = useTransition();
  const canImportFiles = hasCapability("workspaceBrowsing");
  const importReasonId = useId();
  // Set when the form closes, so New Session takes focus back as it remounts
  // (the form held focus; without this it falls to <body>).
  const restoreFocus = useRef(false);
  const closeForm = () => {
    restoreFocus.current = true;
    setNaming(false);
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      {naming ? (
        <NewSessionForm onClose={closeForm} />
      ) : (
        <Button
          variant="primary"
          size="sm"
          ref={(el) => {
            if (el == null || !restoreFocus.current) return;
            restoreFocus.current = false;
            if (document.activeElement == null || document.activeElement === document.body) {
              el.focus();
            }
          }}
          onClick={() => setNaming(true)}
        >
          New Session
        </Button>
      )}

      <Button
        variant="secondary"
        size="sm"
        loading={importing}
        disabled={!canImportFiles}
        aria-describedby={canImportFiles ? undefined : importReasonId}
        onClick={() => startImport(importSession)}
      >
        Import
      </Button>
      {!canImportFiles && (
        <span id={importReasonId} className="text-fg-dim text-xs">
          {DESKTOP_ONLY_REASON}
        </span>
      )}
    </div>
  );
}

/**
 * The inline create form. Submission is a form action: while it is
 * pending the submit button is `loading`, which swallows its clicks
 * (implicit submission clicks it too), so neither a second click nor a
 * held Enter can start a second `create_session`. Escape cancels.
 */
function NewSessionForm({ onClose }: { readonly onClose: () => void }): React.ReactElement {
  const errorId = useId();
  const [state, createAction, creating] = useActionState(
    async (_previous: CreateFormState, form: FormData) => {
      const next = await submitNewSession(form);
      if (next.created) onClose();
      return next;
    },
    INITIAL_FORM_STATE,
  );

  return (
    <form
      action={createAction}
      className="flex items-center gap-2"
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <Input
        name="name"
        aria-label="Session Name"
        placeholder="Session Name…"
        defaultValue={state.name}
        required
        autoFocus
        aria-invalid={state.error != null || undefined}
        aria-describedby={state.error != null ? errorId : undefined}
        className="w-48"
      />
      <Button type="submit" variant="primary" size="sm" loading={creating}>
        Create
      </Button>
      <Button variant="ghost" size="sm" onClick={onClose}>
        Cancel
      </Button>
      {state.error != null && (
        <span id={errorId} role="alert" className="text-xs text-[oklch(0.72_0.20_25)]">
          {state.error}
        </span>
      )}
    </form>
  );
}
