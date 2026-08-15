// ── SpawnWorkerDialog ───────────────────────────────
// The Workers page's spawn dialog — replaces the inline header picker
// (PR #11's minimal provider/model/trust-tier select) with a designed
// modal/form. Follows the app's hand-rolled dialog convention seen in
// CausalityPanel.tsx: role="dialog", focus trap, Escape/click-outside
// to close, focus restored to whatever had it on open.
//
// Capability-honesty (docs/architecture.md's "honesty doctrine"): the
// Claude Code provider option is disabled — never silently no-op'd —
// the instant `agentProbe()` reports the CLI unavailable, re-probed
// EVERY time this dialog opens (not just once at app mount) so a CLI
// installed/authenticated after the app launched is picked up without
// a restart. Trust-tier copy below is a plain-language restatement of
// the MEASURED behavior in `ClaudeCodeTrustTier`'s Rust doc
// (`src-tauri/crates/swarm-core/src/agent/claude_code.rs`) — spawn-time
// flags, never a marketing gloss.

import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { CSSProperties } from "react";
import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "#components/ui/Button";
import type { ClaudeCodeTrustTier } from "#lib/agent-events";
import { ClaudeCodeTrustTierSchema } from "#lib/agent-events";
import { DEFAULT_REPO_ROOT_KEY, getPersistedRepoRoot } from "#lib/project-root";
import { agentProbe, agentSpawn, spawnWorker, validateRepoRoot, writeConfig } from "#lib/tauri";

/** Worker spawn provider — "Webview Anthropic" is the existing, default behavior. */
export type SpawnProvider = "webview_anthropic" | "claude_code";

interface SpawnWorkerDialogProps {
  readonly onClose: () => void;
  /** Invoked with the new worker's id after a successful spawn, before the dialog closes itself. */
  readonly onSpawned?: (workerId: string) => void;
}

// ── Trust tier copy — matches MEASURED reality, not aspiration ──────
// Restricted: `--permission-mode dontAsk` + a full deny of
// Bash/Write/Edit/NotebookEdit (read-only exploration).
// Standard: no `--permission-mode` flag (the CLI's own default) — Bash
// runs, but the default `-p` mode auto-denies Write/Edit.
// Write-Enabled: `--permission-mode acceptEdits`, canary-verified
// (module doc's "acceptEdits canary") — writes execute with zero
// `permission_denied` events.
const TRUST_TIER_INFO: Record<
  ClaudeCodeTrustTier,
  { readonly label: string; readonly explanation: string }
> = {
  restricted: {
    label: "Restricted",
    explanation: "Commands And File Writes Are Denied By Default — Read-Only Exploration.",
  },
  standard: {
    label: "Standard",
    explanation:
      "Commands Run Normally; File Writes Are Gated And Denied By Default. Destructive Commands Like sudo And rm -rf Are Always Blocked.",
  },
  write_enabled: {
    label: "Write-Enabled",
    explanation:
      "Commands Run And File Writes Are Automatically Accepted — No Prompt. Destructive Commands Like sudo And rm -rf Are Always Blocked.",
  },
};

const TRUST_TIER_ORDER: readonly ClaudeCodeTrustTier[] = ClaudeCodeTrustTierSchema.options;

// ── Styles (OKLCH) ───────────────────────────────────

const overlayStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 200,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "oklch(0.04 0.01 220 / 0.55)",
  backdropFilter: "blur(2px)",
};

const panelStyle: CSSProperties = {
  width: 480,
  maxHeight: "85vh",
  display: "flex",
  flexDirection: "column",
  background: "oklch(0.10 0.03 220)",
  border: "1px solid oklch(0.28 0.05 220)",
  borderRadius: 12,
  boxShadow: "0 0 0 1px oklch(0.78 0.18 205 / 0.1), 0 16px 48px oklch(0.06 0.02 220 / 0.6)",
  overflow: "hidden",
};

const headerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "14px 16px",
  borderBottom: "1px solid oklch(0.22 0.04 220)",
  flexShrink: 0,
};

const titleStyle: CSSProperties = {
  fontFamily: "var(--font-display)",
  fontSize: "0.9375rem",
  fontWeight: 600,
  color: "oklch(0.95 0.02 220)",
  margin: 0,
};

const closeButtonStyle: CSSProperties = {
  width: 28,
  height: 28,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "oklch(0 0 0 / 0)",
  border: "none",
  borderRadius: 6,
  color: "oklch(0.55 0.04 220)",
  cursor: "pointer",
  fontSize: "1rem",
};

const bodyStyle: CSSProperties = {
  flex: 1,
  overflowY: "auto",
  padding: 16,
  display: "flex",
  flexDirection: "column",
  gap: 18,
};

const fieldGroupStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

const fieldLabelStyle: CSSProperties = {
  fontFamily: "var(--font-body)",
  fontSize: "0.75rem",
  fontWeight: 600,
  color: "oklch(0.72 0.03 220)",
  textTransform: "uppercase",
  letterSpacing: "0.06em",
};

const segmentedGroupStyle: CSSProperties = {
  display: "flex",
  background: "oklch(0.08 0.02 220)",
  border: "1px solid oklch(0.22 0.04 220)",
  borderRadius: 8,
  padding: 2,
};

function segmentButtonStyle(active: boolean, disabled: boolean): CSSProperties {
  return {
    flex: 1,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    padding: "8px 12px",
    background: active ? "oklch(0.78 0.18 205 / 0.15)" : "transparent",
    border: "none",
    borderRadius: 6,
    color: disabled
      ? "oklch(0.38 0.03 220)"
      : active
        ? "oklch(0.78 0.18 205)"
        : "oklch(0.65 0.04 220)",
    fontFamily: "var(--font-body)",
    fontSize: "0.8125rem",
    fontWeight: 500,
    cursor: disabled ? "not-allowed" : "pointer",
  };
}

const unavailableNoteStyle: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "0.6875rem",
  color: "oklch(0.72 0.16 40)",
  lineHeight: 1.5,
};

const textInputStyle: CSSProperties = {
  width: "100%",
  padding: "8px 12px",
  borderRadius: 8,
  border: "1px solid oklch(0.28 0.05 220)",
  background: "oklch(0.08 0.02 220)",
  color: "oklch(0.88 0.03 220)",
  fontFamily: "var(--font-mono)",
  fontSize: "0.8125rem",
  outline: "none",
  boxSizing: "border-box",
};

function tierCardStyle(active: boolean): CSSProperties {
  return {
    display: "flex",
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    padding: "10px 12px",
    borderRadius: 8,
    border: `1px solid ${active ? "oklch(0.55 0.14 205)" : "oklch(0.22 0.04 220)"}`,
    background: active ? "oklch(0.78 0.18 205 / 0.10)" : "oklch(0.08 0.02 220 / 0.6)",
    cursor: "pointer",
    textAlign: "left",
    width: "100%",
  };
}

/** Native `accent-color` themes the browser's own radio dot to the house OKLCH accent — real `<input type="radio">` elements throughout this dialog, never a `role="radio"` div/button (semantic-elements). */
const radioInputStyle: CSSProperties = {
  accentColor: "oklch(0.78 0.18 205)",
  cursor: "pointer",
  flexShrink: 0,
  marginTop: 2,
};

const tierLabelStyle: CSSProperties = {
  fontFamily: "var(--font-body)",
  fontSize: "0.8125rem",
  fontWeight: 600,
  color: "oklch(0.90 0.02 220)",
};

const tierExplanationStyle: CSSProperties = {
  fontFamily: "var(--font-body)",
  fontSize: "0.71875rem",
  color: "oklch(0.58 0.04 220)",
  lineHeight: 1.4,
};

const repoRootRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
};

const repoRootPathStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  padding: "8px 12px",
  borderRadius: 8,
  border: "1px solid oklch(0.22 0.04 220)",
  background: "oklch(0.08 0.02 220 / 0.6)",
  color: "oklch(0.65 0.04 220)",
  fontFamily: "var(--font-mono)",
  fontSize: "0.75rem",
};

const errorBannerStyle: CSSProperties = {
  padding: "8px 12px",
  borderRadius: 8,
  border: "1px solid oklch(0.45 0.18 25)",
  background: "oklch(0.16 0.08 25 / 0.4)",
  color: "oklch(0.82 0.19 25)",
  fontFamily: "var(--font-body)",
  fontSize: "0.75rem",
  lineHeight: 1.4,
};

const footerStyle: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: 8,
  padding: "12px 16px",
  borderTop: "1px solid oklch(0.20 0.03 220)",
  flexShrink: 0,
};

// ── Component ─────────────────────────────────────────

/**
 * The Workers page's spawn dialog. Fields:
 *
 * - Provider (Webview Anthropic default | Claude Code) — Claude Code
 *   disabled with a Title Case, `agentProbe`-sourced reason when the
 *   CLI is unavailable. Probed fresh on every open (not just app
 *   mount), so an install/`claude setup-token` done while the app was
 *   already running is picked up the next time this dialog opens.
 * - Model alias + trust tier (Claude Code only), the latter with a
 *   plain-language, measured-behavior explanation per tier.
 * - Working directory — the persisted default project root, changeable
 *   via the native folder picker; persists immediately like the prior
 *   header widget did.
 *
 * Conditionally mounted by the caller (`{open && <SpawnWorkerDialog .../>}`)
 * rather than driven by its own `open` prop — mirrors the house
 * "remount dialog per open cycle" fix (see CommandPalette's `key={String(open)}`
 * doc) so every field/probe/error resets cleanly between opens without
 * this component needing to track that itself.
 */
export function SpawnWorkerDialog({
  onClose,
  onSpawned,
}: SpawnWorkerDialogProps): React.ReactElement {
  const [provider, setProvider] = useState<SpawnProvider>("webview_anthropic");
  const [claudeModel, setClaudeModel] = useState("sonnet");
  const [claudeTrustTier, setClaudeTrustTier] = useState<ClaudeCodeTrustTier>("standard");
  // undefined = still probing (the option stays enabled meanwhile — an
  // early click can't be blocked by a probe that hasn't resolved yet),
  // null = available, string = unavailable, holding the reason.
  const [claudeUnavailableReason, setClaudeUnavailableReason] = useState<string | null | undefined>(
    undefined,
  );
  // undefined = still loading, null = explicitly none, string = a picked directory.
  const [projectRoot, setProjectRoot] = useState<string | null | undefined>(undefined);
  const [isSpawning, setIsSpawning] = useState(false);
  const [spawnError, setSpawnError] = useState<string | null>(null);

  const panelRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const titleId = useId();

  // Probe on open, every time — capability-honesty means this dialog
  // never trusts a probe result from an earlier open cycle.
  useEffect(() => {
    let cancelled = false;
    void agentProbe().then((report) => {
      if (cancelled) return;
      setClaudeUnavailableReason(
        report.available ? null : (report.detail ?? "Claude Code CLI Not Available"),
      );
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Load + revalidate the persisted project root (same discipline as
  // the prior Workers.tsx header widget) — a since-deleted/moved repo
  // surfaces a warning and falls back to "none" rather than silently
  // failing every subsequent spawn.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const persisted = await getPersistedRepoRoot();
      if (!persisted) {
        if (!cancelled) setProjectRoot(null);
        return;
      }
      try {
        const toplevel = await validateRepoRoot(persisted);
        if (!cancelled) setProjectRoot(toplevel);
      } catch {
        if (!cancelled) {
          setProjectRoot(null);
          toast.warning(`Saved Project Root Is No Longer A Git Repository: ${persisted}`);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Focus management: move focus in on open, restore it on close (see
  // CausalityPanel.tsx's identical doc for why this can't rely on
  // role="dialog" alone).
  useEffect(() => {
    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;
    closeButtonRef.current?.focus();
    return () => {
      previouslyFocusedRef.current?.focus?.();
    };
  }, []);

  // Focus trap.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || !panelRef.current) return;
      // input:not([disabled]) — this dialog, unlike CausalityPanel's
      // (where this selector originated), has real disabled inputs
      // (the Claude Code radio when unavailable); a bare `input` would
      // count one as the trap's first/last element even though a
      // disabled control is never actually tab-reachable, throwing off
      // the wrap-around checks below.
      const focusable = panelRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  const handlePickProjectRoot = async () => {
    const selected = await openDialog({
      title: "Choose Project Root For Worktree Isolation",
      directory: true,
      multiple: false,
    });
    if (!selected) return;

    let toplevel: string;
    try {
      toplevel = await validateRepoRoot(selected);
    } catch {
      toast.error(`Not A Git Repository: ${selected}`);
      return;
    }

    setProjectRoot(toplevel);
    try {
      await writeConfig(DEFAULT_REPO_ROOT_KEY, toplevel);
    } catch (err) {
      toast.error(
        `Could Not Save Project Root: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const handleSpawn = async () => {
    if (provider === "claude_code" && claudeUnavailableReason != null) {
      setSpawnError(`Claude Code Unavailable: ${claudeUnavailableReason}`);
      return;
    }
    setSpawnError(null);
    setIsSpawning(true);
    try {
      const options = {
        name: "Worker",
        ...(projectRoot ? { repoRoot: projectRoot } : {}),
      };
      const id =
        provider === "claude_code"
          ? await agentSpawn(options, claudeModel, claudeTrustTier)
          : await spawnWorker(options);
      if (id) {
        toast.success(`Worker Spawned: ${id.slice(0, 8)}`);
        onSpawned?.(id);
      }
      onClose();
    } catch (err) {
      // Surfaced honestly, not guessed at — an AgentSpawnCommandError's
      // message (it extends Error) is whatever the adapter actually
      // reported (e.g. an init timeout or non-zero exit), never a
      // synthesized "Not Signed In" classification `agent_probe` has
      // no way to measure ahead of a real spawn attempt (see this
      // file's header doc).
      const message = err instanceof Error ? err.message : String(err);
      setSpawnError(`Spawn Failed: ${message}`);
      toast.error(`Spawn Failed: ${message}`);
    } finally {
      setIsSpawning(false);
    }
  };

  const claudeDisabled = claudeUnavailableReason != null;

  return (
    <div style={overlayStyle}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        style={panelStyle}
      >
        <div style={headerStyle}>
          <h2 id={titleId} style={titleStyle}>
            Spawn Worker
          </h2>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            aria-label="Close Spawn Worker Dialog"
            style={closeButtonStyle}
          >
            <svg width={14} height={14} viewBox="0 0 14 14" fill="none">
              <title>Close</title>
              <path
                d="M2 2l10 10M12 2L2 12"
                stroke="currentColor"
                strokeWidth={1.5}
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>

        <div style={bodyStyle}>
          {/* Provider — real <input type="radio"> elements sharing one
              `name`, so browsers/AT get native radio-group semantics for
              free (no role="radio" div-button, which the a11y linter
              rightly rejects since a real form control exists). */}
          <fieldset style={{ ...fieldGroupStyle, border: "none", margin: 0, padding: 0 }}>
            <legend style={{ ...fieldLabelStyle, padding: 0 }}>Provider</legend>
            <div style={segmentedGroupStyle}>
              <label style={segmentButtonStyle(provider === "webview_anthropic", false)}>
                <input
                  type="radio"
                  name="spawn-dialog-provider"
                  checked={provider === "webview_anthropic"}
                  onChange={() => setProvider("webview_anthropic")}
                  style={radioInputStyle}
                />
                Webview Anthropic
              </label>
              <label
                style={segmentButtonStyle(provider === "claude_code", claudeDisabled)}
                title={claudeDisabled ? (claudeUnavailableReason ?? undefined) : undefined}
              >
                <input
                  type="radio"
                  name="spawn-dialog-provider"
                  checked={provider === "claude_code"}
                  disabled={claudeDisabled}
                  onChange={() => setProvider("claude_code")}
                  style={radioInputStyle}
                />
                Claude Code
              </label>
            </div>
            {claudeDisabled && (
              <span style={unavailableNoteStyle}>
                Claude Code Unavailable — {claudeUnavailableReason}
              </span>
            )}
          </fieldset>

          {/* Claude Code-specific fields */}
          {provider === "claude_code" && (
            <>
              <div style={fieldGroupStyle}>
                <label htmlFor="spawn-dialog-model" style={fieldLabelStyle}>
                  Model Alias
                </label>
                <input
                  id="spawn-dialog-model"
                  value={claudeModel}
                  onChange={(e) => setClaudeModel(e.target.value)}
                  placeholder="E.g. Sonnet"
                  style={textInputStyle}
                />
              </div>

              <fieldset style={{ ...fieldGroupStyle, border: "none", margin: 0, padding: 0 }}>
                <legend style={{ ...fieldLabelStyle, padding: 0 }}>Trust Tier</legend>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {TRUST_TIER_ORDER.map((tier) => {
                    const info = TRUST_TIER_INFO[tier];
                    const active = claudeTrustTier === tier;
                    const explanationId = `spawn-dialog-tier-${tier}-explanation`;
                    return (
                      <label key={tier} style={tierCardStyle(active)}>
                        <input
                          type="radio"
                          name="spawn-dialog-trust-tier"
                          checked={active}
                          onChange={() => setClaudeTrustTier(tier)}
                          aria-label={info.label}
                          aria-describedby={explanationId}
                          style={radioInputStyle}
                        />
                        <span style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                          <span style={tierLabelStyle}>{info.label}</span>
                          <span id={explanationId} style={tierExplanationStyle}>
                            {info.explanation}
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </fieldset>
            </>
          )}

          {/* Working directory / repo root */}
          <div style={fieldGroupStyle}>
            <span style={fieldLabelStyle}>Working Directory</span>
            <div style={repoRootRowStyle}>
              <span style={repoRootPathStyle} title={projectRoot ?? undefined}>
                {projectRoot === undefined
                  ? "Loading…"
                  : (projectRoot ?? "No Project Root — Spawns Without Worktree Isolation")}
              </span>
              <Button variant="secondary" size="sm" onClick={() => void handlePickProjectRoot()}>
                Choose…
              </Button>
            </div>
          </div>

          {spawnError && <div style={errorBannerStyle}>{spawnError}</div>}
        </div>

        <div style={footerStyle}>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={isSpawning}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            loading={isSpawning}
            disabled={projectRoot === undefined || (provider === "claude_code" && claudeDisabled)}
            onClick={() => void handleSpawn()}
          >
            Spawn Worker
          </Button>
        </div>
      </div>
    </div>
  );
}
