import Anthropic from "@anthropic-ai/sdk";
import type {
  MessageCreateParamsBase,
  MessageStreamEvent,
  Tool,
} from "@anthropic-ai/sdk/resources/messages/messages";
import * as z from "zod";
import { readConfig } from "#lib/tauri";

// ── Types ────────────────────────────────────────────

/**
 * Parameters for initiating an Anthropic streaming message request.
 *
 * Deliberately has no `temperature` (or `top_p`/`top_k`) field — mirrors
 * the Rust side's `build_request_body` invariant (`src-tauri/src/ai/client.rs`):
 * never send a sampling parameter, for any model. This matters most for
 * Fable-tier models (`claude-fable-5`, `claude-mythos-5`), which reject any
 * sampling parameter with a 400, and for `claude-opus-4-8`, which rejects
 * `temperature`/`top_p`/`top_k` outright.
 */
export interface StreamParams {
  readonly model: string;
  readonly maxTokens: number;
  readonly messages: ReadonlyArray<{
    readonly role: "user" | "assistant";
    readonly content: string;
  }>;
  readonly system?: string;
  readonly tools?: Tool[];
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
      if (!key) throw new Error("Anthropic API Key Not Configured");
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
    // Surface auth errors clearly. Lowercased so this keeps matching
    // regardless of how the underlying "not configured" message is cased.
    const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
    if (msg.includes("not configured")) {
      throw new Error("API Key Not Configured \u2014 Update In Settings.");
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

      // Refusal: safety classifiers declined the request (stop_reason
      // "refusal" on a message_delta event). Surface this as a thrown
      // error instead of falling through to the generic yield below — a
      // silent empty/truncated "complete" reply would otherwise render to
      // the user as a normal response. Mirrors the Rust side's
      // `is_refusal` check (src-tauri/src/ai/client.rs, src-tauri/src/ai/stream.rs).
      // Partial text already yielded before this event is not treated as a
      // valid final reply: the throw propagates out of this generator, so
      // callers' `for await` loops never reach a normal completion.
      if (event.type === "message_delta" && event.delta.stop_reason === "refusal") {
        throw new Error("Request Declined By Safety Classifiers");
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
    throw new Error("401 Unauthorized \u2014 API Key Invalid. Update In Settings.");
  }

  if (status === 403) {
    throw new Error("403 Forbidden \u2014 Your API Key Lacks Permission For This Model.");
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
    throw new Error("Network Connection Lost During Streaming. Check Your Internet Connection.");
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
