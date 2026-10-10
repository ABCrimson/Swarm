// A CLI that predates `system/init.capabilities`: no `command_lifecycle`
// frames and no `user_message_uuid` stamps, so only its `system/init`
// can open the turn SWARM queued.
export default async function noLifecycle(cli) {
  const f = cli.frames;
  await cli.nextUser();
  const answer = "Binary search halves the search space each step.";
  cli.emit(
    f.init(),
    f.status(),
    f.messageStart(),
    f.textBlock(0, answer),
    f.messageDelta("end_turn"),
    f.messageStop(),
    f.result({ result: answer, costUsd: 0.01 }),
  );
}

export const config = { capabilities: null };
