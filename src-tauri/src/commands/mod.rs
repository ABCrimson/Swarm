//! Tauri IPC command handlers.
//!
//! Every command here is now a THIN wrapper: it packs its typed
//! parameters into a `serde_json::Value`, calls
//! [`swarm_core::commands::Registry::dispatch`] (the SAME dispatch
//! table `swarmd`'s WS `rpc` frames use), and unpacks the result back
//! into the command's declared return type. The actual logic lives
//! entirely in `swarm_core::commands::*` — see that module's doc for
//! the drift-proof contract this split exists to make CI-checkable
//! (`registry_contract` test, below).
//!
//! ## Modules
//!
//! - [`worker`] — Worker lifecycle commands (spawn, pause, resume, kill, list, input, resize)
//! - [`session`] — Session CRUD commands (create, delete, list, get)
//! - [`agent`] — Provider-adapter agent commands
//! - [`config`] — App config file commands (read_config, write_config)
//! - [`metrics`] — System metrics retrieval
//! - [`bus`] — Message bus commands (send, list channels)
//! - [`fs`] — `read_file`/`write_file` commands
//! - [`git`] — Git repo-root validation + the ship chain
//! - [`notification`] — OS notification command (NATIVE_ONLY — no registry entry)
//! - [`orchestration`] — Ordered event core commands (events_since)
//! - [`updater`] — Auto-updater check command (NATIVE_ONLY — no registry entry)

pub mod agent;
pub mod bus;
pub mod config;
pub mod fs;
pub mod git;
pub mod metrics;
pub mod notification;
pub mod orchestration;
pub mod session;
pub mod updater;
pub mod worker;

use serde::de::DeserializeOwned;
use serde_json::Value;
use swarm_core::commands::{Ctx, Registry};

/// Dispatches `cmd` through the shared [`Registry`], deserializing a
/// successful result into `T` and an error into a plain `String` — the
/// shape every command that used to return `Result<T, String>` still
/// returns.
pub(crate) async fn call<T: DeserializeOwned>(
    registry: &Registry,
    ctx: Ctx,
    cmd: &'static str,
    args: Value,
) -> Result<T, String> {
    match registry.dispatch(cmd, ctx, args).await {
        Ok(v) => serde_json::from_value(v).map_err(|e| {
            format!("Internal Error: Registry Result For \"{cmd}\" Did Not Match The Expected Shape: {e}")
        }),
        Err(e) => Err(value_to_message(e)),
    }
}

/// Same as [`call`], but for the handful of commands whose Tauri IPC
/// error type is a STRUCTURED value (`ShipError`, `AgentSpawnError`),
/// not a plain string — deserializes the registry's error `Value` back
/// into `E` (constructed the same way by
/// [`swarm_core::commands::err_value`] on the registry side, so this
/// round-trips exactly for every real error the handler produces;
/// `on_shape_mismatch` builds a fallback `E` only for the
/// (never-expected-in-practice) case where that round-trip itself
/// fails, so a JSON-shape bug degrades to a truthful "something is
/// wrong" error instead of a panic across the IPC boundary).
pub(crate) async fn call_typed_err<T: DeserializeOwned, E: DeserializeOwned>(
    registry: &Registry,
    ctx: Ctx,
    cmd: &'static str,
    args: Value,
    on_shape_mismatch: impl FnOnce(String) -> E,
) -> Result<T, E> {
    match registry.dispatch(cmd, ctx, args).await {
        Ok(v) => match serde_json::from_value(v) {
            Ok(t) => Ok(t),
            Err(e) => Err(on_shape_mismatch(format!(
                "Internal Error: Registry Result For \"{cmd}\" Did Not Match The Expected Shape: {e}"
            ))),
        },
        Err(e) => match serde_json::from_value(e.clone()) {
            Ok(typed) => Err(typed),
            Err(_) => Err(on_shape_mismatch(value_to_message(e))),
        },
    }
}

fn value_to_message(v: Value) -> String {
    match v {
        Value::String(s) => s,
        other => other.to_string(),
    }
}

#[cfg(test)]
mod registry_contract;
