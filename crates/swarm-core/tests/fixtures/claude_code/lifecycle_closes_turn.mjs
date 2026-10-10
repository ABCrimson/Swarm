// Closes the live turn with a lifecycle frame and no `result`.
export const closeWith = (state) => async (cli) => {
  const f = cli.frames;
  const turn = await cli.nextUser();
  cli.emit(f.init(), f.status(), f.messageStart({ turn }));
  cli.lifecycle(turn, state);
};

export default closeWith("completed");
