// Control requests the host cannot serve. A `request_user_dialog` is a
// readable frame of a kind the host never handles; a `can_use_tool`
// without its required fields is unreadable. The host refuses both with
// an error response so the CLI stops waiting, and the turn carries on.
// The turn's text echoes the two answers so the test can check them.
// Synthetic sequence in 2.1.281 frame shapes.
export default async function unsupportedControlRequests(cli) {
  const f = cli.frames;
  const turn = await cli.nextUser();
  cli.emit(
    f.init(),
    f.status(),
    f.messageStart({ turn }),
    { type: "control_request", request_id: "dialog-1", request: { subtype: "request_user_dialog" } },
    { type: "control_request", request_id: "malformed-1", request: { subtype: "can_use_tool" } },
  );
  const first = await cli.answer("dialog-1");
  const second = await cli.answer("malformed-1");
  const reply = JSON.stringify([first, second]);
  cli.emit(
    f.textBlock(0, reply, { turn }),
    f.messageDelta("end_turn"),
    f.messageStop(),
    f.result({ turn, result: reply, costUsd: 0.01 }),
  );
  cli.lifecycle(turn, "completed");
}
