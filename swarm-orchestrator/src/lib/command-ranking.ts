// ── Command Ranking ─────────────────────────────────
// Query-aware ranking for the command palette. The palette renders
// with the library filter disabled (`filter={false}`) so frecency can
// order the list — but that used to mean typing filtered NOTHING and
// the most-used command stayed first regardless of the query. Ranking
// now puts match relevance first; frecency only breaks ties (and
// solely orders the list when the query is empty).

export interface RankableCommand {
  readonly id: string;
  readonly label: string;
  readonly keywords: readonly string[];
}

/** Relevance of one query token against one command. 0 = no match. */
function tokenScore(cmd: RankableCommand, token: string): number {
  const label = cmd.label.toLowerCase();
  if (label === token) return 100;
  if (label.startsWith(token)) return 80;
  if (label.split(/\s+/).some((w) => w.startsWith(token))) return 60;
  if (label.includes(token)) return 40;
  const keywords = cmd.keywords.map((k) => k.toLowerCase());
  if (keywords.some((k) => k.startsWith(token))) return 30;
  if (keywords.some((k) => k.includes(token))) return 20;
  return 0;
}

/**
 * Relevance of a whole query against a command. Every whitespace-
 * separated token must match somewhere (AND semantics — "go tools"
 * matches "Go To Tools"); scores sum across tokens. An empty query
 * matches everything with a neutral score.
 */
export function commandMatchScore(cmd: RankableCommand, query: string): number {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return 1;

  let total = 0;
  for (const token of tokens) {
    const score = tokenScore(cmd, token);
    if (score === 0) return 0;
    total += score;
  }
  return total;
}

/**
 * Filters and orders commands for display: non-matching commands drop
 * out, matches sort by relevance, and `frecencyScore` breaks ties (so
 * an empty query yields pure frecency order — the original behavior).
 */
export function rankCommands<T extends RankableCommand>(
  commands: readonly T[],
  query: string,
  frecencyScore: (id: string) => number,
): T[] {
  return commands
    .map((cmd) => ({ cmd, score: commandMatchScore(cmd, query) }))
    .filter((entry) => entry.score > 0)
    .toSorted((a, b) => b.score - a.score || frecencyScore(b.cmd.id) - frecencyScore(a.cmd.id))
    .map((entry) => entry.cmd);
}
