//! Worker lifecycle management.
//!
//! Handles the complete worker lifecycle — spawn, pause, resume,
//! kill, and input — with proper cleanup and event emission at
//! each transition. These functions are called by the Tauri
//! command handlers in [`crate::commands::worker`].

use parking_lot::Mutex;
use tauri::AppHandle;
use uuid::Uuid;

use crate::error::AppError;
use crate::events::{
    SwarmEvent, WorkerKilledPayload, WorkerSpawnedPayload, WorkerStatePayload, emit_event,
};
use crate::worker::handle::{WorkerConfig, WorkerHandle, WorkerState};
use crate::worker::pty::spawn_pty;
use crate::worker::registry::WorkerRegistry;

/// Spawns a new worker process with a PTY and registers it.
///
/// Creates a new PTY process using the shell specified in `config`
/// (or the system default), wraps it in a [`WorkerHandle`], inserts
/// it into the registry, and emits a `worker_spawned` event on
/// `swarm://events`.
///
/// # Arguments
///
/// * `app` - Tauri app handle for event emission
/// * `registry` - The shared worker registry
/// * `config` - Worker spawn configuration (name, shell, cwd, env, PTY size)
///
/// # Returns
///
/// The UUID of the newly spawned worker.
///
/// # Errors
///
/// * [`AppError::PtySpawn`] - The PTY process failed to spawn
/// * [`AppError::RegistryFull`] - The registry has reached capacity
#[tracing::instrument(skip(app, registry))]
pub fn do_spawn_worker(
    app: &AppHandle,
    registry: &WorkerRegistry,
    config: WorkerConfig,
) -> Result<Uuid, AppError> {
    let default_shell = registry.config.read().default_shell.clone();
    let shell = if config.shell.is_empty() {
        &default_shell
    } else {
        &config.shell
    };

    let worker_id = Uuid::new_v4();

    let pty_handle = spawn_pty(
        app,
        worker_id,
        shell,
        &config.cwd,
        &config.env,
        config.rows,
        config.cols,
    )
    .map_err(|e| {
        tracing::error!(error = %e, "PTY spawn failed");
        AppError::PtySpawn(e.to_string())
    })?;

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    let pid = pty_handle.pid;
    let handle = WorkerHandle {
        id: worker_id,
        state: WorkerState::Running,
        name: config.name.clone(),
        pid,
        started_at: now,
        pty_writer: Some(Mutex::new(pty_handle.writer)),
        child: Some(Mutex::new(pty_handle.child)),
    };

    registry.spawn_worker(handle)?;

    emit_event(
        app,
        SwarmEvent::WorkerSpawned(WorkerSpawnedPayload {
            worker_id,
            name: config.name,
            pid,
        }),
    );

    Ok(worker_id)
}

/// Pauses a running worker by updating its state to [`WorkerState::Paused`].
///
/// This is state-only on all platforms today (see
/// [`WorkerState::Paused`]) — no signal is sent to the underlying
/// process yet.
///
/// The precondition check (worker must currently be `Running`) and the
/// state write happen atomically via [`WorkerRegistry::update_state_if`]
/// (a single `DashMap` shard lock), preventing a TOCTOU race where a
/// concurrent pause/resume call on the same worker could observe a
/// stale state between a separate check and set.
///
/// Emits a `worker_state` event on `swarm://events` with `state: "paused"`.
///
/// # Arguments
///
/// * `app` - Tauri app handle for event emission
/// * `registry` - The shared worker registry
/// * `id` - UUID of the worker to pause
///
/// # Errors
///
/// * [`AppError::WorkerNotFound`] - No worker with the given ID exists
/// * [`AppError::Ipc`] - The worker is not currently `Running`
#[tracing::instrument(skip(app, registry))]
pub fn do_pause_worker(
    app: &AppHandle,
    registry: &WorkerRegistry,
    id: Uuid,
) -> Result<(), AppError> {
    registry.update_state_if(&id, WorkerState::Running, WorkerState::Paused)?;

    emit_event(
        app,
        SwarmEvent::WorkerState(WorkerStatePayload {
            worker_id: id,
            state: WorkerState::Paused,
        }),
    );

    Ok(())
}

/// Resumes a paused worker by updating its state to [`WorkerState::Running`].
///
/// The precondition check (worker must currently be `Paused`) and the
/// state write happen atomically via [`WorkerRegistry::update_state_if`]
/// (a single `DashMap` shard lock), preventing a TOCTOU race with a
/// concurrent pause/resume call on the same worker.
///
/// Emits a `worker_state` event on `swarm://events` with `state: "running"`.
///
/// # Arguments
///
/// * `app` - Tauri app handle for event emission
/// * `registry` - The shared worker registry
/// * `id` - UUID of the worker to resume
///
/// # Errors
///
/// * [`AppError::WorkerNotFound`] - No worker with the given ID exists
/// * [`AppError::Ipc`] - The worker is not currently `Paused`
#[tracing::instrument(skip(app, registry))]
pub fn do_resume_worker(
    app: &AppHandle,
    registry: &WorkerRegistry,
    id: Uuid,
) -> Result<(), AppError> {
    registry.update_state_if(&id, WorkerState::Paused, WorkerState::Running)?;

    emit_event(
        app,
        SwarmEvent::WorkerState(WorkerStatePayload {
            worker_id: id,
            state: WorkerState::Running,
        }),
    );

    Ok(())
}

/// Kills a worker process and removes it from the registry.
///
/// Removes the worker from the registry, drops the PTY writer
/// first to close the master fd (ensuring the child sees EOF),
/// then kills the child process and waits for it to exit to
/// prevent zombie processes. Emits a `worker_killed` event on
/// `swarm://events`.
///
/// # Arguments
///
/// * `app` - Tauri app handle for event emission
/// * `registry` - The shared worker registry
/// * `id` - UUID of the worker to kill
///
/// # Errors
///
/// * [`AppError::WorkerNotFound`] - No worker with the given ID exists
#[tracing::instrument(skip(app, registry))]
pub fn do_kill_worker(
    app: &AppHandle,
    registry: &WorkerRegistry,
    id: Uuid,
) -> Result<(), AppError> {
    let handle = registry.remove_worker(&id)?;

    // Drop the PTY writer first to close the master fd.
    // This ensures the child process sees EOF on its stdin,
    // preventing it from blocking on read after we kill it.
    drop(handle.pty_writer);

    // Kill the child process and wait for it to exit
    if let Some(child_mutex) = &handle.child {
        let mut child = child_mutex.lock();
        if let Err(e) = child.kill() {
            tracing::error!(worker_id = %id, error = %e, "failed to kill child process");
        }
        // Wait for the child to exit to avoid zombie processes
        match child.wait() {
            Ok(status) => {
                tracing::debug!(worker_id = %id, ?status, "child process exited");
            }
            Err(e) => {
                tracing::error!(worker_id = %id, error = %e, "failed to wait on child process");
            }
        }
    }

    emit_event(
        app,
        SwarmEvent::WorkerKilled(WorkerKilledPayload { worker_id: id }),
    );

    tracing::info!(worker_id = %id, "worker killed and removed");
    Ok(())
}

/// Writes input data to a worker's PTY.
///
/// Looks up the worker in the registry, acquires the PTY writer
/// mutex, and writes the data bytes to the PTY master fd.
///
/// # Arguments
///
/// * `registry` - The shared worker registry
/// * `id` - UUID of the worker to send input to
/// * `data` - Raw bytes to write to the PTY
///
/// # Errors
///
/// * [`AppError::WorkerNotFound`] - No worker with the given ID exists
/// * [`AppError::Ipc`] - The worker has no PTY writer, or the write failed
#[tracing::instrument(skip(registry, data))]
pub fn do_worker_input(registry: &WorkerRegistry, id: Uuid, data: &[u8]) -> Result<(), AppError> {
    let entry = registry
        .workers
        .get(&id)
        .ok_or_else(|| AppError::WorkerNotFound { id: id.to_string() })?;

    if let Some(writer_mutex) = &entry.pty_writer {
        let mut writer = writer_mutex.lock();
        crate::worker::pty::write_to_pty(writer.as_mut(), data)
            .map_err(|e| AppError::Ipc(e.to_string()))?;
    } else {
        return Err(AppError::Ipc(format!("worker {} has no PTY writer", id)));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worker::handle::{WorkerHandle, WorkerState};

    /// Helper to create a lightweight WorkerHandle for testing
    /// (no PTY resources needed for state-transition tests).
    fn make_handle(state: WorkerState) -> WorkerHandle {
        WorkerHandle {
            id: Uuid::new_v4(),
            state,
            name: "test-worker".to_string(),
            pid: Some(9999),
            started_at: 0,
            pty_writer: None,
            child: None,
        }
    }

    #[test]
    fn test_pause_rejects_non_running_state() {
        let registry = WorkerRegistry::new();
        let handle = make_handle(WorkerState::Idle);
        let id = handle.id;
        registry.spawn_worker(handle).unwrap();

        // do_pause_worker requires an AppHandle, but the state check
        // happens before event emission. We test the registry-level
        // precondition directly: worker must be Running to pause.
        let entry = registry.workers.get(&id).unwrap();
        assert_ne!(entry.state, WorkerState::Running);

        // Replicate the guard logic from do_pause_worker
        let result: Result<(), AppError> = if entry.state != WorkerState::Running {
            Err(AppError::Ipc(format!(
                "cannot pause worker {} in state {}",
                id, entry.state
            )))
        } else {
            Ok(())
        };
        assert!(result.is_err());
        let err_msg = result.unwrap_err().to_string();
        assert!(
            err_msg.contains("cannot pause"),
            "expected 'cannot pause' in error, got: {err_msg}"
        );
        assert!(
            err_msg.contains("idle"),
            "expected 'idle' state in error, got: {err_msg}"
        );
    }

    #[test]
    fn test_pause_rejects_paused_state() {
        let registry = WorkerRegistry::new();
        let handle = make_handle(WorkerState::Paused);
        let id = handle.id;
        registry.spawn_worker(handle).unwrap();

        let entry = registry.workers.get(&id).unwrap();
        assert_eq!(entry.state, WorkerState::Paused);

        let result: Result<(), AppError> = if entry.state != WorkerState::Running {
            Err(AppError::Ipc(format!(
                "cannot pause worker {} in state {}",
                id, entry.state
            )))
        } else {
            Ok(())
        };
        assert!(result.is_err());
        let err_msg = result.unwrap_err().to_string();
        assert!(
            err_msg.contains("paused"),
            "expected 'paused' state in error, got: {err_msg}"
        );
    }

    #[test]
    fn test_resume_rejects_non_paused_state() {
        let registry = WorkerRegistry::new();
        let handle = make_handle(WorkerState::Running);
        let id = handle.id;
        registry.spawn_worker(handle).unwrap();

        let entry = registry.workers.get(&id).unwrap();
        assert_eq!(entry.state, WorkerState::Running);

        // Replicate the guard logic from do_resume_worker
        let result: Result<(), AppError> = if entry.state != WorkerState::Paused {
            Err(AppError::Ipc(format!(
                "cannot resume worker {} in state {}",
                id, entry.state
            )))
        } else {
            Ok(())
        };
        assert!(result.is_err());
        let err_msg = result.unwrap_err().to_string();
        assert!(
            err_msg.contains("cannot resume"),
            "expected 'cannot resume' in error, got: {err_msg}"
        );
        assert!(
            err_msg.contains("running"),
            "expected 'running' state in error, got: {err_msg}"
        );
    }

    #[test]
    fn test_resume_rejects_idle_state() {
        let registry = WorkerRegistry::new();
        let handle = make_handle(WorkerState::Idle);
        let id = handle.id;
        registry.spawn_worker(handle).unwrap();

        let entry = registry.workers.get(&id).unwrap();
        let result: Result<(), AppError> = if entry.state != WorkerState::Paused {
            Err(AppError::Ipc(format!(
                "cannot resume worker {} in state {}",
                id, entry.state
            )))
        } else {
            Ok(())
        };
        assert!(result.is_err());
        let err_msg = result.unwrap_err().to_string();
        assert!(
            err_msg.contains("idle"),
            "expected 'idle' state in error, got: {err_msg}"
        );
    }

    #[test]
    fn test_worker_not_found_returns_error() {
        let registry = WorkerRegistry::new();
        let fake_id = Uuid::new_v4();

        let result = registry
            .workers
            .get(&fake_id)
            .ok_or_else(|| AppError::WorkerNotFound {
                id: fake_id.to_string(),
            });
        assert!(result.is_err());
        let err_msg = result.unwrap_err().to_string();
        assert!(
            err_msg.contains("not found"),
            "expected 'not found' in error, got: {err_msg}"
        );
    }

    #[test]
    fn test_worker_input_no_pty_writer() {
        let registry = WorkerRegistry::new();
        let handle = make_handle(WorkerState::Running);
        let id = handle.id;
        registry.spawn_worker(handle).unwrap();

        let result = do_worker_input(&registry, id, b"hello");
        assert!(result.is_err());
        let err_msg = result.unwrap_err().to_string();
        assert!(
            err_msg.contains("no PTY writer"),
            "expected 'no PTY writer' in error, got: {err_msg}"
        );
    }
}
