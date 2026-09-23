import * as z from "zod";
import { MODEL_KEYS } from "#lib/models";

// ── Worker schemas ──────────────────────────────────

/** Zod schema for worker lifecycle states. */
export const WorkerStateSchema = z.enum(["idle", "running", "paused", "error"]);

/** Lifecycle state of a SWARM worker process. */
export type WorkerState = z.infer<typeof WorkerStateSchema>;

/** Zod schema for a SWARM worker entity. */
export const WorkerSchema = z.object({
  id: z.uuid(),
  state: WorkerStateSchema,
  name: z.string().optional(),
  pid: z.int().optional(),
  startedAt: z.iso.datetime(),
  output: z.string().optional(),
  /**
   * Absolute path of this worker's git worktree, mirrored from the
   * `worktree_created` event (`#hooks/useWorkerEvents`). Absent for a
   * worker spawned without isolation.
   */
  worktreePath: z.string().optional(),
  /** Branch checked out in `worktreePath` (`swarm/<slug>-<id8>`). */
  branch: z.string().optional(),
});

/** A SWARM worker process with its current state and metadata. */
export type Worker = z.infer<typeof WorkerSchema>;

// ── Session schemas ─────────────────────────────────

/** Zod schema for session metadata (description, tags, template reference). */
export const SessionMetadataSchema = z.object({
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  templateId: z.string().optional(),
});

/** Metadata attached to a session for categorisation and filtering. */
export type SessionMetadata = z.infer<typeof SessionMetadataSchema>;

/** Zod schema for a SWARM orchestration session. */
export const SessionSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  workerIds: z.array(z.uuid()),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  config: z.record(z.string(), z.unknown()).optional(),
  metadata: SessionMetadataSchema.optional(),
  snapshotIds: z.array(z.uuid()).optional(),
});

/** A SWARM session grouping one or more workers with shared config. */
export type Session = z.infer<typeof SessionSchema>;

/**
 * Zod schema for the `session_worker_removed` event payload (mirrors
 * Rust's `SessionWorkerRemovedPayload`,
 * `crates/swarm-core/src/events/emitter.rs`). The event bus validates
 * payloads with it (`#lib/event-payloads`).
 */
export const SessionWorkerRemovedPayloadSchema = z.object({
  sessionId: z.uuid(),
  workerId: z.uuid(),
});

/** Payload of the `session_worker_removed` event. */
export type SessionWorkerRemovedPayload = z.infer<typeof SessionWorkerRemovedPayloadSchema>;

// ── Snapshot schemas ────────────────────────────────

/** Zod schema for a point-in-time session snapshot. */
export const SnapshotSchema = z.object({
  id: z.uuid(),
  sessionId: z.uuid(),
  timestamp: z.iso.datetime(),
  data: z.record(z.string(), z.unknown()),
});

/** Point-in-time snapshot of a session's state for time-travel debugging. */
export type Snapshot = z.infer<typeof SnapshotSchema>;

// ── Template schemas ────────────────────────────────

/** Zod schema for worktree isolation mode — mirrors Rust's `WorkerIsolation`. */
export const WorkerIsolationSchema = z.enum(["worktree", "none"]);

/** Worktree isolation mode for a spawned worker. */
export type WorkerIsolation = z.infer<typeof WorkerIsolationSchema>;

/**
 * Zod schema for the process options half of a worker spawn spec —
 * fields that map 1:1 onto Rust's `WorkerConfig`
 * (`crates/swarm-core/src/worker/handle.rs`) and are sent
 * over IPC to `spawn_worker`. Deliberately excludes `rows`/`cols` (PTY
 * dimensions, Rust-defaulted and not template-configurable today).
 *
 * `repoRoot`/`isolation` are additive and optional — omitting both
 * reproduces exactly the pre-worktree-isolation spawn (no git
 * anywhere). When `repoRoot` is given, `isolation` defaults
 * server-side to `"worktree"`.
 */
export const WorkerProcessOptionsSchema = z.object({
  name: z.string(),
  shell: z.string().optional(),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  repoRoot: z.string().optional(),
  isolation: WorkerIsolationSchema.optional(),
});

/** Process-level spawn options sent to the Rust `spawn_worker` command. */
export type WorkerProcessOptions = z.infer<typeof WorkerProcessOptionsSchema>;

/**
 * Zod schema for the agent-metadata half of a worker spawn spec —
 * client-side only, never sent to Rust. Stored per worker id in
 * `useWorkerAgentStore` (`#store/worker-agents`) at spawn time so
 * WorkerAIPanel/AIChat can preselect the model and inject the system
 * prompt for a worker spawned from a template.
 */
export const WorkerAgentMetadataSchema = z.object({
  role: z.string().optional(),
  model: z.enum(MODEL_KEYS).optional(),
  systemPrompt: z.string().optional(),
});

/** Client-side-only agent metadata for a worker (role/model/system prompt). */
export type WorkerAgentMetadata = z.infer<typeof WorkerAgentMetadataSchema>;

/**
 * Zod schema for a full worker spawn spec within a session template:
 * process options (sent to Rust) plus agent metadata (kept client-side).
 * Replaces the old, single `WorkerConfig` type that conflated both with
 * Rust's unrelated `WorkerConfig` struct of the same name.
 */
export const WorkerSpawnSpecSchema = z.object({
  ...WorkerProcessOptionsSchema.shape,
  ...WorkerAgentMetadataSchema.shape,
});

/** Full spawn spec for a single worker in a session template. */
export type WorkerSpawnSpec = z.infer<typeof WorkerSpawnSpecSchema>;

/** Zod schema for a reusable session template. */
export const SessionTemplateSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  description: z.string(),
  workerConfigs: z.array(WorkerSpawnSpecSchema),
  builtIn: z.boolean().optional(),
  createdAt: z.iso.datetime().optional(),
});

/** Reusable session template defining a preset worker configuration. */
export type SessionTemplate = z.infer<typeof SessionTemplateSchema>;

// ── System metrics schemas ──────────────────────────

/** Zod schema for a single system metric data point. */
export const MetricPointSchema = z.object({
  time: z.number(),
  cpu: z.number(),
  memory: z.number(),
  workerCount: z.int(),
});

/** A single time-series data point for system metrics. */
export type MetricPoint = z.infer<typeof MetricPointSchema>;

/** Zod schema for aggregate system metrics with history. */
export const SystemMetricsSchema = z.object({
  cpuPercent: z.number(),
  memoryMb: z.number(),
  memoryTotalMb: z.number(),
  workerCount: z.int(),
  aiReqPerSec: z.number(),
  tokensPerSec: z.number(),
  history: z.array(MetricPointSchema),
});

/** Aggregate system metrics including CPU, memory, and AI throughput. */
export type SystemMetrics = z.infer<typeof SystemMetricsSchema>;

// ── AI schemas ──────────────────────────────────────

/** Zod schema for an AI conversation message with optional tool calls. */
export const AiMessageSchema = z.object({
  id: z.uuid(),
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  timestamp: z.iso.datetime(),
  toolCalls: z
    .array(
      z.object({
        id: z.string().optional(),
        name: z.string(),
        input: z.record(z.string(), z.unknown()),
        result: z.string().optional(),
      }),
    )
    .optional(),
});

/** A single AI conversation message (user or assistant) with optional tool calls. */
export type AiMessage = z.infer<typeof AiMessageSchema>;

/** Zod schema for a priority-queued AI request item. */
export const AiQueueItemSchema = z.object({
  id: z.uuid(),
  priority: z.enum(["critical", "high", "normal", "low"]),
  workerId: z.uuid(),
  messages: z.array(AiMessageSchema),
  status: z.enum(["pending", "streaming", "complete", "error"]),
});

/** A queued AI request with priority, status, and associated worker. */
export type AiQueueItem = z.infer<typeof AiQueueItemSchema>;

// ── Provider schemas ───────────────────────────────

/** Zod schema for the selected AI provider configuration. */
export const ProviderConfigSchema = z.object({
  providerId: z.string(),
  modelId: z.string(),
});

/** The currently selected AI provider and model. */
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

/** Zod schema for a single token usage record. */
export const TokenUsageRecordSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  model: z.string(),
  provider: z.string(),
  costUsd: z.number(),
  timestamp: z.number(),
});

/** A single token usage record with cost tracking. */
export type TokenUsageRecord = z.infer<typeof TokenUsageRecordSchema>;

/** Zod schema for cumulative token usage statistics. */
export const CumulativeUsageSchema = z.object({
  totalInputTokens: z.number(),
  totalOutputTokens: z.number(),
  totalCostUsd: z.number(),
  history: z.array(TokenUsageRecordSchema),
});

/** Cumulative token usage and cost tracking across sessions. */
export type CumulativeUsage = z.infer<typeof CumulativeUsageSchema>;

// ── Ship schemas ─────────────────────────────────────
//
// Mirror Rust's `swarm_core::git::ship` types
// (`crates/swarm-core/src/git/ship.rs`) exactly: `ShipError`
// is a documented divergence from the rest of the IPC surface's
// `Result<T, String>` convention — it serializes as a structured
// `{ kind, message, remedy }` object so the UI can branch on `kind`.

/** Zod schema mirroring Rust's `ShipErrorKind` (camelCased variant names). */
export const ShipErrorKindSchema = z.enum([
  "workerNotFound",
  "noWorktree",
  "primaryCheckout",
  "invalidBranch",
  "noRemote",
  "nonGitHubHost",
  "nothingToCommit",
  "identityMissing",
  "hookFailed",
  "pushRejected",
  "authExpired",
  "timeout",
  "unknown",
]);

/** The full enumeration of ways a ship operation can fail. */
export type ShipErrorKind = z.infer<typeof ShipErrorKindSchema>;

/** Zod schema mirroring Rust's `ShipRemedy`. */
export const ShipRemedySchema = z.enum(["fetchAndRebase", "reAuthenticate", "configureIdentity"]);

/** A suggested next action for a `ShipError`. */
export type ShipRemedy = z.infer<typeof ShipRemedySchema>;

/**
 * Zod schema for a typed ship failure. Every ship command
 * (`git_stage_commit`, `git_push`, `ship_compare_url`) rejects with
 * this shape rather than a bare string on error — see
 * `#lib/tauri`'s `ShipCommandError`, which wraps a parsed instance of
 * this in a real `Error` subclass so callers can `catch` normally
 * while still reading `.shipError.kind`.
 */
export const ShipErrorSchema = z.object({
  kind: ShipErrorKindSchema,
  message: z.string(),
  remedy: ShipRemedySchema.nullable(),
});

/** A typed ship failure — `{ kind, message, remedy }`. */
export type ShipError = z.infer<typeof ShipErrorSchema>;

/** Zod schema for one file the secret/size deny list caught. */
export const SkippedFileSchema = z.object({
  path: z.string(),
  reason: z.string(),
});

/** A file skipped from staging, with its Title Case skip reason. */
export type SkippedFile = z.infer<typeof SkippedFileSchema>;

/** Zod schema for a diff stat summary. */
export const DiffStatSchema = z.object({
  filesChanged: z.int(),
  insertions: z.int(),
  deletions: z.int(),
});

/** File/insertion/deletion counts for a diff or commit. */
export type DiffStat = z.infer<typeof DiffStatSchema>;

/** Zod schema for the full `git_ship_preflight` response. */
export const ShipPreflightSchema = z.object({
  workerId: z.uuid(),
  branch: z.string(),
  baseBranch: z.string(),
  remote: z.string().nullable(),
  host: z.string().nullable(),
  /** Whether `host` looks like GitHub/GHES — the "Open Compare Page" action is the only one gated on this. */
  hostSupportsCompare: z.boolean(),
  upstream: z.string().nullable(),
  ahead: z.int(),
  behind: z.int(),
  staged: z.array(z.string()),
  unstaged: z.array(z.string()),
  untracked: z.array(z.string()),
  skipped: z.array(SkippedFileSchema),
  diffStat: DiffStatSchema,
  canShip: z.boolean(),
  blockers: z.array(z.string()),
});

/** Ship preflight state for a worker's worktree. */
export type ShipPreflight = z.infer<typeof ShipPreflightSchema>;

/** Zod schema for the staging strategy sent to `git_stage_commit`. */
export const StagingModeSchema = z.enum(["all", "staged"]);

/** Staging strategy: stage every changed file, or commit exactly what's already staged. */
export type StagingMode = z.infer<typeof StagingModeSchema>;

/** Zod schema for the `git_stage_commit` response. */
export const CommitOutcomeSchema = z.object({
  sha: z.string(),
  filesChanged: z.int(),
  insertions: z.int(),
  deletions: z.int(),
  seqFrom: z.int(),
  seqTo: z.int(),
  skipped: z.array(SkippedFileSchema),
});

/** Result of a successful staged commit. */
export type CommitOutcome = z.infer<typeof CommitOutcomeSchema>;

/** Zod schema for the `git_push` response. */
export const PushOutcomeSchema = z.object({
  pushedRef: z.string(),
  /** `HEAD` sha at push time, resolved server-side — never a caller-supplied value. */
  sha: z.string(),
});

/** Result of a successful push. */
export type PushOutcome = z.infer<typeof PushOutcomeSchema>;

/**
 * Zod schema for one tool call within a `ship_context` turn — the row
 * shape the ship preview's Causal Record table renders, and the same
 * shape fed to the AI prose model (see `#lib/ship-causal`). `target` is a
 * best-effort extraction from an allowlist of path/command-shaped input
 * fields on the Rust side (`git::causal::extract_target`) — never a raw
 * tool input, which can legitimately contain file contents.
 */
export const CausalToolCallSchema = z.object({
  seq: z.int(),
  name: z.string(),
  target: z.string().nullable(),
  ok: z.boolean().nullable(),
});

/** A tool call row in a `ship_context` turn's Causal Record table. */
export type CausalToolCall = z.infer<typeof CausalToolCallSchema>;

/**
 * Zod schema for one AI/agent turn within a `ship_context` range,
 * identified by the `turnId` its `agent_block`/`agent_tool_call`/
 * `agent_tool_result`/`agent_turn_settled` events share.
 */
export const CausalTurnSchema = z.object({
  turnId: z.string(),
  status: z.string().nullable(),
  toolCalls: z.array(CausalToolCallSchema),
});

/** One AI/agent turn in a `ship_context` range. */
export type CausalTurn = z.infer<typeof CausalTurnSchema>;

/** Zod schema for a commit made within a `ship_context` range. */
export const CausalCommitSchema = z.object({
  sha: z.string(),
  branch: z.string(),
  seqFrom: z.int(),
  seqTo: z.int(),
});

/** A commit made within a `ship_context` range. */
export type CausalCommit = z.infer<typeof CausalCommitSchema>;

/**
 * Zod schema for the full `ship_context` response — the evidence half of
 * a ship's PR body. See `#lib/ship-causal`'s `renderCausalRecordSection`
 * for how this renders into the deterministic "Causal Record" section a
 * model never writes.
 */
export const ShipContextSchema = z.object({
  workerId: z.uuid(),
  seqFrom: z.int(),
  seqTo: z.int(),
  turns: z.array(CausalTurnSchema),
  commits: z.array(CausalCommitSchema),
  omittedTurnCount: z.int(),
  /** `true` when the backend's row fetch for this range hit its own cap — older turns than `omittedTurnCount` alone can account for may exist (review FIX-1). Folded into the same honest disclosure `omittedTurnCount` renders. */
  eventsTruncated: z.boolean(),
  /** `true` when this worker had `agent_turn_started` (webview chat) activity in range that produced no `CausalTurn` — distinguishes "genuinely no activity" from "activity the causal record structurally can't see" (review NIT-4). */
  hasUncapturedWebviewActivity: z.boolean(),
});

/** The causal record for one worker's ship range. */
export type ShipContext = z.infer<typeof ShipContextSchema>;
