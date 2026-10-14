// Reports how the adapter launched the CLI, then exits before answering
// anything: one JSON line on stderr with the working directory and the
// `--settings` and `--setting-sources` values, which the adapter quotes in
// its "Exited During ..." failure. Synthetic; no capture.
import { writeSync } from "node:fs";

const flag = (name) => {
  const at = process.argv.indexOf(name);
  return at === -1 ? null : process.argv[at + 1];
};

writeSync(
  2,
  `${JSON.stringify({
    cwd: process.cwd(),
    settings: flag("--settings"),
    settingSources: flag("--setting-sources"),
  })}\n`,
);
process.exit(1);
