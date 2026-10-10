/**
 * The webview's Anthropic Messages API client — the only place the app
 * talks to Claude directly (the provider-adapter sessions in
 * `crates/swarm-core/src/agent/` drive their own CLIs instead).
 *
 * - The API key is read from the backend config (`anthropic_api_key`,
 *   written by Settings) before every request and handed to the SDK as
 *   a plain string. The SDK keeps `apiKey` only when it is a string: an
 *   async getter type-checks (`ApiKeySetter`) but is discarded at runtime,
 *   leaving the client with no key, so every request fails authentication.
 * - {@link streamMessage} streams through the SDK's `BetaMessageStream`
 *   and returns `stream.finalMessage()` — the complete assistant turn
 *   (thinking blocks with signatures, text and `tool_use` blocks in model
 *   order) plus `stop_reason`, `stop_details` and `usage` — so a tool
 *   loop can replay the turn verbatim, as the API requires.
 * - Requests go through the beta surface so models with safety
 *   classifiers can opt into server-side refusal fallbacks
 *   (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`): a
 *   declined request is re-run on the model Anthropic recommends for
 *   that refusal category inside the same call. Models without the
 *   capability get a plain request with no beta header.
 * - Failures surface as {@link AiRequestError} with a Title Case message
 *   and a `kind` derived from the SDK's typed error classes (never from
 *   message substrings); the SDK error stays on `cause`.
 *
 * Requests never carry `temperature`/`top_p`/`top_k`: every current
 * model rejects non-default sampling parameters with a 400, so
 * {@link StreamParams} has no field for them.
 *
 * @module anthropic
 */

import Anthropic from "@anthropic-ai/sdk";
import type {
  BetaContentBlock,
  BetaContentBlockParam,
  BetaMessage,
  BetaMessageParam,
  BetaMessageStreamParams,
  BetaRedactedThinkingBlock,
  BetaTextBlock,
  BetaThinkingBlock,
  BetaTool,
  BetaToolUseBlock,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import * as z from "zod";
import { ANTHROPIC_API_KEY_CONFIG_KEY } from "#lib/anthropic-config";
import { estimateCostUsd, getModelById, hasPricing, type UsageTokens } from "#lib/models";
import { readConfig } from "#lib/tauri";
import { useAiStore } from "#store/ai";

/** Beta header for the scalar `fallbacks: "default"` form of server-side refusal fallbacks. */
const REFUSAL_FALLBACK_BETA = "server-side-fallback-2026-07-01";

// ── Request / response types ─────────────────────────

/** A conversation message as sent to (and replayed back into) the Messages API. */
export type ChatMessageParam = BetaMessageParam;
/** A client tool definition. */
export type ChatTool = BetaTool;
/** A complete assistant response. */
export type ChatResponse = BetaMessage;

/** `output_config.effort` levels. */
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** Parameters for one streamed Messages API request. */
export interface StreamParams {
  readonly model: string;
  /**
   * `max_tokens`. Thinking tokens count against it, so keep it generous;
   * it is clamped to the model's catalog output limit.
   */
  readonly maxTokens: number;
  /**
   * The conversation, replayed verbatim: plain turns use string content,
   * tool-loop turns carry full content blocks (the assistant's
   * `thinking`/`text`/`tool_use` blocks, the user's `tool_result` blocks).
   */
  readonly messages: readonly ChatMessageParam[];
  readonly system?: string;
  readonly tools?: readonly ChatTool[];
  /**
   * `output_config.effort`. Dropped for models whose catalog entry
   * reports no effort support (none of today's catalog), so callers can set it per
   * route without checking the model.
   */
  readonly effort?: Effort;
  /**
   * Adds top-level `cache_control: { type: "ephemeral" }` so the whole
   * prefix is cached. Worth it for multi-round conversations that resend
   * their history; a single-shot request would only pay the cache-write
   * premium.
   */
  readonly cache?: boolean;
}

/** Streaming progress of one `tool_use` block. */
interface ToolUseDelta {
  /** The API's `tool_use` block id — echoed back as `tool_use_id` in the `tool_result`. */
  readonly id: string;
  readonly toolName: string;
  /** The raw input JSON accumulated so far (partial until `complete`). */
  readonly partialInput: string;
  readonly complete: boolean;
}

/**
 * One streaming delta. `content` is always the visible-text fragment
 * (empty for every other kind), so a text-only consumer can concatenate
 * `content` and ignore the rest.
 */
export type StreamDelta =
  | { readonly type: "text"; readonly content: string; readonly toolUse?: undefined }
  | {
      readonly type: "thinking";
      readonly content: "";
      /** A fragment of the model's summarized thinking. */
      readonly thinking: string;
      readonly toolUse?: undefined;
    }
  | { readonly type: "tool_use"; readonly content: ""; readonly toolUse: ToolUseDelta }
  | {
      readonly type: "fallback";
      readonly content: "";
      /** The model that declined. */
      readonly from: string;
      /** The model that continues the response. */
      readonly to: string;
      readonly toolUse?: undefined;
    };

// ── Errors ───────────────────────────────────────────

/** What went wrong with a request, derived from the SDK's typed errors. */
export type AiErrorKind =
  | "missing_key"
  | "auth"
  | "permission"
  | "not_found"
  | "bad_request"
  | "rate_limit"
  | "overloaded"
  | "server"
  | "timeout"
  | "connection"
  | "stream"
  | "aborted"
  | "refusal"
  | "unknown";

/** A failed AI request with a Title Case, user-facing `message`; the SDK error is its `cause`. */
export class AiRequestError extends Error {
  override readonly name: string = "AiRequestError";
  readonly kind: AiErrorKind;
  /** Whether re-sending the same request can succeed (rate limits, overload, network). */
  readonly retryable: boolean;
  /** The API's `request-id`, when the failure came from an HTTP response. */
  readonly requestId: string | undefined;

  constructor(
    kind: AiErrorKind,
    message: string,
    options?: ErrorOptions & { readonly retryable?: boolean; readonly requestId?: string },
  ) {
    super(message, options);
    this.kind = kind;
    this.retryable = options?.retryable ?? false;
    this.requestId = options?.requestId;
  }
}

/** Refusal categories the API reports in `stop_details.category`. */
type RefusalCategory = NonNullable<NonNullable<BetaMessage["stop_details"]>["category"]>;

/** Title Case display name per refusal category. */
const REFUSAL_CATEGORY_LABELS: Record<RefusalCategory, string> = {
  cyber: "Cybersecurity",
  bio: "Biology",
  frontier_llm: "Frontier AI Development",
  reasoning_extraction: "Reasoning Extraction",
  general_harms: "General Harms",
};

/**
 * The model declined the request (`stop_reason: "refusal"`, HTTP 200) —
 * after any server-side fallback also declined. Carries `stop_details`
 * so the UI can say why; `declined` holds the whole response, whose
 * partial output must never be treated as a finished reply.
 */
export class AiRefusalError extends AiRequestError {
  override readonly name: string = "AiRefusalError";
  /** The policy category, or `null` when the API names none (a permanent, valid state). */
  readonly category: RefusalCategory | null;
  readonly explanation: string | null;
  readonly declined: ChatResponse;

  constructor(declined: ChatResponse) {
    const category = declined.stop_details?.category ?? null;
    const label = category ? REFUSAL_CATEGORY_LABELS[category] : null;
    super("refusal", `Request Declined${label ? ` (${label})` : ""}`);
    this.category = category;
    this.explanation = declined.stop_details?.explanation ?? null;
    this.declined = declined;
  }
}

/** Seconds to wait before retrying, from a 429/529 response's `retry-after` header. */
function retryAfterSeconds(err: InstanceType<typeof Anthropic.APIError>): number | undefined {
  const seconds = Number(err.headers?.get("retry-after") ?? Number.NaN);
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : undefined;
}

const ApiErrorBodySchema = z.object({ error: z.object({ message: z.string() }) });

/** The API's own error text from a 4xx body (`{ error: { message } }`), when present. */
function apiErrorDetail(err: InstanceType<typeof Anthropic.APIError>): string | undefined {
  const body = ApiErrorBodySchema.safeParse(err.error);
  return body.success ? body.data.error.message : undefined;
}

/**
 * Normalizes anything a request can throw into an {@link AiRequestError}.
 * Classification goes by SDK error class, most specific first; the
 * original error is kept as `cause`.
 */
export function toAiRequestError(err: unknown): AiRequestError {
  if (err instanceof AiRequestError) return err;
  const requestId = err instanceof Anthropic.APIError ? (err.requestID ?? undefined) : undefined;
  const opts = { cause: err, requestId };

  if (err instanceof Anthropic.APIUserAbortError) {
    return new AiRequestError("aborted", "Request Cancelled", opts);
  }
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return new AiRequestError("timeout", "Request Timed Out — Check Your Connection", {
      ...opts,
      retryable: true,
    });
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new AiRequestError("connection", "Network Connection Failed — Check Your Connection", {
      ...opts,
      retryable: true,
    });
  }
  if (err instanceof Anthropic.AuthenticationError) {
    return new AiRequestError("auth", "API Key Rejected (401) — Update It In Settings", opts);
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return new AiRequestError(
      "permission",
      "Permission Denied (403) — This API Key Cannot Use This Model",
      opts,
    );
  }
  if (err instanceof Anthropic.NotFoundError) {
    return new AiRequestError("not_found", "Model Not Found (404) — Pick Another Model", opts);
  }
  if (err instanceof Anthropic.RateLimitError) {
    const wait = retryAfterSeconds(err);
    return new AiRequestError(
      "rate_limit",
      `Rate Limited (429)${wait ? ` — Retry In ${wait}s` : " — Retry Shortly"}`,
      { ...opts, retryable: true },
    );
  }
  if (err instanceof Anthropic.APIError && err.type === "overloaded_error") {
    return new AiRequestError("overloaded", "Anthropic API Overloaded — Try Again Shortly", {
      ...opts,
      retryable: true,
    });
  }
  if (err instanceof Anthropic.InternalServerError) {
    return new AiRequestError("server", `Anthropic API Error (${err.status}) — Try Again Shortly`, {
      ...opts,
      retryable: true,
    });
  }
  if (err instanceof Anthropic.APIError && err.status !== undefined && err.status < 500) {
    const detail = apiErrorDetail(err);
    return new AiRequestError(
      "bad_request",
      `Request Rejected (${err.status})${detail ? `: ${detail}` : ""}`,
      opts,
    );
  }
  if (err instanceof Anthropic.APIError) {
    return new AiRequestError("server", "Anthropic API Error — Try Again Shortly", {
      ...opts,
      retryable: true,
    });
  }
  // Every other SDK error is raised client-side while reading the event
  // stream (e.g. tool-input JSON it could not parse at
  // `content_block_stop`): nothing was committed, so a re-send can work.
  if (err instanceof Anthropic.AnthropicError) {
    return new AiRequestError("stream", "The Response Stream Broke Off — Try Again", {
      ...opts,
      retryable: true,
    });
  }
  return new AiRequestError(
    "unknown",
    Error.isError(err) ? err.message : "Unexpected AI Request Failure",
    opts,
  );
}

// ── Client ───────────────────────────────────────────

let cached: { readonly key: string; readonly client: Anthropic } | undefined;

/**
 * Returns an SDK client for the currently configured API key. The key is
 * re-read from the backend config on every call (one IPC round-trip), so
 * a key saved in Settings applies to the very next request; the client
 * itself is rebuilt only when the key changes.
 */
async function getClient(): Promise<Anthropic> {
  const raw = await readConfig(ANTHROPIC_API_KEY_CONFIG_KEY, z.string());
  const key = raw?.trim() ?? "";
  if (!key) {
    throw new AiRequestError("missing_key", "API Key Not Configured — Add It In Settings");
  }
  if (cached?.key !== key) {
    cached = { key, client: new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true }) };
  }
  return cached.client;
}

/**
 * Models whose `fallbacks` opt-in the API rejected this session (see
 * {@link streamMessage}); later requests for them go out without it.
 */
const fallbackRejected = new Set<string>();

/** Builds the request body; capability-gated fields are dropped for models that reject them. */
function buildRequest(params: StreamParams, withFallbacks: boolean): BetaMessageStreamParams {
  const model = getModelById(params.model);
  return {
    model: params.model,
    max_tokens: Math.min(params.maxTokens, model?.maxOutputTokens ?? params.maxTokens),
    messages: [...params.messages],
    ...(params.system ? { system: params.system } : {}),
    // Every tool streams its input as it is generated (the API otherwise
    // buffers each parameter). The input is then no longer validated
    // server-side, which is why the tool runtime validates every input
    // against its schema before running it.
    ...(params.tools?.length
      ? { tools: params.tools.map((tool) => ({ ...tool, eager_input_streaming: true })) }
      : {}),
    // Summarized thinking streams readable reasoning — and, on Fable 5.1,
    // Mythos 5.1, Opus 5.5 and Sonnet 5.5, the progress notes written between tool calls —
    // instead of a silent pause (the default display is "omitted").
    // Unknown models get the API's own default rather than a guess.
    ...(model?.adaptiveThinking
      ? { thinking: { type: "adaptive", display: "summarized" } as const }
      : {}),
    ...(params.effort && model?.effort ? { output_config: { effort: params.effort } } : {}),
    ...(params.cache ? { cache_control: { type: "ephemeral" } as const } : {}),
    ...(withFallbacks ? { betas: [REFUSAL_FALLBACK_BETA], fallbacks: "default" as const } : {}),
  };
}

/** Prices one usage record by the model that served it (falling back to the requested one). */
function priceUsage(
  model: string | null | undefined,
  fallback: string,
  usage: UsageTokens,
): number {
  return estimateCostUsd(model && hasPricing(model) ? model : fallback, usage);
}

/**
 * Adds a response's token usage and estimated cost to the AI store's
 * running totals. With server-side fallbacks, `usage.iterations` is the
 * per-attempt source of truth (a declined partial bills at the declining
 * model's rates, the rescue at the fallback's); top-level `usage` then
 * covers only the attempt that produced the message.
 */
function recordUsage(requestedModel: string, message: ChatResponse): void {
  const attempts = (message.usage.iterations ?? []).filter(
    (entry) => entry.type === "message" || entry.type === "fallback_message",
  );
  const billed: readonly { readonly model: string | null; readonly usage: UsageTokens }[] =
    attempts.length > 0
      ? attempts.map((entry) => ({ model: entry.model, usage: entry }))
      : [{ model: message.model, usage: message.usage }];
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  for (const { model, usage } of billed) {
    inputTokens +=
      usage.input_tokens +
      (usage.cache_creation_input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0);
    outputTokens += usage.output_tokens;
    costUsd += priceUsage(model, requestedModel, usage);
  }
  useAiStore.getState().addTokenUsage({
    inputTokens,
    outputTokens,
    model: message.model,
    provider: "anthropic",
    costUsd,
    timestamp: Date.now(),
  });
}

// ── Replay ───────────────────────────────────────────

type ReplayableBlock =
  | BetaTextBlock
  | BetaThinkingBlock
  | BetaRedactedThinkingBlock
  | BetaToolUseBlock;

const REPLAYABLE_TYPES: ReadonlySet<BetaContentBlock["type"]> = new Set([
  "text",
  "thinking",
  "redacted_thinking",
  "tool_use",
]);

function isReplayable(block: BetaContentBlock): block is ReplayableBlock {
  return REPLAYABLE_TYPES.has(block.type);
}

/**
 * The part of a response to replay as the next request's assistant turn
 * — the blocks exactly as received, never rebuilt. After a mid-output
 * refusal fallback only the declined partial's `text` blocks may be
 * echoed (its `thinking`/`tool_use` blocks belong to a model that did
 * not finish the turn), everything after the last `fallback` marker
 * echoes normally, and the markers themselves are dropped.
 */
export function replayableContent(message: ChatResponse): ReplayableBlock[] {
  const boundary = message.content.findLastIndex((block) => block.type === "fallback");
  return message.content.filter(
    (block, index): block is ReplayableBlock =>
      isReplayable(block) && (index > boundary || block.type === "text"),
  );
}

/**
 * The `tool_use` blocks a response asks the client to run — those in
 * {@link replayableContent}, so a call begun by a model that was then
 * replaced by a refusal fallback is never executed.
 */
export function toolUseBlocks(message: ChatResponse): BetaToolUseBlock[] {
  return replayableContent(message).filter(
    (block): block is BetaToolUseBlock => block.type === "tool_use",
  );
}

/** Content blocks stripped of `thinking`/`redacted_thinking` — for replaying a history that no longer matches the prefix those blocks were bound to. */
export function withoutThinking(
  content: string | readonly BetaContentBlockParam[],
): string | BetaContentBlockParam[] {
  if (typeof content === "string") return content;
  return content.filter((block) => block.type !== "thinking" && block.type !== "redacted_thinking");
}

// ── Streaming ────────────────────────────────────────

/**
 * Streams one Messages API request.
 *
 * Yields {@link StreamDelta}s as the model writes (summarized thinking,
 * text, `tool_use` input as it streams, and a `fallback` marker when a
 * declined request continues on another model), then **returns** the
 * SDK's `finalMessage()` — iterate with `for await` when only the deltas
 * matter, or drive the generator manually to receive the final message.
 * Token usage and cost are recorded in `useAiStore`.
 *
 * `stop_reason` is left to the caller (`max_tokens`, `pause_turn`,
 * `tool_use`, `model_context_window_exceeded`, …) except `refusal`,
 * which throws {@link AiRefusalError}: a declined turn must never read
 * as a normal reply. Every other failure — no key, HTTP/network errors,
 * abort via `signal`, a broken event stream — throws
 * {@link AiRequestError}.
 *
 * The refusal-fallback opt-in is a beta feature; should the API reject
 * a request carrying it (HTTP 400, decided before any output and not
 * billed), the request is sent once more without it; only if that retry
 * succeeds is the model remembered for the rest of the session.
 */
export async function* streamMessage(
  params: StreamParams,
  signal?: AbortSignal,
): AsyncGenerator<StreamDelta, ChatResponse, undefined> {
  let message: ChatResponse | undefined;
  let withFallbacks =
    getModelById(params.model)?.refusalFallback === true && !fallbackRejected.has(params.model);
  let retriedWithoutFallbacks = false;

  while (message === undefined) {
    let yielded = false;
    let stream: { abort(): void } | undefined;
    const toolBlocks = new Map<number, { id: string; name: string; json: string }>();
    try {
      signal?.throwIfAborted();
      const client = await getClient();
      signal?.throwIfAborted();
      const request = client.beta.messages.stream(buildRequest(params, withFallbacks), { signal });
      stream = request;

      for await (const event of request) {
        switch (event.type) {
          case "content_block_start": {
            const block = event.content_block;
            if (block.type === "tool_use") {
              toolBlocks.set(event.index, { id: block.id, name: block.name, json: "" });
              yielded = true;
              yield {
                type: "tool_use",
                content: "",
                toolUse: { id: block.id, toolName: block.name, partialInput: "", complete: false },
              };
            } else if (block.type === "fallback") {
              yielded = true;
              yield { type: "fallback", content: "", from: block.from.model, to: block.to.model };
            }
            break;
          }
          case "content_block_delta": {
            const { delta } = event;
            if (delta.type === "text_delta") {
              yielded = true;
              yield { type: "text", content: delta.text };
            } else if (delta.type === "thinking_delta" && delta.thinking) {
              yielded = true;
              yield { type: "thinking", content: "", thinking: delta.thinking };
            } else if (delta.type === "input_json_delta") {
              const block = toolBlocks.get(event.index);
              if (block) {
                block.json += delta.partial_json;
                yield {
                  type: "tool_use",
                  content: "",
                  toolUse: {
                    id: block.id,
                    toolName: block.name,
                    partialInput: block.json,
                    complete: false,
                  },
                };
              }
            }
            // signature_delta / citations_delta and the rest are
            // accumulated by the SDK into finalMessage().
            break;
          }
          case "content_block_stop": {
            const block = toolBlocks.get(event.index);
            if (block) {
              toolBlocks.delete(event.index);
              yield {
                type: "tool_use",
                content: "",
                toolUse: {
                  id: block.id,
                  toolName: block.name,
                  partialInput: block.json,
                  complete: true,
                },
              };
            }
            break;
          }
          default:
            break;
        }
      }
      message = await request.finalMessage();
    } catch (err) {
      // The DOMException from `throwIfAborted` and the SDK's
      // APIUserAbortError both mean "cancelled by the caller".
      if (signal?.aborted) {
        throw new AiRequestError("aborted", "Request Cancelled", { cause: err });
      }
      if (withFallbacks && !yielded && err instanceof Anthropic.BadRequestError) {
        withFallbacks = false;
        retriedWithoutFallbacks = true;
        continue;
      }
      throw toAiRequestError(err);
    } finally {
      // A consumer that stops iterating early (`break`/`return`) closes
      // this generator mid-stream: abort the HTTP stream with it.
      if (message === undefined) stream?.abort();
    }
  }

  // Only a retry that succeeded without the opt-in proves the opt-in was
  // what the API rejected; an unrelated 400 (bad transcript, prompt too
  // long, bad tool schema) fails the retry too and leaves fallbacks on.
  if (retriedWithoutFallbacks) fallbackRejected.add(params.model);
  recordUsage(params.model, message);
  if (message.stop_reason === "refusal") throw new AiRefusalError(message);
  return message;
}

// ── Tool schema conversion ───────────────────────────

/**
 * Converts a Zod schema into an Anthropic tool definition via
 * `z.toJSONSchema()`. The JSON Schema `$schema` dialect marker is
 * dropped: the API assumes draft 2020-12 and it would only add request
 * bytes to every call.
 */
export function zodToTool(name: string, description: string, schema: z.ZodType): ChatTool {
  const { $schema: _dialect, ...inputSchema } = z.toJSONSchema(schema);
  return {
    name,
    description,
    input_schema: { ...inputSchema, type: "object" },
  };
}
