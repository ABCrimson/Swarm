// `--resume` of a session the CLI has no transcript for: it writes one
// error `result` and exits 1 without answering `initialize`. The error
// text is the CLI's own; the frame is trimmed.
export default async function resumeMissing(cli) {
  const at = cli.argv.indexOf("--resume");
  if (at === -1) throw new Error("resume_missing.mjs expects --resume <key>");
  cli.emit(
    cli.frames.result({
      subtype: "error_during_execution",
      isError: true,
      errors: [`No conversation found with session ID: ${cli.argv[at + 1]}`],
      durationMs: 0,
      numTurns: 0,
    }),
  );
  cli.exit(1);
}
