// Two turns on one process. Replies and costs come from the 2.1.232
// multi-turn capture: `total_cost_usd` is the session's running total
// (0.0619659, then 0.0741961), so the second turn itself cost 0.0122302.
const TURNS = [
  { reply: "ONE", runningTotal: 0.0619659, durationMs: 2489 },
  { reply: "TWO", runningTotal: 0.0741961, durationMs: 1712 },
];

export default async function twoTurn(cli) {
  const f = cli.frames;
  for (const { reply, runningTotal, durationMs } of TURNS) {
    const turn = await cli.nextUser();
    cli.emit(
      f.init(),
      f.status(),
      f.messageStart({ turn }),
      f.textBlock(0, reply, { turn }),
      f.messageDelta("end_turn"),
      f.messageStop(),
      f.rateLimit(),
      f.result({ turn, result: reply, costUsd: runningTotal, durationMs }),
    );
    cli.lifecycle(turn, "completed");
  }
}
