// ── Agentic Tool Execution Loop ─────────────────────
// ReAct-style loop: model generates, calls tools, observes results, repeats.
// Continues until the model responds without tool calls or maxIterations hit.

import type { ModelProvider, StreamDelta } from "#lib/providers/index";
import type { SwarmTool, SwarmToolResult } from "#lib/tools";
import { executeTool } from "#lib/tools";
import type { AiMessage } from "#store/types";

// ── Types ───────────────────────────────────────────

/** Configuration for a single agent loop execution. */
export interface AgentLoopConfig {
  /** The model provider to use for inference. */
  readonly provider: ModelProvider;
  /** The model identifier to use (e.g. "claude-sonnet-4-20250514"). */
  readonly model: string;
  /** System prompt providing the agent's persona and instructions. */
  readonly systemPrompt: string;
  /** Available tools the agent can invoke. */
  readonly tools: SwarmTool[];
  /** Maximum number of tool-use iterations before forcing a stop. */
  readonly maxIterations: number;
  /** Callback fired for each streaming text delta. */
  readonly onDelta: (delta: StreamDelta) => void;
  /** Callback fired when the model initiates a tool call. */
  readonly onToolCall: (name: string, input: Record<string, unknown>) => void;
  /** Callback fired when a tool execution completes. */
  readonly onToolResult: (name: string, result: SwarmToolResult) => void;
  /** Optional abort signal for cancellation. */
  readonly signal?: AbortSignal;
}

/** Accumulated tool call from streaming deltas. */
interface PendingToolCall {
  name: string;
  inputJson: string;
}

// ── Agent Loop ──────────────────────────────────────

/**
 * Runs a ReAct-style agent loop with tool execution.
 *
 * The loop operates as follows:
 * 1. Send the current message history to the model with available tools.
 * 2. Stream the response, collecting text and tool_use deltas.
 * 3. If the model requests tool calls, execute each tool via `executeTool()`.
 * 4. Append the tool results as new messages and repeat from step 1.
 * 5. Stop when the model responds with only text (no tool calls) or `maxIterations` is reached.
 *
 * All streaming deltas are forwarded through `onDelta` for real-time UI updates.
 * Tool lifecycle events are reported via `onToolCall` and `onToolResult`.
 *
 * @param config - Agent loop configuration.
 * @param initialMessages - The starting conversation messages.
 * @returns The complete conversation history including all tool interactions.
 */
export async function runAgentLoop(
  config: AgentLoopConfig,
  initialMessages: AiMessage[],
): Promise<AiMessage[]> {
  const messages: AiMessage[] = [...initialMessages];
  const anthropicTools = config.tools.map((t) => t.anthropicTool);

  for (let iteration = 0; iteration < config.maxIterations; iteration++) {
    // Check for cancellation before each iteration
    if (config.signal?.aborted) {
      break;
    }

    // Build stream params from current message state
    const streamParams = {
      model: config.model,
      maxTokens: 4096,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      system: config.systemPrompt,
      tools: anthropicTools,
      signal: config.signal,
    };

    // Collect the full response text and any tool calls
    let responseText = "";
    const pendingToolCalls: PendingToolCall[] = [];
    let currentToolCall: PendingToolCall | null = null;

    // Stream the model's response
    for await (const delta of config.provider.streamMessage(streamParams)) {
      if (config.signal?.aborted) break;

      // Handle tool_use deltas
      if (delta.toolUse) {
        if (!delta.toolUse.complete) {
          // Starting or continuing a tool call
          if (currentToolCall === null || currentToolCall.name !== delta.toolUse.toolName) {
            currentToolCall = { name: delta.toolUse.toolName, inputJson: "" };
          }
          currentToolCall.inputJson = delta.toolUse.partialInput;
        } else {
          // Tool call complete
          if (currentToolCall) {
            pendingToolCalls.push({
              name: currentToolCall.name,
              inputJson: currentToolCall.inputJson,
            });
            currentToolCall = null;
          }
        }
        config.onDelta(delta);
        continue;
      }

      // Regular text delta
      if (delta.content) {
        responseText += delta.content;
        config.onDelta(delta);
      }
    }

    if (config.signal?.aborted) break;

    // No tool calls: this is the final response
    if (pendingToolCalls.length === 0) {
      const assistantMessage = createAssistantMessage(responseText);
      messages.push(assistantMessage);
      return messages;
    }

    // Execute all tool calls and collect results
    const toolCallResults: Array<{
      name: string;
      input: Record<string, unknown>;
      result: string;
    }> = [];

    for (const toolCall of pendingToolCalls) {
      if (config.signal?.aborted) break;

      let parsedInput: Record<string, unknown> = {};
      try {
        parsedInput = JSON.parse(toolCall.inputJson || "{}") as Record<string, unknown>;
      } catch {
        parsedInput = {};
      }

      config.onToolCall(toolCall.name, parsedInput);

      const result = await executeTool(toolCall.name, parsedInput);
      config.onToolResult(toolCall.name, result);

      toolCallResults.push({
        name: toolCall.name,
        input: parsedInput,
        result: result.success ? JSON.stringify(result.data) : `Error: ${result.error}`,
      });
    }

    // Append assistant message with tool calls
    const assistantWithTools = createAssistantMessage(responseText, toolCallResults);
    messages.push(assistantWithTools);

    // Append tool results as a user message so the model can observe them
    const toolResultSummary = toolCallResults
      .map((tc) => `Tool "${tc.name}" result: ${tc.result}`)
      .join("\n\n");

    const toolResultMessage: AiMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: toolResultSummary,
      timestamp: new Date().toISOString(),
    };

    messages.push(toolResultMessage);
  }

  return messages;
}

// ── Helpers ─────────────────────────────────────────

/**
 * Creates an assistant AiMessage with optional tool call records.
 *
 * @param content - The text content of the assistant's response.
 * @param toolCalls - Optional array of tool calls made during this turn.
 * @returns A new {@link AiMessage}.
 */
function createAssistantMessage(
  content: string,
  toolCalls?: Array<{ name: string; input: Record<string, unknown>; result: string }>,
): AiMessage {
  return {
    id: crypto.randomUUID(),
    role: "assistant",
    content,
    timestamp: new Date().toISOString(),
    ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
  };
}
