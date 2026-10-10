// Writes a line past the 10 MiB NDJSON cap before answering initialize, then exits.
export const config = { initialize: "never" };
export default async function handshakeOversized(cli) { cli.oversized(); cli.exit(1); }
