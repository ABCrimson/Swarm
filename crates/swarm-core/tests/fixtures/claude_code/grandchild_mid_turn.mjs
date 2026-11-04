// A turn that starts a sleeping grandchild, the way a Bash tool call
// leaves a process running under the CLI, and never finishes. The CLI
// ignores stdin EOF, so on Unix only a kill of its process tree ends
// both; on Windows node's libuv job object already ends this
// non-detached child with its parent, so there the npm-shim test in
// `agent/codex/tests.rs` is the red test.
// Once the grandchild runs, it writes `{"pid":<cli pid>,"grandchild":<pid>}`
// to `pids.json` in the working directory, then streams the turn's first
// delta. Synthetic: no capture.
import { spawn } from "node:child_process";
import { renameSync, writeFileSync } from "node:fs";

export const config = { ignoreStdinEof: true };

export default async function grandchildMidTurn(cli) {
  const f = cli.frames;
  const turn = await cli.nextUser();
  const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 60_000)"], {
    stdio: "ignore",
  });
  grandchild.once("spawn", () => {
    // Written whole, then renamed, so a reader never sees half a file.
    writeFileSync(
      "pids.json.tmp",
      JSON.stringify({ pid: process.pid, grandchild: grandchild.pid }),
    );
    renameSync("pids.json.tmp", "pids.json");
    cli.emit(
      f.init(),
      f.status(),
      f.messageStart({ turn }),
      f.blockStart(0, { type: "text", text: "" }),
      f.textDelta(0, "Running a long command"),
    );
  });
  // A pending timer keeps the event loop alive once stdin is gone.
  setInterval(() => {}, 60_000);
  await cli.hang();
}
