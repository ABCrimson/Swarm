// ── Claude Model Catalog ────────────────────────────
// Single source of truth for Claude model metadata used across the
// AI subsystem (Settings, ModelSelector, AIChat, useStream, cost estimation).
// No other module should maintain its own model list — widen this
// catalog and everything else derives from it.
//
// Figures confirmed against https://platform.claude.com/docs/en/about-claude/models/overview
// (fetched 2026-07-10). Standard (non-introductory) per-MTok pricing is used;
// Claude Sonnet 5 has introductory pricing of $2/$10 per MTok through 2026-08-31.

import { toast } from "sonner";

/** Stable identifier for a catalog entry. */
export type ModelKey = "fable" | "mythos" | "opus" | "sonnet" | "haiku";

/** An access gate a model requires beyond a valid API key. */
export type ModelGate = "glasswing";

/** Metadata for a single Claude model. */
export interface ModelInfo {
  /** The Claude API model ID (or alias) to pass as `model` in requests. */
  readonly id: string;
  /** Human-readable display label. */
  readonly label: string;
  /** One-line, Title Case summary of the model's role. */
  readonly description: string;
  /** Maximum context window, in tokens. */
  readonly contextWindow: number;
  /** Maximum output tokens per response. */
  readonly maxOutputTokens: number;
  /** Price per million input tokens, in USD. */
  readonly inputPerMTok: number;
  /** Price per million output tokens, in USD. */
  readonly outputPerMTok: number;
  /** Access gate required beyond a valid API key, if any (e.g. Mythos → Project Glasswing). */
  readonly gated?: ModelGate;
}

/** The current Claude model catalog, keyed by a stable short name. */
export const CLAUDE_MODELS: Record<ModelKey, ModelInfo> = {
  fable: {
    id: "claude-fable-5",
    label: "Claude Fable 5",
    description: "Most Capable — Long-Horizon Reasoning And Agentic Work",
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    inputPerMTok: 10,
    outputPerMTok: 50,
  },
  mythos: {
    id: "claude-mythos-5",
    label: "Claude Mythos 5",
    description: "Most Capable — Available Exclusively Through Project Glasswing",
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    inputPerMTok: 10,
    outputPerMTok: 50,
    gated: "glasswing",
  },
  opus: {
    id: "claude-opus-4-8",
    label: "Claude Opus 4.8",
    description: "Highly Capable — Complex Reasoning And Deep Analysis",
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    inputPerMTok: 5,
    outputPerMTok: 25,
  },
  sonnet: {
    id: "claude-sonnet-5",
    label: "Claude Sonnet 5",
    description: "Balanced — Fast Reasoning For Everyday Orchestration",
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    inputPerMTok: 3,
    outputPerMTok: 15,
  },
  haiku: {
    id: "claude-haiku-4-5",
    label: "Claude Haiku 4.5",
    description: "Fastest — Lightweight Tasks And Quick Queries",
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    inputPerMTok: 1,
    outputPerMTok: 5,
  },
};

/** Ordered list of catalog entries, for iteration/rendering. */
export const CLAUDE_MODEL_LIST: readonly ModelInfo[] = Object.values(CLAUDE_MODELS);

/**
 * Ordered list of catalog keys, in the same order as `CLAUDE_MODEL_LIST`.
 * The single source of truth for any exhaustive model-key union or Zod
 * enum built elsewhere (e.g. `WorkerConfigSchema`, `UiStoreSchema`) —
 * import this instead of re-listing `"opus" | "sonnet" | "haiku"`.
 */
export const MODEL_KEYS = Object.keys(CLAUDE_MODELS) as [ModelKey, ...ModelKey[]];

/** Looks up a model's metadata by its Claude API model ID. Returns undefined if unknown. */
export function getModelById(id: string): ModelInfo | undefined {
  return CLAUDE_MODEL_LIST.find((m) => m.id === id);
}

/** Looks up a model's context window by its Claude API model ID, falling back to 200K tokens. */
export function getContextWindow(id: string): number {
  return getModelById(id)?.contextWindow ?? 200_000;
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
 * Shared by both selection paths — the `ModelSelector` dropdown and the
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
