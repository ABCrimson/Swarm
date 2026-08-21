import * as z from "zod";

/**
 * Zod schemas for the `agent_*` event family (multi-provider agent
 * execution, Phase 2 of the multi-provider plan — see
 * `docs/architecture.md`'s "Adapter Layer" section and
 * `crates/swarm-core/src/events/emitter.rs`).
 *
 * As of Phase 3, `ClaudeCodeAdapter` (`crates/swarm-core/src/agent/claude_code.rs`)
 * is a real, wired provider — `useAgentSessionEvents`
 * (`#hooks/useAgentSessionEvents`) and `AgentChat`
 * (`#components/ai/AgentChat`) consume this module's schemas via
 * `safeParse` at the event-bus seam, the same discipline
 * `#lib/event-bus`'s `DomainEventSchema` already applies at the
 * envelope level. Phase 4 adds `CodexAdapter`
 * (`crates/swarm-core/src/agent/codex.rs`) as a second, structurally
 * different provider (stateful JSON-RPC vs. one-way stream-json) behind
 * the SAME event family — see `Capabilities.interactivePermissions` for
 * the one wire-visible difference a consumer needs to branch on.
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
  /**
   * Phase 4: the provider's own protocol supports a REAL
   * `agent_permission_request` -> `agentPermissionRespond` round-trip —
   * `respondPermission` (`#lib/tauri`) actually answers a pending
   * question on the wire, as opposed to the event being a report-only
   * notice of an already-decided denial (Claude Code: `false` —
   * `--permission-mode manual` is a silent no-op, see
   * `AgentPermissionRequestPayloadSchema`'s doc). Codex: `true` — its
   * JSON-RPC app-server protocol issues a genuine server -> client
   * request that blocks until answered. A consumer MUST branch on this
   * flag before rendering Allow/Deny affordances rather than assuming
   * every provider behaves like Claude Code.
   */
  interactivePermissions: z.boolean(),
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
  // .nullable().optional() (review F1, belt #2 alongside Rust's
  // skip_serializing_if): Tauri's JSON bridge can hand back an
  // explicit `null` for an absent Option<T> in some serialization
  // paths even though the emitter now omits the key entirely on the
  // wire — accept both rather than trusting the omission alone.
  suggestedDecision: PermissionDecisionSchema.nullable().optional(),
  /**
   * Phase 3 semantics shift for `ClaudeCodeAdapter`: this event is a
   * REPORT of an already-decided denial, not a pending request — see
   * Rust's `AgentPermissionRequestPayload` doc. `denialSubclass` is one
   * of `"mode"` | `"ungranted_write"` | `"redirection_guard"` (the §0b
   * mini-spike's three observed subclasses) when classifiable, `null`
   * otherwise. Free-form (not a closed enum) — provider-observed text
   * classification, not a SWARM-owned vocabulary.
   */
  denialSubclass: z.string().nullable().optional(),
  /** Raw, human-readable denial message from the provider, verbatim. */
  message: z.string().nullable().optional(),
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

/**
 * Phase 3: `ClaudeCodeAdapter`'s spawn-time trust dial
 * (`crates/swarm-core/src/agent/claude_code.rs`'s `ClaudeCodeTrustTier`).
 * Spawn-time only — permission modes are never a mid-turn prompt for
 * this provider (the interactive round-trip is a documented no-op, see
 * `AgentPermissionRequestPayloadSchema`'s semantics-shift doc below).
 */
export const ClaudeCodeTrustTierSchema = z.enum(["restricted", "standard", "write_enabled"]);
export type ClaudeCodeTrustTier = z.infer<typeof ClaudeCodeTrustTierSchema>;

/**
 * Phase 4: `CodexAdapter`'s spawn-time trust dial
 * (`crates/swarm-core/src/agent/codex.rs`'s `CodexTrustTier`). The same
 * three wire tokens as {@link ClaudeCodeTrustTierSchema} by deliberate
 * design symmetry, but mapped onto Codex's own
 * `approvalPolicy`/`sandboxPolicy` vocabulary
 * (`untrusted`/`on-request`/`on-failure`, never `"never"` — Codex's
 * full-auto/bypass-equivalent mode is unconstructible through this
 * vocabulary, mirroring Claude Code's `bypassPermissions`/`manual`).
 */
export const CodexTrustTierSchema = z.enum(["restricted", "standard", "write_enabled"]);
export type CodexTrustTier = z.infer<typeof CodexTrustTierSchema>;

/**
 * Payload schema for the `agent_probe` command's response
 * (mirrors Rust's `ProbeReport`, `crates/swarm-core/src/agent/adapter.rs`).
 * `detail` is always human-readable, never a credential — see
 * `ProbeReport`'s doc ("Detect and report, never store").
 */
export const ProbeReportSchema = z.object({
  available: z.boolean(),
  version: z.string().nullable().optional(),
  detail: z.string().nullable().optional(),
});
export type ProbeReport = z.infer<typeof ProbeReportSchema>;
