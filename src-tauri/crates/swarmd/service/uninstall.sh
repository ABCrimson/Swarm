#!/usr/bin/env sh
# Remove the swarmd per-user service installed by install.sh. Leaves the
# binary and your data directory in place; pass --purge-binary to also
# remove ~/.local/bin/swarmd. Never touches your SWARM data/event log.
set -eu

BIN_DEST="${SWARMD_BIN_DEST:-$HOME/.local/bin/swarmd}"
purge_binary=0
[ "${1:-}" = "--purge-binary" ] && purge_binary=1

uninstall_linux() {
    if command -v systemctl >/dev/null 2>&1; then
        systemctl --user disable --now swarmd.service 2>/dev/null || true
        systemctl --user daemon-reload 2>/dev/null || true
    fi
    rm -f "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/swarmd.service"
    echo "Removed systemd user service."
}

uninstall_macos() {
    plist_dest="$HOME/Library/LaunchAgents/dev.crimson.swarmd.plist"
    launchctl bootout "gui/$(id -u)/dev.crimson.swarmd" 2>/dev/null || true
    rm -f "$plist_dest"
    echo "Removed launchd LaunchAgent."
}

case "$(uname -s)" in
    Linux)  uninstall_linux ;;
    Darwin) uninstall_macos ;;
    *)      echo "uninstall.sh: unsupported OS $(uname -s) — on Windows run uninstall.ps1" >&2; exit 1 ;;
esac

if [ "$purge_binary" -eq 1 ]; then
    rm -f "$BIN_DEST"
    echo "Removed binary: $BIN_DEST"
fi
echo "Your SWARM data directory and event log were left untouched."
