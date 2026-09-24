// The static Bash output-redirection guard, from the 2.1.232 capture:
// `echo ... >> canary.txt` was refused, `pwd` ran, then `--max-turns 2`
// ended the turn. Paths shortened.
const APPEND = {
  id: "toolu_01Krx9FDsr1UA2azVteYasdT",
  name: "Bash",
  input: {
    command: "echo MUTATED-BY-BASELINE-BASH >> canary.txt",
    description: "Append line to canary.txt",
  },
};
const PWD = {
  id: "toolu_01M5gthFPUL8ohuaVZH32BCQ",
  name: "Bash",
  input: { command: "pwd", description: "Show current working directory" },
};
const DENIAL =
  "Output redirection to 'C:\\spike\\repo\\canary.txt' was blocked. For security, Claude Code may only write to files in the allowed working directories for this session: 'C:\\spike\\repo'.";

export default async function permissionDeniedRedirectionGuard(cli) {
  const f = cli.frames;
  const turn = await cli.nextUser();
  cli.emit(
    f.init(),
    f.status(),
    f.messageStart({ turn }),
    f.thinkingBlock(0, { turn }),
    f.textBlock(1, "I'll run that exact command now."),
    f.toolUseBlock(2, APPEND),
    f.permissionDenied({ toolName: "Bash", toolUseId: APPEND.id, message: DENIAL }),
    f.toolResults([{ id: APPEND.id, content: DENIAL, isError: true }]),
    f.messageDelta("tool_use"),
    f.messageStop(),
    f.rateLimit(),
    f.status(),
    f.messageStart(),
    f.thinkingBlock(0),
    f.toolUseBlock(1, PWD),
    f.messageDelta("tool_use"),
    f.messageStop(),
    f.toolResults([{ id: PWD.id, content: "/tmp/spike/repo", isError: false }]),
    f.result({
      turn,
      subtype: "error_max_turns",
      isError: true,
      errors: ["Reached maximum number of turns (2)"],
      terminalReason: "max_turns",
      stopReason: "tool_use",
      costUsd: 0.1514874,
      durationMs: 20810,
      numTurns: 3,
      denials: [{ toolName: "Bash", toolUseId: APPEND.id, toolInput: APPEND.input }],
    }),
  );
  cli.lifecycle(turn, "completed");
}
