// An `AskUserQuestion` call: its approval card is where the user answers,
// so the ask carries `requires_user_interaction: true` (the flag and its
// meaning follow @anthropic-ai/claude-agent-sdk 0.3.280's
// SDKControlPermissionRequest; the tool is in the live 2.1.280 tool
// list). The question text and the frame sequence are synthetic. The
// tool result echoes the host's deny message, and the refusal lands in
// `result.permission_denials`.
import { randomUUID } from "node:crypto";

const ASK = {
  id: "toolu_01AskUserQuestionCard",
  name: "AskUserQuestion",
  input: {
    questions: [
      {
        question: "Which test runner should the new suite use?",
        header: "Runner",
        options: [
          { label: "Vitest", description: "Already configured" },
          { label: "Node", description: "Built into the runtime" },
        ],
        multiSelect: false,
      },
    ],
  },
};

export default async function userInteractionAsk(cli) {
  const f = cli.frames;
  const turn = await cli.nextUser();
  const askId = randomUUID();
  cli.emit(
    f.init(),
    f.status(),
    f.messageStart({ turn }),
    f.toolUseBlock(0, ASK, { turn }),
    f.canUseTool(askId, {
      toolName: ASK.name,
      input: ASK.input,
      toolUseId: ASK.id,
      title: "Claude has a question for you",
      requiresUserInteraction: true,
    }),
    f.messageDelta("tool_use"),
    f.messageStop(),
  );
  const answer = await cli.answer(askId);
  const denied = answer.subtype === "success" && answer.response.behavior === "deny";
  const reply = "I will pick Vitest, which is already configured.";
  cli.emit(
    f.toolResults([
      {
        id: ASK.id,
        content: denied ? answer.response.message : JSON.stringify(answer),
        isError: denied,
      },
    ]),
    f.status(),
    f.messageStart(),
    f.textBlock(0, reply),
    f.messageDelta("end_turn"),
    f.messageStop(),
    f.result({
      turn,
      result: reply,
      costUsd: 0.0151,
      numTurns: 2,
      denials: denied ? [{ toolName: ASK.name, toolUseId: ASK.id, toolInput: ASK.input }] : [],
    }),
  );
  cli.lifecycle(turn, "completed");
}
