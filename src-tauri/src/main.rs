// Release builds are GUI-subsystem executables on Windows, so launching
// the app opens no console window next to it.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/// SWARM Orchestrator's entry point; everything happens in
/// [`swarm_desktop::run`].
///
/// Launch the app with `pnpm tauri:dev`, which starts the Vite dev server
/// the debug build loads its UI from, or run `cargo run -p swarm-desktop`
/// while `pnpm dev` is already serving.
fn main() {
    swarm_desktop::run();
}
