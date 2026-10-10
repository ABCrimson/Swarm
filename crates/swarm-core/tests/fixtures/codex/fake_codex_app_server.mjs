#!/usr/bin/env node
/**
 * Fake `codex` CLI for CodexAdapter's tests
 * (crates/swarm-core/src/agent/codex/tests.rs).
 *
 * It speaks the codex-cli 0.156.1 app-server protocol the way the real
 * server does where the tests depend on it:
 *
 * - JSON-RPC without the `"jsonrpc"` member, one message per line.
 * - Any request before `initialize` is answered `-32600 Not initialized`.
 * - `thread/start` / `thread/resume` responses echo the `approvalPolicy`
 *   and `sandbox` the client sent — and, when a key is missing, report the
 *   user's configured default instead (here the most permissive one,
 *   `dangerFullAccess`), exactly as the live server answered a request that
 *   used the wrong `sandboxPolicy` key.
 * - Stdin EOF ends the process (exit 0), unless IGNORE_STDIN_EOF.
 *
 * Every message the client writes is appended to the `--record` file as
 * one JSON line, so a test can assert the exact wire traffic; the fake
 * also records `{"fake":"stdin-eof"}` when stdin closes.
 *
 * Usage:
 *   node fake_codex_app_server.mjs --version
 *   node fake_codex_app_server.mjs [--logged-out] login status
 *   node fake_codex_app_server.mjs --script <file> [--record <file>] app-server
 *
 * Script format — one entry per line; blank lines and `#` comments are
 * skipped; any other line is written to stdout verbatim after these
 * substitutions: `@THREAD` -> the current thread id, `@TURN` -> the
 * current turn id, `@N` -> the REPEAT counter. Directives
 * (`#DIRECTIVE <NAME> [args]`):
 *
 *   EXPECT_REQUEST <method>       next client message must be that request
 *   EXPECT_NOTIFICATION <method>  next client message must be that notification
 *   EXPECT_RESPONSE <json-id>     next client message must answer that id
 *                                 (type-exact: 7 and "7" differ)
 *   RESPOND_INITIALIZE            answer the last request like `initialize`
 *   RESPOND_THREAD_START <thread-id> [<sandbox>]
 *                                 answer like `thread/start`; <sandbox>
 *                                 forces the applied sandbox mode
 *   RESPOND_THREAD_RESUME [<sandbox>]
 *                                 answer like `thread/resume`
 *   RESPOND_TURN_START <turn-id>  answer like `turn/start`
 *   RESPOND <json-result>         answer the last request with this result
 *   RESPOND_ERROR <code> <text>   answer the last request with an error
 *   REPEAT <n> <line>             write <line> n times
 *   EMIT_OVERSIZED_LINE           write 11 MB with no newline, then hang
 *   IGNORE_STDIN_EOF              keep running after stdin closes (a hung server)
 *   ON_STDIN_EOF <line>           keep running after stdin closes and write
 *                                 <line> then (repeatable: lines queue up)
 *   HANG                          never continue
 *   EXIT <code>                   exit now
 *
 * When the script ends the fake keeps serving until stdin closes, like the
 * real server.
 */

import { appendFileSync, readFileSync, writeSync } from "node:fs";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";

const VERSION = "0.156.1";

/** Sandbox policies as the server reports them, keyed by the mode sent. */
const SANDBOX_POLICIES = {
  "read-only": { type: "readOnly", networkAccess: false },
  "workspace-write": {
    type: "workspaceWrite",
    writableRoots: [],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  },
  "danger-full-access": { type: "dangerFullAccess" },
};

/** What a request without an approval policy or sandbox falls back to. */
const CONFIGURED_DEFAULT = { approvalPolicy: "on-request", sandbox: "danger-full-access" };

const { values: options, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    version: { type: "boolean", default: false },
    "logged-out": { type: "boolean", default: false },
    script: { type: "string" },
    record: { type: "string" },
  },
});

if (options.version) {
  console.log(`codex-cli ${VERSION}`);
  process.exit(0);
}
if (positionals[0] === "login" && positionals[1] === "status") {
  console.log(options["logged-out"] ? "Not logged in" : "Logged in using ChatGPT");
  process.exit(options["logged-out"] ? 1 : 0);
}
if (positionals[0] !== "app-server" || options.script === undefined) {
  console.error("usage: fake_codex_app_server.mjs --script <file> [--record <file>] app-server");
  process.exit(2);
}

const record = (entry) => {
  if (options.record !== undefined) appendFileSync(options.record, `${JSON.stringify(entry)}\n`);
};
/**
 * Writes all of `text` to stdout synchronously, so every line reaches the
 * pipe before the script moves on. `writeSync` may write only part of a
 * large buffer, and a non-blocking pipe answers `EAGAIN` while it is full.
 */
const writeAll = (text) => {
  let pending = Buffer.from(text);
  const pause = new Int32Array(new SharedArrayBuffer(4));
  while (pending.length > 0) {
    try {
      pending = pending.subarray(writeSync(1, pending));
    } catch (error) {
      if (error.code !== "EAGAIN") throw error;
      Atomics.wait(pause, 0, 0, 5);
    }
  }
};
const send = (line) => writeAll(`${line}\n`);
const fail = (message) => {
  process.stderr.write(`FAKE_CODEX_APP_SERVER: ${message}\n`);
  process.exit(3);
};

const state = {
  lastRequest: undefined,
  thread: "",
  turn: "",
  initialized: false,
  exitOnEof: true,
  afterEof: [],
};
const inbox = [];
const waiters = [];

record({ fake: "started", pid: process.pid });
const input = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
input.on("line", (line) => {
  if (line.trim() === "") return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    fail(`client wrote a line that is not JSON: ${line}`);
  }
  record(message);
  const isRequest = message.method !== undefined && message.id !== undefined;
  if (isRequest && !state.initialized && message.method !== "initialize") {
    send(JSON.stringify({ error: { code: -32600, message: "Not initialized" }, id: message.id }));
    return;
  }
  if (message.method === "initialize") state.initialized = true;
  const waiter = waiters.shift();
  if (waiter) waiter(message);
  else inbox.push(message);
});
input.on("close", () => {
  record({ fake: "stdin-eof" });
  if (state.exitOnEof) process.exit(0);
  for (const line of state.afterEof) send(fill(line));
  for (const waiter of waiters.splice(0)) waiter(undefined);
});

const nextMessage = () =>
  inbox.length > 0
    ? Promise.resolve(inbox.shift())
    : new Promise((resolve) => waiters.push(resolve));

const fill = (line, n = 0) =>
  line
    .replaceAll("@THREAD", state.thread)
    .replaceAll("@TURN", state.turn)
    .replaceAll("@N", String(n));

const respond = (result) => send(JSON.stringify({ id: state.lastRequest?.id, result }));

const hang = async () => {
  // A pending timer keeps the event loop alive once stdin is gone.
  setInterval(() => {}, 60_000);
  await new Promise(() => {});
};

/** A `thread/start` / `thread/resume` result, shaped like 0.156.1's. */
const threadOpened = (threadId, params, forcedSandbox) => {
  const model = params.model ?? "gpt-6-astra";
  const cwd = params.cwd ?? "/";
  const sandbox = forcedSandbox ?? params.sandbox ?? CONFIGURED_DEFAULT.sandbox;
  return {
    thread: {
      id: threadId,
      sessionId: threadId,
      forkedFromId: null,
      parentThreadId: null,
      preview: "",
      ephemeral: false,
      section: null,
      sectionEnteredAt: null,
      projectId: null,
      historyMode: "paginated",
      modelProvider: "openai",
      model,
      reasoningEffort: "high",
      createdAt: 1790201245,
      updatedAt: 1790201245,
      recencyAt: 1790201245,
      status: { type: "idle" },
      path: null,
      cwd,
      cliVersion: VERSION,
      originator: "swarm",
      source: "appServer",
      threadSource: null,
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: null,
      turns: [],
    },
    model,
    modelProvider: "openai",
    serviceTier: null,
    cwd,
    instructionSources: [],
    approvalPolicy: params.approvalPolicy ?? CONFIGURED_DEFAULT.approvalPolicy,
    approvalsReviewer: "user",
    sandbox: SANDBOX_POLICIES[sandbox],
    reasoningEffort: "high",
  };
};

const directives = {
  async EXPECT_REQUEST(method) {
    const message = await nextMessage();
    if (message?.id === undefined || message.method !== method) {
      fail(`expected request ${method}, got ${JSON.stringify(message)}`);
    }
    state.lastRequest = message;
  },
  async EXPECT_NOTIFICATION(method) {
    const message = await nextMessage();
    if (message === undefined || message.id !== undefined || message.method !== method) {
      fail(`expected notification ${method}, got ${JSON.stringify(message)}`);
    }
  },
  async EXPECT_RESPONSE(id) {
    const message = await nextMessage();
    if (message === undefined || message.method !== undefined || message.id !== JSON.parse(id)) {
      fail(`expected a response to ${id}, got ${JSON.stringify(message)}`);
    }
  },
  RESPOND_INITIALIZE() {
    respond({
      userAgent: `swarm/${VERSION} (fake)`,
      codexHome: "/tmp/fake-codex-home",
      platformFamily: "unix",
      platformOs: "linux",
    });
  },
  RESPOND_THREAD_START(args) {
    const [threadId, forcedSandbox] = args.split(" ");
    state.thread = threadId;
    respond(threadOpened(threadId, state.lastRequest.params, forcedSandbox));
  },
  RESPOND_THREAD_RESUME(forcedSandbox) {
    state.thread = state.lastRequest.params.threadId;
    respond(threadOpened(state.thread, state.lastRequest.params, forcedSandbox || undefined));
  },
  RESPOND_TURN_START(turnId) {
    state.turn = turnId;
    respond({
      turn: {
        id: turnId,
        items: [],
        itemsView: "notLoaded",
        status: "inProgress",
        error: null,
        startedAt: 1790201250,
        completedAt: null,
        durationMs: null,
      },
    });
  },
  RESPOND(json) {
    respond(JSON.parse(fill(json)));
  },
  RESPOND_ERROR(args) {
    const [code, ...text] = args.split(" ");
    send(
      JSON.stringify({
        error: { code: Number(code), message: text.join(" ") },
        id: state.lastRequest?.id,
      }),
    );
  },
  REPEAT(args) {
    const [count, ...line] = args.split(" ");
    for (let n = 0; n < Number(count); n++) send(fill(line.join(" "), n));
  },
  async EMIT_OVERSIZED_LINE() {
    writeAll("x".repeat(11 * 1024 * 1024));
    await hang();
  },
  ON_STDIN_EOF(line) {
    state.exitOnEof = false;
    state.afterEof.push(line);
  },
  IGNORE_STDIN_EOF() {
    state.exitOnEof = false;
  },
  async HANG() {
    await hang();
  },
  EXIT(code) {
    process.exit(Number(code));
  },
};

for (const raw of readFileSync(options.script, "utf8").split("\n")) {
  const line = raw.replace(/\r$/, "");
  if (line.trim() === "") continue;
  const directive = line.match(/^#DIRECTIVE\s+(\S+)(?:\s+(.*))?$/);
  if (directive) {
    const [, name, args = ""] = directive;
    const run = directives[name];
    if (run === undefined) fail(`unknown directive ${name}`);
    await run(args.trim());
    continue;
  }
  if (line.startsWith("#")) continue;
  send(fill(line));
}
