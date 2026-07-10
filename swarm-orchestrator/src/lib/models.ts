// ── Claude Model Catalog ────────────────────────────
// Single source of truth for Claude model metadata used across the
// AI subsystem (ModelSelector, AIChat, useStream, cost estimation).
//
// Figures confirmed against https://platform.claude.com/docs/en/about-claude/models/overview
// (fetched 2026-07-09). Standard (non-introductory) per-MTok pricing is used;
// Claude Sonnet 5 has introductory pricing of $2/$10 per MTok through 2026-08-31.

/** Stable identifier for a catalog entry. */
export type ModelKey = "fable" | "opus" | "sonnet" | "haiku";

/** Metadata for a single Claude model. */
export interface ModelInfo {
  /** The Claude API model ID (or alias) to pass as `model` in requests. */
  readonly id: string;
  /** Human-readable display label. */
  readonly label: string;
  /** Maximum context window, in tokens. */
  readonly contextWindow: number;
  /** Price per million input tokens, in USD. */
  readonly inputPerMTok: number;
  /** Price per million output tokens, in USD. */
  readonly outputPerMTok: number;
}

/** The current Claude model catalog, keyed by a stable short name. */
export const CLAUDE_MODELS: Record<ModelKey, ModelInfo> = {
  fable: {
    id: "claude-fable-5",
    label: "Claude Fable 5",
    contextWindow: 1_000_000,
    inputPerMTok: 10,
    outputPerMTok: 50,
  },
  opus: {
    id: "claude-opus-4-8",
    label: "Claude Opus 4.8",
    contextWindow: 1_000_000,
    inputPerMTok: 5,
    outputPerMTok: 25,
  },
  sonnet: {
    id: "claude-sonnet-5",
    label: "Claude Sonnet 5",
    contextWindow: 1_000_000,
    inputPerMTok: 3,
    outputPerMTok: 15,
  },
  haiku: {
    id: "claude-haiku-4-5-20251001",
    label: "Claude Haiku 4.5",
    contextWindow: 200_000,
    inputPerMTok: 1,
    outputPerMTok: 5,
  },
};

/** Ordered list of catalog entries, for iteration/rendering. */
export const CLAUDE_MODEL_LIST: readonly ModelInfo[] = Object.values(CLAUDE_MODELS);

/** Looks up a model's metadata by its Claude API model ID. Returns undefined if unknown. */
export function getModelById(id: string): ModelInfo | undefined {
  return CLAUDE_MODEL_LIST.find((m) => m.id === id);
}

/** Looks up a model's context window by its Claude API model ID, falling back to 200K tokens. */
export function getContextWindow(id: string): number {
  return getModelById(id)?.contextWindow ?? 200_000;
}
