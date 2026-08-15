//! DIRECTIVE (headless-daemon plan Phase 2 item 2): `registry.keys() ==
//! generate_handler!'s command list − NATIVE_ONLY`. Without this, a
//! command added to one side (a new `#[tauri::command]` wired into
//! `generate_handler!`, or a new registry entry) and forgotten on the
//! other silently drifts — "works locally, missing remotely" (or the
//! inverse: a registry command no Tauri wrapper ever calls, dead code
//! nobody notices).
//!
//! # Mechanism: parses `lib.rs`'s OWN SOURCE, re-read every test run
//!
//! `include_str!("../lib.rs")` embeds the literal text of `lib.rs` at
//! COMPILE time — every `cargo test` recompiles this test against
//! whatever `lib.rs` currently says, so there is no hand-maintained
//! snapshot to fall out of sync. The parser is deliberately narrow: it
//! looks for the `tauri::generate_handler![ ... ]` block and extracts
//! every `commands::<module>::<name>` path inside it, taking the final
//! `::`-segment as the command name — the exact shape every existing
//! entry in that macro call already has (see `lib.rs`'s own
//! `invoke_handler` call). A new entry that does NOT follow that
//! `commands::module::name,` shape would fail to parse, which is a
//! DELIBERATE fail-loud: a command wired in some other way would defeat
//! this test's purpose, so the parser errors out (panics with a clear
//! message) rather than silently skipping it.
use std::collections::BTreeSet;

const LIB_RS: &str = include_str!("../lib.rs");

/// Extracts every `commands::<module>::<name>` path's final segment
/// from the `tauri::generate_handler![...]` block in `lib.rs`.
fn parse_generate_handler_names() -> BTreeSet<String> {
    let start_marker = "tauri::generate_handler![";
    let start = LIB_RS
        .find(start_marker)
        .expect("lib.rs must contain a `tauri::generate_handler![...]` call — has it been renamed/restructured?")
        + start_marker.len();

    // Find the matching closing bracket by simple depth counting — the
    // block contains no nested `[`/`]` of its own (it's a flat list of
    // paths and comments), so this is exact, not a heuristic.
    let mut depth = 1i32;
    let mut end = start;
    for (i, ch) in LIB_RS[start..].char_indices() {
        match ch {
            '[' => depth += 1,
            ']' => {
                depth -= 1;
                if depth == 0 {
                    end = start + i;
                    break;
                }
            }
            _ => {}
        }
    }
    assert!(
        end > start,
        "could not find the closing `]` of generate_handler!'s block"
    );

    let block = &LIB_RS[start..end];
    let mut names = BTreeSet::new();
    for line in block.lines() {
        let line = line.trim();
        let line = line.strip_prefix("// ").unwrap_or(line);
        if line.is_empty() || !line.starts_with("commands::") {
            continue; // blank lines and `// Worker commands`-style section comments
        }
        let path = line.trim_end_matches(',').trim();
        let name = path
            .rsplit("::")
            .next()
            .unwrap_or_else(|| panic!("malformed generate_handler! entry: {path:?}"));
        names.insert(name.to_string());
    }
    names
}

#[test]
fn test_registry_matches_generate_handler_minus_native_only() {
    let handler_names = parse_generate_handler_names();
    assert!(
        handler_names.len() >= 30,
        "sanity check: parsed suspiciously few generate_handler! entries ({}) — parser likely broke",
        handler_names.len()
    );

    let native_only: BTreeSet<String> = swarm_core::commands::NATIVE_ONLY
        .iter()
        .map(|s| s.to_string())
        .collect();

    let expected_registry_names: BTreeSet<String> =
        handler_names.difference(&native_only).cloned().collect();

    let registry_names: BTreeSet<String> = swarm_core::commands::Registry::new()
        .keys()
        .into_iter()
        .map(|s| s.to_string())
        .collect();

    let missing_from_registry: Vec<&String> = expected_registry_names
        .difference(&registry_names)
        .collect();
    let extra_in_registry: Vec<&String> = registry_names
        .difference(&expected_registry_names)
        .collect();

    assert!(
        missing_from_registry.is_empty() && extra_in_registry.is_empty(),
        "registry drift detected!\n  \
         In generate_handler! but missing from the registry: {missing_from_registry:?}\n  \
         In the registry but not in generate_handler! (and not NATIVE_ONLY): {extra_in_registry:?}"
    );
}

#[test]
fn test_native_only_commands_are_not_in_the_registry() {
    let registry_names = swarm_core::commands::Registry::new().keys();
    for native in swarm_core::commands::NATIVE_ONLY {
        assert!(
            !registry_names.contains(native),
            "{native} is NATIVE_ONLY and must never have a registry entry"
        );
    }
}

#[test]
fn test_native_only_commands_are_still_wired_in_generate_handler() {
    // The inverse check: NATIVE_ONLY names must still be REAL commands
    // this app exposes (just not through the registry) — catches a
    // typo in NATIVE_ONLY silently exempting a command that should have
    // a registry entry.
    let handler_names = parse_generate_handler_names();
    for native in swarm_core::commands::NATIVE_ONLY {
        assert!(
            handler_names.contains(*native),
            "{native} is listed in NATIVE_ONLY but is not a real generate_handler! command — typo?"
        );
    }
}
