// A `can_use_tool` ask raised while the CLI runs a turn of its own, before
// SWARM's queued prompt starts (a background task's tool call, say). No
// SWARM turn is running, so the host denies it at once and never offers
// it to the human. The deny comes back as the answer to `can_use_tool`;
// the SWARM turn's text echoes it so the test can check it.
// Synthetic sequence in 2.1.281 frame shapes.
import { randomUUID } from "node:crypto";

export default async function foreignAsk(cli) {
  const f = cli.frames;
  const turn = await cli.nextUser({ start: false });
  const askId = randomUUID();
  cli.emit(
    f.canUseTool(askId, {
      toolName: "Write",
      input: { file_path: "C:\\probe\\bg.txt", content: "x" },
      toolUseId: "toolu_01BackgroundWrite",
    }),
  );
  const answer = await cli.answer(askId);
  cli.lifecycle(turn, "started");
  const reply = JSON.stringify(answer);
  cli.emit(
    f.init(),
    f.status(),
    f.messageStart({ turn }),
    f.textBlock(0, reply, { turn }),
    f.messageDelta("end_turn"),
    f.messageStop(),
    f.result({ turn, result: reply, costUsd: 0.01 }),
  );
  cli.lifecycle(turn, "completed");
}
