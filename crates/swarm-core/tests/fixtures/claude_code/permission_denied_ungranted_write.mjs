// The default mode's refusal of an unapproved write, from the 2.1.232
// headless capture (no permission prompt tool, so the ask became a
// denial). The turn then hit `--max-turns 2`. Paths shortened.
const READ = {
  id: "toolu_01RgsZBm1Y1XiyueQsXrFAvz",
  name: "Read",
  input: { file_path: "C:\\spike\\repo\\canary.txt" },
};
const WRITE = {
  id: "toolu_01KNSim1HDM3rycSMhw6wHac",
  name: "Write",
  input: { file_path: "C:\\spike\\repo\\canary.txt", content: "MUTATED-BY-WRITE-TEST" },
};
const DENIAL =
  "Claude requested permissions to write to C:\\spike\\repo\\canary.txt, but you haven't granted it yet.";

export default async function permissionDeniedUngrantedWrite(cli) {
  const f = cli.frames;
  const turn = await cli.nextUser();
  cli.emit(
    f.init(),
    f.status(),
    f.messageStart({ turn }),
    f.thinkingBlock(0, { turn }),
    f.toolUseBlock(1, READ),
    f.toolResults([
      { id: READ.id, content: "1\tCANARY-DO-NOT-MODIFY\n2\tsentinel-value-7f3a9c\n3\t" },
    ]),
    f.messageDelta("tool_use"),
    f.messageStop(),
    f.rateLimit(),
    f.status(),
    f.messageStart(),
    f.toolUseBlock(0, WRITE),
    f.permissionDenied({ toolName: "Write", toolUseId: WRITE.id, message: DENIAL }),
    f.toolResults([{ id: WRITE.id, content: DENIAL, isError: true }]),
    f.messageDelta("tool_use"),
    f.messageStop(),
    f.result({
      turn,
      subtype: "error_max_turns",
      isError: true,
      errors: ["Reached maximum number of turns (2)"],
      terminalReason: "max_turns",
      stopReason: "tool_use",
      costUsd: 0.1382142,
      durationMs: 8396,
      numTurns: 3,
      denials: [{ toolName: "Write", toolUseId: WRITE.id, toolInput: WRITE.input }],
    }),
  );
  cli.lifecycle(turn, "completed");
}
