// ── SWARM Tool System ───────────────────────────────
// Defines SWARM tools as Zod v4 schemas → Anthropic tool format.
// Each tool has a name, description, input schema, and execute function.

import type { Tool } from "@anthropic-ai/sdk/resources/messages/messages";
import * as z from "zod";
import { zodToTool } from "#lib/anthropic";
import { customToolToAnthropic, isValidToolName, runCustomTool } from "#lib/custom-tools";
import { invoke } from "#lib/tauri";
import { useCustomToolsStore } from "#store/custom-tools";

// ── Tool Types ──────────────────────────────────────

/** Result returned by a SWARM tool execution. */
export interface SwarmToolResult {
  readonly success: boolean;
  readonly data?: unknown;
  readonly error?: string;
}

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
  readonly anthropicTool: Tool;
  readonly execute: (input: Record<string, unknown>) => Promise<SwarmToolResult>;
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
  maxLines: z.number().int().optional().describe("Maximum number of lines to read"),
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
  execute: (input: Record<string, unknown>) => Promise<SwarmToolResult>,
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
  async (input) => {
    try {
      const workerId = await invoke<string>("spawn_worker", {
        config: {
          name: input.name ?? "Worker",
        },
      });
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
  async (input) => {
    try {
      await invoke<void>("kill_worker", { id: input.workerId });
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
  async (input) => {
    try {
      await invoke<void>("worker_input", {
        id: input.workerId,
        data: `${input.command}\n`,
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
      const content = await invoke<string>("read_file", {
        path: input.path,
        maxLines: input.maxLines,
      });
      return { success: true, data: { path: input.path, content } };
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
  async (input) => {
    try {
      await invoke<void>("write_file", {
        path: input.path,
        content: input.content,
      });
      return { success: true, data: { path: input.path, written: true } };
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
export function getAnthropicTools(): Tool[] {
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
export function getAllAnthropicTools(): Tool[] {
  const seen = new Set<string>(toolRegistry.keys());
  const customs: Tool[] = [];
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
 * Built-ins run their registry execute function; names not in the
 * registry fall back to the persisted custom tools, whose scripts run
 * in a sandboxed Blob Worker (see #lib/custom-tools).
 */
export async function executeTool(
  name: string,
  input: Record<string, unknown>,
): Promise<SwarmToolResult> {
  const tool = toolRegistry.get(name);
  if (tool) {
    return tool.execute(input);
  }
  const custom = useCustomToolsStore.getState().customTools.find((t) => t.name === name);
  if (custom) {
    return runCustomTool(custom, input);
  }
  return { success: false, error: `Unknown Tool: ${name}` };
}
