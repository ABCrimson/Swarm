/**
 * SWARM's built-in AI tools — Zod input schemas, their Anthropic tool
 * definitions, and the runtime that executes a model's `tool_use`
 * calls — plus the merge with the user's custom tools (`#lib/custom-tools`).
 *
 * Tool input is untrusted model output. The chat streams tool input
 * eagerly (`eager_input_streaming`), so the API does not validate it
 * either: every call is checked against its schema here, before any
 * side effect, and a mismatch comes back to the model as an error
 * `tool_result` it can correct.
 *
 * The five tools that act on the user's machine (`run_command`,
 * `spawn_worker`, `kill_worker`, `write_file`, `read_file`) also need the
 * user's approval (allow once, allow for the session, or deny) before
 * they run. The gate sits inside each tool's own `execute`, so no caller
 * (the registry included) can skip it; see "Tool Approval" below. A
 * session grant covers one exact call (tool, worker and arguments), never
 * a whole tool. The prompt is `ToolApprovalPrompt` in `#components/ai`.
 * The Rust side still enforces its own file scope.
 *
 * @module tools
 */

import * as z from "zod";
import type { ChatTool } from "#lib/anthropic";
import { zodToTool } from "#lib/anthropic";
import {
  customToolInputSchema,
  customToolToAnthropic,
  isValidToolName,
  runCustomTool,
} from "#lib/custom-tools";
import type { ProvenanceArgs } from "#lib/tauri";
import { invoke, killWorker, workerInput } from "#lib/tauri";
import { spawnWorkerFromSpec } from "#lib/worker-spawn";
import { useCustomToolsStore } from "#store/custom-tools";

// ── Tool Types ──────────────────────────────────────

/** Result returned by a SWARM tool execution. */
export interface SwarmToolResult {
  readonly success: boolean;
  readonly data?: unknown;
  readonly error?: string;
}

/**
 * Causal attribution passed from an AI turn's tool loop (`#lib/ai-chat`)
 * into a built-in tool: the turn's worker id and `agent_turn_started`
 * seq. Forwarded as-is to whichever IPC command the tool calls, so the
 * side effect joins the causality graph. The same shape as `#lib/tauri`'s
 * `ProvenanceArgs`.
 */
export type ToolProvenance = ProvenanceArgs;

/**
 * A registered SWARM tool with its Zod schema and Anthropic-compatible
 * definition.
 *
 * `description` and `uiDescription` are deliberately split (one
 * audience each): `description` is the model-facing tool-schema text in
 * natural sentence case; `uiDescription` is the Title Case copy the
 * Tools page shows.
 */
export interface SwarmTool {
  readonly name: string;
  /** Sentence-case description sent to the Anthropic API as the tool's schema description. */
  readonly description: string;
  /** Title Case description rendered in the Tools page UI (`ToolList`). */
  readonly uiDescription: string;
  readonly schema: z.ZodType;
  readonly anthropicTool: ChatTool;
  /**
   * Validates `input` against `schema`, waits for the user's approval
   * when the tool needs it (a denial comes back as an error result), then
   * runs the tool.
   */
  readonly execute: (input: unknown, prov?: ToolProvenance) => Promise<SwarmToolResult>;
}

/** A failed tool result carrying a Title Case, model- and user-readable message. */
function failure(error: unknown): SwarmToolResult {
  return { success: false, error: Error.isError(error) ? error.message : String(error) };
}

/** Validates model-supplied input, returning the parsed value or a failed result. */
function parseInput<S extends z.ZodType>(
  toolName: string,
  schema: S,
  input: unknown,
):
  | { readonly ok: true; readonly data: z.output<S> }
  | { readonly ok: false; readonly result: SwarmToolResult } {
  const parsed = schema.safeParse(input);
  if (parsed.success) return { ok: true, data: parsed.data };
  return {
    ok: false,
    result: {
      success: false,
      error: `Invalid Input For ${toolName}:\n${z.prettifyError(parsed.error)}`,
    },
  };
}

// ── Tool Input Schemas ──────────────────────────────

const SpawnWorkerInput = z.object({
  name: z.string().min(1).optional().describe("Optional human-readable name for the worker"),
});

const KillWorkerInput = z.object({
  workerId: z.uuid().describe("UUID of the worker to terminate"),
});

const RunCommandInput = z.object({
  workerId: z.uuid().describe("UUID of the worker whose terminal receives the command"),
  command: z.string().min(1).describe("Shell command line to type into the terminal"),
});

const ReadFileInput = z.object({
  path: z.string().min(1).describe("Absolute path to the file to read"),
  maxLines: z.int().min(1).optional().describe("Maximum number of lines to return"),
});

const WriteFileInput = z.object({
  path: z.string().min(1).describe("Absolute path to the file to write"),
  content: z.string().describe("Content to write to the file"),
});

const GetMetricsInput = z.object({
  workerId: z
    .uuid()
    .optional()
    .describe("Optional worker UUID to also report that worker's process metrics"),
});

/** The parts of `get_metrics`' response this tool relies on (`crates/swarm-core/src/metrics.rs`). */
const MetricsSnapshotSchema = z.looseObject({
  perWorker: z.array(z.looseObject({ workerId: z.string() })).default([]),
});

// ── Tool Approval ───────────────────────────────────

/** The user's answer to an approval prompt. */
export type ApprovalChoice = "once" | "session" | "deny";

/** A tool call waiting for the user's decision. */
export interface ToolApprovalRequest {
  readonly id: string;
  readonly tool: string;
  /** The call's validated input, shown to the user as structured data. */
  readonly input: unknown;
  /** Whether "Allow for session" is offered; it never is for `write_file`. */
  readonly sessionAllowed: boolean;
  /** The worker whose AI turn made the call, when it is known. */
  readonly workerId?: string;
}

/** How a tool asks for approval: the exact-call key and whether a session grant is offered. */
interface ApprovalSpec<I> {
  /** Identifies the arguments of one call; equal keys are the same decision. */
  readonly argKey: (input: I) => string;
  /** `false` makes a "session" answer count as "once". Defaults to `true`. */
  readonly sessionAllowed?: boolean;
}

/** Exact-call keys the user allowed for the rest of this app session. */
const sessionGrants = new Set<string>();
/** Per tool, the key of a parsed input (for {@link grantToolCallForSession}). */
const argKeyers = new Map<string, (input: unknown) => string>();
const grantKeys = new Map<string, string>();
const resolvers = new Map<string, (choice: ApprovalChoice) => void>();
const listeners = new Set<() => void>();
let pending: readonly ToolApprovalRequest[] = [];

/** One grant covers one tool, one worker and one argument set (NUL-separated). */
function grantKey(tool: string, workerId: string | undefined, argKey: string): string {
  return `${tool}\0${workerId ?? ""}\0${argKey}`;
}

function publish(next: readonly ToolApprovalRequest[]): void {
  pending = next;
  for (const listener of listeners) listener();
}

/** `useSyncExternalStore` subscription to the pending approval list. */
export function subscribeToolApprovals(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** The pending approvals, oldest first; the same array until it changes. */
export function getPendingToolApprovals(): readonly ToolApprovalRequest[] {
  return pending;
}

function release(requests: readonly ToolApprovalRequest[], choice: ApprovalChoice): void {
  if (requests.length === 0) return;
  publish(pending.filter((request) => !requests.includes(request)));
  for (const request of requests) {
    resolvers.get(request.id)?.(choice);
    resolvers.delete(request.id);
    grantKeys.delete(request.id);
  }
}

/**
 * Records the user's answer to one call. "Allow for session" also lets
 * later calls identical in tool, worker and arguments through without a
 * prompt until the app reloads; it never releases any other pending
 * call, whose arguments the user has not seen. For a tool that offers no
 * session grant (`write_file`) it counts as "once".
 */
export function resolveToolApproval(id: string, choice: ApprovalChoice): void {
  const request = pending.find((candidate) => candidate.id === id);
  if (!request) return;
  const key = grantKeys.get(id);
  if (choice === "session" && request.sessionAllowed && key !== undefined) sessionGrants.add(key);
  release([request], choice);
}

/**
 * Denies the pending calls of one worker's turn (or all of them): the
 * turn that made them was stopped, so nobody is left to answer. Calls
 * with no known worker are denied too.
 */
export function denyPendingToolApprovals(workerId?: string): void {
  release(
    pending.filter(
      (request) =>
        workerId === undefined || request.workerId === undefined || request.workerId === workerId,
    ),
    "deny",
  );
}

/**
 * Allows exactly one call, as if the user had chosen "Allow for session"
 * on it: the same tool, `workerId` and `input`. Throws when `tool` takes
 * no approval or `input` is invalid. For tests and trusted callers.
 */
export function grantToolCallForSession(tool: string, input: unknown, workerId?: string): void {
  const argKey = argKeyers.get(tool);
  if (!argKey) throw new Error(`${tool} Needs No Approval.`);
  sessionGrants.add(grantKey(tool, workerId, argKey(input)));
}

/** Forgets every session grant and denies every pending call. */
export function resetToolApprovals(): void {
  sessionGrants.clear();
  denyPendingToolApprovals();
}

/** Resolves to whether the user lets this exact call run. */
async function requestApproval(
  tool: string,
  input: unknown,
  argKey: string,
  sessionAllowed: boolean,
  workerId?: string,
): Promise<boolean> {
  const key = grantKey(tool, workerId, argKey);
  if (sessionGrants.has(key)) return true;
  const request: ToolApprovalRequest = {
    id: crypto.randomUUID(),
    tool,
    input,
    sessionAllowed,
    ...(workerId !== undefined && { workerId }),
  };
  const { promise, resolve } = Promise.withResolvers<ApprovalChoice>();
  resolvers.set(request.id, resolve);
  grantKeys.set(request.id, key);
  publish([...pending, request]);
  return (await promise) !== "deny";
}

// ── Tool Definitions ────────────────────────────────

/**
 * Builds a SWARM tool whose `execute` validates the model's input
 * against `schema` before `run` sees it, so no handler ever touches raw
 * model output.
 */
function createTool<S extends z.ZodType>(
  name: string,
  description: string,
  uiDescription: string,
  schema: S,
  run: (input: z.output<S>, prov?: ToolProvenance) => Promise<SwarmToolResult>,
  approval?: ApprovalSpec<z.output<S>>,
): SwarmTool {
  if (approval) argKeyers.set(name, (input) => approval.argKey(schema.parse(input)));
  return {
    name,
    description,
    uiDescription,
    schema,
    anthropicTool: zodToTool(name, description, schema),
    async execute(input, prov) {
      const parsed = parseInput(name, schema, input);
      if (!parsed.ok) return parsed.result;
      // The gate lives here, not in executeTool, so a direct call to a
      // registry entry cannot act without the user's answer.
      if (
        approval &&
        !(await requestApproval(
          name,
          parsed.data,
          approval.argKey(parsed.data),
          approval.sessionAllowed ?? true,
          prov?.originWorker,
        ))
      ) {
        return { success: false, error: `The User Denied ${name}. It Was Not Run.` };
      }
      try {
        return await run(parsed.data, prov);
      } catch (error) {
        return failure(error);
      }
    },
  };
}

const spawnWorkerTool = createTool(
  "spawn_worker",
  "Spawn a new worker process. Returns the worker ID.",
  "Spawn A New Worker Process. Returns The Worker ID.",
  SpawnWorkerInput,
  async ({ name }, prov) => {
    // Through spawnWorkerFromSpec, like every other spawn path, so the
    // worker gets the same validated response and store bookkeeping. The
    // turn's provenance makes the new worker's spawn events cite their
    // causer — the "spawn" edge of the causality graph.
    const workerId = await spawnWorkerFromSpec({ name: name ?? "Worker" }, undefined, prov);
    if (workerId === null) {
      return { success: false, error: "Spawn Worker Unavailable Outside The Desktop App." };
    }
    return { success: true, data: { id: workerId } };
  },
  { argKey: ({ name }) => name ?? "" },
);

const killWorkerTool = createTool(
  "kill_worker",
  "Terminate a running worker process by its UUID.",
  "Terminate A Running Worker Process By Its UUID.",
  KillWorkerInput,
  async ({ workerId }, prov) => {
    await killWorker(workerId, prov);
    return { success: true, data: { killed: workerId } };
  },
  { argKey: ({ workerId }) => workerId },
);

const runCommandTool = createTool(
  "run_command",
  "Type a shell command into a worker's terminal and press Enter. The command's output is not returned; it appears in the worker's terminal.",
  "Type A Shell Command Into A Worker's Terminal. Its Output Stays In The Terminal.",
  RunCommandInput,
  async ({ workerId, command }, prov) => {
    await workerInput(workerId, `${command}\n`, "tool", prov);
    return { success: true, data: { sent: command } };
  },
  { argKey: ({ workerId, command }) => `${workerId}\0${command}` },
);

const readFileTool = createTool(
  "read_file",
  "Read the contents of a file at the given absolute path.",
  "Read The Contents Of A File At The Given Absolute Path.",
  ReadFileInput,
  async ({ path, maxLines }) => {
    // The real read_file Rust command (commands/fs.rs): canonicalized,
    // scoped to the app data and home directories, with the app's
    // credential files denied. The file is read in full and sliced in
    // memory — fine for the small text files an AI turn reads.
    const fullContent = z.string().parse(await invoke<unknown>("read_file", { path }));
    const content =
      maxLines === undefined ? fullContent : fullContent.split("\n").slice(0, maxLines).join("\n");
    return { success: true, data: { path, content } };
  },
  { argKey: ({ path }) => path },
);

const writeFileTool = createTool(
  "write_file",
  "Write content to a file at the given absolute path, creating or overwriting it.",
  "Write Content To A File At The Given Absolute Path, Creating Or Overwriting It.",
  WriteFileInput,
  async ({ path, content }, prov) => {
    // The real write_file Rust command (commands/fs.rs); its file_written
    // event carries this turn's provenance, joining the causality graph.
    await invoke<void>("write_file", {
      path,
      content,
      originWorker: prov?.originWorker,
      causeSeq: prov?.causeSeq,
    });
    return { success: true, data: { path, written: true } };
  },
  // A write is never granted for the session: each one is answered on its own.
  { argKey: ({ path }) => path, sessionAllowed: false },
);

const getMetricsTool = createTool(
  "get_metrics",
  "Retrieve system-wide metrics (CPU, memory, worker counts by state) and every worker's process CPU and memory; pass a worker UUID to get just that worker's process metrics alongside the system figures.",
  "Retrieve System Metrics And Per-Worker Process CPU And Memory.",
  GetMetricsInput,
  async ({ workerId }) => {
    const snapshot = MetricsSnapshotSchema.parse(await invoke<unknown>("get_metrics"));
    if (workerId === undefined) return { success: true, data: snapshot };
    const { perWorker, ...system } = snapshot;
    const worker = perWorker.find((entry) => entry.workerId === workerId);
    if (!worker) {
      return { success: false, error: `No Running Worker Process With ID ${workerId}.` };
    }
    return { success: true, data: { ...system, worker } };
  },
);

// ── Tool Registry ───────────────────────────────────

const TOOLS: readonly SwarmTool[] = [
  spawnWorkerTool,
  killWorkerTool,
  runCommandTool,
  readFileTool,
  writeFileTool,
  getMetricsTool,
];

/** Registry of all built-in SWARM tools, keyed by name. */
export const toolRegistry: ReadonlyMap<string, SwarmTool> = new Map(
  TOOLS.map((tool) => [tool.name, tool]),
);

/** Anthropic tool definitions for the built-in tools, in registry order. */
export function getAnthropicTools(): ChatTool[] {
  return TOOLS.map((tool) => tool.anthropicTool);
}

/**
 * The custom tools that are actually offered to the model: valid names
 * only, a name taken by a built-in loses to the built-in, and duplicate
 * custom names keep the first. The same filter backs {@link executeTool},
 * so a shadowed custom tool can never run.
 */
function activeCustomTools() {
  const seen = new Set<string>(toolRegistry.keys());
  return useCustomToolsStore.getState().customTools.filter((tool) => {
    if (!isValidToolName(tool.name) || seen.has(tool.name)) return false;
    seen.add(tool.name);
    return true;
  });
}

/**
 * Anthropic tool definitions for built-ins plus every persisted custom
 * tool (see {@link activeCustomTools}) — defensive at request-assembly
 * time, because one bad definition would 400 every chat request.
 */
export function getAllAnthropicTools(): ChatTool[] {
  return [...getAnthropicTools(), ...activeCustomTools().map(customToolToAnthropic)];
}

/**
 * Executes a tool call by name. Built-ins validate and run through the
 * registry, forwarding `prov` (the calling AI turn's attribution) to the
 * IPC command they call. A built-in that needs approval waits for it
 * inside its own `execute`, once its input has validated; a denial comes
 * back to the model as an error result. Other names resolve to the active custom tools,
 * whose input is validated against their declared parameters and whose
 * scripts run in a sandboxed Blob Worker (see `#lib/custom-tools`) —
 * they have no backend side effects to stamp, so `prov` is not forwarded.
 */
export async function executeTool(
  name: string,
  input: unknown,
  prov?: ToolProvenance,
): Promise<SwarmToolResult> {
  const tool = toolRegistry.get(name);
  if (tool) {
    return tool.execute(input, prov);
  }

  const custom = activeCustomTools().find((candidate) => candidate.name === name);
  if (!custom) return { success: false, error: `Unknown Tool: ${name}` };
  const parsed = parseInput(name, customToolInputSchema(custom), input);
  if (!parsed.ok) return parsed.result;
  return runCustomTool(custom, parsed.data);
}
