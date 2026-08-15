//! `swarmd` — the headless SWARM Orchestrator daemon.
//!
//! Runs the exact same [`swarm_core::runtime::Runtime`] the desktop
//! shell does (worker registry, session manager, ordered event log,
//! agent scheduler), with no webview and no `tauri`/`tauri-plugin-*`
//! link-time dependency, and serves the command surface + event stream
//! over an authenticated WebSocket (see [`swarmd::ws`]) instead of
//! Tauri IPC.
//!
//! Usage:
//! ```text
//! swarmd [--bind ADDR] [--data-dir PATH] [--serve-ui DIR]
//! ```
//!
//! - `--bind` (default `127.0.0.1:8787`): listen address. Binding
//!   non-loopback requires a token file to already exist (see
//!   [`swarmd::auth::DaemonToken::load_or_create`]'s doc) — a fresh
//!   install must complete one loopback-bound run first.
//! - `--data-dir` (default: the identifier-scoped app data directory,
//!   matching the desktop shell's `app.path().app_data_dir()` exactly —
//!   see [`default_data_dir`]).
//! - `--serve-ui DIR`: serves the `pnpm build:web` output from `DIR` at
//!   `/`, with the browser-build CSP header — see [`swarmd::serve_ui`].
//!
//! This binary is deliberately thin: everything routable/testable lives
//! in the `swarmd` LIBRARY target (`src/lib.rs`), which
//! `tests/integration.rs` drives directly with a real axum server + a
//! real WebSocket client.

use std::net::SocketAddr;
use std::path::PathBuf;

use swarm_core::Paths;
use swarm_core::runtime::{Runtime, RuntimeConfig, RuntimeStartError};
use swarmd::auth;

struct Args {
    bind: String,
    data_dir: Option<PathBuf>,
    serve_ui: Option<PathBuf>,
}

fn parse_args() -> Args {
    let mut bind = "127.0.0.1:8787".to_string();
    let mut data_dir = None;
    let mut serve_ui = None;

    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--bind" => bind = it.next().unwrap_or_else(|| bind.clone()),
            "--data-dir" => data_dir = it.next().map(PathBuf::from),
            "--serve-ui" => serve_ui = it.next().map(PathBuf::from),
            "--version" => {
                println!("swarmd {}", env!("CARGO_PKG_VERSION"));
                std::process::exit(0);
            }
            other => {
                eprintln!("Unrecognized Argument: \"{other}\".");
                std::process::exit(2);
            }
        }
    }

    Args {
        bind,
        data_dir,
        serve_ui,
    }
}

/// Resolves the SAME identifier-scoped app data directory Tauri's
/// `app.path().app_data_dir()` resolves for the desktop shell
/// (`tauri.conf.json`'s `identifier`: `dev.crimson.swarm-orchestrator`)
/// — the two shells MUST agree, or a `swarmd` run against the same
/// machine as the desktop app would see a DIFFERENT (empty) event log
/// and worker/session state, silently diverging rather than colliding
/// (the single-instance lock only protects against two engines on the
/// SAME dir; it says nothing about two DIFFERENT dirs).
fn default_data_dir() -> std::io::Result<PathBuf> {
    const IDENTIFIER: &str = "dev.crimson.swarm-orchestrator";

    #[cfg(target_os = "windows")]
    {
        let appdata = std::env::var_os("APPDATA")
            .ok_or_else(|| std::io::Error::other("%APPDATA% is not set"))?;
        Ok(PathBuf::from(appdata).join(IDENTIFIER))
    }
    #[cfg(target_os = "macos")]
    {
        let home = swarm_core::git::home_dir().map_err(|e| std::io::Error::other(e.to_string()))?;
        Ok(home
            .join("Library")
            .join("Application Support")
            .join(IDENTIFIER))
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        if let Some(xdg) = std::env::var_os("XDG_DATA_HOME") {
            return Ok(PathBuf::from(xdg).join(IDENTIFIER));
        }
        let home = swarm_core::git::home_dir().map_err(|e| std::io::Error::other(e.to_string()))?;
        Ok(home.join(".local").join("share").join(IDENTIFIER))
    }
}

fn init_tracing() {
    use tracing_subscriber::EnvFilter;
    let env_filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("swarm_core=debug,swarmd=debug,warn"));
    tracing_subscriber::fmt()
        .with_env_filter(env_filter)
        .with_target(true)
        .init();
}

#[tokio::main]
async fn main() {
    init_tracing();
    let args = parse_args();

    let data_dir = match args
        .data_dir
        .clone()
        .map(Ok)
        .unwrap_or_else(default_data_dir)
    {
        Ok(d) => d,
        Err(e) => {
            eprintln!("Failed To Resolve The SWARM Data Directory: {e}");
            std::process::exit(1);
        }
    };
    if let Err(e) = std::fs::create_dir_all(&data_dir) {
        eprintln!(
            "Failed To Create The SWARM Data Directory ({}): {e}",
            data_dir.display()
        );
        std::process::exit(1);
    }

    let bind_addr: SocketAddr = match args.bind.parse() {
        Ok(a) => a,
        Err(e) => {
            eprintln!("Invalid --bind Address \"{}\": {e}", args.bind);
            std::process::exit(2);
        }
    };

    // ── Auth gate FIRST (before the lock/event log): a non-loopback
    // bind against a data dir that has never seen a loopback run yet is
    // refused outright — see auth.rs's module doc.
    let (token, token_pre_existing) = match auth::DaemonToken::load_or_create(&data_dir) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("Failed To Establish The Daemon Token: {e}");
            std::process::exit(1);
        }
    };
    if !auth::is_loopback_host(&bind_addr.to_string()) && !token_pre_existing {
        eprintln!(
            "Refusing To Bind A Non-Loopback Address On A Fresh Data Directory. \
             Run `swarmd` Once With The Default Loopback Bind First (Establishes The Token And \
             Prints The Connect URL), Then Retry With --bind {}.",
            args.bind
        );
        std::process::exit(1);
    }

    let runtime = match Runtime::start(
        RuntimeConfig {
            paths: Paths {
                data_dir: data_dir.clone(),
            },
            shell_name: "swarmd",
            bind: Some(args.bind.clone()),
        },
        |_envelope| {
            // No PRIMARY lossless consumer for swarmd — there is no
            // webview. Every WS client rides the engine's SECONDARY
            // broadcast fanout instead, healed per-connection on lag by
            // `swarmd::ws`'s replay routine — see that module's doc.
        },
    ) {
        Ok(rt) => rt,
        Err(RuntimeStartError::Lock(e)) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
        Err(e) => {
            eprintln!("Failed To Start The SWARM Runtime: {e}");
            std::process::exit(1);
        }
    };

    let token_str = token.as_str().to_string();
    let state = swarmd::build_state(
        &runtime,
        bind_addr.to_string(),
        token,
        swarmd::default_caps(),
    );
    let app = swarmd::build_router(state, args.serve_ui.as_deref())
        .into_make_service_with_connect_info::<SocketAddr>();

    let listener = match tokio::net::TcpListener::bind(bind_addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("Failed To Bind {bind_addr}: {e}");
            std::process::exit(1);
        }
    };
    let local_addr = listener.local_addr().unwrap_or(bind_addr);

    // The token lives ONLY in the URL fragment — never transmitted to
    // the server, never logged by an intermediary proxy, per the plan's
    // "Token: URL fragment ← query param" decision.
    println!("SWARM Daemon Listening On http://{local_addr}/#t={token_str}");
    tracing::info!(bind = %local_addr, data_dir = %data_dir.display(), "swarmd started");

    if let Err(e) = axum::serve(listener, app).await {
        eprintln!("Server Error: {e}");
        std::process::exit(1);
    }

    // `runtime` (and its held `SingleInstanceLock`) stays alive for the
    // entire `axum::serve` call above — dropped here only on normal
    // shutdown, releasing the lock.
    drop(runtime);
}
