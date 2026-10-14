//! Contract tests between the frontend's `invoke` calls and the app's commands.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use crate::commands::{NATIVE_COMMANDS, REGISTRY_COMMANDS};

/// Every non-test TypeScript source of the frontend (`src/**/*.ts(x)`
/// without the `*.test.*` files and the `src/test/` setup), as its
/// path and text.
fn frontend_sources() -> Vec<(PathBuf, String)> {
    fn walk(dir: &Path, sources: &mut Vec<(PathBuf, String)>) {
        for entry in std::fs::read_dir(dir).expect("read a frontend directory") {
            let path = entry.expect("read a frontend directory entry").path();
            let name = path.file_name().unwrap_or_default().to_string_lossy();
            if path.is_dir() {
                if name != "test" {
                    walk(&path, sources);
                }
            } else if (name.ends_with(".ts") || name.ends_with(".tsx")) && !name.contains(".test.")
            {
                let text = std::fs::read_to_string(&path).expect("read a frontend source");
                sources.push((path, text));
            }
        }
    }
    let mut sources = Vec::new();
    walk(
        &Path::new(env!("CARGO_MANIFEST_DIR")).join("../src"),
        &mut sources,
    );
    sources
}

/// `text` after an identifier: past its type arguments, if any, and
/// the `(` that opens a call, or `None` when no call follows.
fn call_arguments(text: &str) -> Option<&str> {
    let mut text = text;
    if let Some(generic) = text.strip_prefix('<') {
        // Skip the (possibly nested) type arguments.
        let mut depth = 1;
        let end = generic.char_indices().find_map(|(i, c)| {
            depth += match c {
                '<' => 1,
                '>' => -1,
                _ => 0,
            };
            (depth == 0).then_some(i)
        })?;
        text = &generic[end + 1..];
    }
    text.strip_prefix('(').map(str::trim_start)
}

fn is_identifier_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '$'
}

/// The text after each call of the function `name` in `source`, from
/// its first argument on.
fn calls_of<'a>(source: &'a str, name: &str) -> Vec<&'a str> {
    source
        .match_indices(name)
        .filter(|&(at, _)| !source[..at].ends_with(|c: char| is_identifier_char(c) || c == '.'))
        .filter_map(|(at, _)| call_arguments(&source[at + name.len()..]))
        .collect()
}

/// The functions in `source` that pass their first parameter on as
/// the command name of an `invoke` call, such as a helper that adds
/// error mapping around `invoke(cmd, args)`: a call of one of them
/// with a string literal is a command invocation too. A function's
/// body is taken to end at the first `}` in column 0, where Biome's
/// formatting closes a top-level declaration.
fn forwarders(source: &str) -> Vec<String> {
    source
        .match_indices("function ")
        .filter_map(|(at, keyword)| {
            let rest = &source[at + keyword.len()..];
            let name: String = rest
                .chars()
                .take_while(|&c| is_identifier_char(c))
                .collect();
            let params = call_arguments(&rest[name.len()..])?;
            let param: String = params
                .chars()
                .take_while(|&c| is_identifier_char(c))
                .collect();
            let body = &params[..params.find("\n}").unwrap_or(params.len())];
            let forwards = !param.is_empty()
                && calls_of(body, "invoke").iter().any(|args| {
                    args.strip_prefix(param.as_str())
                        .is_some_and(|after| after.trim_start().starts_with([',', ')']))
                });
            (forwards && name != "invoke").then_some(name)
        })
        .collect()
}

/// One call in the frontend that names its command with a string
/// literal: `invoke("command", { key, … })`, or the same through a
/// forwarding helper.
#[derive(Debug)]
struct FrontendCall {
    command: String,
    /// The keys of an inline object literal argument; `None` when
    /// the call passes no arguments or a non-literal expression.
    keys: Option<BTreeSet<String>>,
}

/// Every call of `invoke` or of a forwarding helper with a
/// string-literal command name in `source`.
fn frontend_calls(source: &str) -> Vec<FrontendCall> {
    let mut callees = forwarders(source);
    callees.push("invoke".to_owned());
    callees
        .iter()
        .flat_map(|callee| calls_of(source, callee))
        .filter_map(|args| {
            let (command, args) = args.strip_prefix('"')?.split_once('"')?;
            // `invoke("${cmd}")` quoted inside a template literal (a
            // log message) is text, not a call.
            if command.contains("${") {
                return None;
            }
            let keys = args
                .trim_start()
                .strip_prefix(',')
                .map(str::trim_start)
                .and_then(|args| args.strip_prefix('{'))
                .and_then(|object| object.split_once('}'))
                .map(|(body, _)| {
                    body.split(',')
                        .map(|entry| entry.split(':').next().unwrap_or_default().trim())
                        .filter(|key| !key.is_empty())
                        .map(str::to_owned)
                        .collect()
                });
            Some(FrontendCall {
                command: command.to_owned(),
                keys,
            })
        })
        .collect()
}

fn all_frontend_calls() -> Vec<FrontendCall> {
    frontend_sources()
        .iter()
        .flat_map(|(_, source)| frontend_calls(source))
        .collect()
}

/// Registry commands with no frontend caller yet (docs/api.md,
/// "Built, Not Wired"): the message bus, the single-session read and
/// agent-session shutdown.
const NOT_WIRED: &[&str] = &[
    "bus_send",
    "bus_list_channels",
    "get_session",
    "agent_shutdown",
];

/// Every command the frontend invokes is one the invoke handler
/// routes; the native commands, whose arguments Tauri itself parses,
/// are called with exactly the parameters they declare; and every
/// registry command's arguments are camelCase keys, which the
/// forwarder hands to the registry as they are (the registry's
/// argument structs, shared with `swarmd`, are the one place their
/// shape is defined).
#[test]
fn frontend_invokes_match_the_handler() {
    let native_params: [(&str, &[&str]); 3] = [
        ("check_for_updates", &[]),
        ("open_worker_directory", &["workerId"]),
        ("send_notification", &["title", "body"]),
    ];
    let calls = all_frontend_calls();
    for call in &calls {
        let command = call.command.as_str();
        let registered = REGISTRY_COMMANDS.contains(&command);
        let native = native_params.iter().find(|(name, _)| *name == command);
        assert!(
            registered || native.is_some(),
            "the frontend invokes {command}, which the app does not expose"
        );
        let keys = call.keys.clone().unwrap_or_default();
        if let Some((_, params)) = native {
            assert_eq!(
                keys,
                params.iter().map(|&p| p.to_owned()).collect(),
                "{command}'s arguments"
            );
        }
        for key in &keys {
            assert!(
                key.chars().next().is_some_and(|c| c.is_ascii_lowercase())
                    && key.chars().all(|c| c.is_ascii_alphanumeric()),
                "{command}: argument {key:?} is not a camelCase key"
            );
        }
    }
    assert!(
        calls
            .iter()
            .any(|call| call.command == "session_remove_worker"
                && call
                    .keys
                    .as_ref()
                    .is_some_and(|keys| keys.contains("workerId"))),
        "the parser reads argument keys"
    );
    assert!(
        calls.iter().any(|call| call.command == "git_ship_preflight"
            && call
                .keys
                .as_ref()
                .is_some_and(|keys| keys.contains("workerId"))),
        "the parser reads calls through forwarding helpers (#lib/tauri's shipCommand)"
    );
}

/// Every exposed command except the unwired ones is invoked by the
/// frontend, and the parser sees that call: a command the frontend
/// names only through a call shape the parser does not know fails
/// here instead of going unchecked.
#[test]
fn frontend_invokes_every_wired_command() {
    let sources = frontend_sources();
    let invoked: BTreeSet<String> = all_frontend_calls()
        .into_iter()
        .map(|call| call.command)
        .collect();
    for &command in REGISTRY_COMMANDS.iter().chain(NATIVE_COMMANDS) {
        let quoted = format!("\"{command}\"");
        let named = sources.iter().any(|(_, source)| source.contains(&quoted));
        if NOT_WIRED.contains(&command) {
            assert!(
                !named,
                "{command} has a frontend caller now: remove it from NOT_WIRED"
            );
        } else {
            assert!(named, "no frontend source invokes {command}");
            assert!(
                invoked.contains(command),
                "the frontend names {command}, but the parser finds no call of it"
            );
        }
    }
}
