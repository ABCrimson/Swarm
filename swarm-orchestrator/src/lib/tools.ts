// ── SWARM Tool System ───────────────────────────────
// Defines SWARM tools as Zod v4 schemas → Anthropic tool format.
// Each tool has a name, description, input schema, and execute function.

import type { Tool } from "@anthropic-ai/sdk/resources/messages/messages";
import * as z from "zod";
import { zodToTool } from "#lib/anthropic";
import { invoke } from "#lib/tauri";

// ── Tool Types ──────────────────────────────────────

/** Result returned by a SWARM tool execution. */
export interface SwarmToolResult {
  readonly success: boolean;
  readonly data?: unknown;
  readonly error?: string;
}

/** A registered SWARM tool with its Zod schema and Anthropic-compatible definition. */
export interface SwarmTool {
  readonly name: string;
  readonly description: string;
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
 * @param description - Human-readable description for the model.
 * @param schema - Zod schema defining the tool's input parameters.
 * @param execute - Async function that runs the tool and returns a result.
 * @returns Fully constructed {@link SwarmTool} with API-compatible definition.
 */
function createTool(
  name: string,
  description: string,
  schema: z.ZodType,
  execute: (input: Record<string, unknown>) => Promise<SwarmToolResult>,
): SwarmTool {
  return {
    name,
    description,
    schema,
    anthropicTool: zodToTool(name, description, schema),
    execute,
  };
}

const spawnWorkerTool = createTool(
  "spawn_worker",
  "Spawn a new worker process. Returns the worker ID.",
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
 * Execute a tool by name with the given input.
 * Looks up the tool in the registry and runs its execute function.
 */
export async function executeTool(
  name: string,
  input: Record<string, unknown>,
): Promise<SwarmToolResult> {
  const tool = toolRegistry.get(name);
  if (!tool) {
    return { success: false, error: `Unknown tool: ${name}` };
  }
  return tool.execute(input);
}
