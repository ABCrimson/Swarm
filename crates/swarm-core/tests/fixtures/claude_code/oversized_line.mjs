// Starts a turn, then writes a line past the adapter's 10 MiB NDJSON cap
// with no terminator (a framer failure), then hangs.
export default async function oversizedLine(cli) {
  const f = cli.frames;
  const turn = await cli.nextUser();
  cli.emit(f.init(), f.status(), f.messageStart({ turn }));
  cli.oversized();
  await cli.hang();
}
