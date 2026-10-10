// A turn cancelled while a `can_use_tool` ask is open. The host
// denies the ask with `interrupt: true` and sends the `interrupt`
// control request; the CLI ends the turn with an `aborted_tools` result.
// The tool result echoes the host's deny so the test can check it.
// Synthetic sequence in 2.1.281 frame shapes.
import { randomUUID } from "node:crypto";

const WRITE = {
  id: "toolu_01CancelledWrite",
  name: "Write",
  input: { file_path: "C:\\probe\\cancelled.txt", content: "x" },
};

export default async function cancelDuringAsk(cli) {
  const f = cli.frames;
  const turn = await cli.nextUser();
  const askId = randomUUID();
  cli.emit(
    f.init(),
    f.status(),
    f.messageStart({ turn }),
    f.toolUseBlock(0, WRITE, { turn }),
    f.canUseTool(askId, {
      toolName: WRITE.name,
      input: WRITE.input,
      toolUseId: WRITE.id,
      description: "cancelled.txt",
    }),
  );
  const answer = await cli.answer(askId);
  await cli.interrupted();
  cli.emit(
    f.toolResults([{ id: WRITE.id, content: JSON.stringify(answer), isError: true }]),
    f.result({
      turn,
      subtype: "error_during_execution",
      isError: true,
      terminalReason: "aborted_tools",
      costUsd: 0,
    }),
  );
  cli.lifecycle(turn, "completed");
}
