//! Starting swarm-core inside the app's `setup` hook.
//!
//! The main window is created hidden (`"visible": false` in
//! tauri.conf.json), so the webview loads the UI while the runtime starts,
//! and [`boot`] shows it once swarm-core is running and its state is
//! registered. When the start fails, the window is shown as the parent of
//! the error dialog instead: [`setup`] never returns an error to Tauri,
//! which would turn it into a "Failed to setup app" panic with no
//! explanation for the user.

use std::path::PathBuf;

use swarm_core::Paths;
use swarm_core::commands::{Ctx, Registry};
use swarm_core::orchestration::EVENT_CHANNEL;
use swarm_core::runtime::{Runtime, RuntimeConfig, RuntimeStartError};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

/// Label of the window tauri.conf.json declares.
const MAIN_WINDOW: &str = "main";

/// Why SWARM Orchestrator could not start. `Display` is the Title Case
/// text the startup dialog shows.
#[derive(Debug, thiserror::Error)]
pub(crate) enum StartupError {
    /// The app data directory could not be resolved or created.
    #[error("Failed To Open The App Data Directory: {0}")]
    DataDir(String),
    /// swarm-core did not start. Its `Display` already reads as a
    /// sentence, e.g. "SWARM Is Already Running …" when another desktop
    /// instance or `swarmd` holds the data directory.
    #[error(transparent)]
    Runtime(#[from] RuntimeStartError),
    /// The started app's main window could not be shown.
    #[error("Failed To Show The Main Window: {0}")]
    Window(#[from] tauri::Error),
}

/// The app's `setup` hook: starts swarm-core against the app data
/// directory, or reports why it could not in a dialog.
pub(crate) fn setup<R: tauri::Runtime>(app: &AppHandle<R>) {
    start_or_report(app, data_dir(app), report_with_dialog);
}

/// Boots from `data_dir` and hands any failure to `report`, never to the
/// caller, together with the main window once it is shown: the report's
/// dialog needs a visible parent (see [`report_with_dialog`]).
fn start_or_report<R: tauri::Runtime>(
    app: &AppHandle<R>,
    data_dir: Result<PathBuf, StartupError>,
    report: impl FnOnce(&AppHandle<R>, Option<&WebviewWindow<R>>, StartupError),
) {
    if let Err(error) = data_dir.and_then(|data_dir| boot(app, data_dir)) {
        let parent = app
            .get_webview_window(MAIN_WINDOW)
            .filter(|window| match window.show() {
                Ok(()) => true,
                Err(show_error) => {
                    tracing::warn!(%show_error, "failed to show the main window for the startup error");
                    false
                }
            });
        report(app, parent.as_ref(), error);
    }
}

/// Resolves the app data directory, creating it on first launch.
fn data_dir<R: tauri::Runtime>(app: &AppHandle<R>) -> Result<PathBuf, StartupError> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| StartupError::DataDir(e.to_string()))?;
    std::fs::create_dir_all(&dir).map_err(|e| StartupError::DataDir(e.to_string()))?;
    Ok(dir)
}

/// Starts swarm-core against `data_dir`, registers [`Runtime`], [`Ctx`] and
/// [`Registry`] as managed state for the command handlers, and shows the
/// main window.
///
/// Every event the runtime records is emitted to the webview on
/// [`EVENT_CHANNEL`] from the event writer thread, synchronously and in
/// seq order: a slow webview backs up the writer's queue instead of
/// losing events, which matters because ephemeral events (terminal
/// output, metrics) are never persisted and cannot be replayed.
///
/// # Errors
///
/// [`StartupError::Runtime`] when another process holds the data directory
/// or the event log cannot be opened; nothing is registered then.
/// [`StartupError::Window`] when the main window cannot be shown.
fn boot<R: tauri::Runtime>(app: &AppHandle<R>, data_dir: PathBuf) -> Result<(), StartupError> {
    let emitter = app.clone();
    let runtime = Runtime::start(
        RuntimeConfig {
            paths: Paths { data_dir },
            shell_name: "swarm-desktop",
            bind: None,
        },
        move |event| {
            if let Err(error) = emitter.emit(EVENT_CHANNEL, event) {
                tracing::error!(%error, seq = event.seq, "failed to emit a domain event");
            }
        },
    )?;

    app.manage(Ctx::from_runtime(&runtime));
    app.manage(Registry::new());
    // Managed for the app's lifetime: the runtime holds the data
    // directory's single-instance lock until the process exits, and
    // `lifecycle` shuts it down from the managed copy.
    app.manage(runtime);

    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        window.show()?;
    }
    tracing::info!("SWARM Orchestrator started");
    Ok(())
}

/// Shows `error` in a native dialog over `parent` and exits with status 1
/// once the user dismisses it.
///
/// `setup` runs on the main thread, inside the event loop, so the dialog
/// must not block: `blocking_show` would wait for a dialog the blocked
/// event loop can never complete (on macOS the dialog is a sheet driven
/// by the main run loop), and a second launch would hang instead of
/// explaining itself. `show` returns at once and the exit happens in its
/// callback.
///
/// The parent must be visible. On macOS, rfd attaches a dialog without a
/// parent to the app's main or first window as a sheet, and would pick
/// the hidden main window: the sheet would never appear, and the process
/// would linger invisibly instead of exiting. The message is also
/// written to stderr and the log, for launches from a terminal.
fn report_with_dialog<R: tauri::Runtime>(
    app: &AppHandle<R>,
    parent: Option<&WebviewWindow<R>>,
    error: StartupError,
) {
    tracing::error!(%error, "SWARM Orchestrator failed to start");
    eprintln!("{error}");
    let mut dialog = app
        .dialog()
        .message(error.to_string())
        .title("SWARM Orchestrator")
        .kind(MessageDialogKind::Error);
    if let Some(parent) = parent {
        dialog = dialog.parent(parent);
    }
    let exit = app.clone();
    dialog.show(move |_| exit.exit(1));
}

#[cfg(test)]
mod tests {
    use std::assert_matches;

    use swarm_core::lock::SingleInstanceLock;
    use tauri::test::{MockRuntime, mock_builder, mock_context, noop_assets};
    use tauri::{WebviewUrl, WebviewWindowBuilder};

    use super::*;
    use crate::test_support::temp_dir;

    fn mock_app() -> tauri::App<MockRuntime> {
        mock_builder().build(mock_context(noop_assets())).unwrap()
    }

    /// A data directory another process holds (the second-launch case)
    /// reaches the reporter as the "Already Running" error, the hook
    /// returns instead of blocking or exiting, and no half-started state
    /// is left behind for the command handlers.
    #[test]
    fn a_held_data_directory_is_reported_and_setup_returns() {
        let tokio = tokio::runtime::Runtime::new().unwrap();
        let _tokio = tokio.enter();
        let dir = temp_dir("startup-held");
        let _held =
            SingleInstanceLock::acquire(&dir, "swarmd", Some("127.0.0.1:0".into())).unwrap();
        let app = mock_app();
        let mut reported = None;

        start_or_report(app.handle(), Ok(dir.to_path_buf()), |_, _, error| {
            reported = Some(error);
        });

        let error = reported.expect("the failure reached the reporter");
        assert_matches!(error, StartupError::Runtime(RuntimeStartError::Lock(_)));
        assert!(
            error.to_string().starts_with("SWARM Is Already Running"),
            "{error}"
        );
        assert!(app.try_state::<Ctx>().is_none());
        assert!(app.try_state::<Registry>().is_none());
        assert!(app.try_state::<Runtime>().is_none());
    }

    /// A data directory that cannot be resolved is reported the same way,
    /// before anything is started.
    #[test]
    fn an_unresolvable_data_directory_is_reported() {
        let app = mock_app();
        let mut reported = None;

        start_or_report(
            app.handle(),
            Err(StartupError::DataDir("no home directory".into())),
            |_, _, error| reported = Some(error.to_string()),
        );

        assert_eq!(
            reported.as_deref(),
            Some("Failed To Open The App Data Directory: no home directory")
        );
        assert!(app.try_state::<Runtime>().is_none());
    }

    /// A failed start hands the reporter the main window, shown, as the
    /// dialog's parent, so the dialog is never attached to a hidden window.
    #[test]
    fn a_failed_start_reports_over_the_shown_main_window() {
        let app = mock_app();
        WebviewWindowBuilder::new(&app, MAIN_WINDOW, WebviewUrl::default())
            .visible(false)
            .build()
            .unwrap();
        let mut parent = None;

        start_or_report(
            app.handle(),
            Err(StartupError::DataDir("no home directory".into())),
            |_, window, _| parent = window.map(|window| window.label().to_owned()),
        );

        assert_eq!(parent.as_deref(), Some(MAIN_WINDOW));
    }

    /// A free data directory boots and registers the handlers' state.
    #[test]
    fn a_free_data_directory_boots() {
        let tokio = tokio::runtime::Runtime::new().unwrap();
        let _tokio = tokio.enter();
        let dir = temp_dir("startup-free");
        let app = mock_app();

        start_or_report(app.handle(), Ok(dir.to_path_buf()), |_, _, error| {
            panic!("{error}")
        });

        assert!(app.try_state::<Ctx>().is_some());
        assert!(app.try_state::<Registry>().is_some());
        assert!(app.try_state::<Runtime>().is_some());
    }
}
