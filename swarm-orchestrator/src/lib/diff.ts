/**
 * LCS-based text diffing for comparing worker outputs.
 *
 * Computes the longest common subsequence on a line-by-line basis
 * and returns a list of typed segments indicating equal, inserted,
 * or deleted content.
 *
 * @module diff
 */

/** A single segment of a diff result. */
export interface DiffSegment {
  readonly type: "equal" | "insert" | "delete";
  readonly value: string;
}

/**
 * Computes a line-level diff between two strings using LCS.
 *
 * Returns an array of `DiffSegment` objects indicating which lines
 * are equal, inserted (present only in `b`), or deleted (present only in `a`).
 */
export function computeDiff(a: string, b: string): DiffSegment[] {
  const aLines = a.split("\n");
  const bLines = b.split("\n");
  const aLen = aLines.length;
  const bLen = bLines.length;

  // Build LCS length table
  const dp: number[][] = Array.from({ length: aLen + 1 }, () =>
    new Array<number>(bLen + 1).fill(0),
  );

  for (let i = 1; i <= aLen; i++) {
    for (let j = 1; j <= bLen; j++) {
      if (aLines[i - 1] === bLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to produce diff segments
  const segments: DiffSegment[] = [];
  let i = aLen;
  let j = bLen;

  // Collect in reverse, then flip
  const reversed: DiffSegment[] = [];

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && aLines[i - 1] === bLines[j - 1]) {
      reversed.push({ type: "equal", value: aLines[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      reversed.push({ type: "insert", value: bLines[j - 1] });
      j--;
    } else {
      reversed.push({ type: "delete", value: aLines[i - 1] });
      i--;
    }
  }

  // Reverse to get correct order
  for (let k = reversed.length - 1; k >= 0; k--) {
    segments.push(reversed[k]);
  }

  return segments;
}
