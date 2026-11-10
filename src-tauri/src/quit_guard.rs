//! Confirmation before a user's quit stops the workers.
//!
//! Closing the main window, the macOS app menu's Quit (Cmd+Q) and a
//! user-initiated exit (`RunEvent::ExitRequested` with no code, which
//! tauri-runtime-wry sends only after the last window is destroyed) are
//! held while the worker registry is not empty, and a native dialog asks
//! whether to quit.
//!
//! Tauri's default macOS menu ends its app submenu with a predefined Quit
//! item, which sends `terminate:` straight to `NSApp`; tao reports that
//! only as `RunEvent::Exit`, too late to hold. So on macOS [`app_menu`]
//! builds that default menu and swaps the predefined Quit for a plain item
//! with the same label and the CmdOrCtrl+Q accelerator, whose event
//! ([`on_menu_event`]) takes the same decision as a close and, when it
//! passes, exits through `AppHandle::exit(0)` and the cleanup hook. The
//! Dock's Quit, logout and shutdown still send `terminate:` to `NSApp`
//! directly (tao's app delegate implements no
//! `applicationShouldTerminate:`), so they are not guarded. Windows and
//! Linux get no app menu, as before.
//!
//! `Ctx.registry.count()` counts every registered worker, idle terminal
//! shells included, so the dialog says how many workers will be stopped,
//! never that agents are running. "Quit" exits with code 0, a programmatic
//! exit that passes the guard (as does the startup failure's exit 1 and a
//! restart, whose `ExitRequested` carries a code); "Keep Running" changes
//! nothing. Wired from the `App::run` callback and the builder's menu
//! hooks in [`crate::run`].

use std::sync::atomic::{AtomicBool, Ordering};

use swarm_core::commands::Ctx;
use tauri::menu::{MenuEvent, MenuId};
use tauri::{AppHandle, Manager, RunEvent, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use crate::MAIN_WINDOW;

/// The dialog's title.
const TITLE: &str = "Quit SWARM Orchestrator?";

/// Menu id of the guarded Quit item in the macOS app menu.
const QUIT_ITEM: &str = "swarm-quit";

/// A request to end the app.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum QuitRequest {
    /// The user asked to close the main window.
    CloseMain,
    /// The user chose the app menu's Quit (macOS: Cmd+Q).
    QuitItem,
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
            // The main window is the app: once its close (or the Quit
            // item) passes, the requests that follow must pass too, even
            // if a worker registers in between, or the app would ask with
            // no window.
            if matches!(request, QuitRequest::CloseMain | QuitRequest::QuitItem) {
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
        } if label == MAIN_WINDOW => {
            guard(app, QuitRequest::CloseMain, || api.prevent_close());
        }
        RunEvent::ExitRequested { code, api, .. } => {
            guard(app, QuitRequest::Exit { code: *code }, || {
                api.prevent_exit()
            });
        }
        _ => {}
    }
}

/// The request a menu item with `id` makes: only the guarded Quit item is
/// one.
fn quit_item_request(id: &MenuId) -> Option<QuitRequest> {
    (id == QUIT_ITEM).then_some(QuitRequest::QuitItem)
}

/// The builder's menu event handler: the app menu's Quit exits with code 0
/// once the guard lets it, which runs the cleanup hook like any other
/// exit. Every other menu event is left alone.
pub(crate) fn on_menu_event<R: tauri::Runtime>(app: &AppHandle<R>, event: &MenuEvent) {
    if let Some(request) = quit_item_request(event.id())
        && guard(app, request, || {})
    {
        app.exit(0);
    }
}

/// Tauri's default macOS menu with its predefined Quit, which ends the app
/// past the guard, swapped for a plain item that keeps its label and
/// CmdOrCtrl+Q and reaches [`on_menu_event`]. Every other item is the
/// default's own. The default's app submenu is its first item, with Quit
/// last.
#[cfg(target_os = "macos")]
pub(crate) fn app_menu<R: tauri::Runtime>(
    app: &AppHandle<R>,
) -> tauri::Result<tauri::menu::Menu<R>> {
    use tauri::menu::{Menu, MenuItem, MenuItemKind};

    let menu = Menu::default(app)?;
    if let Some(MenuItemKind::Submenu(app_submenu)) = menu.items()?.first()
        && let Some((position, label)) =
            app_submenu
                .items()?
                .iter()
                .enumerate()
                .rev()
                .find_map(|(position, item)| {
                    let label = item.as_predefined_menuitem()?.text().ok()?;
                    label.starts_with("Quit").then_some((position, label))
                })
    {
        app_submenu.remove_at(position)?;
        let quit = MenuItem::with_id(app, QUIT_ITEM, label, true, Some("CmdOrCtrl+Q"))?;
        app_submenu.insert(&quit, position)?;
    } else {
        tracing::warn!("the default app menu has no Quit item; Cmd+Q is not guarded");
    }
    Ok(menu)
}

/// Decides `request`, calling `prevent` unless it may proceed. Returns
/// whether it may.
fn guard<R: tauri::Runtime>(
    app: &AppHandle<R>,
    request: QuitRequest,
    prevent: impl FnOnce(),
) -> bool {
    let Some(state) = app.try_state::<QuitGuard>() else {
        return true;
    };
    // No `Ctx` when swarm-core did not start: there are no workers then.
    let workers = app.try_state::<Ctx>().map_or(0, |ctx| ctx.registry.count());
    match state.decide(request, workers) {
        Decision::Proceed => true,
        Decision::Hold => {
            prevent();
            false
        }
        Decision::Prompt { workers } => {
            prevent();
            confirm(app, workers);
            false
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

    /// The app menu's Quit (Cmd+Q on macOS) asks exactly as closing the
    /// main window does, and is held while the question is on screen.
    #[test]
    fn the_quit_item_is_guarded_like_a_close() {
        assert_eq!(
            QuitGuard::default().decide(QuitRequest::QuitItem, 0),
            Decision::Proceed
        );
        let guard = QuitGuard::default();
        assert_eq!(
            guard.decide(QuitRequest::QuitItem, 2),
            Decision::Prompt { workers: 2 }
        );
        assert_eq!(guard.decide(QuitRequest::QuitItem, 2), Decision::Hold);
        assert_eq!(guard.decide(QuitRequest::CloseMain, 2), Decision::Hold);
        guard.answer(false);
        assert_eq!(
            guard.decide(QuitRequest::QuitItem, 2),
            Decision::Prompt { workers: 2 }
        );
        guard.answer(true);
        assert_eq!(guard.decide(QuitRequest::QuitItem, 2), Decision::Proceed);
    }

    /// A Quit item that passes with no workers ends the app, so a close or
    /// exit request that follows passes even if a worker appeared in
    /// between.
    #[test]
    fn a_passed_quit_item_lets_what_follows_through() {
        let guard = QuitGuard::default();
        assert_eq!(guard.decide(QuitRequest::QuitItem, 0), Decision::Proceed);
        assert_eq!(guard.decide(QuitRequest::CloseMain, 1), Decision::Proceed);
        assert_eq!(guard.decide(USER_EXIT, 1), Decision::Proceed);
    }

    /// Only the app menu's own Quit item is guarded; any other menu id
    /// passes untouched.
    #[test]
    fn only_the_quit_item_id_is_a_quit_request() {
        assert_eq!(
            quit_item_request(&MenuId::new(QUIT_ITEM)),
            Some(QuitRequest::QuitItem)
        );
        assert_eq!(quit_item_request(&MenuId::new("other")), None);
    }
}
