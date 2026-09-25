//! `swarmd`, the headless SWARM Orchestrator daemon.
//!
//! Runs the same [`swarm_core::runtime::Runtime`] as the desktop app
//! (worker registry, sessions, ordered event log, agent scheduler) with no
//! webview and no Tauri dependency, and serves its command surface and
//! event stream over an authenticated WebSocket (see [`swarmd::ws`]).
//! `swarmd --help` lists the options; [`swarmd::cli`] parses them.
//!
//! Startup order matters. The shutdown signal handlers are installed before
//! any of it, and steps 1-3 (blocking file work) run on the main thread
//! before the async runtime serves anything:
//!
//! 1. The data directory is created (or tightened) to mode `0700` on Unix:
//!    it holds the Anthropic API key, the event log and the token.
//! 2. The non-loopback gate: `--bind` to a non-loopback address is refused
//!    unless a valid token file already exists, and this check runs BEFORE
//!    anything could mint one (see [`swarmd::auth`]).
//! 3. The token is loaded or minted; failing to make its file private is
//!    fatal for a non-loopback bind and a warning on loopback.
//! 4. The listener is bound BEFORE the runtime starts, so a port conflict
//!    exits before the lock, the event log or any startup work, and the
//!    real address (port `0` resolved) is what the lock file records.
//! 5. The runtime starts; another instance holding the data directory
//!    exits with status 75 (`EX_TEMPFAIL`), which the systemd unit does
//!    not restart in a tight loop.
//!
//! The connect URL carries the token in its fragment. It is printed only
//! when stdout is a terminal; under a service manager the log gets the
//! address and a `swarmd connect-url` command instead.
//!
//! SIGINT/SIGTERM (Ctrl-C, console close, logoff or shutdown on Windows)
//! start a graceful shutdown: clients get `1001 Going Away`, every worker
//! is stopped as `kill_worker` would stop it, the event writer drains, and
//! the lock is released.

use std::fmt::Write as _;
use std::fs::{File, OpenOptions};
use std::io::{self, IsTerminal};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use swarm_core::Paths;
use swarm_core::events::{Provenance, SwarmEvent, SystemLogPayload};
use swarm_core::lock::LockError;
use swarm_core::runtime::{Runtime, RuntimeConfig, RuntimeStartError};
use swarmd::auth::{DaemonToken, HostPolicy};
use swarmd::cli::{self, Command, ConnectUrlArgs, ServeArgs};
use swarmd::{AppState, Limits};
use tokio::net::TcpListener;

/// Exit status for a command line that does not parse.
const EXIT_USAGE: u8 = 2;
/// Exit status when another instance holds the data directory
/// (`EX_TEMPFAIL`); `swarmd.service` does not restart on it.
const EXIT_LOCKED: u8 = 75;

/// Log filter when `RUST_LOG` is unset or invalid.
const DEFAULT_LOG_FILTER: &str = "swarm_core=info,swarmd=info,warn";

/// How long shutdown waits for workers to stop.
const STOP_WORKERS_TIMEOUT: Duration = Duration::from_secs(10);
/// How long shutdown waits for the event writer to persist what is queued.
const FLUSH_TIMEOUT: Duration = Duration::from_secs(5);

fn main() -> ExitCode {
    let command = match cli::parse(std::env::args_os().skip(1)) {
        Ok(command) => command,
        Err(error) => {
            eprintln!("{error}\nRun `swarmd --help` For Usage.");
            return ExitCode::from(EXIT_USAGE);
        }
    };
    match command {
        Command::Help => {
            print!("{}", cli::USAGE);
            ExitCode::SUCCESS
        }
        Command::Version => {
            println!("swarmd {}", env!("CARGO_PKG_VERSION"));
            ExitCode::SUCCESS
        }
        Command::ConnectUrl(args) => print_connect_url(&args),
        Command::Serve(args) => {
            // Under a service manager stderr may go nowhere (the Windows
            // task has no visible console), so a fatal error is logged too.
            let log_to_file = args.log_file.is_some();
            match run(args) {
                Ok(()) => ExitCode::SUCCESS,
                Err(fatal) => {
                    if log_to_file {
                        tracing::error!(status = fatal.status, "{}", fatal.message);
                    }
                    eprintln!("{}", fatal.message);
                    ExitCode::from(fatal.status)
                }
            }
        }
    }
}

/// Runs the daemon: the synchronous startup steps on the main thread, then
/// [`serve`] on a multi-threaded async runtime, so no blocking file or
/// process work (`icacls.exe` on Windows) runs on a runtime worker.
fn run(args: ServeArgs) -> Result<(), Fatal> {
    init_tracing(args.log_file.as_deref()).map_err(|error| {
        fatal(format!(
            "Failed To Open The Log File {}: {error}",
            args.log_file.as_deref().unwrap_or(Path::new("")).display()
        ))
    })?;
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|error| fatal(format!("Failed To Start The Async Runtime: {error}")))?;
    // Installed before any startup work: a SIGTERM that arrives during
    // startup, or right after the "Listening On" line, is then held for
    // `serve` instead of killing the process with the signal's default
    // action. The handlers need the runtime's signal driver.
    let signals = {
        let _context = runtime.enter();
        shutdown_signal()
    };
    let startup = prepare(&args)?;
    runtime.block_on(serve(args, startup, signals))
}

/// A startup or runtime failure: the message printed to stderr and the
/// exit status.
struct Fatal {
    message: String,
    status: u8,
}

fn fatal(message: impl Into<String>) -> Fatal {
    Fatal {
        message: message.into(),
        status: 1,
    }
}

fn resolve_data_dir(data_dir: Option<PathBuf>) -> Result<PathBuf, Fatal> {
    match data_dir {
        Some(dir) => Ok(dir),
        None => cli::default_data_dir().map_err(|error| {
            fatal(format!(
                "Failed To Resolve The SWARM Data Directory: {error}"
            ))
        }),
    }
}

fn print_connect_url(args: &ConnectUrlArgs) -> ExitCode {
    let data_dir = match resolve_data_dir(args.data_dir.clone()) {
        Ok(dir) => dir,
        Err(fatal) => {
            eprintln!("{}", fatal.message);
            return ExitCode::FAILURE;
        }
    };
    match DaemonToken::load(&data_dir) {
        Ok(Some(token)) => {
            println!("{}", cli::connect_url(args.bind, &token));
            ExitCode::SUCCESS
        }
        Ok(None) => {
            eprintln!(
                "No Daemon Token In {} Yet. Start swarmd Once To Mint One.",
                data_dir.display()
            );
            ExitCode::FAILURE
        }
        Err(error) => {
            eprintln!("Failed To Read The Daemon Token: {error}");
            ExitCode::FAILURE
        }
    }
}

/// What the synchronous startup steps established.
struct Startup {
    data_dir: PathBuf,
    token: DaemonToken,
}

/// Startup steps 1-3 (see the crate doc), plus the `--serve-ui` bundle
/// check: blocking file work, run before the async runtime starts serving.
fn prepare(args: &ServeArgs) -> Result<Startup, Fatal> {
    let data_dir = resolve_data_dir(args.data_dir.clone())?;
    let loopback = args.bind.ip().to_canonical().is_loopback();

    create_private_dir(&data_dir).map_err(|error| {
        fatal(format!(
            "Failed To Create The SWARM Data Directory ({}): {error}",
            data_dir.display()
        ))
    })?;
    if let Err(error) = restrict_dir(&data_dir) {
        let message = format!(
            "Could Not Restrict The SWARM Data Directory ({}) To Its Owner: {error}",
            data_dir.display()
        );
        if !loopback {
            return Err(fatal(format!(
                "Refusing To Bind A Non-Loopback Address: {message}"
            )));
        }
        tracing::warn!("{message}");
    }

    // The gate runs BEFORE `load_or_create` can mint a token (see the crate
    // doc): a refused run must not create the file a second run would pass on.
    if !loopback && !DaemonToken::exists(&data_dir) {
        return Err(fatal(format!(
            "Refusing To Bind A Non-Loopback Address Without A Valid Daemon Token. Run `swarmd` Once \
             With The Default Loopback Bind First (It Mints The Token), Then Retry With --bind {}.",
            args.bind
        )));
    }
    let loaded = DaemonToken::load_or_create(&data_dir)
        .map_err(|error| fatal(format!("Failed To Establish The Daemon Token: {error}")))?;
    if let Err(error) = loaded.permissions {
        let message = format!(
            "Could Not Restrict The Daemon Token File To Its Owner: {error}. Fix Its \
             Permissions Or Delete It (A New Token Is Minted) Before Binding Non-Loopback."
        );
        if !loopback {
            return Err(fatal(format!(
                "Refusing To Bind A Non-Loopback Address: {message}"
            )));
        }
        tracing::warn!("{message}");
    }
    if loaded.minted {
        tracing::info!(data_dir = %data_dir.display(), "minted a new daemon token");
    }

    if let Some(dir) = &args.serve_ui {
        swarmd::serve_ui::check_bundle(dir).map_err(|error| {
            fatal(format!(
                "--serve-ui {}: No Web Bundle There ({error}). Build One With `pnpm build:web`.",
                dir.display()
            ))
        })?;
    }
    Ok(Startup {
        data_dir,
        token: loaded.token,
    })
}

/// Startup steps 4-5 (see the crate doc), then serves until a shutdown
/// signal and stops the runtime.
async fn serve(
    args: ServeArgs,
    Startup { data_dir, token }: Startup,
    signals: io::Result<impl Future<Output = &'static str> + Send + 'static>,
) -> Result<(), Fatal> {
    let listener = TcpListener::bind(args.bind).await.map_err(|error| {
        let hint = if error.kind() == io::ErrorKind::AddrInUse {
            " (Is Another swarmd Already Listening There?)"
        } else {
            ""
        };
        fatal(format!("Failed To Bind {}: {error}{hint}", args.bind))
    })?;
    let local_addr = listener
        .local_addr()
        .map_err(|error| fatal(format!("Failed To Read The Bound Address: {error}")))?;

    let config = RuntimeConfig {
        paths: Paths {
            data_dir: data_dir.clone(),
        },
        shell_name: "swarmd",
        bind: Some(local_addr.to_string()),
    };
    // No primary event consumer: there is no webview. Every client reads
    // the engine's broadcast fanout instead (see `swarmd::ws`).
    let runtime = tokio::task::spawn_blocking(move || Runtime::start(config, |_| {}))
        .await
        .map_err(|error| fatal(format!("Failed To Start The SWARM Runtime: {error}")))?
        .map_err(|error| match error {
            RuntimeStartError::Lock(error @ LockError::AlreadyRunning(_)) => Fatal {
                message: error.to_string(),
                status: EXIT_LOCKED,
            },
            RuntimeStartError::Lock(error) => fatal(error.to_string()),
            error => fatal(format!("Failed To Start The SWARM Runtime: {error}")),
        })?;

    let state = AppState::new(
        &runtime,
        token.clone(),
        HostPolicy::new(args.allow_hosts),
        Limits::default(),
    );
    announce(local_addr, &token, args.data_dir.as_deref());
    tracing::info!(bind = %local_addr, data_dir = %data_dir.display(), "swarmd started");

    match signals {
        Ok(signal) => {
            let shutdown = state.shutdown_token();
            tokio::spawn(async move {
                let signal = signal.await;
                tracing::info!(signal, "shutting down");
                shutdown.cancel();
            });
        }
        // Without signal handling the daemon still runs; a service
        // manager's stop then kills it without a graceful shutdown.
        Err(error) => tracing::error!(%error, "cannot listen for shutdown signals"),
    }

    let served = swarmd::serve(listener, state.clone(), args.serve_ui.as_deref()).await;
    stop_runtime(&state, runtime).await;
    served.map_err(|error| fatal(format!("Server Error: {error}")))?;
    tracing::info!("swarmd stopped");
    Ok(())
}

/// Logs to `log_file` (appended, never with color) or to stderr (colored
/// only on a terminal). `RUST_LOG` overrides [`DEFAULT_LOG_FILTER`].
fn init_tracing(log_file: Option<&Path>) -> io::Result<()> {
    use tracing_subscriber::EnvFilter;
    let filter =
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new(DEFAULT_LOG_FILTER));
    let subscriber = tracing_subscriber::fmt().with_env_filter(filter);
    match log_file {
        Some(path) => subscriber
            .with_ansi(false)
            .with_writer(Arc::new(open_log_file(path)?))
            .init(),
        None => subscriber
            .with_ansi(io::stderr().is_terminal())
            .with_writer(io::stderr)
            .init(),
    }
    Ok(())
}

/// Opens `path` for appending, creating it (private to the owner on Unix)
/// and its parent directories.
fn open_log_file(path: &Path) -> io::Result<File> {
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        std::fs::create_dir_all(parent)?;
    }
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

/// Creates the data directory (and missing parents) private to the owner.
fn create_private_dir(dir: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir)
    }
    #[cfg(not(unix))]
    {
        std::fs::create_dir_all(dir)
    }
}

/// Tightens an existing data directory to mode `0700`. On Windows the
/// default directory lives under the user's profile, which is already
/// private to them; the token file gets its own owner-only ACL.
fn restrict_dir(dir: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
    }
    #[cfg(not(unix))]
    {
        let _ = dir;
        Ok(())
    }
}

/// Prints the listening line: the tokenized connect URL on a terminal, and
/// otherwise the address plus the command that prints the URL.
fn announce(local_addr: SocketAddr, token: &DaemonToken, data_dir: Option<&Path>) {
    if io::stdout().is_terminal() {
        println!(
            "SWARM Daemon Listening On {}",
            cli::connect_url(local_addr, token)
        );
    } else {
        let mut command = String::from("swarmd connect-url");
        // Writing to a String cannot fail.
        if local_addr != cli::DEFAULT_BIND {
            let _ = write!(command, " --bind {local_addr}");
        }
        if let Some(dir) = data_dir {
            let _ = write!(command, " --data-dir \"{}\"", dir.display());
        }
        println!(
            "SWARM Daemon Listening On {} (Run `{command}` For The Connect URL)",
            cli::base_url(local_addr)
        );
    }
    if local_addr.ip().is_unspecified() {
        println!(
            "Listening On Every Interface: Remote Clients Connect Through This Machine's LAN Or \
             Tailnet Address, Which Is Accepted Automatically."
        );
    }
}

/// Installs the shutdown signal handlers. The returned future resolves on
/// the first shutdown request, including one delivered between installation
/// and the first poll, and names it.
fn shutdown_signal() -> io::Result<impl Future<Output = &'static str>> {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        let mut terminate = signal(SignalKind::terminate())?;
        let mut interrupt = signal(SignalKind::interrupt())?;
        Ok(async move {
            tokio::select! {
                _ = terminate.recv() => "SIGTERM",
                _ = interrupt.recv() => "SIGINT",
            }
        })
    }
    #[cfg(windows)]
    {
        use tokio::signal::windows;
        let mut ctrl_c = windows::ctrl_c()?;
        let mut close = windows::ctrl_close()?;
        let mut logoff = windows::ctrl_logoff()?;
        let mut shutdown = windows::ctrl_shutdown()?;
        Ok(async move {
            tokio::select! {
                _ = ctrl_c.recv() => "CTRL_C",
                _ = close.recv() => "CTRL_CLOSE",
                _ = logoff.recv() => "CTRL_LOGOFF",
                _ = shutdown.recv() => "CTRL_SHUTDOWN",
            }
        })
    }
}

/// Stops what the runtime started, after the server has stopped: the
/// metrics loop, then every worker (through `kill_worker`, so each agent
/// session shuts down and each worktree gets its usual disposition), then
/// waits for the event writer to persist everything recorded so far.
/// Dropping the runtime at the end releases the single-instance lock.
async fn stop_runtime(state: &AppState, runtime: Runtime) {
    runtime.metrics_cancel.cancel();

    let ctx = state.ctx();
    let workers = ctx.registry.list_workers();
    if !workers.is_empty() {
        tracing::info!(count = workers.len(), "stopping workers");
        let kills = workers.into_iter().map(|worker| async move {
            let args = serde_json::json!({ "id": worker.id.to_string() });
            if let Err(error) = state.registry().dispatch("kill_worker", ctx.clone(), args).await {
                tracing::warn!(worker_id = %worker.id, %error, "failed to stop a worker during shutdown");
            }
        });
        if tokio::time::timeout(STOP_WORKERS_TIMEOUT, futures_util::future::join_all(kills))
            .await
            .is_err()
        {
            tracing::warn!("workers still stopping after the shutdown timeout");
        }
    }

    // The writer handles events in order, so its acknowledgement of this
    // last one means everything recorded before it has been persisted.
    let timestamp = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_or(0, |elapsed| {
            i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX)
        });
    let flushed = ctx.sink.emit_awaiting_seq(
        SwarmEvent::SystemLog(SystemLogPayload {
            level: "info".to_owned(),
            message: "SWARM Daemon Stopped.".to_owned(),
            target: "swarmd".to_owned(),
            timestamp,
        }),
        Provenance::default(),
    );
    if tokio::time::timeout(FLUSH_TIMEOUT, flushed).await.is_err() {
        tracing::warn!("the event writer did not drain within the shutdown timeout");
    }
    drop(runtime);
}
