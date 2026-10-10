#!/usr/bin/env node
/**
 * Stand-in for the `claude` CLI in ClaudeCodeAdapter's unit tests
 * (crates/swarm-core/src/agent/claude_code/tests.rs) and in the worker
 * commands' handshake tests (crates/swarm-core/src/commands/agent.rs),
 * which play the `"held"` initialize mode and repeat HELD_MARKER and
 * RELEASE_MARKER as Rust constants, so the two change together:
 *
 *   node fake_claude_cli.mjs <scenario.mjs> <claude flags...>
 *
 * It speaks claude 2.1.28x's stream-json protocol over piped stdio with
 * the real CLI's ordering: nothing reaches stdout before input arrives,
 * and every turn's `system/init` follows that turn's user message. The
 * harness answers `initialize`, `get_binary_version` and `interrupt`
 * itself, refuses any other control request the way the CLI does, and
 * exits 0 on stdin EOF (the CLI's idle shutdown).
 *
 * A scenario module default-exports `async (cli) => {}` and plays its
 * turns through the `cli` object below; it may also export `config` to
 * change what the harness reports (see `DEFAULTS`). A scenario without a
 * default export only serves the control protocol (the probe tests).
 *
 * Frame shapes follow @anthropic-ai/claude-agent-sdk 0.3.280's sdk.d.ts
 * and live claude 2.1.280/2.1.281 traces, trimmed to the fields the
 * adapter reads plus representative neighbours. Each scenario's header
 * says which capture its text, tool inputs and costs come from, and
 * which parts are synthetic.
 *
 * Needs Node 22 or newer (`Promise.withResolvers`); the repo pins its
 * Node through pnpm, and every job that runs the Rust tests must put
 * that Node on PATH.
 */
import { randomUUID } from "node:crypto";
import { existsSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const DEFAULTS = {
  /** `get_binary_version` answer and `system/init.claude_code_version`. */
  version: "2.1.281",
  /** `initialize` account; this is the signed-in (OAuth) shape. */
  account: {
    email: "worker@example.com",
    organization: "Example Org",
    subscriptionType: "Claude Max",
    apiProvider: "firstParty",
  },
  /** `system/init.capabilities`; `null` omits the field (a pre-capability CLI). */
  capabilities: ["interrupt_receipt_v1", "interrupt_cancel_queued_v1", "msg_lifecycle_v1"],
  /**
   * `"answer"`, `"never"` (no response at all), `"error"`,
   * `"unreadable"` (a success whose `current_permission_mode` is not a
   * string), or `"held"`: write `HELD_MARKER` in the working directory,
   * wait until `RELEASE_MARKER` exists there, then reply as `released`
   * says.
   */
  initialize: "answer",
  /** How a `"held"` `initialize` replies once released (any mode above but `"held"`). */
  released: "answer",
  /** Overrides the permission mode `initialize` reports (default: from `--permission-mode`). */
  permissionMode: undefined,
  /** Write `<tmpdir>/swarm-fake-claude-<session id>.pid` at start (process-reaping tests). */
  writePid: false,
};

const [scenarioPath, ...argv] = process.argv.slice(2);
const scenario = await import(pathToFileURL(scenarioPath).href);
const config = { ...DEFAULTS, ...scenario.config };

const flag = (name) => {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
};
const sessionId = flag("--session-id") ?? flag("--resume") ?? randomUUID();
// The CLI still reports its renamed default mode as `default` when
// started with `--permission-mode manual` (2.1.281).
const permissionMode = (flag("--permission-mode") ?? "default").replace(/^manual$/, "default");
const lifecycleSupported = config.capabilities?.includes("msg_lifecycle_v1") ?? false;

if (config.writePid) {
  writeFileSync(join(tmpdir(), `swarm-fake-claude-${sessionId}.pid`), String(process.pid));
}

// ── Output ──────────────────────────────────────────────────────────

// Synchronous writes to fd 1: stdout is a pipe here, and an async write
// followed by process.exit() can lose whatever has not reached the OS.
const emit = (...frames) => {
  for (const frame of frames.flat()) writeSync(1, `${JSON.stringify(frame)}\n`);
};

// ── Frame builders ──────────────────────────────────────────────────

const MODEL = "claude-sonnet-5";
const stamp = (turn) =>
  turn ? { user_message_uuid: turn.uuid, user_message_uuids: [turn.uuid] } : {};
const parentOf = (opts) => opts?.parent ?? null;

const streamEvent = (event, opts) => ({
  type: "stream_event",
  event,
  session_id: sessionId,
  parent_tool_use_id: parentOf(opts),
  uuid: randomUUID(),
  ...stamp(opts?.turn),
});

const assistant = (content, opts) => ({
  type: "assistant",
  message: {
    model: opts?.model ?? MODEL,
    id: opts?.id ?? `msg_${randomUUID().replaceAll("-", "")}`,
    type: "message",
    role: "assistant",
    content,
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 8, service_tier: "standard" },
  },
  parent_tool_use_id: parentOf(opts),
  session_id: sessionId,
  uuid: randomUUID(),
  ...stamp(opts?.turn),
});

const frames = {
  init: (overrides) => ({
    type: "system",
    subtype: "init",
    cwd: process.cwd(),
    session_id: sessionId,
    tools: ["Agent", "Bash", "Edit", "Glob", "Grep", "Read", "WebSearch", "Write"],
    mcp_servers: [],
    model: MODEL,
    permissionMode,
    slash_commands: ["compact", "context", "cost", "init", "review"],
    apiKeySource: "none",
    claude_code_version: config.version,
    output_style: "default",
    agents: ["general-purpose", "Explore", "Plan"],
    skills: [],
    plugins: [],
    ...(config.capabilities === null ? {} : { capabilities: config.capabilities }),
    uuid: randomUUID(),
    fast_mode_state: "off",
    ...overrides,
  }),
  status: () => ({
    type: "system",
    subtype: "status",
    status: "requesting",
    session_id: sessionId,
    uuid: randomUUID(),
  }),
  messageStart: (opts) =>
    streamEvent(
      {
        type: "message_start",
        message: {
          model: opts?.model ?? MODEL,
          id: `msg_${randomUUID().replaceAll("-", "")}`,
          type: "message",
          role: "assistant",
          content: [],
          stop_reason: null,
          usage: { input_tokens: 10, output_tokens: 3, service_tier: "standard" },
        },
      },
      opts,
    ),
  blockStart: (index, block, opts) =>
    streamEvent({ type: "content_block_start", index, content_block: block }, opts),
  textDelta: (index, text, opts) =>
    streamEvent({ type: "content_block_delta", index, delta: { type: "text_delta", text } }, opts),
  thinkingDelta: (index, thinking, opts) =>
    streamEvent(
      {
        type: "content_block_delta",
        index,
        delta: { type: "thinking_delta", thinking, estimated_tokens: 50 },
      },
      opts,
    ),
  signatureDelta: (index, opts) =>
    streamEvent(
      {
        type: "content_block_delta",
        index,
        delta: { type: "signature_delta", signature: "EuMFCokBCBAYAipA55Qmx54REdyrkfaVzRgO" },
      },
      opts,
    ),
  inputJsonDelta: (index, partial, opts) =>
    streamEvent(
      {
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: partial },
      },
      opts,
    ),
  blockStop: (index, opts) => streamEvent({ type: "content_block_stop", index }, opts),
  messageDelta: (stopReason, opts) =>
    streamEvent(
      {
        type: "message_delta",
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { input_tokens: 10, output_tokens: 36 },
      },
      opts,
    ),
  messageStop: (opts) => streamEvent({ type: "message_stop" }, opts),
  assistant,
  /** A whole text block: start, two deltas, the complete message, stop. */
  textBlock: (index, text, opts) => {
    const cut = Math.ceil(text.length / 2);
    return [
      frames.blockStart(index, { type: "text", text: "" }, opts),
      frames.textDelta(index, text.slice(0, cut), opts),
      frames.textDelta(index, text.slice(cut), opts),
      assistant([{ type: "text", text }], opts),
      frames.blockStop(index, opts),
    ];
  },
  /** A thinking block as current models stream it: empty thinking, then a signature. */
  thinkingBlock: (index, opts) => [
    frames.blockStart(index, { type: "thinking", thinking: "", signature: "" }, opts),
    frames.thinkingDelta(index, "", opts),
    frames.signatureDelta(index, opts),
    assistant(
      [{ type: "thinking", thinking: "", signature: "EuMFCokBCBAYAipA55Qmx54REdyrkfaVzRgO" }],
      opts,
    ),
    frames.blockStop(index, opts),
  ],
  /** A whole tool_use block; its input streams as one input_json_delta. */
  toolUseBlock: (index, { id, name, input }, opts) => [
    frames.blockStart(
      index,
      { type: "tool_use", id, name, input: {}, caller: { type: "direct" } },
      opts,
    ),
    frames.inputJsonDelta(index, JSON.stringify(input), opts),
    assistant([{ type: "tool_use", id, name, input, caller: { type: "direct" } }], opts),
    frames.blockStop(index, opts),
  ],
  /** A user line carrying tool results: `[{ id, content, isError }]`. */
  toolResults: (results, opts) => ({
    type: "user",
    message: {
      role: "user",
      content: results.map(({ id, content, isError }) => ({
        tool_use_id: id,
        type: "tool_result",
        content,
        ...(isError === undefined ? {} : { is_error: isError }),
      })),
    },
    parent_tool_use_id: parentOf(opts),
    session_id: sessionId,
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
  }),
  rateLimit: () => ({
    type: "rate_limit_event",
    rate_limit_info: { status: "allowed", rateLimitType: "five_hour", isUsingOverage: false },
    uuid: randomUUID(),
    session_id: sessionId,
  }),
  permissionDenied: ({ toolName, toolUseId, message, decisionReasonType }) => ({
    type: "system",
    subtype: "permission_denied",
    tool_name: toolName,
    tool_use_id: toolUseId,
    ...(decisionReasonType ? { decision_reason_type: decisionReasonType } : {}),
    message,
    uuid: randomUUID(),
    session_id: sessionId,
  }),
  /** Only the fields a scenario passes are set, as on the live asks. */
  canUseTool: (
    requestId,
    {
      toolName,
      input,
      toolUseId,
      decisionReason,
      title,
      description,
      requiresUserInteraction,
      agentId,
    },
  ) => ({
    type: "control_request",
    request_id: requestId,
    request: {
      subtype: "can_use_tool",
      tool_name: toolName,
      display_name: toolName,
      input,
      permission_suggestions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
      tool_use_id: toolUseId,
      ...(decisionReason ? { decision_reason: decisionReason } : {}),
      ...(title ? { title } : {}),
      ...(description ? { description } : {}),
      ...(requiresUserInteraction ? { requires_user_interaction: true } : {}),
      ...(agentId ? { agent_id: agentId } : {}),
    },
  }),
  lifecycle: (turn, state) => ({
    type: "command_lifecycle",
    command_uuid: turn.uuid,
    state,
    uuid: randomUUID(),
    session_id: sessionId,
  }),
  result: ({
    turn,
    subtype = "success",
    isError = false,
    result,
    errors,
    costUsd = 0,
    durationMs = 1000,
    numTurns = 1,
    terminalReason = subtype === "success" && !isError ? "completed" : undefined,
    stopReason = subtype === "success" && !isError ? "end_turn" : null,
    apiErrorStatus,
    denials = [],
  }) => ({
    type: "result",
    subtype,
    duration_ms: durationMs,
    duration_api_ms: durationMs,
    is_error: isError,
    num_turns: numTurns,
    stop_reason: stopReason,
    session_id: sessionId,
    total_cost_usd: costUsd,
    usage: { input_tokens: 18, output_tokens: 239, service_tier: "standard" },
    modelUsage: {},
    permission_denials: denials.map(({ toolName, toolUseId, toolInput }) => ({
      tool_name: toolName,
      tool_use_id: toolUseId,
      tool_input: toolInput,
    })),
    ...(terminalReason ? { terminal_reason: terminalReason } : {}),
    ...(subtype === "success" ? { api_error_status: apiErrorStatus ?? null, result } : {}),
    ...(errors ? { errors } : {}),
    uuid: randomUUID(),
    ...stamp(turn),
  }),
};

// ── Input ───────────────────────────────────────────────────────────

/** A queue whose `next()` resolves with the oldest unclaimed item. */
const queue = () => {
  const items = [];
  const waiters = [];
  return {
    push(item) {
      const waiter = waiters.shift();
      if (waiter) waiter(item);
      else items.push(item);
    },
    next() {
      if (items.length > 0) return Promise.resolve(items.shift());
      const { promise, resolve } = Promise.withResolvers();
      waiters.push(resolve);
      return promise;
    },
  };
};

const userMessages = queue();
const interrupts = queue();
const answers = new Map();

const answerOf = (requestId) => {
  if (!answers.has(requestId)) answers.set(requestId, Promise.withResolvers());
  return answers.get(requestId);
};

const controlSuccess = (requestId, response) =>
  emit({
    type: "control_response",
    response: { subtype: "success", request_id: requestId, response },
  });

const controlError = (requestId, error) =>
  emit({ type: "control_response", response: { subtype: "error", request_id: requestId, error } });

/** Written to the working directory when a `"held"` `initialize` starts waiting. */
const HELD_MARKER = "swarm-fake-claude.held";
/** A `"held"` `initialize` replies once this file exists in the working directory. */
const RELEASE_MARKER = "swarm-fake-claude.release";

const answerInitialize = (requestId, mode) => {
  if (mode === "never") return;
  if (mode === "error") return controlError(requestId, "initialize refused");
  if (mode === "unreadable") {
    return controlSuccess(requestId, { models: [], current_permission_mode: 7 });
  }
  if (mode === "held") {
    writeFileSync(join(process.cwd(), HELD_MARKER), "");
    const poll = setInterval(() => {
      if (!existsSync(join(process.cwd(), RELEASE_MARKER))) return;
      clearInterval(poll);
      answerInitialize(requestId, config.released);
    }, 20);
    return;
  }
  return controlSuccess(requestId, {
    commands: [{ name: "compact", description: "Compact the conversation", argumentHint: "" }],
    agents: [{ name: "general-purpose", description: "General-purpose agent" }],
    output_style: "default",
    available_output_styles: ["default"],
    models: [
      { value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default" },
      { value: "sonnet", resolvedModel: "claude-sonnet-5", displayName: "Sonnet" },
      { value: "haiku", resolvedModel: "claude-haiku-4-5-20251001", displayName: "Haiku" },
    ],
    account: config.account,
    pid: process.pid,
    current_permission_mode: config.permissionMode ?? permissionMode,
    session_state: "idle",
    pending_permission_requests: [],
  });
};

const handleControlRequest = ({ request_id: requestId, request }) => {
  switch (request.subtype) {
    case "initialize":
      return answerInitialize(requestId, config.initialize);
    case "get_binary_version":
      return controlSuccess(requestId, {
        version: config.version,
        buildTime: "2026-09-23T02:22:43Z",
      });
    case "interrupt":
      controlSuccess(requestId, { still_queued: [] });
      return interrupts.push({ requestId, cancelQueued: request.cancel_queued === true });
    default:
      return controlError(requestId, `Unsupported control request subtype: ${request.subtype}`);
  }
};

const input = createInterface({ input: process.stdin, terminal: false });
input.on("line", (line) => {
  if (!line.trim()) return;
  const frame = JSON.parse(line);
  switch (frame.type) {
    case "user":
      return userMessages.push(frame);
    case "control_request":
      return handleControlRequest(frame);
    case "control_response":
      return answerOf(frame.response.request_id).resolve(frame.response);
    default:
      return undefined;
  }
});
// The CLI's idle shutdown: stdin EOF ends the process cleanly.
input.on("close", () => process.exit(0));

// ── Scenario API ────────────────────────────────────────────────────

const cli = {
  argv,
  sessionId,
  frames,
  emit,
  /**
   * Resolves with the next user message as `{ uuid, text }`. With a
   * uuid-stamped message on a lifecycle-capable CLI it also emits the
   * `queued` lifecycle frame and, unless `start` is false, `started`.
   */
  async nextUser({ start = true } = {}) {
    const frame = await userMessages.next();
    const turn = {
      uuid: frame.uuid,
      text: frame.message.content.map((block) => block.text ?? "").join(""),
    };
    if (turn.uuid && lifecycleSupported) {
      emit(frames.lifecycle(turn, "queued"));
      if (start) emit(frames.lifecycle(turn, "started"));
    }
    return turn;
  },
  /** Emits a lifecycle frame for `turn` when the CLI supports them. */
  lifecycle(turn, state) {
    if (turn.uuid && lifecycleSupported) emit(frames.lifecycle(turn, state));
  },
  /** Resolves with the host's `control_response` to a request the scenario sent. */
  answer: (requestId) => answerOf(requestId).promise,
  /** Resolves on the next `interrupt` control request (already acknowledged). */
  interrupted: () => interrupts.next(),
  exit: (code) => process.exit(code),
  /** An 11MB line with no newline, past the adapter's 10MB NDJSON cap. */
  oversized: () => writeSync(1, "x".repeat(11 * 1024 * 1024)),
  /** Never resolves: the process stays up until it is killed or stdin closes. */
  hang: () => new Promise(() => {}),
};

await scenario.default?.(cli);
