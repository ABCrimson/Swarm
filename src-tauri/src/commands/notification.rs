//! OS notification Tauri IPC command.
//!
//! NATIVE_ONLY (see `swarm_core::commands::NATIVE_ONLY`): needs
//! `tauri-plugin-notification`, which has no meaning over a network RPC
//! call, so this has no registry entry.
//!
//! Provides a `send_notification` command that uses `tauri-plugin-notification`
//! to display native OS notifications from the frontend.

use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;

/// Sends a native OS notification.
///
/// Uses `tauri-plugin-notification` to display a system notification
/// with the specified title, body, and optional icon.
///
/// # Arguments
///
/// * `app` - Tauri app handle (injected by Tauri)
/// * `title` - Notification title (required)
/// * `body` - Notification body text (required)
/// * `icon` - Optional path to a notification icon
///
/// # Errors
///
/// Returns a `String` error if the notification fails to send.
#[tauri::command]
#[tracing::instrument(skip(app))]
pub async fn send_notification(
    app: AppHandle,
    title: String,
    body: String,
    icon: Option<String>,
) -> Result<(), String> {
    tracing::info!(title = %title, "send_notification called");

    let mut builder = app.notification().builder();
    builder = builder.title(&title).body(&body);

    if let Some(ref icon_path) = icon {
        builder = builder.icon(icon_path);
    }

    builder.show().map_err(|e| {
        tracing::error!(error = %e, "failed to send notification");
        e.to_string()
    })?;

    tracing::debug!("notification sent successfully");
    Ok(())
}
