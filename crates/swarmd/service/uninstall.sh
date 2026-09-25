#!/usr/bin/env sh
# Removes the per-user service installed by install.sh, stopping the daemon.
# Leaves the binary in place unless --purge-binary is given ($SWARMD_BIN_DEST
# names it, as for install.sh). Never touches your SWARM data directory or
# event log.
set -eu

BIN_DEST="${SWARMD_BIN_DEST:-$HOME/.local/bin/swarmd}"
LABEL=dev.crimson.swarmd

purge_binary=0
case "${1:-}" in
    '') ;;
    --purge-binary) purge_binary=1 ;;
    *) printf 'usage: %s [--purge-binary]\n' "$0" >&2; exit 2 ;;
esac

uninstall_linux() {
    unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
    if command -v systemctl >/dev/null 2>&1; then
        systemctl --user disable --now swarmd.service 2>/dev/null || true
    fi
    rm -f -- "$unit_dir/swarmd.service" "$unit_dir/swarmd.service.d/install.conf"
    rmdir -- "$unit_dir/swarmd.service.d" 2>/dev/null || true
    if command -v systemctl >/dev/null 2>&1; then
        systemctl --user daemon-reload 2>/dev/null || true
    fi
    echo "Removed the systemd user service."
}

uninstall_macos() {
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    rm -f -- "$HOME/Library/LaunchAgents/$LABEL.plist"
    echo "Removed the launchd LaunchAgent. Its logs remain in ~/Library/Logs/swarmd."
}

case "$(uname -s)" in
    Linux) uninstall_linux ;;
    Darwin) uninstall_macos ;;
    *) printf 'uninstall.sh: unsupported OS %s; on Windows run uninstall.ps1\n' "$(uname -s)" >&2; exit 1 ;;
esac

if [ "$purge_binary" -eq 1 ]; then
    rm -f -- "$BIN_DEST"
    echo "Removed binary: $BIN_DEST"
fi
echo "Your SWARM data directory and event log were left untouched."
