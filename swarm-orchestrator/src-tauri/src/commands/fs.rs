//! File system commands.
//!
//! Delegates to `tauri-plugin-fs` for filesystem operations.
//! The plugin provides scoped read/write access to the user's
//! filesystem through Tauri's permission system.
//!
//! Custom commands can be added here if the plugin's built-in
//! operations are insufficient. Currently, all filesystem
//! access is handled directly by the plugin.
