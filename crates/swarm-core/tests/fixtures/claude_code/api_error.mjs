// An API error the CLI reports as `subtype: "success"` with
// `is_error: true`, from the 2.1.280 invalid-model capture: no stream
// events, one synthetic assistant message, a 404 result, and a
// `cancelled` lifecycle frame after the result.
const TEXT =
  "There's an issue with the selected model (claude-does-not-exist-9). It may not exist or you may not have access to it. Run --model to pick a different model.";

export default async function apiError(cli) {
  const f = cli.frames;
  const turn = await cli.nextUser();
  cli.emit(
    f.init({ model: "claude-does-not-exist-9" }),
    f.status(),
    f.assistant([{ type: "text", text: TEXT }], { turn, model: "<synthetic>" }),
    f.result({
      turn,
      isError: true,
      result: TEXT,
      apiErrorStatus: 404,
      terminalReason: "api_error",
      stopReason: "stop_sequence",
      costUsd: 0,
      durationMs: 536,
    }),
  );
  cli.lifecycle(turn, "cancelled");
}
