import * as z from "zod";

/**
 * Zod schemas for the `agent_*` event family (multi-provider agent
 * execution, Phase 2 of the multi-provider plan — see
 * `docs/architecture.md`'s "Adapter Layer" section and
 * `crates/swarm-core/src/events/emitter.rs`).
 *
 * **Additive, event-bus-consumption-only — no UI wired to these yet.**
 * No concrete `AgentAdapter` implementation exists (that's Phase 3's
 * `ClaudeCodeAdapter`), so nothing in the shipped app ever emits these
 * payloads today. **This module is consumed starting Phase 3** — the
 * next consumer is a `useAgentEvents` hook, mirroring
 * `#hooks/useWorkerEvents`'s `onEvent(type, handler)` pattern, which
 * will `safeParse` a payload instead of trusting an `as` cast, the same
 * discipline `#lib/event-bus`'s `DomainEventSchema` already applies at
 * the envelope level.
 *
 * Field names are camelCase, mirroring the Rust payload structs'
 * `#[serde(rename_all = "camelCase")]` convention exactly.
 *
 * **Manual cross-language contract, no automated diff:** every closed
 * enum below (`ProviderIdSchema`, `CancelGranularitySchema`,
 * `PermissionDecisionSchema`) is hand-kept in sync with its Rust
 * counterpart in `crates/swarm-core/src/agent/adapter.rs`. The Rust
 * side pins its wire values in a dedicated test
 * (`agent::adapter::tests::test_provider_id_wire_values_pinned_for_the_typescript_schema`)
 * — if that test ever needs to change, this file needs the identical
 * edit, and vice versa.
 */

/** Mirrors Rust's `ProviderId` (`crates/swarm-core/src/agent/adapter.rs`) — closed, snake_case wire values. */
export const ProviderIdSchema = z.enum([
  "claude_code",
  "codex",
  "open_code",
  "gemini",
  "webview_anthropic",
]);
export type ProviderId = z.infer<typeof ProviderIdSchema>;

/** Mirrors Rust's `CancelGranularity`. */
export const CancelGranularitySchema = z.enum(["kill_only", "graceful"]);
export type CancelGranularity = z.infer<typeof CancelGranularitySchema>;

/** Mirrors Rust's `PermissionDecision`. */
export const PermissionDecisionSchema = z.enum(["allow", "deny"]);
export type PermissionDecision = z.infer<typeof PermissionDecisionSchema>;

/**
 * Mirrors Rust's `Capabilities` — see its doc for the "honesty
 * doctrine": every field traces to an empirical Phase 1 spike finding,
 * never an aspiration. A future UI must disable (not silently no-op)
 * an affordance a session's `capabilities` reports as unsupported.
 */
export const CapabilitiesSchema = z.object({
  partialDeltas: z.boolean(),
  resume: z.boolean(),
  nativeCost: z.boolean(),
  permissionModes: z.array(z.string()),
  cancelGranularity: CancelGranularitySchema,
  interruptMidturn: z.boolean(),
  worktreeAware: z.boolean(),
});
export type Capabilities = z.infer<typeof CapabilitiesSchema>;

/** Payload schema for the `agent_session_started` event. */
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
 * Payload schema for the `agent_turn_delta` event. EPHEMERAL on the
 * Rust side (never persisted, never replayed after a gap) — the same
 * is true here: a consumer that misses one live cannot recover it via
 * `events_since`.
 */
export const AgentTurnDeltaPayloadSchema = z.object({
  workerId: z.uuid(),
  turnId: z.string(),
  blockIndex: z.number().int().nonnegative(),
  kind: z.string(),
  text: z.string(),
});
export type AgentTurnDeltaPayload = z.infer<typeof AgentTurnDeltaPayloadSchema>;

/** Payload schema for the `agent_block` event (persisted counterpart to `agent_turn_delta`). */
export const AgentBlockPayloadSchema = z.object({
  workerId: z.uuid(),
  turnId: z.string(),
  blockIndex: z.number().int().nonnegative(),
  kind: z.string(),
  content: z.unknown(),
});
export type AgentBlockPayload = z.infer<typeof AgentBlockPayloadSchema>;

/** Payload schema for the `agent_tool_call` event. */
export const AgentToolCallPayloadSchema = z.object({
  workerId: z.uuid(),
  turnId: z.string(),
  toolUseId: z.string(),
  name: z.string(),
  input: z.unknown(),
});
export type AgentToolCallPayload = z.infer<typeof AgentToolCallPayloadSchema>;

/** Payload schema for the `agent_tool_result` event — `toolUseId` correlates with the originating `agent_tool_call`. */
export const AgentToolResultPayloadSchema = z.object({
  workerId: z.uuid(),
  turnId: z.string(),
  toolUseId: z.string(),
  isError: z.boolean(),
  content: z.unknown(),
});
export type AgentToolResultPayload = z.infer<typeof AgentToolResultPayloadSchema>;

/**
 * Payload schema for the `agent_permission_request` event.
 *
 * **Condition C (binding, see `docs/architecture.md`):** this event,
 * answered via a future `agent_permission_respond` command, is the
 * ONLY legitimate permission-gating surface. `allowedTools` (a
 * provider CLI flag, never surfaced here) is an auto-approve list, not
 * a restriction — a future consumer must never treat its absence as a
 * denial.
 */
export const AgentPermissionRequestPayloadSchema = z.object({
  workerId: z.uuid(),
  turnId: z.string(),
  requestId: z.string(),
  tool: z.string(),
  input: z.unknown(),
  suggestedDecision: PermissionDecisionSchema.optional(),
});
export type AgentPermissionRequestPayload = z.infer<typeof AgentPermissionRequestPayloadSchema>;

/**
 * Payload schema for the `agent_turn_settled` receipt — exactly once
 * per turn, on success AND on ungraceful child exit (Condition B).
 * `costUsd`/`usage` are `null` on a synthesized (kill-path) settlement
 * — honestly absent, never a fabricated estimate. `status` mirrors
 * Rust's closed `AgentTurnStatus` enum (not a bare string) — see this
 * file's header doc on the manual cross-language contract.
 */
export const AgentTurnSettledPayloadSchema = z.object({
  workerId: z.uuid(),
  turnId: z.string(),
  status: z.enum(["ok", "error"]),
  error: z.string().nullable().optional(),
  costUsd: z.number().nullable().optional(),
  usage: z.unknown().nullable().optional(),
  durationMs: z.number().nonnegative(),
  numTurns: z.number().int().nonnegative().nullable().optional(),
});
export type AgentTurnSettledPayload = z.infer<typeof AgentTurnSettledPayloadSchema>;

/** Payload schema for the `agent_session_exited` event. */
export const AgentSessionExitedPayloadSchema = z.object({
  workerId: z.uuid(),
  exitCode: z.number().int().nullable().optional(),
  signal: z.string().nullable().optional(),
});
export type AgentSessionExitedPayload = z.infer<typeof AgentSessionExitedPayloadSchema>;
