//! Workers: shells running on their own pseudo-terminals, optionally
//! isolated in a git worktree, plus the piped-process substrate the
//! agent adapters run provider CLIs on.
//!
//! - [`handle`] — wire types (state, isolation, spawn config, info
//!   snapshot) and the runtime [`handle::WorkerHandle`]
//! - [`registry`] — the concurrent store of live workers: capacity
//!   admission, state transitions, aggregate counts
//! - [`pty`] — starting a shell on a PTY, streaming its output,
//!   watching for its exit
//! - [`lifecycle`] — spawn, pause, resume, resize, input and kill, with
//!   the events each one emits
//! - [`proc`] — piped-stdio children with NDJSON framing, for
//!   JSON-protocol provider CLIs (a PTY would corrupt the framing; see
//!   the module doc)

use uuid::Uuid;

pub mod handle;
pub mod lifecycle;
pub mod proc;
pub mod pty;
pub mod registry;

/// First 8 hex digits of `id`: the `<id8>` in a worker's branch name
/// (`swarm/<slug>-<id8>`), worktree directory (`w-<id8>`) and thread
/// names (`pty-<id8>`, `pty-exit-<id8>`).
pub(crate) fn short_id8(id: Uuid) -> String {
    let mut buf = Uuid::encode_buffer();
    id.simple().encode_lower(&mut buf)[..8].to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_short_id8_is_the_first_eight_hex_digits() {
        let id = Uuid::parse_str("0123abcd-ef45-6789-0abc-def012345678").unwrap();
        assert_eq!(short_id8(id), "0123abcd");
    }
}
