/**
 * Zod schemas for the `agent_*` event family and the agent command
 * results — the webview side of the provider-adapter layer
 * (`crates/swarm-core/src/agent/`, payloads emitted from
 * `crates/swarm-core/src/events/emitter.rs`).
 *
 * `#hooks/useAgentSessionEvents` parses every event with these schemas
 * at the event-bus seam before it reaches `#store/agent-sessions`; an
 * unexpected shape is dropped, never trusted via `as`.
 *
 * Field names are camelCase, mirroring the Rust structs'
 * `#[serde(rename_all = "camelCase")]`; closed enums mirror their Rust
 * `#[serde(rename_all = "snake_case")]` variants. `agent-events.contract.test.ts`
 * checks both against the Rust source, so a field or variant added on
 * either side without the other fails the test suite.
 *
 * @module agent-events
 */

import * as z from "zod";

// ── Enums ────────────────────────────────────────────

/** Mirrors Rust's `ProviderId` (`agent/adapter.rs`). */
export const ProviderIdSchema = z.enum([
  "claude_code",
  "codex",
  "open_code",
  "gemini",
  "webview_anthropic",
]);
export type ProviderId = z.infer<typeof ProviderIdSchema>;

/** Title Case display label per provider — the one list every provider-naming UI uses. */
export const PROVIDER_LABELS: Readonly<Record<ProviderId, string>> = {
  claude_code: "Claude Code",
  codex: "Codex",
  open_code: "Open Code",
  gemini: "Gemini",
  webview_anthropic: "Webview Anthropic",
};

/** Mirrors Rust's `CancelGranularity`. */
export const CancelGranularitySchema = z.enum(["kill_only", "graceful"]);
export type CancelGranularity = z.infer<typeof CancelGranularitySchema>;

/** Mirrors Rust's `PermissionDecision`. */
export const PermissionDecisionSchema = z.enum(["allow", "deny"]);
export type PermissionDecision = z.infer<typeof PermissionDecisionSchema>;

/** Mirrors Rust's `AgentTurnStatus`. */
export const AgentTurnStatusSchema = z.enum(["ok", "error"]);
export type AgentTurnStatus = z.infer<typeof AgentTurnStatusSchema>;

/**
 * The spawn-time trust dial, mirroring both Rust's `ClaudeCodeTrustTier`
 * (`agent/claude_code.rs`) and `CodexTrustTier` (`agent/codex.rs`) —
 * the same three wire tokens, each mapped by its adapter onto that
 * provider's own permission vocabulary. Neither mapping can express a
 * bypass-everything mode.
 */
export const TrustTierSchema = z.enum(["restricted", "standard", "write_enabled"]);
export type TrustTier = z.infer<typeof TrustTierSchema>;
/** The trust dial as `agent_spawn` takes it for a Claude Code session (see {@link TrustTierSchema}). */
export type ClaudeCodeTrustTier = TrustTier;

// ── Capabilities & probe ─────────────────────────────

/**
 * Mirrors Rust's `Capabilities`: what a provider can honestly promise,
 * each flag measured rather than assumed. A UI disables — never
 * silently no-ops — an affordance a session reports as unsupported.
 */
export const CapabilitiesSchema = z.object({
  partialDeltas: z.boolean(),
  resume: z.boolean(),
  nativeCost: z.boolean(),
  permissionModes: z.array(z.string()),
  cancelGranularity: CancelGranularitySchema,
  /** Sending during a turn interrupts it; otherwise the new turn queues behind it. */
  interruptMidturn: z.boolean(),
  worktreeAware: z.boolean(),
  /**
   * The provider blocks on an `agent_permission_request` until it is
   * answered with `agentPermissionRespond` (`#lib/tauri`). When `false`,
   * the event reports a decision the provider already made.
   */
  interactivePermissions: z.boolean(),
});
export type Capabilities = z.infer<typeof CapabilitiesSchema>;

/**
 * The `agent_probe` command's result (Rust's `ProbeReport`). `detail` is
 * always human-readable and never a credential.
 */
export const ProbeReportSchema = z.object({
  available: z.boolean(),
  version: z.string().nullish(),
  detail: z.string().nullish(),
});
export type ProbeReport = z.infer<typeof ProbeReportSchema>;

// ── Event payloads ───────────────────────────────────

/** `agent_session_started`. */
export const AgentSessionStartedPayloadSchema = z.object({
  workerId: z.uuid(),
  provider: ProviderIdSchema,
  sessionKey: z.string(),
  model: z.string(),
  cwd: z.string(),
  capabilities: CapabilitiesSchema,
});
export type AgentSessionStartedPayload = z.infer<typeof AgentSessionStartedPayloadSchema>;

/**
 * `agent_turn_delta` — ephemeral: never persisted or replayed, so a
 * consumer that misses one cannot recover it; the finalized
 * `agent_block` supersedes it.
 */
export const AgentTurnDeltaPayloadSchema = z.object({
  workerId: z.uuid(),
  turnId: z.string(),
  blockIndex: z.int().nonnegative(),
  kind: z.string(),
  text: z.string(),
});
export type AgentTurnDeltaPayload = z.infer<typeof AgentTurnDeltaPayloadSchema>;

/** `agent_block` — a finalized content block (the persisted counterpart of `agent_turn_delta`). */
export const AgentBlockPayloadSchema = z.object({
  workerId: z.uuid(),
  turnId: z.string(),
  blockIndex: z.int().nonnegative(),
  kind: z.string(),
  content: z.unknown(),
});
export type AgentBlockPayload = z.infer<typeof AgentBlockPayloadSchema>;

/** `agent_tool_call`. */
export const AgentToolCallPayloadSchema = z.object({
  workerId: z.uuid(),
  turnId: z.string(),
  toolUseId: z.string(),
  name: z.string(),
  input: z.unknown(),
});
export type AgentToolCallPayload = z.infer<typeof AgentToolCallPayloadSchema>;

/** `agent_tool_result` — `toolUseId` correlates it with its `agent_tool_call`. */
export const AgentToolResultPayloadSchema = z.object({
  workerId: z.uuid(),
  turnId: z.string(),
  toolUseId: z.string(),
  isError: z.boolean(),
  content: z.unknown(),
});
export type AgentToolResultPayload = z.infer<typeof AgentToolResultPayloadSchema>;

/**
 * `agent_permission_request` — the only permission-gating surface. With
 * `capabilities.interactivePermissions` (Codex) it is a pending question
 * answered through `agent_permission_respond`; otherwise (Claude Code)
 * it reports a denial the provider already made, classified by
 * `denialSubclass` when possible (`mode`, `ungranted_write`,
 * `redirection_guard` — free-form provider-observed text, not a closed
 * set). A provider's auto-approve list is never surfaced here, and its
 * absence is not a denial.
 *
 * Optional fields are omitted on the wire when unset but accepted as
 * `null` too.
 */
export const AgentPermissionRequestPayloadSchema = z.object({
  workerId: z.uuid(),
  turnId: z.string(),
  requestId: z.string(),
  tool: z.string(),
  input: z.unknown(),
  suggestedDecision: PermissionDecisionSchema.nullish(),
  denialSubclass: z.string().nullish(),
  /** The provider's own human-readable text (the denial message, or the command awaiting approval). */
  message: z.string().nullish(),
});
export type AgentPermissionRequestPayload = z.infer<typeof AgentPermissionRequestPayloadSchema>;

/**
 * `agent_turn_settled` — exactly once per turn, on success and on an
 * ungraceful child exit alike. `costUsd`/`usage` are `null` on a
 * synthesized (kill-path) settlement: honestly absent, never estimated.
 */
export const AgentTurnSettledPayloadSchema = z.object({
  workerId: z.uuid(),
  turnId: z.string(),
  status: AgentTurnStatusSchema,
  error: z.string().nullish(),
  costUsd: z.number().nullish(),
  usage: z.unknown().nullish(),
  durationMs: z.number().nonnegative(),
  numTurns: z.int().nonnegative().nullish(),
});
export type AgentTurnSettledPayload = z.infer<typeof AgentTurnSettledPayloadSchema>;

/** `agent_session_exited`. */
export const AgentSessionExitedPayloadSchema = z.object({
  workerId: z.uuid(),
  exitCode: z.int().nullish(),
  signal: z.string().nullish(),
});
export type AgentSessionExitedPayload = z.infer<typeof AgentSessionExitedPayloadSchema>;
