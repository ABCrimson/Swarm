// The `can_use_tool` round trip, from the 2.1.280 capture of a default-
// mode session with `--permission-prompt-tool stdio`: the Write call
// blocks on the host's answer. Every turn asks once. An allowed call's
// tool result echoes the host's whole answer (synthetic) so the test can
// check what the adapter sent; a denied call's result carries the deny
// message and the refusal lands in `result.permission_denials`, as the
// real CLI does. The ANSI-styled `decision_reason` is synthetic too.
import { randomUUID } from "node:crypto";

export default async function interactivePermission(cli) {
  const f = cli.frames;
  let runningTotal = 0;
  for (let round = 1; ; round += 1) {
    const turn = await cli.nextUser();
    const write = {
      id: `toolu_01InteractiveWrite${round}`,
      name: "Write",
      input: { file_path: `C:\\probe\\cwd-perm\\probe${round}.txt`, content: "ok" },
    };
    const askId = randomUUID();
    cli.emit(
      f.init(),
      f.status(),
      f.messageStart({ turn }),
      f.thinkingBlock(0, { turn }),
      f.toolUseBlock(1, write),
      f.canUseTool(askId, {
        toolName: "Write",
        input: write.input,
        toolUseId: write.id,
        decisionReason: "\u001b[1mClaude wants to create\u001b[0m a file",
      }),
      f.messageDelta("tool_use"),
      f.messageStop(),
      f.rateLimit(),
    );
    const answer = await cli.answer(askId);
    const decision = answer.response;
    const allowed = answer.subtype === "success" && decision.behavior === "allow";
    cli.emit(
      f.toolResults([
        allowed
          ? { id: write.id, content: JSON.stringify(answer) }
          : { id: write.id, content: decision?.message ?? "denied", isError: true },
      ]),
    );
    const reply = allowed ? "DONE" : "The Write tool call was denied.";
    runningTotal += allowed ? 0.020434 : 0.0069429;
    cli.emit(
      f.status(),
      f.messageStart(),
      f.thinkingBlock(0),
      f.textBlock(1, reply),
      f.messageDelta("end_turn"),
      f.messageStop(),
      f.result({
        turn,
        result: reply,
        costUsd: runningTotal,
        numTurns: 2,
        denials: allowed
          ? []
          : [{ toolName: "Write", toolUseId: write.id, toolInput: write.input }],
      }),
    );
    cli.lifecycle(turn, "completed");
  }
}
