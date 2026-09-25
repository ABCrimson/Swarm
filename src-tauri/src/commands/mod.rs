//! Tauri IPC commands.
//!
//! Every command of the shared [`Registry`] is exposed under its own name
//! by a forwarder that hands the invoke's JSON arguments to
//! [`Registry::dispatch`] untouched and returns the registry's result or
//! error value untouched. The registry parses and validates arguments, so
//! the desktop and `swarmd` (which dispatches its WebSocket `rpc` frames
//! through the same table) accept exactly the same arguments and answer
//! with the same JSON: optional arguments such as the `originWorker` /
//! `causeSeq` provenance pair reach the handler however they are sent,
//! with no per-command wrapper that could drop them.
//!
//! [`native`] holds the two commands with no registry entry
//! ([`swarm_core::commands::NATIVE_ONLY`]).

pub mod native;

use serde_json::Value;
use swarm_core::commands::{Ctx, Registry};
use tauri::State;
use tauri::ipc::{Invoke, InvokeBody, Request};
use tracing::Instrument;

/// Declares one forwarding `#[tauri::command]` per registry command, the
/// app's invoke handler over them and the native commands, and the name
/// lists the contract tests compare against swarm-core's.
///
/// The forwarders stay private, and `generate_handler!` is invoked here
/// next to them: on a `pub` or `pub(..)` function, `#[tauri::command]`
/// `#[macro_export]`s the helper macro `generate_handler!` expands to,
/// which would put 35 macros at the crate root.
macro_rules! commands {
    (registry: [$($command:ident),+ $(,)?], native: [$($native:ident),+ $(,)?] $(,)?) => {
        $(
            #[tauri::command]
            async fn $command(
                registry: State<'_, Registry>,
                ctx: State<'_, Ctx>,
                request: Request<'_>,
            ) -> Result<Value, Value> {
                forward(&registry, &ctx, stringify!($command), request.body()).await
            }
        )+

        /// Registry commands exposed as Tauri commands, in declaration order.
        #[cfg(test)]
        const REGISTRY_COMMANDS: &[&str] = &[$(stringify!($command)),+];

        /// Desktop-only commands exposed as Tauri commands.
        #[cfg(test)]
        const NATIVE_COMMANDS: &[&str] = &[$(stringify!($native)),+];

        /// The app's invoke handler: every registry command plus the
        /// native ones.
        pub fn handler<R: tauri::Runtime>() -> impl Fn(Invoke<R>) -> bool + Send + Sync + 'static {
            tauri::generate_handler![$($command,)+ $(native::$native),+]
        }
    };
}

commands! {
    registry: [
        // Workers
        spawn_worker,
        pause_worker,
        resume_worker,
        kill_worker,
        list_workers,
        worker_input,
        set_max_workers,
        // Git and the ship chain
        validate_repo_root,
        git_ship_preflight,
        git_stage_commit,
        git_push,
        ship_context,
        ship_compare_url,
        // Sessions
        create_session,
        delete_session,
        list_sessions,
        get_session,
        session_add_worker,
        session_remove_worker,
        // Provider agents
        agent_turn_started,
        agent_spawn,
        agent_send_turn,
        agent_cancel,
        agent_shutdown,
        agent_probe,
        agent_permission_respond,
        set_agent_concurrency,
        // App config
        read_config,
        write_config,
        // Files
        read_file,
        write_file,
        // Metrics
        get_metrics,
        // Ordered event log
        events_since,
        // Message bus
        bus_send,
        bus_list_channels,
    ],
    native: [check_for_updates, send_notification],
}

/// Dispatches `command` with the invoke's JSON arguments, inside a
/// debug-level `ipc` span that names the command and records none of its
/// arguments (prompts, file contents and terminal input pass through
/// here).
async fn forward(
    registry: &Registry,
    ctx: &Ctx,
    command: &'static str,
    body: &InvokeBody,
) -> Result<Value, Value> {
    let InvokeBody::Json(args) = body else {
        return Err(Value::String(format!(
            "Invalid Arguments: \"{command}\" Takes A JSON Object, Not Raw Bytes."
        )));
    };
    registry
        .dispatch(command, ctx.clone(), args.clone())
        .instrument(tracing::debug_span!("ipc", command))
        .await
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;
    use std::path::{Path, PathBuf};
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    use swarm_core::commands::NATIVE_ONLY;
    use swarm_core::events::SwarmEvent;
    use swarm_core::orchestration::DomainEvent;
    use tauri::ipc::CallbackFn;
    use tauri::test::{
        INVOKE_KEY, MockRuntime, get_ipc_response, mock_builder, mock_context, noop_assets,
    };
    use tauri::webview::InvokeRequest;
    use tauri::{Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

    use super::*;
    use crate::test_support::{TempDir, start_runtime, temp_dir};

    /// Exactly the registry's commands are forwarded, each once.
    #[test]
    fn forwarded_commands_are_exactly_the_registry() {
        let forwarded: BTreeSet<&str> = REGISTRY_COMMANDS.iter().copied().collect();
        assert_eq!(
            forwarded.len(),
            REGISTRY_COMMANDS.len(),
            "a command is listed twice"
        );
        let registry: BTreeSet<&str> = Registry::new().keys().into_iter().collect();
        assert_eq!(forwarded, registry);
    }

    /// The native commands are exactly swarm-core's `NATIVE_ONLY`, and
    /// none of them is also a registry command.
    #[test]
    fn native_commands_are_exactly_native_only() {
        let native: BTreeSet<&str> = NATIVE_COMMANDS.iter().copied().collect();
        assert_eq!(native, NATIVE_ONLY.iter().copied().collect());
        let registry = Registry::new();
        assert!(
            native
                .iter()
                .all(|command| registry.policy(command).is_none())
        );
    }

    /// A mock app wired like the real one: the real invoke handler over a
    /// real swarm-core runtime in a temporary data directory, with every
    /// event the runtime emits forwarded to `events`.
    struct Harness {
        webview: WebviewWindow<MockRuntime>,
        events: mpsc::Receiver<DomainEvent>,
        _app: tauri::App<MockRuntime>,
        _tokio: tokio::runtime::Runtime,
        _data_dir: TempDir,
    }

    impl Harness {
        fn new(name: &str) -> Self {
            let data_dir = temp_dir(&format!("ipc-{name}"));
            let tokio = tokio::runtime::Runtime::new().unwrap();
            let (sender, events) = mpsc::channel();
            let runtime = {
                let _context = tokio.enter();
                start_runtime(&data_dir, move |event| {
                    let _ = sender.send(event.clone());
                })
            };

            let app = mock_builder()
                .invoke_handler(handler())
                .build(mock_context(noop_assets()))
                .unwrap();
            app.manage(Ctx::from_runtime(&runtime));
            app.manage(Registry::new());
            app.manage(runtime);
            let webview = WebviewWindowBuilder::new(&app, "main", WebviewUrl::default())
                .build()
                .unwrap();

            Self {
                webview,
                events,
                _app: app,
                _tokio: tokio,
                _data_dir: data_dir,
            }
        }

        /// Invokes `command` the way the webview's `invoke()` does.
        fn invoke(&self, command: &str, args: Value) -> Result<Value, Value> {
            get_ipc_response(
                &self.webview,
                InvokeRequest {
                    cmd: command.into(),
                    callback: CallbackFn(0),
                    error: CallbackFn(1),
                    url: "tauri://localhost".parse().unwrap(),
                    body: InvokeBody::Json(args),
                    headers: Default::default(),
                    invoke_key: INVOKE_KEY.to_owned(),
                },
            )
            .map(|body| body.deserialize().unwrap())
        }

        /// The next emitted event that `matches`, waiting up to five seconds.
        fn next_event(&self, matches: impl Fn(&SwarmEvent) -> bool) -> DomainEvent {
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                let remaining = deadline.saturating_duration_since(Instant::now());
                let event = self
                    .events
                    .recv_timeout(remaining)
                    .expect("no matching event within 5 s");
                if matches(&event.event) {
                    return event;
                }
            }
        }
    }

    /// Every registry command answers under its own name, from the
    /// registry itself: called with `null` arguments, each either runs or
    /// is rejected by the registry's argument parser, never by Tauri's
    /// router ("Command … not found") or its ACL ("… not allowed").
    #[test]
    fn every_registry_command_is_invocable() {
        let harness = Harness::new("reachable");
        for command in Registry::new().keys() {
            if let Err(error) = harness.invoke(command, Value::Null) {
                assert!(
                    error
                        .as_str()
                        .is_some_and(|message| message.starts_with("Invalid Arguments")),
                    "{command}: {error}"
                );
            }
        }
    }

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
                } else if (name.ends_with(".ts") || name.ends_with(".tsx"))
                    && !name.contains(".test.")
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
    /// "Built, Not Wired"): the message bus.
    const NOT_WIRED: &[&str] = &["bus_send", "bus_list_channels"];

    /// Every command the frontend invokes is one the invoke handler
    /// routes; the native commands, whose arguments Tauri itself parses,
    /// are called with exactly the parameters they declare; and every
    /// registry command's arguments are camelCase keys, which the
    /// forwarder hands to the registry as they are (the registry's
    /// argument structs, shared with `swarmd`, are the one place their
    /// shape is defined).
    #[test]
    fn frontend_invokes_match_the_handler() {
        let native_params: [(&str, &[&str]); 2] = [
            ("check_for_updates", &[]),
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

    /// Optional arguments the registry accepts reach it over Tauri IPC:
    /// the provenance of `session_remove_worker`, which the hand-written
    /// wrapper this forwarder replaced dropped, lands on the event.
    #[test]
    fn provenance_arguments_reach_the_registry() {
        let harness = Harness::new("provenance");
        let session = harness
            .invoke(
                "create_session",
                serde_json::json!({ "name": "S", "config": {} }),
            )
            .unwrap();
        let origin_worker = "0b6f5a4c-5f9e-4d6f-9d7e-1c2b3a4d5e6f";

        harness
            .invoke(
                "session_remove_worker",
                serde_json::json!({
                    "sessionId": session["id"],
                    "workerId": "7d1f0c2e-3b4a-4c5d-8e9f-0a1b2c3d4e5f",
                    "originWorker": origin_worker,
                    "causeSeq": 7,
                }),
            )
            .unwrap();

        let removed =
            harness.next_event(|event| matches!(event, SwarmEvent::SessionWorkerRemoved(_)));
        assert_eq!(
            removed.origin_worker.map(|id| id.to_string()).as_deref(),
            Some(origin_worker)
        );
        assert_eq!(removed.cause_seq, Some(7));
    }

    /// Results and errors are the registry's own JSON, the same values
    /// `swarmd` returns in an `rpcResult` frame.
    #[test]
    fn results_and_errors_are_the_registrys_json() {
        let harness = Harness::new("wire");
        assert_eq!(
            harness.invoke("list_workers", serde_json::json!({})),
            Ok(serde_json::json!([]))
        );
        let error = harness
            .invoke("get_session", serde_json::json!({ "id": "not-a-uuid" }))
            .unwrap_err();
        assert!(
            error
                .as_str()
                .is_some_and(|message| message.starts_with("Invalid UUID")),
            "{error}"
        );
    }
}
