#!/usr/bin/env node
/**
 * A hung provider that has started a sleeping grandchild, the way a Bash
 * tool call leaves a process running under the CLI
 * (crates/swarm-core/tests/proc_tree_stop.rs).
 *
 * Usage: node grandchild.mjs <pidfile>
 *
 * Writes `{"pid":<own pid>,"grandchild":<grandchild pid>}` to <pidfile>
 * once the grandchild runs. Neither process ends on its own: this one
 * ignores stdin EOF, and the grandchild only sleeps. SIGTERM keeps Node's
 * default action (the process ends).
 */

import { spawn } from "node:child_process";
import { renameSync, writeFileSync } from "node:fs";

const pidfile = process.argv[2];

const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 60_000)"], {
  stdio: "ignore",
});
grandchild.once("spawn", () => {
  // Written whole, then renamed, so a reader never sees half a file.
  writeFileSync(`${pidfile}.tmp`, JSON.stringify({ pid: process.pid, grandchild: grandchild.pid }));
  renameSync(`${pidfile}.tmp`, pidfile);
});

// A pending timer keeps the event loop alive once stdin is gone.
setInterval(() => {}, 60_000);
process.stdin.resume();
