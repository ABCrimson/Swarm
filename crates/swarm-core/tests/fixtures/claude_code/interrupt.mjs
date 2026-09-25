// A graceful interrupt, from the 2.1.280 capture: the turn starts
// streaming, the host sends `interrupt`, and the CLI writes the
// "[Request interrupted by user]" notice and a zeroed
// `error_during_execution` result (`terminal_reason:
// "aborted_streaming"`). A second, ordinary turn follows on the same
// process to show the session survives the interrupt.
export default async function interrupt(cli) {
  const f = cli.frames;
  const first = await cli.nextUser();
  cli.emit(
    f.init(),
    f.status(),
    f.messageStart({ turn: first }),
    f.blockStart(0, { type: "thinking", thinking: "", signature: "" }),
    f.thinkingDelta(0, ""),
  );
  await cli.interrupted();
  cli.emit(
    {
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] },
      parent_tool_use_id: null,
      session_id: cli.sessionId,
      uuid: "c9b50530-5618-40ef-b5d8-bd6bb641f43f",
    },
    f.result({
      turn: first,
      subtype: "error_during_execution",
      isError: true,
      errors: ["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null"],
      terminalReason: "aborted_streaming",
      costUsd: 0,
      durationMs: 1097,
      numTurns: 2,
    }),
  );
  cli.lifecycle(first, "completed");

  const second = await cli.nextUser();
  cli.emit(
    f.init(),
    f.status(),
    f.messageStart({ turn: second }),
    f.textBlock(0, "Still here.", { turn: second }),
    f.messageDelta("end_turn"),
    f.messageStop(),
    f.result({ turn: second, result: "Still here.", costUsd: 0.0121, durationMs: 900 }),
  );
  cli.lifecycle(second, "completed");
}
