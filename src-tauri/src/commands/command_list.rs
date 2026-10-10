// The app's command names, the single source of truth for two consumers:
// `commands::commands!` (which declares one forwarder per name) and
// `build.rs` (which hands the same names to `AppManifest::commands`, so
// each one gets an `allow-<name>` / `deny-<name>` permission). Both
// `include!` this file, so a command cannot exist without its ACL entry.
//
// `command_list!(callback)` calls `callback! { registry: [...], native:
// [...] }`. The registry list is `swarm_core::commands::Registry`'s keys,
// the native list is `swarm_core::commands::NATIVE_ONLY`; the contract
// tests in `commands::tests` pin both.
macro_rules! command_list {
    ($callback:ident) => {
        $callback! {
            registry: [
                // Workers
                spawn_worker,
                pause_worker,
                resume_worker,
                kill_worker,
                list_workers,
                worker_input,
                resize_worker,
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
    };
}
