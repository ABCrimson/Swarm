import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_RPC_DEADLINE_MS,
  GIT_MUTATE_BUDGET_MS,
  GIT_PUSH_BUDGET_MS,
  GIT_READ_BUDGET_MS,
  GIT_SCAN_BUDGET_MS,
  RPC_DEADLINE_MARGIN_MS,
  rpcDeadlineMs,
} from "#lib/transport";

/** Seconds per unit of the whole-unit `Duration` constructors `git/cli.rs` uses. */
const SECONDS_PER_UNIT = { secs: 1, mins: 60, hours: 3600 } as const;

/**
 * The seconds of `pub const <name>: Duration = Duration::from_{secs,mins,hours}(N);`
 * in `git/cli.rs`.
 */
function rustBudgetSeconds(name: string): number {
  const source = readFileSync(join(process.cwd(), "crates/swarm-core/src/git/cli.rs"), "utf8");
  const declaration = new RegExp(
    String.raw`const ${name}:\s*Duration\s*=\s*Duration::from_(secs|mins|hours)\((\d[\d_]*)\)`,
  );
  const match = declaration.exec(source);
  const unit = match?.[1] as keyof typeof SECONDS_PER_UNIT | undefined;
  const count = match?.[2];
  if (unit === undefined || count === undefined) {
    throw new Error(
      `${name} is no longer a Duration::from_secs/from_mins/from_hours(N) const in crates/swarm-core/src/git/cli.rs: the daemon's git budget moved, so re-derive GIT_${name.replace(/_TIMEOUT$/, "")}_BUDGET_MS in #lib/transport.`,
    );
  }
  return Number(count.replaceAll("_", "")) * SECONDS_PER_UNIT[unit];
}

describe("rpc deadlines", () => {
  it("mirrors the daemon's git budgets in git/cli.rs", () => {
    expect(GIT_MUTATE_BUDGET_MS).toBe(rustBudgetSeconds("MUTATE_TIMEOUT") * 1000);
    expect(GIT_PUSH_BUDGET_MS).toBe(rustBudgetSeconds("PUSH_TIMEOUT") * 1000);
    expect(GIT_SCAN_BUDGET_MS).toBe(rustBudgetSeconds("SCAN_TIMEOUT") * 1000);
    expect(GIT_READ_BUDGET_MS).toBe(rustBudgetSeconds("READ_TIMEOUT") * 1000);
  });

  it("bounds each ship command by the sum of the git calls it can run, plus the margin", () => {
    // Worst-case call counts, derived in `rpcDeadlineMs`'s doc.
    const margin = RPC_DEADLINE_MARGIN_MS;
    expect(rpcDeadlineMs("git_stage_commit")).toBe(
      7 * GIT_SCAN_BUDGET_MS + 3 * GIT_MUTATE_BUDGET_MS + 2 * GIT_READ_BUDGET_MS + margin,
    );
    expect(rpcDeadlineMs("git_push")).toBe(GIT_PUSH_BUDGET_MS + 7 * GIT_READ_BUDGET_MS + margin);
    expect(rpcDeadlineMs("git_ship_preflight")).toBe(
      5 * GIT_SCAN_BUDGET_MS + 4 * GIT_READ_BUDGET_MS + margin,
    );
    expect(rpcDeadlineMs("ship_compare_url")).toBe(4 * GIT_READ_BUDGET_MS + margin);
  });

  it("gives the documented totals while the Rust budgets stand", () => {
    expect(rpcDeadlineMs("git_stage_commit")).toBe(2_280_000);
    expect(rpcDeadlineMs("git_push")).toBe(735_000);
    expect(rpcDeadlineMs("git_ship_preflight")).toBe(390_000);
    expect(rpcDeadlineMs("ship_compare_url")).toBe(90_000);
  });

  it("gives every other command the default deadline", () => {
    for (const cmd of ["list_workers", "ship_context", "kill_worker"]) {
      expect(rpcDeadlineMs(cmd)).toBe(DEFAULT_RPC_DEADLINE_MS);
    }
    expect(DEFAULT_RPC_DEADLINE_MS).toBe(30_000);
  });
});
