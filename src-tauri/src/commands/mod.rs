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
/// `#[macro_export]`s the two hidden helper macros `generate_handler!`
/// expands to (`__cmd__<name>` and `__tauri_command_name_<name>`), which
/// would put 72 macros at the crate root. The [`native`] commands are
/// `pub`, and export their four, because the handler names them from this
/// module and a private command's helpers are re-exported only inside its
/// own module.
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
        pub(crate) const REGISTRY_COMMANDS: &[&str] = &[$(stringify!($command)),+];

        /// Desktop-only commands exposed as Tauri commands.
        #[cfg(test)]
        pub(crate) const NATIVE_COMMANDS: &[&str] = &[$(stringify!($native)),+];

        /// The app's invoke handler: every registry command plus the
        /// native ones.
        pub fn handler<R: tauri::Runtime>() -> impl Fn(Invoke<R>) -> bool + Send + Sync + 'static {
            tauri::generate_handler![$($command,)+ $(native::$native),+]
        }
    };
}

include!("command_list.rs");

command_list!(commands);

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
            let webview =
                WebviewWindowBuilder::new(&app, crate::MAIN_WINDOW, WebviewUrl::default())
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
    /// registry itself: called with arguments that are not a JSON object,
    /// each is rejected by the registry's argument check, never by
    /// Tauri's router ("Command … not found") or its ACL ("… not
    /// allowed"). Not `null`: the registry reads `null` as `{}`, which
    /// would really run every command whose arguments are all optional,
    /// `agent_probe` included, and that one launches the provider CLIs
    /// installed on the host.
    #[test]
    fn every_registry_command_is_invocable() {
        let harness = Harness::new("reachable");
        for command in Registry::new().keys() {
            let error = harness
                .invoke(command, Value::String("not an object".to_owned()))
                .expect_err(command);
            assert!(
                error
                    .as_str()
                    .is_some_and(|message| message.starts_with("Invalid Arguments")),
                "{command}: {error}"
            );
        }
    }

    /// Optional arguments the registry accepts reach it over Tauri IPC
    /// unchanged: the `originWorker` / `causeSeq` provenance of
    /// `session_remove_worker` lands on the `SessionWorkerRemoved` event,
    /// because a forwarder has no per-command argument struct that could
    /// drop it.
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
