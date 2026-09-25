/**
 * Claude model catalog — the single source of truth for model IDs,
 * labels, limits, prices and per-model request capabilities on the
 * webview AI path (Settings, ModelSelector, the chat engine in
 * `#lib/ai-chat`, ship prose, cost accounting). No other module keeps
 * its own model list: widen this catalog and everything else derives
 * from it.
 *
 * Figures verified 2026-09-23 against the Claude models overview and
 * pricing pages (https://platform.claude.com/docs/en/about-claude/models/overview,
 * https://platform.claude.com/docs/en/about-claude/pricing). Current
 * lineup: Fable 5.1, Mythos 5.1 (Project Glasswing only), Opus 5.5,
 * Sonnet 5 ($2/$10 is its standard price — the once-scheduled rise to
 * $3/$15 was cancelled) and Haiku 4.5. Nothing newer exists.
 *
 * The {@link ModelKey} names are persisted (`selectedModelAtom`, worker
 * agent metadata, session templates), so a newer model replaces an
 * entry's `id`/`label`/prices, never its key.
 *
 * @module models
 */

import { toast } from "sonner";

/** Stable catalog keys, in display order. Persisted — never rename one. */
export const MODEL_KEYS = ["fable", "mythos", "opus", "sonnet", "haiku"] as const;

/** Stable identifier for a catalog entry. */
export type ModelKey = (typeof MODEL_KEYS)[number];

/** An access gate a model requires beyond a valid API key. */
export type ModelGate = "glasswing";

/** Metadata for a single Claude model. */
export interface ModelInfo {
  /** The Claude API model ID to pass as `model` in requests. */
  readonly id: string;
  /** Human-readable display label. */
  readonly label: string;
  /** Short Title Case description for the model picker UI. */
  readonly description: string;
  /** Context window size in tokens. */
  readonly contextWindow: number;
  /** Maximum output tokens per response (thinking included). */
  readonly maxOutputTokens: number;
  /** USD per million uncached input tokens (5-minute cache writes bill at 1.25x this). */
  readonly inputPerMTok: number;
  /** USD per million cache-read input tokens — not a fixed ratio: 0.025x on Fable 5.1, 0.05x on Opus 5.5, 0.1x elsewhere. */
  readonly cacheReadPerMTok: number;
  /** USD per million output tokens (thinking tokens bill as output). */
  readonly outputPerMTok: number;
  /**
   * Takes `thinking: { type: "adaptive" }`. Every current model except
   * Haiku 4.5 does (Fable/Mythos 5.1 and Opus 5.5 cannot turn thinking
   * off at all); Haiku 4.5 only has the legacy `budget_tokens` mode,
   * which the app does not use.
   */
  readonly adaptiveThinking: boolean;
  /** Accepts `output_config.effort` (Haiku 4.5 rejects it). */
  readonly effort: boolean;
  /**
   * Runs safety classifiers whose false positives the server-side
   * `fallbacks: "default"` opt-in (beta `server-side-fallback-2026-07-01`)
   * rescues by re-running a declined request on a recommended model.
   */
  readonly refusalFallback: boolean;
  /** Accepts mid-conversation `role: "system"` messages (not Sonnet 5 or Haiku 4.5). */
  readonly systemMessages: boolean;
  /** Access gate required beyond a valid API key, if any (Mythos → Project Glasswing). */
  readonly gated?: ModelGate;
}

/** The current Claude model catalog, keyed by a stable short name. */
export const CLAUDE_MODELS: Readonly<Record<ModelKey, ModelInfo>> = {
  fable: {
    id: "claude-fable-5-1",
    label: "Claude Fable 5.1",
    description: "Most Capable — Long-Horizon Reasoning And Agentic Work",
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    inputPerMTok: 10,
    cacheReadPerMTok: 0.25,
    outputPerMTok: 50,
    adaptiveThinking: true,
    effort: true,
    refusalFallback: true,
    systemMessages: true,
  },
  mythos: {
    id: "claude-mythos-5-1",
    label: "Claude Mythos 5.1",
    description: "Most Capable — Available Exclusively Through Project Glasswing",
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    inputPerMTok: 10,
    // Whether Mythos 5.1 shares Fable 5.1's $0.25 cache-read rate is
    // unannounced; the standard 0.1x keeps cost estimates conservative.
    cacheReadPerMTok: 1,
    outputPerMTok: 50,
    adaptiveThinking: true,
    effort: true,
    refusalFallback: true,
    systemMessages: true,
    gated: "glasswing",
  },
  opus: {
    id: "claude-opus-5-5",
    label: "Claude Opus 5.5",
    description: "Highly Capable — Long-Running Agentic Coding And Deep Analysis",
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    inputPerMTok: 4,
    cacheReadPerMTok: 0.2,
    outputPerMTok: 20,
    adaptiveThinking: true,
    effort: true,
    refusalFallback: true,
    systemMessages: true,
  },
  sonnet: {
    id: "claude-sonnet-5",
    label: "Claude Sonnet 5",
    description: "Balanced — Fast Reasoning For Everyday Orchestration",
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    inputPerMTok: 2,
    cacheReadPerMTok: 0.2,
    outputPerMTok: 10,
    adaptiveThinking: true,
    effort: true,
    refusalFallback: false,
    systemMessages: false,
  },
  haiku: {
    id: "claude-haiku-4-5",
    label: "Claude Haiku 4.5",
    description: "Fastest — Lightweight Tasks At The Lowest Cost",
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    inputPerMTok: 1,
    cacheReadPerMTok: 0.1,
    outputPerMTok: 5,
    adaptiveThinking: false,
    effort: false,
    refusalFallback: false,
    systemMessages: false,
  },
};

const MODELS_BY_ID: ReadonlyMap<string, ModelInfo> = new Map(
  MODEL_KEYS.map((key) => [CLAUDE_MODELS[key].id, CLAUDE_MODELS[key]]),
);

/** Looks up a model's catalog entry by its Claude API model ID. Returns `undefined` if unknown. */
export function getModelById(id: string): ModelInfo | undefined {
  return MODELS_BY_ID.get(id);
}

/** Token counts from a response's `usage` block (cache fields are `null` when absent). */
export interface UsageTokens {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_creation_input_tokens?: number | null;
  readonly cache_read_input_tokens?: number | null;
}

/**
 * Estimates the USD cost of one response from its `usage` block, priced
 * at the catalog rates of `modelId`: uncached input at the input rate,
 * 5-minute cache writes at 1.25x it, cache reads at the model's own
 * cache-read rate, output (thinking included) at the output rate.
 * Returns `0` for a model outside the catalog rather than guessing.
 */
export function estimateCostUsd(modelId: string, usage: UsageTokens): number {
  const model = getModelById(modelId);
  if (!model) return 0;
  const microDollars =
    usage.input_tokens * model.inputPerMTok +
    (usage.cache_creation_input_tokens ?? 0) * model.inputPerMTok * 1.25 +
    (usage.cache_read_input_tokens ?? 0) * model.cacheReadPerMTok +
    usage.output_tokens * model.outputPerMTok;
  return microDollars / 1_000_000;
}

/** Formats a token count as a compact label, e.g. `1M` / `200K`. */
function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${tokens / 1_000_000}M`;
  return `${Math.round(tokens / 1000)}K`;
}

/** Formats a model's context window as a compact, Title Case label, e.g. "1M Context". */
export function formatContextLabel(contextWindow: number): string {
  return `${formatTokenCount(contextWindow)} Context`;
}

/** Formats a model's max output as a compact, Title Case label, e.g. "128K Max Output". */
export function formatMaxOutputLabel(maxOutputTokens: number): string {
  return `${formatTokenCount(maxOutputTokens)} Max Output`;
}

/**
 * Fires the Project Glasswing warning toast for a gated model selection
 * (currently just Mythos) — selection itself is still allowed, this is a
 * notice, not a block. No-ops (and returns `false`) for non-gated models.
 *
 * Shared by both selection paths — the `ModelSelector` listbox and the
 * Settings model cards — so the gating check and copy live once. Callers
 * with their own default "selected" toast (e.g. Settings' "Switched To
 * X") should skip it when this returns `true`: one toast per selection,
 * never two.
 */
export function warnIfModelGated(model: ModelInfo): boolean {
  if (!model.gated) return false;
  toast.warning(`${model.label} Requires Project Glasswing Access`);
  return true;
}
