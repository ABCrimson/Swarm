// A `result` whose `duration_ms` has the wrong type: the line is JSON but
// not a frame the host can read. The host settles the turn as an error
// from the raw `type` instead of waiting for a result that never parses.
// Synthetic sequence in 2.1.281 frame shapes.
export default async function unreadableResult(cli) {
  const f = cli.frames;
  const turn = await cli.nextUser();
  cli.emit(
    f.init(),
    f.status(),
    f.messageStart({ turn }),
    f.textBlock(0, "Done.", { turn }),
    f.messageDelta("end_turn"),
    f.messageStop(),
    { ...f.result({ turn, result: "Done.", costUsd: 0.01 }), duration_ms: "x" },
  );
  cli.lifecycle(turn, "completed");
}
