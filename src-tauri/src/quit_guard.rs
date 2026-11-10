//! Confirmation before a user's quit stops the workers.
//!
//! Closing the main window and a user-initiated exit
//! (`RunEvent::ExitRequested` with no code: the last window closed, or the
//! OS's quit command) are held while the worker registry is not empty,
//! and a native dialog asks whether to quit. `Ctx.registry.count()`
//! counts every registered worker, idle terminal shells included, so the
//! dialog says how many workers will be stopped, never that agents are
//! running. "Quit" exits with code 0, a programmatic exit that passes
//! the guard (as does the startup failure's exit 1 and a restart, whose
//! `ExitRequested` carries a code); "Keep Running" changes nothing.
//! Wired from the `App::run` callback in [`crate::run`].

use std::sync::atomic::{AtomicBool, Ordering};

use swarm_core::commands::Ctx;
use tauri::{AppHandle, Manager, RunEvent, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use crate::MAIN_WINDOW;

/// The dialog's title.
const TITLE: &str = "Quit SWARM Orchestrator?";

/// A request to end the app.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum QuitRequest {
    /// The user asked to close the main window.
    CloseMain,
    /// The event loop is about to exit: `code` is `None` when the user
    /// asked, `Some` for `AppHandle::exit` and `restart`.
    Exit { code: Option<i32> },
}

/// What to do with a [`QuitRequest`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Decision {
    /// Let it happen.
    Proceed,
    /// Prevent it and ask, naming how many workers would be stopped.
    Prompt { workers: usize },
    /// Prevent it: the question is already on screen.
    Hold,
}

/// Managed state: whether the user has confirmed the quit, and whether
/// the question is on screen.
#[derive(Debug, Default)]
pub(crate) struct QuitGuard {
    quitting: AtomicBool,
    prompting: AtomicBool,
}

impl QuitGuard {
    /// Decides `request` with `workers` registered.
    pub(crate) fn decide(&self, request: QuitRequest, workers: usize) -> Decision {
        if matches!(request, QuitRequest::Exit { code: Some(_) })
            || self.quitting.load(Ordering::Acquire)
        {
            return Decision::Proceed;
        }
        if workers == 0 {
            // The main window is the app: once its close passes, the
            // exit request that follows must pass too, even if a worker
            // registers in between, or the app would ask with no window.
            if request == QuitRequest::CloseMain {
                self.quitting.store(true, Ordering::Release);
            }
            return Decision::Proceed;
        }
        if self.prompting.swap(true, Ordering::AcqRel) {
            return Decision::Hold;
        }
        Decision::Prompt { workers }
    }

    /// Records the user's answer: `quit` lets every later request through.
    pub(crate) fn answer(&self, quit: bool) {
        if quit {
            self.quitting.store(true, Ordering::Release);
        }
        self.prompting.store(false, Ordering::Release);
    }
}

/// The dialog's message for `workers` registered workers.
pub(crate) fn body(workers: usize) -> String {
    match workers {
        1 => "1 Worker Will Be Stopped".to_owned(),
        n => format!("{n} Workers Will Be Stopped"),
    }
}

/// The `App::run` callback's part: guards a close of the main window and
/// every exit request.
pub(crate) fn on_run_event<R: tauri::Runtime>(app: &AppHandle<R>, event: &RunEvent) {
    match event {
        RunEvent::WindowEvent {
            label,
            event: WindowEvent::CloseRequested { api, .. },
            ..
        } if label == MAIN_WINDOW => guard(app, QuitRequest::CloseMain, || api.prevent_close()),
        RunEvent::ExitRequested { code, api, .. } => {
            guard(app, QuitRequest::Exit { code: *code }, || {
                api.prevent_exit()
            });
        }
        _ => {}
    }
}

/// Decides `request`, calling `prevent` unless it may proceed.
fn guard<R: tauri::Runtime>(app: &AppHandle<R>, request: QuitRequest, prevent: impl FnOnce()) {
    let Some(state) = app.try_state::<QuitGuard>() else {
        return;
    };
    // No `Ctx` when swarm-core did not start: there are no workers then.
    let workers = app.try_state::<Ctx>().map_or(0, |ctx| ctx.registry.count());
    match state.decide(request, workers) {
        Decision::Proceed => {}
        Decision::Hold => prevent(),
        Decision::Prompt { workers } => {
            prevent();
            confirm(app, workers);
        }
    }
}

/// Asks whether to quit, over the main window. The dialog does not block
/// the event loop; the answer arrives in its callback.
fn confirm<R: tauri::Runtime>(app: &AppHandle<R>, workers: usize) {
    let mut dialog = app
        .dialog()
        .message(body(workers))
        .title(TITLE)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Quit".to_owned(),
            "Keep Running".to_owned(),
        ));
    if let Some(main) = app.get_webview_window(MAIN_WINDOW) {
        dialog = dialog.parent(&main);
    }
    let app = app.clone();
    dialog.show(move |quit| {
        if let Some(state) = app.try_state::<QuitGuard>() {
            state.answer(quit);
        }
        if quit {
            app.exit(0);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    const USER_EXIT: QuitRequest = QuitRequest::Exit { code: None };

    #[test]
    fn no_workers_never_prompts() {
        let guard = QuitGuard::default();
        assert_eq!(guard.decide(QuitRequest::CloseMain, 0), Decision::Proceed);
        assert_eq!(QuitGuard::default().decide(USER_EXIT, 0), Decision::Proceed);
    }

    #[test]
    fn workers_prompt_with_their_count() {
        let guard = QuitGuard::default();
        assert_eq!(
            guard.decide(QuitRequest::CloseMain, 3),
            Decision::Prompt { workers: 3 }
        );
        assert_eq!(body(3), "3 Workers Will Be Stopped");
        assert_eq!(body(1), "1 Worker Will Be Stopped");
        assert_eq!(
            QuitGuard::default().decide(USER_EXIT, 2),
            Decision::Prompt { workers: 2 }
        );
    }

    /// `AppHandle::exit` (the startup failure's exit(1), the confirmed
    /// quit's exit(0)) and `restart` carry a code and are never prompted.
    #[test]
    fn a_programmatic_exit_never_prompts() {
        let guard = QuitGuard::default();
        for code in [0, 1, tauri::RESTART_EXIT_CODE] {
            assert_eq!(
                guard.decide(QuitRequest::Exit { code: Some(code) }, 5),
                Decision::Proceed
            );
        }
    }

    #[test]
    fn after_quit_the_second_request_passes() {
        let guard = QuitGuard::default();
        assert_eq!(
            guard.decide(QuitRequest::CloseMain, 2),
            Decision::Prompt { workers: 2 }
        );
        guard.answer(true);
        assert_eq!(guard.decide(QuitRequest::CloseMain, 2), Decision::Proceed);
        assert_eq!(guard.decide(USER_EXIT, 2), Decision::Proceed);
    }

    /// "Keep Running" leaves the guard as it was: the next request asks
    /// again.
    #[test]
    fn keep_running_asks_again_next_time() {
        let guard = QuitGuard::default();
        guard.decide(QuitRequest::CloseMain, 2);
        guard.answer(false);
        assert_eq!(
            guard.decide(QuitRequest::CloseMain, 2),
            Decision::Prompt { workers: 2 }
        );
    }

    /// A request while the question is on screen is held without a second
    /// dialog.
    #[test]
    fn a_request_during_the_prompt_is_held() {
        let guard = QuitGuard::default();
        guard.decide(QuitRequest::CloseMain, 2);
        assert_eq!(guard.decide(USER_EXIT, 2), Decision::Hold);
    }

    /// Closing the main window with no workers quits the app, so the exit
    /// request that follows passes even if a worker appeared in between.
    #[test]
    fn a_passed_close_lets_the_following_exit_through() {
        let guard = QuitGuard::default();
        assert_eq!(guard.decide(QuitRequest::CloseMain, 0), Decision::Proceed);
        assert_eq!(guard.decide(USER_EXIT, 1), Decision::Proceed);
    }
}
