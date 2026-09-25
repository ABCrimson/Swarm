// A turn that starts streaming and never finishes: no result, no exit.
// Interrupts are acknowledged (by the harness) and otherwise ignored.
export default async function hangMidTurn(cli) {
  const f = cli.frames;
  const turn = await cli.nextUser();
  cli.emit(
    f.init(),
    f.status(),
    f.messageStart({ turn }),
    f.blockStart(0, { type: "text", text: "" }),
    f.textDelta(0, "Starting a long task"),
  );
  await cli.hang();
}
