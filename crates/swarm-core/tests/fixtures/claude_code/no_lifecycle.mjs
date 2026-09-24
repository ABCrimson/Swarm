// The happy turn on a CLI that predates `system/init.capabilities`
// (no `command_lifecycle` frames): the turn starts with its init.
export { default } from "./happy_turn.mjs";

export const config = { capabilities: null };
