// ── SWARM Tool System ───────────────────────────────
// Defines SWARM tools as Zod v4 schemas → Anthropic tool format.
// Each tool has a name, description, input schema, and execute function.

import * as z from "zod";
import type { ChatTool } from "#lib/anthropic";
import { zodToTool } from "#lib/anthropic";
import { customToolToAnthropic, isValidToolName, runCustomTool } from "#lib/custom-tools";
import type { ProvenanceArgs } from "#lib/tauri";
import { invoke } from "#lib/tauri";
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
 * Causal attribution passed from an AI turn's tool loop
 * (`AIChat.tsx`'s `doSend`) into a built-in tool's `execute`. `undefined`
 * when a tool runs outside a turn context (there is none today, but the
 * signature stays honest either way) — every `execute` treats it as
 * optional and forwards `originWorker`/`causeSeq` as-is to whichever IPC
 * command it calls. Re-exported from `#lib/tauri`'s `ProvenanceArgs` —
 * one shape, one name, used at both seams.
 */
export type ToolProvenance = ProvenanceArgs;

/**
 * A registered SWARM tool with its Zod schema and Anthropic-compatible
 * definition.
 *
 * `description` and `uiDescription` are deliberately split (dual-use
 * strings, one audience each):
 *   - `description` is sent to the Anthropic API as the tool-schema
 *     description (via `anthropicTool`/`zodToTool`) — natural sentence
 *     case reads better as a model-facing instruction and yields better
 *     prompt quality than a Title-Cased label.
 *   - `uiDescription` is shown on the Tools page (`ToolCard`) — Title
 *     Case, matching this app's UI copy convention.
 */
export interface SwarmTool {
  readonly name: string;
  /** Sentence-case description sent to the Anthropic API as the tool's schema description. */
  readonly description: string;
  /** Title Case description rendered in the Tools page UI (`ToolCard`). */
  readonly uiDescription: string;
  readonly schema: z.ZodType;
  readonly anthropicTool: ChatTool;
  readonly execute: (
    input: Record<string, unknown>,
    prov?: ToolProvenance,
  ) => Promise<SwarmToolResult>;
}

// ── Tool Input Schemas ──────────────────────────────

const SpawnWorkerInput = z.object({
  name: z.string().optional().describe("Optional human-readable name for the worker"),
});

const KillWorkerInput = z.object({
  workerId: z.uuid().describe("UUID of the worker to terminate"),
});

const RunCommandInput = z.object({
  workerId: z.uuid().describe("UUID of the worker to run the command in"),
  command: z.string().describe("Shell command to execute"),
});

const ReadFileInput = z.object({
  path: z.string().describe("Absolute path to the file to read"),
  maxLines: z.number().int().min(1).optional().describe("Maximum number of lines to read"),
});

const WriteFileInput = z.object({
  path: z.string().describe("Absolute path to the file to write"),
  content: z.string().describe("Content to write to the file"),
});

const GetMetricsInput = z.object({
  workerId: z.uuid().optional().describe("Optional worker UUID; omit for system-wide metrics"),
});

// ── Tool Definitions ────────────────────────────────

/**
 * Factory for creating a SWARM tool with its Anthropic-compatible definition.
 *
 * @param name - Tool identifier used in Anthropic tool_use blocks.
 * @param description - Sentence-case description sent to the model as the tool-schema description (via `zodToTool`).
 * @param uiDescription - Title Case description rendered in the Tools page UI (`ToolCard`); never sent to the API.
 * @param schema - Zod schema defining the tool's input parameters.
 * @param execute - Async function that runs the tool and returns a result.
 * @returns Fully constructed {@link SwarmTool} with API-compatible definition.
 */
function createTool(
  name: string,
  description: string,
  uiDescription: string,
  schema: z.ZodType,
  execute: (input: Record<string, unknown>, prov?: ToolProvenance) => Promise<SwarmToolResult>,
): SwarmTool {
  return {
    name,
    description,
    uiDescription,
    schema,
    anthropicTool: zodToTool(name, description, schema),
    execute,
  };
}

const spawnWorkerTool = createTool(
  "spawn_worker",
  "Spawn a new worker process. Returns the worker ID.",
  "Spawn A New Worker Process. Returns The Worker ID.",
  SpawnWorkerInput,
  async (input, prov) => {
    try {
      const { name } = SpawnWorkerInput.parse(input);
      // Routed through spawnWorkerFromSpec (not a hand-rolled invoke())
      // so an AI-spawned worker gets the same Zod-validated response and
      // store bookkeeping (useWorkerStore placeholder) as every other
      // spawn path — see #lib/worker-spawn. `prov` (the turn's
      // workerId/turnSeq) is threaded through, when present, so the new
      // worker's worker_spawned/worktree_created events carry a real
      // causer, distinct from the subject (the new worker's own id) —
      // that difference is the causal edge. Called with exactly two
      // args when `prov` is absent, matching every pre-provenance
      // caller's call shape.
      const spec = { name: name ?? "Worker" };
      const workerId = prov
        ? await spawnWorkerFromSpec(spec, undefined, prov)
        : await spawnWorkerFromSpec(spec);
      if (workerId === null) {
        return { success: false, error: "Spawn Worker Unavailable Outside The Desktop App." };
      }
      return { success: true, data: { id: workerId } };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
);

const killWorkerTool = createTool(
  "kill_worker",
  "Terminate a running worker process by its UUID.",
  "Terminate A Running Worker Process By Its UUID.",
  KillWorkerInput,
  async (input, prov) => {
    try {
      await invoke<void>("kill_worker", {
        id: input.workerId,
        originWorker: prov?.originWorker,
        causeSeq: prov?.causeSeq,
      });
      return { success: true, data: { killed: input.workerId } };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
);

const runCommandTool = createTool(
  "run_command",
  "Execute a shell command within a worker's PTY. Returns stdout/stderr output.",
  "Execute A Shell Command Within A Worker's PTY. Returns Stdout/Stderr Output.",
  RunCommandInput,
  async (input, prov) => {
    try {
      await invoke<void>("worker_input", {
        id: input.workerId,
        data: `${input.command}\n`,
        source: "tool",
        originWorker: prov?.originWorker,
        causeSeq: prov?.causeSeq,
      });
      return { success: true, data: { sent: input.command } };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
);

const readFileTool = createTool(
  "read_file",
  "Read the contents of a file at the given path.",
  "Read The Contents Of A File At The Given Path.",
  ReadFileInput,
  async (input) => {
    try {
      const { path, maxLines } = ReadFileInput.parse(input);
      // Routed through the real read_file Rust command (not
      // tauri-plugin-fs) — see commands/fs.rs. The file is always read
      // in full, then sliced in memory — there is no streaming/
      // early-exit read path yet. Acceptable for now given these are
      // AI-tool reads of small config/text files, not a
      // general-purpose log tailer; revisit if maxLines is ever used
      // against multi-gigabyte files.
      const fullContent = await invoke<string>("read_file", { path });
      const content =
        typeof maxLines === "number"
          ? fullContent.split("\n").slice(0, maxLines).join("\n")
          : fullContent;
      return { success: true, data: { path, content } };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
);

const writeFileTool = createTool(
  "write_file",
  "Write content to a file at the given path, creating or overwriting it.",
  "Write Content To A File At The Given Path, Creating Or Overwriting It.",
  WriteFileInput,
  async (input, prov) => {
    try {
      const { path, content } = WriteFileInput.parse(input);
      // Routed through the real write_file Rust command (not
      // tauri-plugin-fs) — see commands/fs.rs. Stamped: the resulting
      // file_written event carries this turn's originWorker/causeSeq,
      // joining the causality graph.
      await invoke<void>("write_file", {
        path,
        content,
        originWorker: prov?.originWorker,
        causeSeq: prov?.causeSeq,
      });
      return { success: true, data: { path, written: true } };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
);

const getMetricsTool = createTool(
  "get_metrics",
  "Retrieve system or per-worker performance metrics (CPU, memory, uptime).",
  "Retrieve System Or Per-Worker Performance Metrics (CPU, Memory, Uptime).",
  GetMetricsInput,
  async (input) => {
    try {
      const metrics = await invoke<Record<string, unknown>>("get_metrics", {
        workerId: input.workerId,
      });
      return { success: true, data: metrics };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
);

// ── Tool Registry ───────────────────────────────────

const TOOLS: SwarmTool[] = [
  spawnWorkerTool,
  killWorkerTool,
  runCommandTool,
  readFileTool,
  writeFileTool,
  getMetricsTool,
];

/** Registry of all SWARM tools, keyed by name. */
export const toolRegistry: Map<string, SwarmTool> = new Map(TOOLS.map((t) => [t.name, t]));

/** Returns an array of Anthropic Tool definitions for use in API calls. */
export function getAnthropicTools(): ChatTool[] {
  return TOOLS.map((t) => t.anthropicTool);
}

/**
 * Returns Anthropic Tool definitions for built-ins plus every persisted
 * custom tool from the Tools page builder.
 *
 * Defensive filtering at request-assembly time (one bad definition
 * would 400 every chat request app-wide): custom tools with names
 * violating the API's `^[a-zA-Z0-9_-]{1,64}$` contract are dropped, a
 * name colliding with a built-in loses to the built-in, and duplicate
 * custom names keep only the first.
 */
export function getAllAnthropicTools(): ChatTool[] {
  const seen = new Set<string>(toolRegistry.keys());
  const customs: ChatTool[] = [];
  for (const t of useCustomToolsStore.getState().customTools) {
    if (!isValidToolName(t.name) || seen.has(t.name)) continue;
    seen.add(t.name);
    customs.push(customToolToAnthropic(t));
  }
  return [...getAnthropicTools(), ...customs];
}

/**
 * Execute a tool by name with the given input.
 *
 * Built-ins run their registry execute function, forwarding `prov`
 * (causal attribution — the calling AI turn's workerId/turnSeq, when
 * this call happens inside one) to whichever IPC command the tool
 * calls. Names not in the registry fall back to the persisted custom
 * tools, whose scripts run in a sandboxed Blob Worker (see
 * #lib/custom-tools) — those have no side effects of their own to
 * stamp, so `prov` is not forwarded there.
 */
export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  prov?: ToolProvenance,
): Promise<SwarmToolResult> {
  const tool = toolRegistry.get(name);
  if (tool) {
    return tool.execute(input, prov);
  }
  const custom = useCustomToolsStore.getState().customTools.find((t) => t.name === name);
  if (custom) {
    return runCustomTool(custom, input);
  }
  return { success: false, error: `Unknown Tool: ${name}` };
}
