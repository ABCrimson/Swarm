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
  pid: z.number().int().optional(),
  startedAt: z.string().datetime(),
  output: z.string().optional(),
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
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  config: z.record(z.string(), z.unknown()).optional(),
  metadata: SessionMetadataSchema.optional(),
  snapshotIds: z.array(z.uuid()).optional(),
});

/** A SWARM session grouping one or more workers with shared config. */
export type Session = z.infer<typeof SessionSchema>;

// ── Snapshot schemas ────────────────────────────────

/** Zod schema for a point-in-time session snapshot. */
export const SnapshotSchema = z.object({
  id: z.uuid(),
  sessionId: z.uuid(),
  timestamp: z.string().datetime(),
  data: z.record(z.string(), z.unknown()),
});

/** Point-in-time snapshot of a session's state for time-travel debugging. */
export type Snapshot = z.infer<typeof SnapshotSchema>;

// ── Template schemas ────────────────────────────────

/**
 * Zod schema for the process options half of a worker spawn spec —
 * fields that map 1:1 onto Rust's `WorkerConfig`
 * (`src-tauri/src/worker/handle.rs`) and are sent over IPC to
 * `spawn_worker`. Deliberately excludes `rows`/`cols` (PTY dimensions,
 * Rust-defaulted and not template-configurable today).
 */
export const WorkerProcessOptionsSchema = z.object({
  name: z.string(),
  shell: z.string().optional(),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
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
  createdAt: z.string().datetime().optional(),
});

/** Reusable session template defining a preset worker configuration. */
export type SessionTemplate = z.infer<typeof SessionTemplateSchema>;

// ── System metrics schemas ──────────────────────────

/** Zod schema for a single system metric data point. */
export const MetricPointSchema = z.object({
  time: z.number(),
  cpu: z.number(),
  memory: z.number(),
  workerCount: z.number().int(),
});

/** A single time-series data point for system metrics. */
export type MetricPoint = z.infer<typeof MetricPointSchema>;

/** Zod schema for aggregate system metrics with history. */
export const SystemMetricsSchema = z.object({
  cpuPercent: z.number(),
  memoryMb: z.number(),
  memoryTotalMb: z.number(),
  workerCount: z.number().int(),
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
  timestamp: z.string().datetime(),
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
