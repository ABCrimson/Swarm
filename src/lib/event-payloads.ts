// ── Domain event payload schemas ────────────────────
//
// One zod schema per `swarm://events` type, mirroring the payload
// structs of Rust's `SwarmEvent` (`crates/swarm-core/src/events/emitter.rs`,
// serialized `{ "type": "<snake_case>", "payload": {…camelCase…} }`).
// `#lib/event-bus` parses each payload once, at the seam, and hands typed
// handlers the parsed value, so no consumer casts `e.payload`.
//
// Every schema is loose: fields the frontend does not know yet pass
// through untouched instead of being stripped. Rust `Option<T>` fields
// accept a missing key as well as `null`, because `events_since`
// backfills rows persisted by older builds that may predate the field.

import * as z from "zod";
import {
  AgentBlockPayloadSchema,
  AgentPermissionRequestPayloadSchema,
  AgentSessionExitedPayloadSchema,
  AgentSessionStartedPayloadSchema,
  AgentToolCallPayloadSchema,
  AgentToolResultPayloadSchema,
  AgentTurnDeltaPayloadSchema,
  AgentTurnSettledPayloadSchema,
} from "#lib/agent-events";
import { ShipErrorSchema, WorkerStateSchema } from "#store/types";

const Count = z.int().nonnegative();

/** Every payload schema, keyed by event type. */
export const EVENT_PAYLOAD_SCHEMAS = {
  worker_spawned: z.looseObject({
    workerId: z.uuid(),
    name: z.string(),
    pid: Count.nullish(),
    /** `"worktree"` or `"none"`; absent on rows from builds before worktree isolation. */
    isolation: z.string().nullish(),
  }),
  worker_killed: z.looseObject({ workerId: z.uuid() }),
  worker_output: z.looseObject({ workerId: z.uuid(), data: z.string() }),
  worker_state: z.looseObject({ workerId: z.uuid(), state: WorkerStateSchema }),
  /** Bytes written to a worker's PTY; `terminal` input is never persisted. */
  worker_input: z.looseObject({
    workerId: z.uuid(),
    bytes: Count,
    source: z.enum(["terminal", "tool", "automation"]),
    preview: z.string().nullish(),
  }),

  session_created: z.looseObject({ sessionId: z.uuid(), name: z.string() }),
  session_deleted: z.looseObject({ sessionId: z.uuid() }),
  session_worker_removed: z.looseObject({ sessionId: z.uuid(), workerId: z.uuid() }),

  system_metrics: z.looseObject({
    cpuPercent: z.number(),
    memoryMb: z.number(),
    memoryTotalMb: z.number(),
    workerCount: Count,
    aiReqPerSec: z.number(),
    timestamp: z.int(),
  }),
  system_log: z.looseObject({
    level: z.string(),
    message: z.string(),
    target: z.string(),
    timestamp: z.int(),
  }),

  ai_stream_delta: z.looseObject({ requestId: z.string(), delta: z.string(), done: z.boolean() }),
  ai_stream_settled: z.looseObject({
    requestId: z.string(),
    status: z.string(),
    error: z.string().nullish(),
  }),

  bus_message: z.looseObject({
    messageId: z.uuid(),
    fromWorker: z.uuid(),
    toWorker: z.uuid().nullish(),
    topic: z.string(),
    payload: z.unknown(),
  }),

  worktree_created: z.looseObject({
    workerId: z.uuid(),
    sessionId: z.uuid().nullish(),
    repoRoot: z.string(),
    worktreePath: z.string(),
    branch: z.string(),
    baseCommit: z.string(),
  }),
  worktree_removed: z.looseObject({
    workerId: z.uuid(),
    worktreePath: z.string(),
    branch: z.string(),
    disposition: z.string(),
    headCommit: z.string().nullish(),
    reason: z.string().nullish(),
  }),

  ship_progress: z.looseObject({
    shipId: z.uuid(),
    workerId: z.uuid(),
    step: z.string(),
    status: z.string(),
    detail: z.string().nullish(),
  }),
  ship_settled: z.looseObject({
    shipId: z.uuid(),
    workerId: z.uuid(),
    commitSha: z.string().nullish(),
    pushedRef: z.string().nullish(),
    prUrl: z.string().nullish(),
    status: z.string(),
    error: ShipErrorSchema.nullish(),
  }),
  commit_created: z.looseObject({
    workerId: z.uuid(),
    sha: z.string(),
    branch: z.string(),
    seqFrom: Count,
    seqTo: Count,
  }),

  file_written: z.looseObject({ path: z.string(), bytes: Count }),

  agent_turn_started: z.looseObject({
    workerId: z.uuid(),
    model: z.string(),
    requestId: z.string(),
  }),
  agent_session_started: AgentSessionStartedPayloadSchema.loose(),
  agent_turn_delta: AgentTurnDeltaPayloadSchema.loose(),
  agent_block: AgentBlockPayloadSchema.loose(),
  agent_tool_call: AgentToolCallPayloadSchema.loose(),
  agent_tool_result: AgentToolResultPayloadSchema.loose(),
  agent_permission_request: AgentPermissionRequestPayloadSchema.loose(),
  agent_turn_settled: AgentTurnSettledPayloadSchema.loose(),
  agent_session_exited: AgentSessionExitedPayloadSchema.loose(),
} as const satisfies Record<string, z.ZodType>;

/** Every `SwarmEvent` type the backend emits. */
export type EventType = keyof typeof EVENT_PAYLOAD_SCHEMAS;

/** The validated payload of event type `K`. */
export type EventPayload<K extends EventType> = z.output<(typeof EVENT_PAYLOAD_SCHEMAS)[K]>;

/** Whether `type` is a known event type, i.e. has a payload schema. */
export function isEventType(type: string): type is EventType {
  return Object.hasOwn(EVENT_PAYLOAD_SCHEMAS, type);
}
