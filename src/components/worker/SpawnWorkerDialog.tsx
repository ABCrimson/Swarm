import { open as openFolderPicker } from "@tauri-apps/plugin-dialog";
import { Suspense, use, useActionState, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "#components/ui/Button";
import { Reveal } from "#components/ui/Reveal";
import { PROVIDER_LABELS, type TrustTier, TrustTierSchema } from "#lib/agent-events";
import { escapeForDisplay } from "#lib/display-escape";
import { errorMessage } from "#lib/is-error";
import { DEFAULT_REPO_ROOT_KEY, getPersistedRepoRoot } from "#lib/project-root";
import {
  AgentSpawnCommandError,
  agentProbe,
  agentSpawn,
  DESKTOP_ONLY_REASON,
  hasCapability,
  spawnWorker,
  validateRepoRoot,
  writeConfig,
} from "#lib/tauri";

/** Where a new worker's chat runs: the webview's own Claude client, or an attached agent CLI. */
type SpawnProvider = "webview_anthropic" | "claude_code" | "codex";

/** Providers that attach an agent session (and take a model alias and trust tier). */
type AgentProvider = Extract<SpawnProvider, "claude_code" | "codex">;

const AGENT_PROVIDERS: readonly AgentProvider[] = ["claude_code", "codex"];

const ALL_PROVIDERS = ["webview_anthropic", ...AGENT_PROVIDERS] as const;

/** Why an agent provider cannot be used: `null` = available, a string = the reason. */
type ProbeReasons = Readonly<Partial<Record<AgentProvider, string | null>>>;

/**
 * The probe answers so far. `next` settles when one more probe answers,
 * so the provider rows fill in as each probe lands; it is `null` once
 * every probe has answered.
 */
interface ProbeAnswers {
  readonly reasons: ProbeReasons;
  readonly next: Promise<ProbeAnswers> | null;
}

/**
 * Reads in flight, keyed by what they read (a provider's probe, the saved
 * project root). Each open of the dialog pins the promises it was handed
 * (see {@link SpawnWorkerDialog}); a settled read leaves the cache, so the
 * next open probes and reads afresh — an install or sign-in done while the
 * app runs is picked up — while reads that overlap (Strict Mode's double
 * mount) share one call.
 */
const inFlight = new Map<string, Promise<unknown>>();

function sharedRead<T>(key: string, read: () => Promise<T>): Promise<T> {
  const cached = inFlight.get(key) as Promise<T> | undefined;
  if (cached !== undefined) return cached;
  const promise = read();
  inFlight.set(key, promise);
  void promise.then(() => {
    if (inFlight.get(key) === promise) inFlight.delete(key);
  });
  return promise;
}

/** Probes `p`; it never rejects, since a failed probe is itself a reason to disable the provider. */
function probeReason(p: AgentProvider): Promise<string | null> {
  return sharedRead(`probe:${p}`, () =>
    agentProbe(p).then(
      (report) =>
        report.available ? null : (report.detail ?? `${PROVIDER_LABELS[p]} CLI Not Available`),
      (err: unknown) => `Probe Failed: ${errorMessage(err)}`,
    ),
  );
}

/** The answers to `probes` beyond `known`, one more each time a probe settles. */
function probeAnswers(
  probes: Readonly<Record<AgentProvider, Promise<string | null>>>,
  known: ProbeReasons = {},
): Promise<ProbeAnswers> {
  const waiting = AGENT_PROVIDERS.filter((p) => !Object.hasOwn(known, p));
  return Promise.race(waiting.map((p) => probes[p].then((reason) => [p, reason] as const))).then(
    ([p, reason]) => {
      const reasons = { ...known, [p]: reason };
      return { reasons, next: waiting.length > 1 ? probeAnswers(probes, reasons) : null };
    },
  );
}

/** The saved project root as the dialog opens: the validated root (or `null`), and what went wrong reading it. */
interface SavedRoot {
  readonly root: string | null;
  readonly notice: string | null;
}

/**
 * Reads and revalidates the persisted project root. It never rejects: a
 * failure is a notice shown in the dialog itself, since a modal's top layer
 * paints over, and makes inert, the page-level toaster.
 */
function readSavedRoot(): Promise<SavedRoot> {
  return sharedRead(DEFAULT_REPO_ROOT_KEY, async () => {
    let persisted: string | null;
    try {
      persisted = await getPersistedRepoRoot();
    } catch (err) {
      return {
        root: null,
        notice: `Could Not Read The Saved Project Root: ${escapeForDisplay(errorMessage(err))}`,
      };
    }
    if (!persisted) return { root: null, notice: null };
    try {
      return { root: await validateRepoRoot(persisted), notice: null };
    } catch (err) {
      return {
        root: null,
        notice: `Could Not Validate The Saved Project Root ${escapeForDisplay(persisted)}: ${escapeForDisplay(errorMessage(err))}`,
      };
    }
  });
}

/** What the dialog reads as it opens, pinned for that open. */
function openReads(): {
  readonly probes: Readonly<Record<AgentProvider, Promise<string | null>>>;
  readonly answers: Promise<ProbeAnswers>;
  readonly savedRoot: Promise<SavedRoot>;
} {
  const probes = { claude_code: probeReason("claude_code"), codex: probeReason("codex") };
  return { probes, answers: probeAnswers(probes), savedRoot: readSavedRoot() };
}

/**
 * Renders `render(reasons)` with the probe answers so far: each step
 * suspends on the next answer and keeps showing the previous one meanwhile.
 */
function WithProbeAnswers({
  answers,
  render,
}: {
  readonly answers: Promise<ProbeAnswers>;
  readonly render: (reasons: ProbeReasons) => React.ReactNode;
}): React.ReactNode {
  const { reasons, next } = use(answers);
  const shown = render(reasons);
  if (next === null) return shown;
  return (
    <Suspense fallback={shown}>
      <WithProbeAnswers answers={next} render={render} />
    </Suspense>
  );
}

/** The probe-dependent `render` under its own boundary: before any probe answers, every agent provider counts as probing. */
function probeBoundary(
  answers: Promise<ProbeAnswers>,
  render: (reasons: ProbeReasons) => React.ReactNode,
): React.ReactElement {
  return (
    <Reveal fallback={render({})}>
      <WithProbeAnswers answers={answers} render={render} />
    </Reveal>
  );
}

/** The working-directory path, with the full path as its tooltip. */
function RootPath({ root }: { readonly root: string | null }): React.ReactElement {
  return (
    <span
      className={REPO_ROOT_PATH_CLASS}
      title={root == null ? undefined : escapeForDisplay(root)}
    >
      {escapeForDisplay(root ?? "No Project Root — Spawns Without Worktree Isolation")}
    </span>
  );
}

function SavedRootPath({ read }: { readonly read: Promise<SavedRoot> }): React.ReactElement {
  return <RootPath root={use(read).root} />;
}

function Notice({ text }: { readonly text: string | null }): React.ReactElement | null {
  if (!text) return null;
  return (
    <div role="alert" className={ERROR_BANNER_CLASS}>
      {text}
    </div>
  );
}

function SavedRootNotice({
  read,
}: {
  readonly read: Promise<SavedRoot>;
}): React.ReactElement | null {
  return <Notice text={use(read).notice} />;
}

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

// ── Styles (utility classes) ───────────────────────────────────────────────────────────

/**
 * Tailwind's preflight zeroes dialog margins; `m-auto` re-centers the modal.
 * The glow ring and the drop shadow are one composite `box-shadow`.
 */
const DIALOG_CLASS =
  "m-auto w-130 max-w-[calc(100vw-32px)] max-h-[85vh] overflow-hidden rounded-lg border border-border-2 bg-surface-1 p-0 text-fg shadow-[0_0_0_1px_oklch(from_var(--color-plasma)_l_c_h/0.1),0_16px_48px_oklch(from_var(--color-void)_l_c_h/0.6)]";

const FORM_CLASS = "flex max-h-[85vh] flex-col";

const HEADER_CLASS =
  "flex shrink-0 items-center justify-between border-b border-border px-4 py-3.5";

const TITLE_CLASS = "m-0 font-display font-semibold text-(length:--text-lg) text-fg-bright";

/** Matches `.swarm-btn:disabled` while spawning: the look of the footer Cancel button when disabled. */
function closeButtonClass(disabled: boolean): string {
  return `flex size-7 items-center justify-center rounded-[6px] border-none bg-transparent text-fg-dim ${
    disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"
  }`;
}

const BODY_CLASS = "flex flex-1 flex-col gap-4.5 overflow-y-auto p-4";

const FIELD_GROUP_CLASS = "flex flex-col gap-2";

const FIELDSET_CLASS = `${FIELD_GROUP_CLASS} m-0 border-none p-0`;

const FIELD_LABEL_CLASS = "p-0 font-medium font-sans text-(length:--text-md) text-fg";

const SEGMENTED_GROUP_CLASS = "flex rounded-md border border-border bg-surface-0 p-0.5";

function segmentClass(active: boolean, disabled: boolean): string {
  const color = disabled ? "text-fg-dim" : active ? "text-plasma" : "text-fg-muted";
  return `flex flex-auto items-center justify-center gap-1.5 whitespace-nowrap rounded-[6px] px-3 py-2 font-medium font-sans text-(length:--text-md) ${
    active ? "bg-plasma/15" : "bg-transparent"
  } ${color} ${disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"}`;
}

const UNAVAILABLE_NOTE_CLASS = "font-sans text-amber text-sm";

function tierCardClass(active: boolean): string {
  return `flex cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2.5 ${
    active ? "border-[oklch(0.55_0.14_205)] bg-plasma/10" : "border-border bg-surface-0/60"
  }`;
}

/**
 * `accent-color` themes the trust-tier radios' native dot to the house accent.
 * The provider radios are `sr-only`: their segment's fill shows the choice,
 * plus a focus outline and, in forced colors, a Highlight outline when checked.
 */
const RADIO_CLASS = "mt-0.5 shrink-0 cursor-pointer accent-plasma";

const TIER_LABEL_CLASS = "font-sans font-semibold text-(length:--text-md) text-fg-bright";

const TIER_EXPLANATION_CLASS = "font-sans text-fg-dim text-xs leading-[1.4]";

const REPO_ROOT_PATH_CLASS =
  "min-w-0 flex-1 truncate rounded-md border border-border bg-surface-0/60 px-3 py-2 font-mono text-(length:--text-sm) text-fg-muted";

const ERROR_BANNER_CLASS =
  "rounded-md border border-[oklch(0.45_0.18_25)] bg-[oklch(0.16_0.08_25/0.4)] px-3 py-2 font-sans text-[oklch(0.82_0.19_25)] text-sm leading-[1.4]";

const FOOTER_CLASS = "flex shrink-0 justify-end gap-2 border-t border-border px-4 py-3";

/**
 * Whether a viewport point lies outside the dialog's border box (on its
 * `::backdrop`).
 */
function isOutside(dialog: HTMLDialogElement, x: number, y: number): boolean {
  const box = dialog.getBoundingClientRect();
  return x < box.left || x > box.right || y < box.top || y > box.bottom;
}

// ── Component ─────────────────────────────────────────

/**
 * The Workers page's spawn dialog, a native modal `<dialog>` opened with
 * `showModal()` (top layer, inert page, native focus handling and focus
 * return; Escape and backdrop clicks close it via `closedby="any"`, and
 * a press-and-release backdrop test where the engine lacks `closedby`).
 *
 * - Provider: Webview Anthropic, Claude Code or Codex. Webview Anthropic
 *   is the default where the build has the `localAiChat` capability;
 *   elsewhere (the swarmd web page) it is disabled with the reason shown
 *   and Claude Code is the default. Each agent CLI is probed every time the dialog opens, so an install or
 *   sign-in done while the app runs is picked up; an unavailable (or
 *   unprobeable) provider is disabled with the reason shown, never
 *   silently accepted. A provider stays enabled while its probe is in
 *   flight.
 * - Model alias and trust tier for agent providers, each tier explained
 *   per provider.
 * - Working directory: the persisted project root (revalidated as a git
 *   repository), changeable with the native folder picker, which is
 *   disabled with the reason shown where the build lacks the
 *   `workspaceBrowsing` capability.
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
  // A disabled button is out of the tab order and may show no tooltip, so the
  // reason is visible text that the button references.
  const canPickFolder = hasCapability("workspaceBrowsing");
  const folderReasonId = useId();
  // The webview's own Claude client exists only in the desktop app, so a
  // build without `localAiChat` (the swarmd web page) starts on an agent CLI.
  const webviewReason = hasCapability("localAiChat") ? null : DESKTOP_ONLY_REASON;
  const [provider, setProvider] = useState<SpawnProvider>(
    webviewReason === null ? "webview_anthropic" : "claude_code",
  );
  const [modelAliases, setModelAliases] = useState<Record<AgentProvider, string>>({
    ...DEFAULT_MODEL_ALIAS,
  });
  const [trustTier, setTrustTier] = useState<TrustTier>("standard");
  // The probes and the saved-root read, started once per open and read
  // with `use()` by the rows that show them, each under its own boundary.
  const [reads] = useState(openReads);
  // A root chosen with the folder picker; undefined = none yet, so the saved one shows.
  const [pickedRoot, setPickedRoot] = useState<string | undefined>(undefined);
  // Project-root problems shown in the dialog itself: a modal's top layer
  // paints over, and makes inert, the page-level toaster. undefined = no
  // pick yet, so the saved root's own notice shows.
  const [notice, setNotice] = useState<string | null | undefined>(undefined);

  /** Why `p` cannot be used given the probe answers so far: undefined = probing, null = available, string = the reason. */
  function providerReason(p: SpawnProvider, reasons: ProbeReasons): string | null | undefined {
    return isAgentProvider(p) ? reasons[p] : webviewReason;
  }

  const [spawnError, spawn, isSpawning] = useActionState(async (): Promise<string | null> => {
    // A spawn started while a probe or the saved-root read is in flight waits for its answer.
    const reason = isAgentProvider(provider) ? await reads.probes[provider] : webviewReason;
    if (reason != null) return `${PROVIDER_LABELS[provider]} Unavailable: ${reason}`;
    const projectRoot = pickedRoot !== undefined ? pickedRoot : (await reads.savedRoot).root;
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

  // The one user-dismissal path for the close and Cancel buttons and, where
  // `closedby` is missing, a backdrop click (Escape and native light dismiss
  // go through `onCancel`, same rule): a dialog
  // dismissed mid-spawn leaves the result nowhere to go. The `spawn` action
  // calls `closeDialog` directly because it closes while `isSpawning` is
  // still true.
  const requestDismiss = () => {
    if (!isSpawning) closeDialog();
  };

  // Whether the current press began on the backdrop: a drag-select that
  // starts in an input and ends outside the dialog fires `click` on the
  // dialog too, and must not dismiss it.
  const backdropPressRef = useRef(false);

  const pickProjectRoot = async () => {
    let selected: string | null;
    try {
      selected = await openFolderPicker({
        title: "Choose Project Root For Worktree Isolation",
        directory: true,
        multiple: false,
      });
    } catch (err) {
      setNotice(`Could Not Open The Folder Picker: ${escapeForDisplay(errorMessage(err))}`);
      return;
    }
    if (!selected) return;
    let toplevel: string;
    try {
      toplevel = await validateRepoRoot(selected);
    } catch (err) {
      setNotice(
        `Could Not Use ${escapeForDisplay(selected)} As The Project Root: ${escapeForDisplay(errorMessage(err))}`,
      );
      return;
    }
    setPickedRoot(toplevel);
    setNotice(null);
    try {
      await writeConfig(DEFAULT_REPO_ROOT_KEY, toplevel);
    } catch (err) {
      setNotice(`Could Not Save Project Root: ${escapeForDisplay(errorMessage(err))}`);
    }
  };

  const agent = isAgentProvider(provider) ? provider : null;

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the keyboard path is Escape (the dialog's native `cancel`); this click handler only adds backdrop dismissal where `closedby` is missing.
    <dialog
      ref={showModalOnMount}
      closedby="any"
      aria-labelledby={titleId}
      onClose={onClose}
      onPointerDown={(e) => {
        backdropPressRef.current =
          e.target === e.currentTarget && isOutside(e.currentTarget, e.clientX, e.clientY);
      }}
      onClick={(e) => {
        // Only engines without `closedby` (WebKit today) take this path. A
        // backdrop click is pressed and released on the dialog itself at a
        // point outside its border box; mid-spawn it is refused like every
        // other dismissal.
        const pressed = backdropPressRef.current;
        backdropPressRef.current = false;
        if ("closedBy" in HTMLDialogElement.prototype) return;
        if (
          pressed &&
          e.target === e.currentTarget &&
          isOutside(e.currentTarget, e.clientX, e.clientY)
        )
          requestDismiss();
      }}
      onCancel={(e) => {
        // Escape and backdrop light-dismiss; never mid-spawn (see `requestDismiss`).
        if (isSpawning) e.preventDefault();
      }}
      className={`${DIALOG_CLASS} opacity-0 translate-y-2 transition-[opacity,translate,display,overlay] transition-discrete duration-200 ease-out-cubic open:translate-y-0 open:opacity-100 starting:open:translate-y-2 starting:open:opacity-0 backdrop:bg-[oklch(0.04_0.01_220/0.55)] backdrop:backdrop-blur-[2px] backdrop:opacity-0 backdrop:transition-opacity backdrop:duration-200 backdrop:ease-out-cubic open:backdrop:opacity-100 starting:open:backdrop:opacity-0`}
    >
      <form ref={formRef} action={spawn} className={FORM_CLASS}>
        <div className={HEADER_CLASS}>
          <h2 id={titleId} className={TITLE_CLASS}>
            Spawn Worker
          </h2>
          <button
            type="button"
            onClick={requestDismiss}
            disabled={isSpawning}
            aria-label="Close Spawn Worker Dialog"
            className={closeButtonClass(isSpawning)}
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

        <div className={BODY_CLASS}>
          <fieldset className={FIELDSET_CLASS}>
            <legend className={FIELD_LABEL_CLASS}>Provider</legend>
            {probeBoundary(reads.answers, (reasons) => (
              <>
                <div className={SEGMENTED_GROUP_CLASS}>
                  {ALL_PROVIDERS.map((p) => {
                    const reason = providerReason(p, reasons);
                    const disabled = reason != null;
                    return (
                      <label
                        key={p}
                        className={`relative ${segmentClass(provider === p, disabled)} has-focus-visible:outline-2 has-focus-visible:-outline-offset-2 has-focus-visible:outline-plasma forced-colors:has-checked:outline-2 forced-colors:has-checked:outline-[Highlight]`}
                        title={reason ?? undefined}
                      >
                        <input
                          type="radio"
                          name="provider"
                          value={p}
                          checked={provider === p}
                          disabled={disabled}
                          onChange={() => setProvider(p)}
                          className="sr-only"
                        />
                        {PROVIDER_LABELS[p]}
                      </label>
                    );
                  })}
                </div>
                {Map.groupBy(
                  ALL_PROVIDERS.filter((p) => providerReason(p, reasons) != null),
                  (p) => String(providerReason(p, reasons)),
                )
                  .entries()
                  .map(([reason, ps]) => (
                    <span key={reason} className={UNAVAILABLE_NOTE_CLASS}>
                      {ps.map((p) => PROVIDER_LABELS[p]).join(" And ")} Unavailable — {reason}
                    </span>
                  ))
                  .toArray()}
              </>
            ))}
          </fieldset>

          {agent && (
            <>
              <div className={FIELD_GROUP_CLASS}>
                <label htmlFor={`${titleId}-model`} className={FIELD_LABEL_CLASS}>
                  Model Alias
                </label>
                <input
                  id={`${titleId}-model`}
                  className="swarm-input font-mono text-(length:--text-md)"
                  value={modelAliases[agent]}
                  onChange={(e) =>
                    setModelAliases((prev) => ({ ...prev, [agent]: e.target.value }))
                  }
                  placeholder={MODEL_PLACEHOLDER[agent]}
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>

              <fieldset className={FIELDSET_CLASS}>
                <legend className={FIELD_LABEL_CLASS}>Trust Tier</legend>
                <div className="flex flex-col gap-1.5">
                  {TrustTierSchema.options.map((tier) => {
                    const info = TRUST_TIER_INFO[agent][tier];
                    const explanationId = `${titleId}-tier-${tier}`;
                    return (
                      <label key={tier} className={tierCardClass(trustTier === tier)}>
                        <input
                          type="radio"
                          name="trust-tier"
                          value={tier}
                          checked={trustTier === tier}
                          onChange={() => setTrustTier(tier)}
                          aria-label={info.label}
                          aria-describedby={explanationId}
                          className={RADIO_CLASS}
                        />
                        <span className="flex flex-col gap-[3px]">
                          <span className={TIER_LABEL_CLASS}>{info.label}</span>
                          <span id={explanationId} className={TIER_EXPLANATION_CLASS}>
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

          <div className={FIELD_GROUP_CLASS}>
            <span className={FIELD_LABEL_CLASS}>Working Directory</span>
            <div className="flex items-center gap-2">
              {pickedRoot !== undefined ? (
                <RootPath root={pickedRoot} />
              ) : (
                <Reveal fallback={<span className={REPO_ROOT_PATH_CLASS}>Loading…</span>}>
                  <SavedRootPath read={reads.savedRoot} />
                </Reveal>
              )}
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void pickProjectRoot()}
                disabled={!canPickFolder}
                aria-describedby={canPickFolder ? undefined : folderReasonId}
              >
                Choose…
              </Button>
            </div>
            {!canPickFolder && (
              <span id={folderReasonId} className={UNAVAILABLE_NOTE_CLASS}>
                {DESKTOP_ONLY_REASON}
              </span>
            )}
          </div>

          {notice !== undefined ? (
            <Notice text={notice} />
          ) : (
            <Reveal fallback={null}>
              <SavedRootNotice read={reads.savedRoot} />
            </Reveal>
          )}

          {spawnError && (
            <div role="alert" className={ERROR_BANNER_CLASS}>
              {spawnError}
            </div>
          )}
        </div>

        <div className={FOOTER_CLASS}>
          <Button variant="ghost" size="sm" onClick={requestDismiss} disabled={isSpawning}>
            Cancel
          </Button>
          {probeBoundary(reads.answers, (reasons) => (
            <Button
              type="submit"
              variant="primary"
              size="sm"
              loading={isSpawning}
              disabled={providerReason(provider, reasons) != null}
            >
              Spawn Worker
            </Button>
          ))}
        </div>
      </form>
    </dialog>
  );
}
