import { openUrl } from "@tauri-apps/plugin-opener";
import { type CSSProperties, useEffect, useEffectEvent } from "react";
import { toast } from "sonner";
import { Pill } from "#components/ui/Pill";
import { Spinner } from "#components/ui/Spinner";
import { type UseShipReturn, useShip } from "#hooks/useShip";
import { errorMessage } from "#lib/is-error";
import type { ShipError, ShipErrorKind, ShipPreflight, ShipRemedy } from "#store/types";
import { ShipPreview } from "./ShipPreview.tsx";
import { ShipProgress } from "./ShipProgress.tsx";

interface ShipPanelProps {
  readonly workerId: string;
}

const containerStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  height: "100%",
  overflowY: "auto",
  background: "oklch(0.10 0.03 220)",
};

const centeredStyle: CSSProperties = {
  flex: 1,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 12,
  padding: 24,
};

const messageStyle: CSSProperties = {
  fontFamily: "var(--font-body)",
  fontSize: "0.8125rem",
  color: "oklch(0.65 0.04 220)",
  textAlign: "center",
};

const receiptStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
  padding: 16,
  fontFamily: "var(--font-mono)",
  fontSize: "0.75rem",
};

const receiptRowStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: 8,
  color: "oklch(0.80 0.03 220)",
};

const errorBoxStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
  gap: 6,
  padding: "10px 12px",
  borderRadius: 8,
  background: "oklch(0.68 0.20 25 / 0.10)",
  border: "1px solid oklch(0.68 0.20 25 / 0.3)",
  color: "oklch(0.80 0.15 25)",
  fontFamily: "var(--font-body)",
  fontSize: "0.8125rem",
};

const remedyCommandStyle: CSSProperties = {
  display: "block",
  padding: "6px 8px",
  borderRadius: 6,
  background: "var(--color-void)",
  color: "var(--color-text)",
  fontFamily: "var(--font-mono)",
  fontSize: "0.6875rem",
  whiteSpace: "pre-wrap",
  userSelect: "all",
};

/** A Title Case heading per failure kind, so the notice says *what* failed before the backend's own sentence says why. */
const ERROR_TITLES = {
  workerNotFound: "Worker Not Found",
  noWorktree: "No Worktree To Ship",
  primaryCheckout: "Primary Checkout Is Protected",
  invalidBranch: "No Branch Checked Out",
  noRemote: "No Remote Configured",
  nonGitHubHost: "Compare Links Need A GitHub Remote",
  nothingToCommit: "Nothing To Commit",
  identityMissing: "Git Identity Missing",
  hookFailed: "Commit Rejected",
  pushRejected: "Push Rejected",
  authExpired: "Authentication Failed",
  timeout: "Git Timed Out",
  unknown: "Ship Failed",
} as const satisfies Record<ShipErrorKind, string>;

/** Branch names pasted unquoted into a POSIX or PowerShell command line; git allows `$ ( ) ;` in branch names and the worker controls its branch. */
const SHELL_SAFE_BRANCH = /^[A-Za-z0-9._/][A-Za-z0-9._/-]*$/;

/** `branch` when it is inert in a pasted shell command, else the `<branch>` placeholder. */
function shellSafeBranch(branch: string | undefined): string {
  return branch != null && SHELL_SAFE_BRANCH.test(branch) ? branch : "<branch>";
}

/** What to do about each backend remedy: a Title Case hint plus the concrete command(s), run in the worker's worktree. */
function remedyInstructions(
  remedy: ShipRemedy,
  preflight: ShipPreflight | null,
): { readonly hint: string; readonly command: string } {
  switch (remedy) {
    case "fetchAndRebase":
      return {
        hint: "Rebase Onto The Remote Branch In The Worker's Worktree, Then Ship Again:",
        command: `git pull --rebase origin ${shellSafeBranch(preflight?.branch)}`,
      };
    case "reAuthenticate":
      return {
        hint: "Re-Authenticate Your Git Credential Helper, For Example:",
        command: "gh auth login",
      };
    case "configureIdentity":
      return {
        hint: "Set Your Git Identity, Then Ship Again:",
        command: 'git config user.name "Your Name"\ngit config user.email "you@example.com"',
      };
  }
}

/**
 * Re-opens the compare page from the receipt. An opener failure (no
 * default browser, a URL outside the opener capability's scope) is
 * surfaced as an error toast — never left as an unhandled rejection
 * from a click handler.
 */
async function openComparePage(url: string): Promise<void> {
  try {
    await openUrl(url);
  } catch (err) {
    toast.error(`Could Not Open The Compare Page: ${errorMessage(err)}`);
  }
}

/** Focuses a flow step as it mounts, only when focus was lost (the ship button that started it just unmounted); a user who moved focus elsewhere keeps it. Module-level, so React calls it once per mount. */
function focusIfLost(el: HTMLElement | null): void {
  if (el != null && (document.activeElement == null || document.activeElement === document.body)) {
    el.focus();
  }
}

/**
 * Ship tab content for a worker's worktree: a preflight-driven
 * preview → confirm → progress → receipt flow, backed by `useShip`.
 * Preflight runs automatically when the tab opens and again after
 * "Ship Again" (working-tree state can change between ships without
 * SWARM knowing).
 *
 * The flow is keyed by `workerId`: selecting another worker remounts it
 * with fresh state, so a preflight or ship still in flight for the
 * previous worker can never land in the new worker's preview.
 */
export function ShipPanel({ workerId }: ShipPanelProps): React.ReactElement {
  return <WorkerShipFlow key={workerId} workerId={workerId} />;
}

function WorkerShipFlow({ workerId }: ShipPanelProps): React.ReactElement {
  const ship = useShip(workerId);

  // `idle` is the start of every flow (mount, and after "Ship Again").
  // The effect event reads the latest `runPreflight` without making it a
  // dependency, so only a transition *into* idle starts a preflight.
  const startPreflight = useEffectEvent(() => {
    void ship.runPreflight();
  });
  useEffect(() => {
    if (ship.state === "idle") startPreflight();
  }, [ship.state]);

  if (ship.state === "idle" || ship.state === "preflighting") {
    return (
      <div style={containerStyle}>
        <div style={centeredStyle}>
          <Spinner size="md" />
          <span style={messageStyle}>Running Ship Preflight…</span>
        </div>
      </div>
    );
  }

  if (ship.state === "running") {
    return (
      <div style={containerStyle}>
        <section ref={focusIfLost} tabIndex={-1} aria-label="Ship In Progress">
          <ShipProgress rows={ship.progress} />
        </section>
      </div>
    );
  }

  if (ship.state === "settled") {
    return (
      <div style={containerStyle}>
        <ShipReceipt ship={ship} />
      </div>
    );
  }

  const preview = ship.preflight != null && (
    <ShipPreview
      preflight={ship.preflight}
      message={ship.message}
      onMessageChange={ship.setMessage}
      mode={ship.mode}
      onModeChange={ship.setMode}
      onCommitOnly={() => void ship.commitOnly()}
      onCommitAndPush={() => void ship.commitAndPush()}
      onCommitPushAndOpenCompare={() => void ship.commitPushAndOpenCompare()}
      context={ship.context}
      contextState={ship.contextState}
      onRetryContext={() => void ship.retryContext()}
      aiProse={ship.aiProse}
      onAiProseChange={ship.setAiProse}
      aiProseState={ship.aiProseState}
      onRegenerateProse={() => void ship.regenerateProse()}
    />
  );

  if (ship.state === "failed") {
    return (
      <div style={containerStyle}>
        {preview}
        <div style={{ padding: preview ? "0 16px 16px" : 16 }}>
          <ShipErrorNotice
            error={ship.error}
            preflight={ship.preflight}
            onRefresh={() => void ship.runPreflight()}
          />
        </div>
      </div>
    );
  }

  return <div style={containerStyle}>{preview}</div>;
}

/**
 * The failure notice: a Title Case heading for the error's `kind`, the
 * backend's own message, the concrete command behind its `remedy` (when
 * it has one), and a Refresh Preflight action — a failed action may
 * still have changed the worktree (a commit landed, then the push was
 * rejected), and the preview must show the real state before a retry.
 */
function ShipErrorNotice({
  error,
  preflight,
  onRefresh,
}: {
  readonly error: ShipError | null;
  readonly preflight: ShipPreflight | null;
  readonly onRefresh: () => void;
}): React.ReactElement {
  const remedy = error?.remedy != null ? remedyInstructions(error.remedy, preflight) : null;
  return (
    <div style={errorBoxStyle} role="alert" data-kind={error?.kind ?? "unknown"}>
      <strong>{ERROR_TITLES[error?.kind ?? "unknown"]}</strong>
      <span>{error?.message ?? "Ship Failed."}</span>
      {remedy != null && (
        <>
          <span>{remedy.hint}</span>
          <code style={remedyCommandStyle}>{remedy.command}</code>
        </>
      )}
      <Pill interactive tone="neutral" size="md" onClick={onRefresh}>
        {preflight == null ? "Retry Preflight" : "Refresh Preflight"}
      </Pill>
    </div>
  );
}

/** The settled receipt: what was committed and pushed, and the compare page (re-openable). */
function ShipReceipt({ ship }: { readonly ship: UseShipReturn }): React.ReactElement {
  const prUrl = ship.result?.prUrl;
  return (
    <>
      <div style={receiptStyle} role="status" ref={focusIfLost} tabIndex={-1}>
        <span style={{ ...messageStyle, color: "oklch(0.75 0.16 150)", textAlign: "left" }}>
          Shipped
        </span>
        {ship.result?.commitSha != null && (
          <div style={receiptRowStyle}>
            <span>Commit</span>
            <span>{ship.result.commitSha.slice(0, 12)}</span>
          </div>
        )}
        {ship.result?.pushedRef != null && (
          <div style={receiptRowStyle}>
            <span>Pushed</span>
            <span>{ship.result.pushedRef}</span>
          </div>
        )}
        {prUrl != null && (
          <div style={receiptRowStyle}>
            <span>Compare Page</span>
            <button
              type="button"
              aria-label="Open Compare Page"
              title={prUrl}
              onClick={() => void openComparePage(prUrl)}
              className="cursor-pointer rounded-sm underline focus-visible:outline-2 focus-visible:outline-plasma"
              style={{
                background: "none",
                border: "none",
                padding: 0,
                color: "var(--color-plasma)",
                fontFamily: "inherit",
                fontSize: "inherit",
              }}
            >
              Open
            </button>
          </div>
        )}
      </div>
      <div style={{ padding: "0 16px 16px" }}>
        <Pill interactive tone="neutral" size="md" onClick={ship.reset}>
          Ship Again
        </Pill>
      </div>
    </>
  );
}
