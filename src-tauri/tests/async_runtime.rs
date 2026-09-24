//! The desktop process runs one Tokio runtime. Its own test binary,
//! because Tauri's async runtime can be installed once per process.

/// Name of the thread the awaited task ran on.
async fn worker_thread_name() -> String {
    std::thread::current().name().unwrap_or_default().to_owned()
}

/// Tasks spawned through `tauri::async_runtime` (async commands, plugin
/// work) and through plain `tokio::spawn` from the entered context
/// (swarm-core's background loops, started from `setup`) land on the same
/// installed runtime, not on a second one Tauri would otherwise create.
#[test]
fn tauri_and_ambient_tasks_share_the_installed_runtime() {
    let runtime = swarm_desktop::install_async_runtime();
    let _context = runtime.enter();

    let tauri_task = tauri::async_runtime::spawn(worker_thread_name());
    let ambient_task = tokio::spawn(worker_thread_name());

    assert_eq!(
        tauri::async_runtime::block_on(tauri_task).unwrap(),
        "swarm-tokio"
    );
    assert_eq!(
        tauri::async_runtime::block_on(ambient_task).unwrap(),
        "swarm-tokio"
    );
}
