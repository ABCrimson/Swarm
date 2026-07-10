import Anthropic from "@anthropic-ai/sdk";
import type {
  MessageCreateParamsBase,
  MessageStreamEvent,
  Tool,
} from "@anthropic-ai/sdk/resources/messages/messages";
import * as z from "zod";
import { readConfig } from "#lib/tauri";

// ── Types ────────────────────────────────────────────

/** Parameters for initiating an Anthropic streaming message request. */
export interface StreamParams {
  readonly model: string;
  readonly maxTokens: number;
  readonly messages: ReadonlyArray<{
    readonly role: "user" | "assistant";
    readonly content: string;
  }>;
  readonly system?: string;
  readonly tools?: Tool[];
  readonly temperature?: number;
}

/**
 * A streaming delta emitted by the Anthropic API.
 *
 * For regular text, `content` contains the text fragment.
 * For tool_use blocks, `toolUse` is populated with streaming tool call data.
 */
export interface StreamDelta {
  readonly type: string;
  readonly content: string;
  readonly toolUse?: {
    readonly toolName: string;
    readonly partialInput: string;
    readonly complete: boolean;
  };
}

// ── Client singleton ─────────────────────────────────

let clientInstance: Anthropic | null = null;

/**
 * Returns a lazily initialized Anthropic client.
 *
 * The API key is retrieved from the Rust backend via invoke — it is
 * never stored in frontend memory beyond the SDK's internal state.
 * Uses a function-based apiKey getter that refreshes on each request.
 */
async function getClient(): Promise<Anthropic> {
  if (clientInstance) return clientInstance;

  clientInstance = new Anthropic({
    apiKey: async () => {
      const key = await readConfig<string>("anthropic_api_key");
      if (!key) throw new Error("Anthropic API key not configured");
      return key;
    },
    dangerouslyAllowBrowser: true,
  });

  return clientInstance;
}

// ── Streaming generator ──────────────────────────────

/** State for accumulating tool_use content blocks during streaming. */
interface ToolUseBlockState {
  toolName: string;
  partialInput: string;
}

/**
 * Extracts the text delta from a stream event.
 */
function extractDelta(event: MessageStreamEvent): string {
  switch (event.type) {
    case "content_block_delta": {
      const delta = event.delta;
      if ("text" in delta) {
        return delta.text;
      }
      if ("partial_json" in delta) {
        return delta.partial_json;
      }
      return "";
    }
    default:
      return "";
  }
}

/**
 * Async generator for streaming Anthropic messages.
 *
 * Yields `StreamDelta` objects as the model generates content.
 * Handles both text deltas and structured tool_use content blocks:
 *
 * - `content_block_start` with type "tool_use" begins accumulating tool input.
 * - `content_block_delta` with `input_json_delta` accumulates partial JSON.
 * - `content_block_stop` finalizes the tool call with `complete: true`.
 *
 * ```ts
 * for await (const delta of streamMessage(params)) {
 *   if (delta.toolUse) {
 *     // Handle structured tool call
 *   } else {
 *     console.log(delta.content);
 *   }
 * }
 * ```
 */
export async function* streamMessage(
  params: StreamParams,
  signal?: AbortSignal,
): AsyncGenerator<StreamDelta> {
  let client: Anthropic;
  try {
    client = await getClient();
  } catch (err) {
    // Surface auth errors clearly
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("not configured")) {
      throw new Error("API key not configured \u2014 update in Settings.");
    }
    throw err;
  }

  const requestParams: MessageCreateParamsBase = {
    model: params.model,
    max_tokens: params.maxTokens,
    messages: params.messages.map((m) => ({
      role: m.role,
      content: m.content,
    })),
    ...(params.system ? { system: params.system } : {}),
    ...(params.tools ? { tools: params.tools } : {}),
    ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
  };

  let stream: ReturnType<typeof client.messages.stream>;
  try {
    stream = client.messages.stream(requestParams, { signal });
  } catch (err) {
    handleStreamError(err);
    throw err;
  }

  let activeToolBlock: ToolUseBlockState | null = null;

  try {
    for await (const event of stream) {
      if (signal?.aborted) break;

      // Handle content_block_start for tool_use blocks
      if (event.type === "content_block_start") {
        const block = event.content_block;
        if (block.type === "tool_use") {
          activeToolBlock = { toolName: block.name, partialInput: "" };
          yield {
            type: "tool_use",
            content: "",
            toolUse: {
              toolName: block.name,
              partialInput: "",
              complete: false,
            },
          };
          continue;
        }
      }

      // Handle input_json_delta within a tool_use block
      if (event.type === "content_block_delta" && activeToolBlock) {
        const delta = event.delta;
        if ("partial_json" in delta) {
          activeToolBlock.partialInput += delta.partial_json;
          yield {
            type: "tool_use",
            content: delta.partial_json,
            toolUse: {
              toolName: activeToolBlock.toolName,
              partialInput: activeToolBlock.partialInput,
              complete: false,
            },
          };
          continue;
        }
      }

      // Handle content_block_stop for tool_use blocks
      if (event.type === "content_block_stop" && activeToolBlock) {
        const finalDelta: StreamDelta = {
          type: "tool_use",
          content: "",
          toolUse: {
            toolName: activeToolBlock.toolName,
            partialInput: activeToolBlock.partialInput,
            complete: true,
          },
        };
        activeToolBlock = null;
        yield finalDelta;
        continue;
      }

      // Regular text deltas
      const content = extractDelta(event);
      yield { type: event.type, content };
    }
  } catch (err) {
    // Handle errors that occur mid-stream (network failures, etc.)
    handleStreamError(err);
    throw err;
  }
}

/**
 * Handles errors from the streaming API, mapping common HTTP status codes
 * to actionable error messages.
 */
function handleStreamError(err: unknown): void {
  if (err == null || typeof err !== "object") return;

  // The Anthropic SDK attaches `status` to API errors
  const status = "status" in err ? (err as { status: number }).status : undefined;

  if (status === 401) {
    // Reset client so the user can reconfigure
    clientInstance = null;
    throw new Error("401 Unauthorized \u2014 API key invalid. Update in Settings.");
  }

  if (status === 403) {
    throw new Error("403 Forbidden \u2014 your API key lacks permission for this model.");
  }

  // Network errors mid-stream
  const msg = err instanceof Error ? err.message.toLowerCase() : "";
  if (
    msg.includes("network") ||
    msg.includes("econnreset") ||
    msg.includes("econnrefused") ||
    msg.includes("fetch failed") ||
    msg.includes("socket hang up")
  ) {
    throw new Error("Network connection lost during streaming. Check your internet connection.");
  }
}

// ── Tool schema conversion ───────────────────────────

/**
 * Converts a Zod v4 schema into an Anthropic tool definition.
 *
 * Uses `z.toJSONSchema()` to produce the JSON Schema for the
 * `input_schema` field required by Anthropic's API.
 *
 * @param name - Tool name
 * @param description - Tool description
 * @param schema - Zod v4 schema for the tool's input
 * @returns Anthropic Tool definition
 */
export function zodToTool<T extends z.ZodType>(name: string, description: string, schema: T): Tool {
  const jsonSchema = z.toJSONSchema(schema);
  return {
    name,
    description,
    input_schema: jsonSchema as Tool["input_schema"],
  };
}

/**
 * Resets the client instance (useful for re-authentication).
 */
export function resetClient(): void {
  clientInstance = null;
}
