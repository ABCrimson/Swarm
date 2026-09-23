//! The causal record: a worker's `agent_*` turns, their tool calls, and
//! any commits it made, filtered to one seq range — the evidence half of
//! the ship chain's PR body (see `commands::git::ship_context`, this
//! module's only caller).
//!
//! # Why the `agent_*` canonical family, not `agent_turn_started`
//!
//! The ship-chain plan's original Phase 2 draft (`scratchpad/plans/ship-chain.md`)
//! assumed a turn's root event was `agent_turn_started {workerId, model,
//! requestId}`. Reading the landed code instead of re-implementing that
//! draft turned up two independent AI paths with two *different*
//! correlation id spaces:
//!
//! - `src/components/ai/AIChat.tsx` (the webview-direct `@anthropic-ai/sdk`
//!   path, still the shipped default) calls the `agent_turn_started`
//!   command once per turn to obtain a `causeSeq` for tool-driven side
//!   effects (`spawn_worker`, `worker_input`, `file_written`, ...) — but
//!   it never emits `agent_block`/`agent_tool_call`/`agent_tool_result`
//!   itself, and its `requestId` is a chat-item id, not a `TurnId`.
//! - `crates/swarm-core/src/agent/claude_code.rs` (`ClaudeCodeAdapter`,
//!   driving `AgentChat.tsx`) generates its own `turn_id: TurnId =
//!   Uuid::new_v4().to_string()` inside `send_turn` and **never emits
//!   `AgentTurnStarted` at all** — the first wire event for one of its
//!   turns is `agent_block`/`agent_tool_call`.
//!
//! These are not the same `turnId`. A causal record keyed off
//! `agent_turn_started` would silently show ZERO turns for every
//! `ClaudeCodeAdapter`-driven worker — exactly the fabricated-emptiness
//! failure mode the honesty rule exists to prevent. [`build_ship_context`]
//! instead derives turn existence from the `agent_block`/`agent_tool_call`/
//! `agent_tool_result`/`agent_turn_settled` family directly, grouped by
//! their own `turnId` — the richer, tool-call-bearing signal, and the one
//! RECONCILIATION.md §1 designates canonical.
//!
//! **Known scope boundary:** `AIChat.tsx`'s tool-driven side effects
//! (correlated via the envelope `causeSeq`, not a payload `turnId`) are
//! NOT surfaced here. They're a different shape (orchestration actions —
//! spawning workers, terminal input — not the tool calls that produced a
//! worktree's own diff) and unifying two differently-shaped signals into
//! one table would blur exactly the "code-generated evidence" boundary
//! this feature exists to keep sharp. A future phase can add a second,
//! clearly-labeled section for that signal if it proves valuable.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::orchestration::log::StoredEvent;

/// Turns beyond this count (oldest first) are dropped from
/// [`ShipContext::turns`] and counted in [`ShipContext::omitted_turn_count`]
/// instead — a large seq range (a worker that ran for hours before its
/// first ship) must not turn one `ship_context` call into an unbounded
/// response. Simpler than the original plan's "oldest-collapsed
/// summarization" (which would need the AI path to summarize dropped
/// turns) — an honest count of what's missing, not a fabricated summary
/// of it.
const MAX_TURNS: usize = 200;

/// Event types [`build_ship_context`] extracts anything from — the
/// caller (`commands::git::ship_context`, via
/// `EventLog::events_for_worker_between`) filters the SQL fetch to
/// exactly this set so the per-worker row cap (`SHIP_CONTEXT_EVENT_LIMIT`
/// in `commands/git.rs`) is spent entirely on rows this function can
/// actually use, never crowded out by a busy worker's `worker_output`/
/// `worker_state`/etc. rows in the same range.
///
/// `"agent_turn_started"` is deliberately included even though
/// [`build_ship_context`] never builds a [`CausalTurn`] from it (see the
/// module doc's turn-id-space mismatch note) — its presence in range is
/// used only to set [`ShipContext::has_uncaptured_webview_activity`], the
/// signal that distinguishes "this worker genuinely did nothing" from
/// "this worker's activity used the webview chat path, which this query
/// structurally cannot see turn-level detail for."
pub const RELEVANT_EVENT_TYPES: &[&str] = &[
    "agent_block",
    "agent_tool_call",
    "agent_tool_result",
    "agent_turn_settled",
    "commit_created",
    "agent_turn_started",
];

/// Fields [`extract_target`] is willing to read out of a tool call's
/// `input` object. Deliberately an **allowlist of path/command/query-shaped
/// keys**, never a generic "first string field" or "content"/"body"/"text"/
/// "data" catch-all — a tool's `input` is arbitrary provider-supplied JSON
/// that can legitimately contain file contents (a `Write` call's `content`
/// field, an `Edit` call's `new_string`), and this table is the deterministic
/// half of the PR body that later gets fed to a model (see
/// `src/lib/ship-causal.ts`'s prompt assembly). Reading only these narrow,
/// short, structurally-a-path-or-command fields is what makes "no secret
/// can reach the model through this path" true by construction rather than
/// by convention.
const TARGET_FIELD_ALLOWLIST: &[&str] = &[
    "path",
    "file_path",
    "filePath",
    "command",
    "cmd",
    "pattern",
    "url",
    "query",
    "name",
];

/// Hard cap on an extracted target's length — a defense-in-depth belt
/// alongside the field allowlist (a `command` field is free-form shell
/// text; this keeps one abnormally long value from ballooning the record
/// or the prompt built from it).
const MAX_TARGET_LEN: usize = 200;

/// One tool call within a [`CausalTurn`] — exactly the row shape the ship
/// preview's Causal Record table renders, and the same shape fed to the
/// AI prose model (never the raw `input`/`content` payloads themselves).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CausalToolCall {
    /// Seq of the `agent_tool_call` event.
    pub seq: u64,
    /// Tool name, verbatim from the provider (e.g. `"Read"`, `"Bash"`).
    pub name: String,
    /// Best-effort target extracted from the call's `input`, via
    /// [`extract_target`]'s allowlist — `None` when no allowlisted field
    /// was present, never a guess.
    pub target: Option<String>,
    /// `true`/`false` once a matching `agent_tool_result` is seen in
    /// range; `None` when no result has landed in range yet (the call is
    /// still in flight, or its result fell outside the seq window) —
    /// never defaulted to `true`.
    pub ok: Option<bool>,
}

/// One AI/agent turn within a [`ShipContext`]'s range, identified by the
/// `turnId` its `agent_block`/`agent_tool_call`/`agent_tool_result`/
/// `agent_turn_settled` events share (see the module doc for why this is
/// NOT `agent_turn_started`'s `requestId`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CausalTurn {
    pub turn_id: String,
    /// `"ok"`/`"error"`, verbatim from a matching `agent_turn_settled` in
    /// range; `None` when no settlement was observed in range (the turn
    /// was still open at `seqTo`, or settled outside the window).
    pub status: Option<String>,
    /// Tool calls this turn issued, in seq order.
    pub tool_calls: Vec<CausalToolCall>,
}

/// A commit made within a [`ShipContext`]'s range — mirrors the `Swarm-Seq-Range`
/// trailer `git::ship::stage_and_commit` writes into the commit itself.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CausalCommit {
    pub sha: String,
    pub branch: String,
    pub seq_from: u64,
    pub seq_to: u64,
}

/// The full causal record for one worker's `(seqFrom, seqTo]` range — the
/// evidence half of a ship's PR body. See `commands::git::ship_context`
/// (the only caller of [`build_ship_context`]) for how `seqFrom`/`seqTo`
/// are resolved, and `src/lib/ship-causal.ts` for how this renders into
/// the deterministic "Causal Record" section a model never writes.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ShipContext {
    pub worker_id: Uuid,
    pub seq_from: u64,
    pub seq_to: u64,
    /// Turns in range, oldest first, capped at [`MAX_TURNS`] (newest kept
    /// on overflow — see [`Self::omitted_turn_count`]).
    pub turns: Vec<CausalTurn>,
    /// Commits this worker made in range (`commit_created` rows) —
    /// ordinarily empty at preview time (the commit hasn't happened yet)
    /// and populated on a re-preview after an earlier "Commit Only" step.
    pub commits: Vec<CausalCommit>,
    /// How many of this worker's turns in range were dropped to respect
    /// [`MAX_TURNS`] — `0` when nothing was dropped. Surfaced so the UI
    /// can say "and N earlier turns" honestly instead of silently
    /// truncating.
    pub omitted_turn_count: u32,
    /// `true` when the SQL-level row fetch that produced `events` hit its
    /// own cap (`SHIP_CONTEXT_EVENT_LIMIT`/`EventLog::events_for_worker_between`)
    /// — meaning turns older than what's visible in `turns` may exist
    /// beyond what `omitted_turn_count` can even count (that count is
    /// only exact when this is `false`). Review FIX-1: a naive fetch that
    /// applied this cap BEFORE filtering to `worker_id` could silently
    /// drop the shipping worker's NEWEST, most ship-relevant turns while
    /// leaving `omitted_turn_count` at `0` — `events_for_worker_between`
    /// fetches newest-first specifically so that failure mode can't
    /// happen, and reports here whenever the newest-first cap itself was
    /// exhausted.
    pub events_truncated: bool,
    /// `true` when an `agent_turn_started` row for this worker was
    /// observed in range but produced no `CausalTurn` (see the module
    /// doc's turn-id-space mismatch note) — the signal that distinguishes
    /// "this worker genuinely had no recorded activity in this range"
    /// from "this worker's activity used the webview chat path
    /// (`AIChat.tsx`), which this query structurally cannot see
    /// turn-level detail for." Review NIT-4.
    pub has_uncaptured_webview_activity: bool,
}

impl ShipContext {
    /// The honest empty record for a range with no engine/db path at all
    /// (e.g. an in-memory-only test engine) — never fabricated turns.
    pub fn empty(worker_id: Uuid, seq_from: u64, seq_to: u64) -> Self {
        ShipContext {
            worker_id,
            seq_from,
            seq_to,
            turns: Vec::new(),
            commits: Vec::new(),
            omitted_turn_count: 0,
            events_truncated: false,
            has_uncaptured_webview_activity: false,
        }
    }
}

/// Reads `input`'s first allowlisted field (see [`TARGET_FIELD_ALLOWLIST`]'s
/// doc for why this is an allowlist, not a generic extractor), trimmed and
/// capped at [`MAX_TARGET_LEN`] chars. `None` for a non-object `input`, an
/// empty/whitespace-only match, or no allowlisted field present at all.
fn extract_target(input: &serde_json::Value) -> Option<String> {
    let obj = input.as_object()?;
    for key in TARGET_FIELD_ALLOWLIST {
        if let Some(raw) = obj.get(*key).and_then(|v| v.as_str()) {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                continue;
            }
            return Some(trimmed.chars().take(MAX_TARGET_LEN).collect());
        }
    }
    None
}

fn payload_worker_id(payload: &serde_json::Value) -> Option<&str> {
    payload.get("workerId").and_then(|v| v.as_str())
}

fn payload_str<'a>(payload: &'a serde_json::Value, field: &str) -> Option<&'a str> {
    payload.get(field).and_then(|v| v.as_str())
}

/// Builds a [`ShipContext`] from an already-fetched, seq-bounded slice of
/// the event log (`events`, typically
/// `EventLog::events_for_worker_between(RELEVANT_EVENT_TYPES, workerId,
/// seqFrom, seqTo, _)`'s result, in ascending seq order) — pure and
/// tauri-free, so it's unit-testable without a real `EventLog`. Filters to
/// `worker_id` (matching `payload.workerId`, never the envelope's
/// `originWorker` — see the module doc: none of the `agent_*` family
/// stamps envelope provenance today, `.emit()` not `.emit_with()`, so
/// payload is the only reliable subject field) and to
/// [`RELEVANT_EVENT_TYPES`]; everything else in `events` is silently
/// ignored (a worker's `worker_output`/`system_metrics` rows, another
/// worker's events, etc.) — harmless if the caller passed an unfiltered
/// slice (e.g. a test fixture), since this function re-checks both
/// conditions itself rather than trusting the caller's query shape.
///
/// `events_truncated` is threaded straight through onto
/// [`ShipContext::events_truncated`] — this function has no way to know
/// whether the SQL fetch that produced `events` was itself capped, so the
/// caller (which does know) must tell it; see that field's doc for what a
/// caller should pass here.
pub fn build_ship_context(
    events: Vec<StoredEvent>,
    worker_id: Uuid,
    seq_from: u64,
    seq_to: u64,
    events_truncated: bool,
) -> ShipContext {
    let worker_id_str = worker_id.to_string();

    // Turn id -> (index into `turn_order`, tool_use_id -> index into that
    // turn's tool_calls) — insertion-ordered by first appearance, since a
    // plain HashMap doesn't preserve order and turn/tool-call counts here
    // are small enough that linear structures beat pulling in an
    // order-preserving-map dependency for it.
    let mut turn_order: Vec<String> = Vec::new();
    let mut turns: HashMap<String, CausalTurn> = HashMap::new();
    let mut tool_use_index: HashMap<String, (String, usize)> = HashMap::new();
    let mut commits: Vec<CausalCommit> = Vec::new();
    let mut has_uncaptured_webview_activity = false;

    let ensure_turn =
        |turn_order: &mut Vec<String>, turns: &mut HashMap<String, CausalTurn>, turn_id: &str| {
            if !turns.contains_key(turn_id) {
                turn_order.push(turn_id.to_string());
                turns.insert(
                    turn_id.to_string(),
                    CausalTurn {
                        turn_id: turn_id.to_string(),
                        status: None,
                        tool_calls: Vec::new(),
                    },
                );
            }
        };

    for event in events {
        let Some(payload_worker) = payload_worker_id(&event.payload) else {
            continue;
        };
        if payload_worker != worker_id_str {
            continue;
        }

        match event.event_type.as_str() {
            "agent_block" => {
                if let Some(turn_id) = payload_str(&event.payload, "turnId") {
                    ensure_turn(&mut turn_order, &mut turns, turn_id);
                }
            }
            "agent_tool_call" => {
                let Some(turn_id) = payload_str(&event.payload, "turnId") else {
                    continue;
                };
                let Some(tool_use_id) = payload_str(&event.payload, "toolUseId") else {
                    continue;
                };
                let name = payload_str(&event.payload, "name")
                    .unwrap_or("unknown")
                    .to_string();
                let target = event.payload.get("input").and_then(extract_target);
                ensure_turn(&mut turn_order, &mut turns, turn_id);
                let turn = turns.get_mut(turn_id).expect("just ensured");
                let idx = turn.tool_calls.len();
                turn.tool_calls.push(CausalToolCall {
                    seq: event.seq,
                    name,
                    target,
                    ok: None,
                });
                tool_use_index.insert(tool_use_id.to_string(), (turn_id.to_string(), idx));
            }
            "agent_tool_result" => {
                let Some(tool_use_id) = payload_str(&event.payload, "toolUseId") else {
                    continue;
                };
                let Some((turn_id, idx)) = tool_use_index.get(tool_use_id) else {
                    // No matching call observed in this range — dropped,
                    // not fabricated (see the module doc's honesty rule).
                    continue;
                };
                let is_error = event
                    .payload
                    .get("isError")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                if let Some(turn) = turns.get_mut(turn_id)
                    && let Some(call) = turn.tool_calls.get_mut(*idx)
                {
                    call.ok = Some(!is_error);
                }
            }
            "agent_turn_settled" => {
                if let Some(turn_id) = payload_str(&event.payload, "turnId") {
                    ensure_turn(&mut turn_order, &mut turns, turn_id);
                    if let Some(status) = payload_str(&event.payload, "status")
                        && let Some(turn) = turns.get_mut(turn_id)
                    {
                        turn.status = Some(status.to_string());
                    }
                }
            }
            "commit_created" => {
                let sha = payload_str(&event.payload, "sha")
                    .unwrap_or_default()
                    .to_string();
                let branch = payload_str(&event.payload, "branch")
                    .unwrap_or_default()
                    .to_string();
                let commit_seq_from = event
                    .payload
                    .get("seqFrom")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let commit_seq_to = event
                    .payload
                    .get("seqTo")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                commits.push(CausalCommit {
                    sha,
                    branch,
                    seq_from: commit_seq_from,
                    seq_to: commit_seq_to,
                });
            }
            "agent_turn_started" => {
                // Deliberately NOT `ensure_turn` — this event's
                // `requestId` is not a `TurnId` (see the module doc).
                // Its only job here is proving this worker had SOME
                // activity in range that the turn-level query above
                // can't see.
                has_uncaptured_webview_activity = true;
            }
            _ => {}
        }
    }

    let total_turns = turn_order.len();
    let kept_order: Vec<String> = if total_turns > MAX_TURNS {
        turn_order[total_turns - MAX_TURNS..].to_vec()
    } else {
        turn_order
    };
    let omitted_turn_count = (total_turns - kept_order.len()) as u32;

    let ordered_turns: Vec<CausalTurn> = kept_order
        .into_iter()
        .filter_map(|id| turns.remove(&id))
        .collect();

    ShipContext {
        worker_id,
        seq_from,
        seq_to,
        turns: ordered_turns,
        commits,
        omitted_turn_count,
        events_truncated,
        has_uncaptured_webview_activity,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(seq: u64, event_type: &str, payload: serde_json::Value) -> StoredEvent {
        StoredEvent {
            seq,
            ts: seq.cast_signed(),
            event_type: event_type.to_string(),
            payload,
            origin_worker: None,
            cause_seq: None,
        }
    }

    // ── extract_target ────────────────────────────────────────────────

    #[test]
    fn test_extract_target_reads_first_allowlisted_field() {
        let input = serde_json::json!({ "path": "src/main.rs", "content": "SECRET=xyz" });
        assert_eq!(extract_target(&input).as_deref(), Some("src/main.rs"));
    }

    #[test]
    fn test_extract_target_never_reads_content_or_body_fields() {
        // DIRECTIVE: the no-secrets-in-prompt boundary starts here — a
        // Write-tool-shaped input with no allowlisted field at all must
        // extract nothing, never falling back to "the first string field
        // I could find" (which would be `content`).
        let input = serde_json::json!({ "content": "ANTHROPIC_API_KEY=sk-ant-abc123" });
        assert_eq!(extract_target(&input), None);
    }

    #[test]
    fn test_extract_target_caps_length() {
        let long = "x".repeat(500);
        let input = serde_json::json!({ "command": long });
        let target = extract_target(&input).unwrap();
        assert_eq!(target.len(), MAX_TARGET_LEN);
    }

    #[test]
    fn test_extract_target_none_for_non_object_input() {
        assert_eq!(extract_target(&serde_json::json!("just a string")), None);
        assert_eq!(extract_target(&serde_json::Value::Null), None);
    }

    // ── build_ship_context: filtering ────────────────────────────────

    #[test]
    fn test_build_ship_context_excludes_other_workers_events() {
        let me = Uuid::new_v4();
        let other = Uuid::new_v4();
        let events = vec![
            ev(
                1,
                "agent_tool_call",
                serde_json::json!({ "workerId": other, "turnId": "t1", "toolUseId": "u1", "name": "Read", "input": {} }),
            ),
            ev(
                2,
                "agent_tool_call",
                serde_json::json!({ "workerId": me, "turnId": "t2", "toolUseId": "u2", "name": "Bash", "input": { "command": "pnpm test" } }),
            ),
        ];
        let ctx = build_ship_context(events, me, 0, 10, false);
        assert_eq!(ctx.turns.len(), 1);
        assert_eq!(ctx.turns[0].turn_id, "t2");
        assert_eq!(ctx.turns[0].tool_calls[0].name, "Bash");
        assert_eq!(
            ctx.turns[0].tool_calls[0].target.as_deref(),
            Some("pnpm test")
        );
    }

    #[test]
    fn test_build_ship_context_ignores_unrelated_event_types() {
        let me = Uuid::new_v4();
        let events = vec![
            ev(
                1,
                "worker_output",
                serde_json::json!({ "workerId": me, "data": "hi" }),
            ),
            ev(2, "system_metrics", serde_json::json!({})),
            ev(
                3,
                "agent_tool_call",
                serde_json::json!({ "workerId": me, "turnId": "t1", "toolUseId": "u1", "name": "Read", "input": {} }),
            ),
        ];
        let ctx = build_ship_context(events, me, 0, 10, false);
        assert_eq!(ctx.turns.len(), 1);
    }

    // ── build_ship_context: seq range exactness ──────────────────────

    #[test]
    fn test_seeded_fixture_ship_context_returns_exactly_the_expected_seqs() {
        // DIRECTIVE test: a realistic seeded fixture spanning one full
        // turn (block, tool call, tool result, settled) plus a commit,
        // asserting every seq surfaces in the right place and nothing
        // extra leaks in.
        let me = Uuid::new_v4();
        let events = vec![
            ev(
                10,
                "agent_block",
                serde_json::json!({ "workerId": me, "turnId": "t1", "blockIndex": 0, "kind": "tool_use", "content": {} }),
            ),
            ev(
                11,
                "agent_tool_call",
                serde_json::json!({ "workerId": me, "turnId": "t1", "toolUseId": "u1", "name": "Write", "input": { "path": "src/lib.rs" } }),
            ),
            ev(
                12,
                "agent_tool_result",
                serde_json::json!({ "workerId": me, "turnId": "t1", "toolUseId": "u1", "isError": false, "content": "ok" }),
            ),
            ev(
                13,
                "agent_turn_settled",
                serde_json::json!({ "workerId": me, "turnId": "t1", "status": "ok" }),
            ),
            ev(
                14,
                "commit_created",
                serde_json::json!({ "workerId": me, "sha": "abc123", "branch": "swarm/x", "seqFrom": 9, "seqTo": 13 }),
            ),
        ];
        let ctx = build_ship_context(events, me, 9, 14, false);

        assert_eq!(ctx.turns.len(), 1);
        let turn = &ctx.turns[0];
        assert_eq!(turn.turn_id, "t1");
        assert_eq!(turn.status.as_deref(), Some("ok"));
        assert_eq!(turn.tool_calls.len(), 1);
        assert_eq!(turn.tool_calls[0].seq, 11);
        assert_eq!(turn.tool_calls[0].name, "Write");
        assert_eq!(turn.tool_calls[0].target.as_deref(), Some("src/lib.rs"));
        assert_eq!(turn.tool_calls[0].ok, Some(true));

        assert_eq!(ctx.commits.len(), 1);
        assert_eq!(ctx.commits[0].sha, "abc123");
        assert_eq!(ctx.commits[0].branch, "swarm/x");
        assert_eq!(ctx.omitted_turn_count, 0);
    }

    #[test]
    fn test_tool_call_with_no_result_in_range_is_ok_none_not_fabricated() {
        let me = Uuid::new_v4();
        let events = vec![ev(
            1,
            "agent_tool_call",
            serde_json::json!({ "workerId": me, "turnId": "t1", "toolUseId": "u1", "name": "Bash", "input": {} }),
        )];
        let ctx = build_ship_context(events, me, 0, 10, false);
        assert_eq!(ctx.turns[0].tool_calls[0].ok, None);
    }

    #[test]
    fn test_tool_result_with_no_matching_call_in_range_is_dropped_not_orphaned() {
        let me = Uuid::new_v4();
        let events = vec![ev(
            1,
            "agent_tool_result",
            serde_json::json!({ "workerId": me, "turnId": "t1", "toolUseId": "u1", "isError": false, "content": "ok" }),
        )];
        let ctx = build_ship_context(events, me, 0, 10, false);
        // No agent_tool_call/agent_block/agent_turn_settled for t1 in
        // range at all — the orphan result must not fabricate a turn.
        assert!(ctx.turns.is_empty());
    }

    #[test]
    fn test_turn_with_no_settled_event_in_range_has_status_none() {
        let me = Uuid::new_v4();
        let events = vec![ev(
            1,
            "agent_block",
            serde_json::json!({ "workerId": me, "turnId": "t1", "blockIndex": 0, "kind": "text", "content": {} }),
        )];
        let ctx = build_ship_context(events, me, 0, 10, false);
        assert_eq!(ctx.turns[0].status, None);
    }

    #[test]
    fn test_empty_range_yields_empty_context_not_fabricated_turns() {
        let me = Uuid::new_v4();
        let ctx = build_ship_context(Vec::new(), me, 5, 5, false);
        assert!(ctx.turns.is_empty());
        assert!(ctx.commits.is_empty());
        assert_eq!(ctx.omitted_turn_count, 0);
    }

    // ── MAX_TURNS overflow ────────────────────────────────────────────

    #[test]
    fn test_turn_overflow_keeps_newest_and_reports_omitted_count() {
        let me = Uuid::new_v4();
        let total = MAX_TURNS + 5;
        let mut events = Vec::with_capacity(total);
        for i in 0..total {
            events.push(ev(
                i as u64,
                "agent_block",
                serde_json::json!({ "workerId": me, "turnId": format!("t{i}"), "blockIndex": 0, "kind": "text", "content": {} }),
            ));
        }
        let ctx = build_ship_context(events, me, 0, total as u64, false);
        assert_eq!(ctx.turns.len(), MAX_TURNS);
        assert_eq!(ctx.omitted_turn_count, 5);
        // The kept turns are the NEWEST ones — t5..t{total-1}, not t0..
        assert_eq!(ctx.turns[0].turn_id, "t5");
        assert_eq!(ctx.turns.last().unwrap().turn_id, format!("t{}", total - 1));
    }

    // ── ShipContext::empty ────────────────────────────────────────────

    #[test]
    fn test_ship_context_empty_is_honest_zero_state() {
        let me = Uuid::new_v4();
        let ctx = ShipContext::empty(me, 1, 1);
        assert_eq!(ctx.worker_id, me);
        assert!(ctx.turns.is_empty());
        assert!(ctx.commits.is_empty());
        assert_eq!(ctx.omitted_turn_count, 0);
        assert!(!ctx.events_truncated);
        assert!(!ctx.has_uncaptured_webview_activity);
    }

    // ── events_truncated (review FIX-1) ─────────────────────────────────

    #[test]
    fn test_events_truncated_flag_flows_straight_through_from_the_caller() {
        // build_ship_context has no way to know whether the fetch that
        // produced `events` was itself capped — the caller (which does
        // know, via EventLog::events_for_worker_between's own return)
        // must tell it. This pins that the value is threaded through
        // verbatim, not derived/recomputed here.
        let me = Uuid::new_v4();
        let events = vec![ev(
            1,
            "agent_block",
            serde_json::json!({ "workerId": me, "turnId": "t1", "blockIndex": 0, "kind": "text", "content": {} }),
        )];
        let truncated_ctx = build_ship_context(events.clone(), me, 0, 10, true);
        assert!(truncated_ctx.events_truncated);

        let not_truncated_ctx = build_ship_context(events, me, 0, 10, false);
        assert!(!not_truncated_ctx.events_truncated);
    }

    // ── has_uncaptured_webview_activity (review NIT-4) ───────────────────

    #[test]
    fn test_agent_turn_started_sets_the_webview_activity_flag_without_fabricating_a_turn() {
        let me = Uuid::new_v4();
        let events = vec![ev(
            5,
            "agent_turn_started",
            serde_json::json!({ "workerId": me, "model": "claude-sonnet-4-5", "requestId": "chat-item-1" }),
        )];
        let ctx = build_ship_context(events, me, 0, 10, false);
        // The webview path leaves a signal, but never a fabricated
        // CausalTurn — agent_turn_started's requestId is not a TurnId
        // (see the module doc).
        assert!(ctx.turns.is_empty());
        assert!(ctx.has_uncaptured_webview_activity);
    }

    #[test]
    fn test_no_agent_turn_started_row_leaves_the_webview_activity_flag_false() {
        let me = Uuid::new_v4();
        let events = vec![ev(
            1,
            "agent_tool_call",
            serde_json::json!({ "workerId": me, "turnId": "t1", "toolUseId": "u1", "name": "Read", "input": {} }),
        )];
        let ctx = build_ship_context(events, me, 0, 10, false);
        assert!(!ctx.has_uncaptured_webview_activity);
    }

    #[test]
    fn test_other_workers_agent_turn_started_never_sets_this_workers_flag() {
        let me = Uuid::new_v4();
        let other = Uuid::new_v4();
        let events = vec![ev(
            5,
            "agent_turn_started",
            serde_json::json!({ "workerId": other, "model": "claude-sonnet-4-5", "requestId": "chat-item-1" }),
        )];
        let ctx = build_ship_context(events, me, 0, 10, false);
        assert!(!ctx.has_uncaptured_webview_activity);
    }
}
