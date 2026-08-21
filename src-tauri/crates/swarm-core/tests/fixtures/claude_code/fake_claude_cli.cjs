#!/usr/bin/env node
"use strict";
/*
 * Fake `claude -p --output-format stream-json ...` child process for
 * ClaudeCodeAdapter's Rust unit tests (crates/swarm-core/src/agent/claude_code.rs).
 *
 * Plays back a canned NDJSON "script" file to stdout over piped stdio —
 * exactly the substrate `spawn_piped`/`NdjsonFramer` expect, with none
 * of the cost/latency of a real CLI invocation. Every line the script
 * plays back verbatim was copied from real spike raw logs
 * (scratchpad/spike/logs/*.raw.ndjson, scratchpad/spike-permissions/logs/*.raw.ndjson)
 * per the Phase 3 brief's directive — this file only adds the replay
 * harness around them.
 *
 * Usage: node fake_claude_cli.cjs <script-file>
 *
 * Script file format: one directive/line per line.
 *   - A line starting with "#DIRECTIVE " is a control directive (see below).
 *   - Any other non-blank line is emitted to stdout verbatim, followed by "\n".
 *   - Blank lines and lines starting with "#" (not "#DIRECTIVE") are comments, skipped.
 *
 * Directives:
 *   #DIRECTIVE SLEEP_MS <n>          - sleep n ms before continuing
 *   #DIRECTIVE HANG                  - sleep effectively forever (until killed) — never returns
 *   #DIRECTIVE EMIT_OVERSIZED_LINE   - write an 11MB blob of 'x' with NO trailing
 *                                      newline (exercises the NdjsonFramer's
 *                                      MAX_LINE_BYTES cap / AppError::LineTooLong),
 *                                      then hang.
 *   #DIRECTIVE AWAIT_STDIN_LINE      - block until exactly one line arrives on stdin
 *                                      before continuing. Mirrors the real CLI: it
 *                                      never emits a turn's stream_event/assistant/
 *                                      result lines until it has actually received
 *                                      that turn's stream-json user message — this
 *                                      is what keeps a fixture's playback correctly
 *                                      ordered AFTER the test's `send_turn` call,
 *                                      instead of racing ahead of it.
 *   #DIRECTIVE EXIT_CODE <n>         - exit with code n once the script is exhausted
 *                                      (default: 0)
 */

const fs = require("fs");
const readline = require("readline");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeStdinLineWaiter() {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  const pending = [];
  const waiters = [];
  rl.on("line", (line) => {
    if (waiters.length > 0) {
      waiters.shift()(line);
    } else {
      pending.push(line);
    }
  });
  return function waitForLine() {
    if (pending.length > 0) return Promise.resolve(pending.shift());
    return new Promise((resolve) => waiters.push(resolve));
  };
}

async function main() {
  const scriptPath = process.argv[2];
  if (!scriptPath) {
    console.error("Usage: node fake_claude_cli.cjs <script-file>");
    process.exit(2);
  }

  const waitForStdinLine = makeStdinLineWaiter();

  const lines = fs.readFileSync(scriptPath, "utf8").split("\n");
  let exitCode = 0;

  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    if (line.trim() === "") continue;
    if (line.startsWith("#DIRECTIVE ")) {
      const [, name, arg] = line.match(/^#DIRECTIVE\s+(\S+)(?:\s+(.*))?$/) || [];
      if (name === "SLEEP_MS") {
        await sleep(Number(arg) || 0);
      } else if (name === "HANG") {
        await new Promise(() => {}); // never resolves; process stays alive until killed
      } else if (name === "EMIT_OVERSIZED_LINE") {
        const blob = "x".repeat(11 * 1024 * 1024);
        fs.writeSync(1, blob); // deliberately NO trailing "\n"
        await new Promise(() => {});
      } else if (name === "AWAIT_STDIN_LINE") {
        await waitForStdinLine();
      } else if (name === "EXIT_CODE") {
        exitCode = Number(arg) || 0;
      }
      continue;
    }
    if (line.startsWith("#")) continue; // plain comment
    // fs.writeSync(1, ...) rather than process.stdout.write(...): stdout
    // is a piped, non-TTY stream here, and Node's async stream write
    // followed immediately by process.exit() can truncate whatever
    // hasn't finished flushing to the OS pipe yet — a real, well-known
    // Node gotcha. Writing directly to fd 1 synchronously guarantees
    // every line actually reaches the pipe before this loop (and the
    // process) moves on, which matters here because this script emits
    // many lines back-to-back with no natural backpressure pause.
    fs.writeSync(1, line + "\n");
  }

  process.exit(exitCode);
}

main().catch((e) => {
  console.error("FAKE_CLAUDE_CLI FATAL", e);
  process.exit(1);
});
