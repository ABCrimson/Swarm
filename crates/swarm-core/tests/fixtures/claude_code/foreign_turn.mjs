// A turn the CLI starts on its own (a background task's completion
// notice, say) runs while SWARM's prompt waits in the CLI's queue. Its
// frames carry no user-message echo and must not be pinned on the SWARM
// turn; its `result` still moves the session's running cost total.
// Synthetic sequence in 2.1.281 frame shapes.
export default async function foreignTurn(cli) {
  const f = cli.frames;
  const turn = await cli.nextUser({ start: false });
  cli.emit(
    f.init(),
    f.status(),
    f.messageStart(),
    f.textBlock(0, "Background task finished."),
    f.messageDelta("end_turn"),
    f.messageStop(),
    f.result({ result: "Background task finished.", costUsd: 0.01, durationMs: 700 }),
  );
  cli.lifecycle(turn, "started");
  cli.emit(
    f.init(),
    f.status(),
    f.messageStart({ turn }),
    f.textBlock(0, "SWARM answer.", { turn }),
    f.messageDelta("end_turn"),
    f.messageStop(),
    f.result({ turn, result: "SWARM answer.", costUsd: 0.03, durationMs: 800 }),
  );
  cli.lifecycle(turn, "completed");
}
