// One text-only turn. The answer text, cost and duration come from the
// 2.1.232 happy-path capture; frame shapes are 2.1.281's.
export default async function happyTurn(cli) {
  const f = cli.frames;
  const turn = await cli.nextUser();
  const answer =
    "Binary search finds a value in a sorted collection by repeatedly cutting the search space in half.";
  cli.emit(
    f.init(),
    f.status(),
    f.messageStart({ turn }),
    f.textBlock(0, answer, { turn }),
    f.messageDelta("end_turn"),
    f.messageStop(),
    f.rateLimit(),
    f.result({ turn, result: answer, costUsd: 0.0328566, durationMs: 3378 }),
  );
  cli.lifecycle(turn, "completed");
}
