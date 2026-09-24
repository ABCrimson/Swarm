// A permission-mode denial (`decision_reason_type: "mode"`), from the
// 2.1.232 plan-mode capture: Bash ran, Write was refused, Read ran. The
// CLI reports the refusal twice, as `system/permission_denied` and in
// `result.permission_denials`. Paths shortened.
const BASH = {
  id: "toolu_01H3gdFyV4gKfeNxDuMh7r5p",
  name: "Bash",
  input: { command: "echo hi", description: 'Echo the string "hi"' },
};
const WRITE = {
  id: "toolu_01FjbE8SMwFMYfz4iaM92pY8",
  name: "Write",
  input: { file_path: "C:\\spike\\repo\\canary.txt", content: "MUTATED-BY-PLAN-MODE" },
};
const READ = {
  id: "toolu_01YH3D8w8bZiYJnPjU3qv9Dg",
  name: "Read",
  input: { file_path: "C:\\spike\\repo\\data.txt" },
};
const DENIAL = "Cannot write to C:\\spike\\repo\\canary.txt while in plan mode.";

export default async function permissionDeniedMode(cli) {
  const f = cli.frames;
  const turn = await cli.nextUser();
  const summary =
    "Results: Bash `echo hi` ran; the Write to canary.txt was blocked in plan mode; Read data.txt succeeded.";
  cli.emit(
    f.init({ permissionMode: "plan" }),
    f.status(),
    f.messageStart({ turn }),
    f.textBlock(0, "Plan mode is active; Read is allowed, the rest may be blocked.", { turn }),
    f.toolUseBlock(1, BASH),
    f.toolUseBlock(2, WRITE),
    f.toolUseBlock(3, READ),
    f.messageDelta("tool_use"),
    f.messageStop(),
    f.rateLimit(),
    f.toolResults([{ id: BASH.id, content: "hi", isError: false }]),
    f.permissionDenied({
      toolName: "Write",
      toolUseId: WRITE.id,
      decisionReasonType: "mode",
      message: DENIAL,
    }),
    f.toolResults([{ id: WRITE.id, content: DENIAL, isError: true }]),
    f.toolResults([
      { id: READ.id, content: "1\twidget-alpha,42\n2\twidget-beta,17\n3\twidget-gamma,93\n4\t" },
    ]),
    f.status(),
    f.messageStart(),
    f.textBlock(0, summary),
    f.messageDelta("end_turn"),
    f.messageStop(),
    f.result({
      turn,
      result: summary,
      costUsd: 0.1591596,
      durationMs: 15045,
      numTurns: 4,
      denials: [{ toolName: "Write", toolUseId: WRITE.id, toolInput: WRITE.input }],
    }),
  );
  cli.lifecycle(turn, "completed");
}
