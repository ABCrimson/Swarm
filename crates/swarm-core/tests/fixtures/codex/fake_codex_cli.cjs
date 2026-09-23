#!/usr/bin/env node
"use strict";
/*
 * Fake `codex app-server` child process for CodexAdapter's Rust unit
 * tests (crates/swarm-core/src/agent/codex.rs).
 *
 * A near-identical fork of tests/fixtures/claude_code/fake_claude_cli.cjs
 * — the replay harness itself is fully protocol-agnostic (it just plays
 * back canned newline-delimited JSON lines with a few timing/control
 * directives), so this copy exists only to keep provider fixtures
 * self-contained under their own directory and to label failures
 * distinctly (FAKE_CODEX_CLI vs FAKE_CLAUDE_CLI in a panic message).
 *
 * UNLIKE the Claude Code fixtures (each copied verbatim from a real
 * spike capture), every line under tests/fixtures/codex/ is AUTHORED
 * from codex.rs's own CodexProtocol assumptions — Codex is not
 * installed on this machine, so there is no real wire log to copy from.
 * See codex.rs's module doc ASSUMPTIONS list.
 *
 * Usage: node fake_codex_cli.cjs <script-file>
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
 *                                      before continuing. Mirrors the real (assumed)
 *                                      protocol: the fake server never emits a
 *                                      response/notification that depends on a
 *                                      client request until that request actually
 *                                      arrived — this is what keeps a fixture's
 *                                      playback correctly ordered AFTER the test's
 *                                      spawn()/send_turn()/respond_permission() calls,
 *                                      instead of racing ahead of them. Used once per
 *                                      expected client request (thread/start,
 *                                      thread/sendMessage, an approval response, ...).
 *   #DIRECTIVE EXIT_CODE <n>         - exit with code n once the script is exhausted
 *                                      (default: 0)
 */

const fs = require("node:fs");
const readline = require("node:readline");

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
    console.error("Usage: node fake_codex_cli.cjs <script-file>");
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
    // hasn't finished flushing to the OS pipe yet. Writing directly to
    // fd 1 synchronously guarantees every line actually reaches the
    // pipe before this loop (and the process) moves on.
    fs.writeSync(1, `${line}\n`);
  }

  process.exit(exitCode);
}

main().catch((e) => {
  console.error("FAKE_CODEX_CLI FATAL", e);
  process.exit(1);
});
