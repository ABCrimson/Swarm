// A turn that runs a subagent through the Agent tool, shaped after the
// 2.1.281 capture of the same prompt (tool input, "pong" reply, costs)
// with the foreground ordering CLAUDE_CODE_DISABLE_BACKGROUND_TASKS
// produces: the subagent's frames (`parent_tool_use_id` set) arrive
// while the Agent call runs, before its top-level tool result. One burst
// of subagent stream events is interleaved inside the open top-level
// Agent block (synthetic timing) to show it cannot disturb the
// top-level block state.
const AGENT = {
  id: "toolu_01YNXucFFjH6YhH1Fv1N1TVA",
  name: "Agent",
  input: {
    description: "Test agent",
    prompt: "Reply with exactly the word pong and do nothing else.",
    subagent_type: "general-purpose",
  },
};
const SUB_READ = {
  id: "toolu_01SubagentReadCall",
  name: "Read",
  input: { file_path: "C:\\probe\\cwd-sub\\notes.txt" },
};

export default async function subagentTurn(cli) {
  const f = cli.frames;
  const turn = await cli.nextUser();
  const sub = { parent: AGENT.id };
  cli.emit(
    f.init(),
    f.status(),
    f.messageStart({ turn }),
    f.thinkingBlock(0, { turn }),
    f.blockStart(1, {
      type: "tool_use",
      id: AGENT.id,
      name: AGENT.name,
      input: {},
      caller: { type: "direct" },
    }),
    f.messageStart(sub),
    f.blockStart(0, { type: "text", text: "" }, sub),
    f.textDelta(0, "subagent stream", sub),
    f.blockStop(0, sub),
    f.inputJsonDelta(1, JSON.stringify(AGENT.input)),
    f.assistant([{ type: "tool_use", ...AGENT, caller: { type: "direct" } }]),
    f.blockStop(1),
    f.messageDelta("tool_use"),
    f.messageStop(),
    f.assistant([{ type: "tool_use", ...SUB_READ, caller: { type: "direct" } }], sub),
    f.toolResults([{ id: SUB_READ.id, content: "1\tnothing here\n" }], sub),
    f.assistant([{ type: "text", text: "pong" }], sub),
    f.toolResults([{ id: AGENT.id, content: [{ type: "text", text: "pong" }] }]),
    f.status(),
    f.messageStart(),
    f.textBlock(0, "DONE"),
    f.messageDelta("end_turn"),
    f.messageStop(),
    f.result({ turn, result: "DONE", costUsd: 0.04385305, durationMs: 13984, numTurns: 2 }),
  );
  cli.lifecycle(turn, "completed");
}
