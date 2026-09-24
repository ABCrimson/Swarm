// A settings deny rule (`Bash(echo*)`) refusing one call while `pwd`
// runs, reported ONLY in `result.permission_denials`: no
// `system/permission_denied` frame, as for the rule-decided denials the
// Agent SDK says that frame does not cover. The tool-result text and the
// denial entry follow the 2.1.232 glob-deny canary; the frame sequence
// is synthetic.
const ECHO = {
  id: "toolu_01EchoDeniedByGlobRule",
  name: "Bash",
  input: { command: "echo hi", description: "Print hi" },
};
const PWD = {
  id: "toolu_01PwdAllowedByGlobRule",
  name: "Bash",
  input: { command: "pwd", description: "Print the working directory" },
};
const DENIAL = "Permission to use Bash with command echo hi has been denied.";
const ANSWER = "echo was denied; pwd printed /tmp/spike/repo.";

export default async function globDeny(cli) {
  const f = cli.frames;
  const turn = await cli.nextUser();
  cli.emit(
    f.init(),
    f.status(),
    f.messageStart({ turn }),
    f.toolUseBlock(0, ECHO, { turn }),
    f.toolUseBlock(1, PWD),
    f.messageDelta("tool_use"),
    f.messageStop(),
    f.toolResults([
      { id: ECHO.id, content: DENIAL, isError: true },
      { id: PWD.id, content: "/tmp/spike/repo", isError: false },
    ]),
    f.status(),
    f.messageStart(),
    f.textBlock(0, ANSWER),
    f.messageDelta("end_turn"),
    f.messageStop(),
    f.result({
      turn,
      result: ANSWER,
      costUsd: 0.0412,
      numTurns: 2,
      denials: [{ toolName: "Bash", toolUseId: ECHO.id, toolInput: ECHO.input }],
    }),
  );
  cli.lifecycle(turn, "completed");
}
