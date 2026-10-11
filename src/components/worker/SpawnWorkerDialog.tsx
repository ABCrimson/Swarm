import { open as openFolderPicker } from "@tauri-apps/plugin-dialog";
import type { CSSProperties } from "react";
import { useActionState, useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "#components/ui/Button";
import { PROVIDER_LABELS, type TrustTier, TrustTierSchema } from "#lib/agent-events";
import { errorMessage } from "#lib/is-error";
import { DEFAULT_REPO_ROOT_KEY, getPersistedRepoRoot } from "#lib/project-root";
import {
  AgentSpawnCommandError,
  agentProbe,
  agentSpawn,
  spawnWorker,
  validateRepoRoot,
  writeConfig,
} from "#lib/tauri";

/** Where a new worker's chat runs: the webview's own Claude client, or an attached agent CLI. */
type SpawnProvider = "webview_anthropic" | "claude_code" | "codex";

/** Providers that attach an agent session (and take a model alias and trust tier). */
type AgentProvider = Extract<SpawnProvider, "claude_code" | "codex">;

const AGENT_PROVIDERS: readonly AgentProvider[] = ["claude_code", "codex"];

interface SpawnWorkerDialogProps {
  readonly onClose: () => void;
  /** Called with the new worker's id after a successful spawn, before the dialog closes. */
  readonly onSpawned?: (workerId: string) => void;
}

/**
 * Plain-language trust tiers, restating what each adapter configures
 * (`crates/swarm-core/src/agent/claude_code/tier.rs`, `agent/codex/tier.rs`).
 *
 * - Claude Code: Restricted = `--restricted` + `--permission-mode
 *   dontAsk` plus a deny list for the writing tools; Standard =
 *   `--permission-mode manual` (commands with side effects and file
 *   edits are asked of the human); Write-Enabled = `--permission-mode
 *   acceptEdits` (file edits run, commands are asked). Asks are answered
 *   from the worker's chat, and destructive commands stay denied in
 *   every tier.
 * - Codex: Restricted = `approvalPolicy: "untrusted"` + read-only
 *   sandbox; Standard = `untrusted` + workspace-write sandbox;
 *   Write-Enabled = `on-request` + workspace-write. Codex's approval
 *   requests are answered from the worker's chat.
 */
const TRUST_TIER_INFO = {
  claude_code: {
    restricted: {
      label: "Restricted",
      explanation: "Commands And File Writes Are Denied — Read-Only Exploration.",
    },
    standard: {
      label: "Standard",
      explanation:
        "Reads Run; Commands With Side Effects And File Edits Ask You First. Destructive Commands Like sudo And rm -rf Are Always Blocked.",
    },
    write_enabled: {
      label: "Write-Enabled",
      explanation:
        "File Edits Are Accepted Without Asking; Commands Ask You First. Destructive Commands Like sudo And rm -rf Are Always Blocked.",
    },
  },
  codex: {
    restricted: {
      label: "Restricted",
      explanation: "Every Gated Action Asks You First, And The Sandbox Is Read-Only.",
    },
    standard: {
      label: "Standard",
      explanation: "Every Gated Action Asks You First; File Writes Are Sandboxed To The Worktree.",
    },
    write_enabled: {
      label: "Write-Enabled",
      explanation:
        "The Model Asks Only When It Decides To; File Writes Are Sandboxed To The Worktree.",
    },
  },
} as const satisfies Record<
  AgentProvider,
  Record<TrustTier, { readonly label: string; readonly explanation: string }>
>;

/** A model alias each CLI understands; Codex runs its own configured default when blank. */
const DEFAULT_MODEL_ALIAS = { claude_code: "sonnet", codex: "" } as const satisfies Record<
  AgentProvider,
  string
>;

const MODEL_PLACEHOLDER = {
  claude_code: "E.g. Sonnet Or Opus",
  codex: "Blank Uses Codex's Configured Default",
} as const satisfies Record<AgentProvider, string>;

function isAgentProvider(p: SpawnProvider): p is AgentProvider {
  return p === "claude_code" || p === "codex";
}

/**
 * Ref callback that opens its `<dialog>` as a modal when it mounts.
 * Unmounting needs no cleanup — removing a dialog from the document takes
 * it out of the top layer without a `close` event — and returning none
 * keeps React Strict Mode's dev-only ref re-run from closing (and so
 * dismissing) the dialog it just opened.
 */
function showModalOnMount(dialog: HTMLDialogElement | null): void {
  if (dialog && !dialog.open) dialog.showModal();
}

// ── Styles (OKLCH) ───────────────────────────────────

/** Tailwind's preflight zeroes dialog margins; `margin: auto` re-centers the modal. */
const dialogStyle: CSSProperties = {
  margin: "auto",
  width: 480,
  maxWidth: "calc(100vw - 32px)",
  maxHeight: "85vh",
  padding: 0,
  background: "oklch(0.10 0.03 220)",
  border: "1px solid oklch(0.28 0.05 220)",
  borderRadius: 12,
  boxShadow: "0 0 0 1px oklch(0.78 0.18 205 / 0.1), 0 16px 48px oklch(0.06 0.02 220 / 0.6)",
  color: "oklch(0.88 0.03 220)",
  overflow: "hidden",
};

const formStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  maxHeight: "85vh",
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
};

const bodyStyle: CSSProperties = {
  flex: 1,
  overflowY: "auto",
  padding: 16,
  display: "flex",
  flexDirection: "column",
  gap: 18,
};

const fieldGroupStyle: CSSProperties = { display: "flex", flexDirection: "column", gap: 8 };

const fieldsetStyle: CSSProperties = { ...fieldGroupStyle, border: "none", margin: 0, padding: 0 };

const fieldLabelStyle: CSSProperties = {
  padding: 0,
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

function segmentStyle(active: boolean, disabled: boolean): CSSProperties {
  return {
    flex: 1,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    padding: "8px 12px",
    background: active ? "oklch(0.78 0.18 205 / 0.15)" : "oklch(0 0 0 / 0)",
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

function tierCardStyle(active: boolean): CSSProperties {
  return {
    display: "flex",
    alignItems: "flex-start",
    gap: 10,
    padding: "10px 12px",
    borderRadius: 8,
    border: `1px solid ${active ? "oklch(0.55 0.14 205)" : "oklch(0.22 0.04 220)"}`,
    background: active ? "oklch(0.78 0.18 205 / 0.10)" : "oklch(0.08 0.02 220 / 0.6)",
    cursor: "pointer",
  };
}

/** `accent-color` themes the native radio dot to the house accent. */
const radioStyle: CSSProperties = {
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
 * The Workers page's spawn dialog, a native modal `<dialog>` opened with
 * `showModal()` (top layer, inert page, native focus handling and focus
 * return; Escape and backdrop clicks close it via `closedby="any"`).
 *
 * - Provider: Webview Anthropic (default), Claude Code or Codex. Each
 *   agent CLI is probed every time the dialog opens, so an install or
 *   sign-in done while the app runs is picked up; an unavailable (or
 *   unprobeable) provider is disabled with the reason shown, never
 *   silently accepted. A provider stays enabled while its probe is in
 *   flight.
 * - Model alias and trust tier for agent providers, each tier explained
 *   per provider.
 * - Working directory: the persisted project root (revalidated as a git
 *   repository), changeable with the native folder picker.
 *
 * The caller mounts it only while open, so every field, probe and error
 * starts fresh on each open.
 */
export function SpawnWorkerDialog({
  onClose,
  onSpawned,
}: SpawnWorkerDialogProps): React.ReactElement {
  const formRef = useRef<HTMLFormElement>(null);
  const closeDialog = () => formRef.current?.closest("dialog")?.close();
  const titleId = useId();
  const [provider, setProvider] = useState<SpawnProvider>("webview_anthropic");
  const [modelAliases, setModelAliases] = useState<Record<AgentProvider, string>>({
    ...DEFAULT_MODEL_ALIAS,
  });
  const [trustTier, setTrustTier] = useState<TrustTier>("standard");
  // Per provider: undefined = probing, null = available, string = why not.
  const [unavailable, setUnavailable] = useState<Record<AgentProvider, string | null | undefined>>({
    claude_code: undefined,
    codex: undefined,
  });
  // undefined = loading, null = none, string = the validated repository root.
  const [projectRoot, setProjectRoot] = useState<string | null | undefined>(undefined);
  // Project-root problems shown in the dialog itself: a modal's top layer
  // paints over, and makes inert, the page-level toaster.
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    for (const p of AGENT_PROVIDERS) {
      void agentProbe(p)
        .then(
          (report) =>
            report.available ? null : (report.detail ?? `${PROVIDER_LABELS[p]} CLI Not Available`),
          (err: unknown) => `Probe Failed: ${errorMessage(err)}`,
        )
        .then((reason) => {
          if (!cancelled) setUnavailable((prev) => ({ ...prev, [p]: reason }));
        });
    }
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<string | null> => {
      let persisted: string | null;
      try {
        persisted = await getPersistedRepoRoot();
      } catch (err) {
        if (!cancelled) setNotice(`Could Not Read The Saved Project Root: ${errorMessage(err)}`);
        return null;
      }
      if (!persisted) return null;
      try {
        return await validateRepoRoot(persisted);
      } catch (err) {
        if (!cancelled) {
          setNotice(`Could Not Validate The Saved Project Root ${persisted}: ${errorMessage(err)}`);
        }
        return null;
      }
    };
    void load().then((root) => {
      if (!cancelled) setProjectRoot(root);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const [spawnError, spawn, isSpawning] = useActionState(async (): Promise<string | null> => {
    const reason = isAgentProvider(provider) ? unavailable[provider] : null;
    if (reason != null) return `${PROVIDER_LABELS[provider]} Unavailable: ${reason}`;
    const options = { name: "Worker", ...(projectRoot ? { repoRoot: projectRoot } : {}) };
    try {
      const id = isAgentProvider(provider)
        ? await agentSpawn(options, provider, modelAliases[provider].trim() || undefined, trustTier)
        : await spawnWorker(options);
      // `null`: no backend transport (a plain `pnpm dev` browser preview), so nothing spawned.
      if (!id) {
        const message = "Spawn Failed: No Backend Transport Available.";
        toast.error(message);
        return message;
      }
      toast.success(`Worker Spawned: ${id.slice(0, 8)}`);
      onSpawned?.(id);
      closeDialog();
      return null;
    } catch (err) {
      // The PTY worker exists as a plain terminal; only the agent session failed to attach.
      if (err instanceof AgentSpawnCommandError && err.workerId) {
        toast.error(`Worker Spawned Without An Agent Session: ${err.message}`);
        onSpawned?.(err.workerId);
        closeDialog();
        return null;
      }
      // The adapter's own report (an init timeout, a non-zero exit…),
      // never a guessed cause.
      const message = `Spawn Failed: ${errorMessage(err)}`;
      toast.error(message);
      return message;
    }
  }, null);

  const pickProjectRoot = async () => {
    let selected: string | null;
    try {
      selected = await openFolderPicker({
        title: "Choose Project Root For Worktree Isolation",
        directory: true,
        multiple: false,
      });
    } catch (err) {
      setNotice(`Could Not Open The Folder Picker: ${errorMessage(err)}`);
      return;
    }
    if (!selected) return;
    let toplevel: string;
    try {
      toplevel = await validateRepoRoot(selected);
    } catch (err) {
      setNotice(`Could Not Use ${selected} As The Project Root: ${errorMessage(err)}`);
      return;
    }
    setProjectRoot(toplevel);
    setNotice(null);
    try {
      await writeConfig(DEFAULT_REPO_ROOT_KEY, toplevel);
    } catch (err) {
      setNotice(`Could Not Save Project Root: ${errorMessage(err)}`);
    }
  };

  const agent = isAgentProvider(provider) ? provider : null;

  return (
    <dialog
      ref={showModalOnMount}
      closedby="any"
      aria-labelledby={titleId}
      onClose={onClose}
      onCancel={(e) => {
        // Never dismiss mid-spawn: the result has nowhere to go.
        if (isSpawning) e.preventDefault();
      }}
      style={dialogStyle}
      className="backdrop:bg-[oklch(0.04_0.01_220/0.55)] backdrop:backdrop-blur-[2px]"
    >
      <form ref={formRef} action={spawn} style={formStyle}>
        <div style={headerStyle}>
          <h2 id={titleId} style={titleStyle}>
            Spawn Worker
          </h2>
          <button
            type="button"
            onClick={closeDialog}
            aria-label="Close Spawn Worker Dialog"
            style={closeButtonStyle}
          >
            <svg width={14} height={14} viewBox="0 0 14 14" fill="none" aria-hidden="true">
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
          <fieldset style={fieldsetStyle}>
            <legend style={fieldLabelStyle}>Provider</legend>
            <div style={segmentedGroupStyle}>
              {(["webview_anthropic", ...AGENT_PROVIDERS] as const).map((p) => {
                const reason = isAgentProvider(p) ? unavailable[p] : null;
                const disabled = reason != null;
                return (
                  <label
                    key={p}
                    style={segmentStyle(provider === p, disabled)}
                    title={reason ?? undefined}
                  >
                    <input
                      type="radio"
                      name="provider"
                      value={p}
                      checked={provider === p}
                      disabled={disabled}
                      onChange={() => setProvider(p)}
                      style={radioStyle}
                    />
                    {PROVIDER_LABELS[p]}
                  </label>
                );
              })}
            </div>
            {AGENT_PROVIDERS.filter((p) => unavailable[p] != null).map((p) => (
              <span key={p} style={unavailableNoteStyle}>
                {PROVIDER_LABELS[p]} Unavailable — {unavailable[p]}
              </span>
            ))}
          </fieldset>

          {agent && (
            <>
              <div style={fieldGroupStyle}>
                <label htmlFor={`${titleId}-model`} style={fieldLabelStyle}>
                  Model Alias
                </label>
                <input
                  id={`${titleId}-model`}
                  className="swarm-input"
                  value={modelAliases[agent]}
                  onChange={(e) =>
                    setModelAliases((prev) => ({ ...prev, [agent]: e.target.value }))
                  }
                  placeholder={MODEL_PLACEHOLDER[agent]}
                  autoComplete="off"
                  spellCheck={false}
                  style={{ fontFamily: "var(--font-mono)", fontSize: "0.8125rem" }}
                />
              </div>

              <fieldset style={fieldsetStyle}>
                <legend style={fieldLabelStyle}>Trust Tier</legend>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {TrustTierSchema.options.map((tier) => {
                    const info = TRUST_TIER_INFO[agent][tier];
                    const explanationId = `${titleId}-tier-${tier}`;
                    return (
                      <label key={tier} style={tierCardStyle(trustTier === tier)}>
                        <input
                          type="radio"
                          name="trust-tier"
                          value={tier}
                          checked={trustTier === tier}
                          onChange={() => setTrustTier(tier)}
                          aria-label={info.label}
                          aria-describedby={explanationId}
                          style={radioStyle}
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

          <div style={fieldGroupStyle}>
            <span style={fieldLabelStyle}>Working Directory</span>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={repoRootPathStyle} title={projectRoot ?? undefined}>
                {projectRoot === undefined
                  ? "Loading…"
                  : (projectRoot ?? "No Project Root — Spawns Without Worktree Isolation")}
              </span>
              <Button variant="secondary" size="sm" onClick={() => void pickProjectRoot()}>
                Choose…
              </Button>
            </div>
          </div>

          {notice && (
            <div role="alert" style={errorBannerStyle}>
              {notice}
            </div>
          )}

          {spawnError && (
            <div role="alert" style={errorBannerStyle}>
              {spawnError}
            </div>
          )}
        </div>

        <div style={footerStyle}>
          <Button variant="ghost" size="sm" onClick={closeDialog} disabled={isSpawning}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            size="sm"
            loading={isSpawning}
            disabled={projectRoot === undefined || (agent !== null && unavailable[agent] != null)}
          >
            Spawn Worker
          </Button>
        </div>
      </form>
    </dialog>
  );
}
