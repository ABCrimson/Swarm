// Read, then Bash, then a text answer. Tool inputs and results come from
// the 2.1.232 tool-use capture (paths shortened); thinking blocks stream
// the way current models do: empty thinking deltas and a signature.
const READ = {
  id: "toolu_01Q2d77HjKTeVx6NBTKLWQdZ",
  name: "Read",
  input: { file_path: "C:\\spike\\repo\\data.txt" },
};
const BASH = {
  id: "toolu_01HpvhGbVUtQ4YH4H1E1nUoX",
  name: "Bash",
  input: {
    command: 'wc -l data.txt; echo "---"; cat -A data.txt | head -20',
    description: "Count lines and show raw file content",
  },
};

export default async function toolTurn(cli) {
  const f = cli.frames;
  const turn = await cli.nextUser();
  const answer = "data.txt has 3 lines: widget-alpha, widget-beta and widget-gamma.";
  cli.emit(
    f.init(),
    f.status(),
    f.messageStart({ turn }),
    f.thinkingBlock(0, { turn }),
    f.toolUseBlock(1, READ),
    f.messageDelta("tool_use"),
    f.messageStop(),
    f.toolResults([
      { id: READ.id, content: "1\twidget-alpha,42\n2\twidget-beta,17\n3\twidget-gamma,93\n4\t" },
    ]),
    f.status(),
    f.messageStart(),
    f.thinkingBlock(0),
    f.toolUseBlock(1, BASH),
    f.messageDelta("tool_use"),
    f.messageStop(),
    f.toolResults([
      {
        id: BASH.id,
        content: "3 data.txt\n---\nwidget-alpha,42$\nwidget-beta,17$\nwidget-gamma,93$",
        isError: false,
      },
    ]),
    f.status(),
    f.messageStart(),
    f.textBlock(0, answer),
    f.messageDelta("end_turn"),
    f.messageStop(),
    f.result({ turn, result: answer, costUsd: 0.1412235, durationMs: 15448, numTurns: 3 }),
  );
  cli.lifecycle(turn, "completed");
}
