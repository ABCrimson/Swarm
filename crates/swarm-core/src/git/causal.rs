//! The causal record: a worker's `agent_*` turns, their tool calls, and
//! any commits it made, filtered to one seq range — the evidence half of
//! the ship chain's PR body (see `commands::git::ship_context`, this
//! module's only caller).
//!
//! # Why the `agent_*` canonical family, not `agent_turn_started`
//!
//! A turn's root event is not `agent_turn_started {workerId, model,
//! requestId}`: two independent AI paths use two *different* correlation
//! id spaces:
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
//!   `AgentTurnStarted` at all** — the first persisted event for one of
//!   its turns is `agent_block`/`agent_tool_call` (its streamed
//!   `agent_turn_delta` chunks arrive earlier but are ephemeral and never
//!   reach the log).
//!
//! These are not the same `turnId`. A causal record keyed off
//! `agent_turn_started` would silently show ZERO turns for every
//! `ClaudeCodeAdapter`-driven worker — exactly the fabricated-emptiness
//! failure mode the honesty rule exists to prevent. [`build_ship_context`]
//! instead derives turn existence from the `agent_block`/`agent_tool_call`/
//! `agent_tool_result`/`agent_turn_settled` family directly, grouped by
//! their own `turnId` — the richer, tool-call-bearing signal, and the
//! canonical agent event family (see `docs/architecture.md`'s causal
//! record section).
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
/// response. An honest count of what's missing rather than a summary of
/// it (which would need the AI path to write one).
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
/// `src/lib/ship-causal.ts`'s prompt assembly). The allowlist keeps file
/// contents out by construction; a command/url/query value can still carry
/// a credential, so [`extract_target`] runs it through
/// [`super::redact::redact`], which strips recognized token shapes and URL
/// userinfo. An opaque secret with no recognizable shape can still pass.
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
    /// `extract_target`'s allowlist — `None` when no allowlisted field
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
    /// The provider's turn id shared by the turn's events.
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
    /// The commit.
    pub sha: String,
    /// The branch it was made on.
    pub branch: String,
    /// Exclusive start of the seq range its trailer records.
    pub seq_from: u64,
    /// Inclusive end of that range.
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
    /// The worker the record describes.
    pub worker_id: Uuid,
    /// Exclusive start of the seq range.
    pub seq_from: u64,
    /// Inclusive end of the seq range.
    pub seq_to: u64,
    /// Turns in range, oldest first; at most 200 (`MAX_TURNS`), the newest
    /// kept on overflow — see [`Self::omitted_turn_count`].
    pub turns: Vec<CausalTurn>,
    /// Commits this worker made in range (`commit_created` rows) —
    /// ordinarily empty at preview time (the commit hasn't happened yet)
    /// and populated on a re-preview after an earlier "Commit Only" step.
    pub commits: Vec<CausalCommit>,
    /// How many of this worker's turns in range were dropped to respect
    /// `MAX_TURNS` — `0` when nothing was dropped. Surfaced so the UI
    /// can say "and N earlier turns" honestly instead of silently
    /// truncating.
    pub omitted_turn_count: u32,
    /// `true` when the SQL-level row fetch that produced `events` hit its
    /// own cap (`SHIP_CONTEXT_EVENT_LIMIT`/`EventLog::events_for_worker_between`)
    /// — meaning turns older than what's visible in `turns` may exist
    /// beyond what `omitted_turn_count` can even count (that count is
    /// only exact when this is `false`). `events_for_worker_between`
    /// filters to this worker in SQL and fetches newest-first, so the cap
    /// only ever drops this worker's oldest rows, never its newest, most
    /// ship-relevant turns.
    pub events_truncated: bool,
    /// `true` when an `agent_turn_started` row for this worker was
    /// observed in range. That event never becomes a `CausalTurn` (see the
    /// module doc's turn-id-space mismatch note); it is the signal that
    /// distinguishes
    /// "this worker genuinely had no recorded activity in this range"
    /// from "this worker's activity used the webview chat path
    /// (`AIChat.tsx`), which this query structurally cannot see
    /// turn-level detail for."
    pub has_uncaptured_webview_activity: bool,
}

impl ShipContext {
    /// The honest empty record for a range with no engine/db path at all
    /// (e.g. an in-memory-only test engine) — never fabricated turns.
    #[must_use = "this only builds an empty ShipContext"]
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
/// doc for why this is an allowlist, not a generic extractor), trimmed,
/// redacted with [`super::redact::redact`], then capped at
/// [`MAX_TARGET_LEN`] chars. `None` for a non-object `input`, an
/// empty/whitespace-only match, or no allowlisted field present at all.
fn extract_target(input: &serde_json::Value) -> Option<String> {
    let obj = input.as_object()?;
    for key in TARGET_FIELD_ALLOWLIST {
        if let Some(raw) = obj.get(*key).and_then(serde_json::Value::as_str) {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                continue;
            }
            return Some(
                super::redact::redact(trimmed)
                    .chars()
                    .take(MAX_TARGET_LEN)
                    .collect(),
            );
        }
    }
    None
}

fn payload_worker_id(payload: &serde_json::Value) -> Option<&str> {
    payload_str(payload, "workerId")
}

fn payload_str<'a>(payload: &'a serde_json::Value, field: &str) -> Option<&'a str> {
    payload.get(field).and_then(serde_json::Value::as_str)
}

/// Builds a [`ShipContext`] from an already-fetched, seq-bounded slice of
/// the event log (`events`, typically
/// `EventLog::events_for_worker_between(RELEVANT_EVENT_TYPES, workerId,
/// seqFrom, seqTo, _)`'s result, in ascending seq order) — pure and
/// Tauri-free, so it's unit-testable without a real `EventLog`. Keeps only
/// rows inside `(seq_from, seq_to]`, for `worker_id` (matching
/// `payload.workerId`, never the envelope's `originWorker`: the agent
/// adapters emit the `agent_*` family with `.emit()`, not `.emit_with()`,
/// so the payload is the only reliable subject field), and of the
/// [`RELEVANT_EVENT_TYPES`]; everything else in `events` is ignored. The
/// caller's query already applies all three, but this function re-checks
/// them rather than trusting the query's shape.
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
    let mut turns = TurnTable::default();
    let mut commits = Vec::new();
    let mut has_uncaptured_webview_activity = false;

    for event in events {
        // Defense in depth: the caller's query already bounds the range,
        // but a row outside `(seq_from, seq_to]` must never be cited.
        if event.seq <= seq_from || event.seq > seq_to {
            continue;
        }
        if payload_worker_id(&event.payload) != Some(worker_id_str.as_str()) {
            continue;
        }
        let payload = &event.payload;

        match event.event_type.as_str() {
            "agent_block" => {
                if let Some(turn_id) = payload_str(payload, "turnId") {
                    turns.turn(turn_id);
                }
            }
            "agent_tool_call" => {
                let (Some(turn_id), Some(tool_use_id)) = (
                    payload_str(payload, "turnId"),
                    payload_str(payload, "toolUseId"),
                ) else {
                    continue;
                };
                turns.push_call(
                    turn_id,
                    tool_use_id,
                    CausalToolCall {
                        seq: event.seq,
                        name: payload_str(payload, "name").unwrap_or("unknown").to_owned(),
                        target: payload.get("input").and_then(extract_target),
                        ok: None,
                    },
                );
            }
            "agent_tool_result" => {
                // A result whose call is not in range is dropped, never
                // attached to a fabricated call.
                if let Some(tool_use_id) = payload_str(payload, "toolUseId")
                    && let Some(call) = turns.call_mut(tool_use_id)
                {
                    let is_error = payload
                        .get("isError")
                        .and_then(serde_json::Value::as_bool)
                        .unwrap_or(false);
                    call.ok = Some(!is_error);
                }
            }
            "agent_turn_settled" => {
                if let Some(turn_id) = payload_str(payload, "turnId") {
                    let turn = turns.turn(turn_id);
                    if let Some(status) = payload_str(payload, "status") {
                        turn.status = Some(status.to_owned());
                    }
                }
            }
            "commit_created" => {
                let seq_field = |field| {
                    payload
                        .get(field)
                        .and_then(serde_json::Value::as_u64)
                        .unwrap_or(0)
                };
                commits.push(CausalCommit {
                    sha: payload_str(payload, "sha").unwrap_or_default().to_owned(),
                    branch: payload_str(payload, "branch")
                        .unwrap_or_default()
                        .to_owned(),
                    seq_from: seq_field("seqFrom"),
                    seq_to: seq_field("seqTo"),
                });
            }
            // Deliberately never a turn — this event's `requestId` is not
            // a `TurnId` (see the module doc). It only proves this worker
            // had activity in range the turn-level query cannot see.
            "agent_turn_started" => has_uncaptured_webview_activity = true,
            _ => {}
        }
    }

    let (turns, omitted) = turns.into_newest(MAX_TURNS);
    ShipContext {
        worker_id,
        seq_from,
        seq_to,
        turns,
        commits,
        omitted_turn_count: u32::try_from(omitted).unwrap_or(u32::MAX),
        events_truncated,
        has_uncaptured_webview_activity,
    }
}

/// Turns keyed by `turnId` in first-appearance order, plus an index from
/// each tool call's `toolUseId` to its position.
#[derive(Default)]
struct TurnTable {
    turns: Vec<CausalTurn>,
    by_id: HashMap<String, usize>,
    calls: HashMap<String, (usize, usize)>,
}

impl TurnTable {
    /// The index of turn `turn_id`, created empty on first sight.
    fn index_of(&mut self, turn_id: &str) -> usize {
        if let Some(&index) = self.by_id.get(turn_id) {
            return index;
        }
        self.turns.push(CausalTurn {
            turn_id: turn_id.to_owned(),
            status: None,
            tool_calls: Vec::new(),
        });
        let index = self.turns.len() - 1;
        self.by_id.insert(turn_id.to_owned(), index);
        index
    }

    /// The turn `turn_id`, created empty on first sight.
    fn turn(&mut self, turn_id: &str) -> &mut CausalTurn {
        let index = self.index_of(turn_id);
        &mut self.turns[index]
    }

    fn push_call(&mut self, turn_id: &str, tool_use_id: &str, call: CausalToolCall) {
        let turn_index = self.index_of(turn_id);
        let calls = &mut self.turns[turn_index].tool_calls;
        calls.push(call);
        self.calls
            .insert(tool_use_id.to_owned(), (turn_index, calls.len() - 1));
    }

    fn call_mut(&mut self, tool_use_id: &str) -> Option<&mut CausalToolCall> {
        let &(turn, call) = self.calls.get(tool_use_id)?;
        self.turns.get_mut(turn)?.tool_calls.get_mut(call)
    }

    /// At most `max` turns — the newest — and how many older ones were
    /// dropped.
    fn into_newest(mut self, max: usize) -> (Vec<CausalTurn>, usize) {
        let omitted = self.turns.len().saturating_sub(max);
        self.turns.drain(..omitted);
        (self.turns, omitted)
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
        // The no-secrets-in-prompt boundary starts here — a
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
    fn test_extract_target_redacts_credentials_in_command_values() {
        let token = format!("ghp_{}", "a".repeat(36));
        let push = serde_json::json!({
            "command": format!("git push https://x-access-token:{token}@github.com/o/r HEAD")
        });
        let target = extract_target(&push).unwrap();
        assert!(target.contains("[REDACTED]"), "{target}");
        assert!(!target.contains("ghp_aaaa"), "{target}");

        let curl = serde_json::json!({
            "command": format!("curl -H 'Authorization: token {token}' https://x")
        });
        let target = extract_target(&curl).unwrap();
        assert!(!target.contains("ghp_aaaa"), "{target}");
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
        // A realistic seeded fixture spanning one full
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
        assert_eq!((ctx.commits[0].seq_from, ctx.commits[0].seq_to), (9, 13));
        assert_eq!(ctx.omitted_turn_count, 0);
    }

    /// The range is `(seq_from, seq_to]`: a row at `seq_from` or past
    /// `seq_to` is never cited, whatever the caller's query returned.
    #[test]
    fn test_rows_outside_the_seq_range_are_ignored() {
        let me = Uuid::new_v4();
        let call = |seq: u64, turn: &str| {
            ev(
                seq,
                "agent_tool_call",
                serde_json::json!({ "workerId": me, "turnId": turn, "toolUseId": format!("u{seq}"), "name": "Bash", "input": {} }),
            )
        };
        let events = vec![
            call(5, "t-at-from"),
            call(6, "t-inside"),
            call(9, "t-at-to"),
            call(10, "t-after"),
        ];
        let ctx = build_ship_context(events, me, 5, 9, false);
        let ids: Vec<&str> = ctx.turns.iter().map(|t| t.turn_id.as_str()).collect();
        assert_eq!(ids, ["t-inside", "t-at-to"]);
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
    fn test_tool_result_is_error_maps_to_ok_false_and_a_missing_flag_to_ok_true() {
        let me = Uuid::new_v4();
        let events = vec![
            ev(
                1,
                "agent_tool_call",
                serde_json::json!({ "workerId": me, "turnId": "t1", "toolUseId": "u1", "name": "Bash", "input": {} }),
            ),
            ev(
                2,
                "agent_tool_result",
                serde_json::json!({ "workerId": me, "turnId": "t1", "toolUseId": "u1", "isError": true, "content": "exit 1" }),
            ),
            ev(
                3,
                "agent_tool_call",
                serde_json::json!({ "workerId": me, "turnId": "t2", "toolUseId": "u2", "name": "Read", "input": {} }),
            ),
            ev(
                4,
                "agent_tool_result",
                serde_json::json!({ "workerId": me, "turnId": "t2", "toolUseId": "u2", "content": "ok" }),
            ),
        ];
        let ctx = build_ship_context(events, me, 0, 10, false);
        assert_eq!(ctx.turns[0].tool_calls[0].ok, Some(false));
        assert_eq!(ctx.turns[1].tool_calls[0].ok, Some(true));
    }

    /// Results attach by `toolUseId` to their own call, whatever their
    /// arrival order, including a turn's second call.
    #[test]
    fn test_tool_results_attach_to_their_own_call_within_a_turn() {
        let me = Uuid::new_v4();
        let call = |seq: u64, turn: &str, id: &str| {
            ev(
                seq,
                "agent_tool_call",
                serde_json::json!({ "workerId": me, "turnId": turn, "toolUseId": id, "name": "Bash", "input": {} }),
            )
        };
        let result = |seq: u64, turn: &str, id: &str, is_error: bool| {
            ev(
                seq,
                "agent_tool_result",
                serde_json::json!({ "workerId": me, "turnId": turn, "toolUseId": id, "isError": is_error, "content": "" }),
            )
        };
        let events = vec![
            call(1, "t1", "u1"),
            call(2, "t1", "u2"),
            call(3, "t2", "u3"),
            result(4, "t1", "u2", true),
            result(5, "t2", "u3", true),
            result(6, "t1", "u1", false),
        ];
        let ctx = build_ship_context(events, me, 0, 10, false);
        let oks: Vec<Vec<Option<bool>>> = ctx
            .turns
            .iter()
            .map(|t| t.tool_calls.iter().map(|c| c.ok).collect())
            .collect();
        assert_eq!(oks, [vec![Some(true), Some(false)], vec![Some(false)]]);
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
                u64::try_from(i).unwrap() + 1,
                "agent_block",
                serde_json::json!({ "workerId": me, "turnId": format!("t{i}"), "blockIndex": 0, "kind": "text", "content": {} }),
            ));
        }
        let ctx = build_ship_context(events, me, 0, u64::try_from(total).unwrap() + 1, false);
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

    // ── events_truncated ────────────────────────────────────────────────

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

    // ── has_uncaptured_webview_activity ─────────────────────────────────

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
