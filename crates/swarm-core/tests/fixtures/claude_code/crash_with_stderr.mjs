// A synthetic crash after streaming starts: the child writes a fatal line to
// stderr and exits non-zero without a result line.
import { writeSync } from "node:fs";

export default async function crashWithStderr(cli) {
  const turn = await cli.nextUser();
  cli.emit(cli.frames.init(), cli.frames.status(), cli.frames.messageStart({ turn }));
  writeSync(2, "fatal: model overloaded\n");
  cli.exit(3);
}
