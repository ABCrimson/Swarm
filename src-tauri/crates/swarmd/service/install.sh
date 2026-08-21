#!/usr/bin/env sh
# Install swarmd as a per-user background service (systemd --user on Linux,
# launchd LaunchAgent on macOS). Idempotent: safe to re-run to upgrade the
# binary or refresh the unit. See docs/daemon.md for the full guide.
#
#   Binary source, in order of preference:
#     1. $SWARMD_BIN if set and executable
#     2. ./swarmd next to this script (release download layout)
#     3. ../../../target/release/swarmd (repo build layout)
#     4. swarmd already on PATH
#   Binary is installed to ~/.local/bin/swarmd ($SWARMD_BIN_DEST to override).
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
BIN_DEST="${SWARMD_BIN_DEST:-$HOME/.local/bin/swarmd}"

die() { echo "install.sh: $*" >&2; exit 1; }

find_source_binary() {
    if [ -n "${SWARMD_BIN:-}" ]; then
        [ -x "$SWARMD_BIN" ] || die "\$SWARMD_BIN ($SWARMD_BIN) is not an executable file"
        printf '%s\n' "$SWARMD_BIN"; return 0
    fi
    for c in \
        "$SCRIPT_DIR/swarmd" \
        "$SCRIPT_DIR/../../../target/release/swarmd" \
        "$(command -v swarmd 2>/dev/null || true)"; do
        if [ -n "$c" ] && [ -x "$c" ]; then printf '%s\n' "$c"; return 0; fi
    done
    return 1
}

install_binary() {
    src=$1
    dest_dir=$(dirname -- "$BIN_DEST")
    mkdir -p "$dest_dir"
    # Same-path re-run (already installed there) needs no copy.
    if [ "$src" != "$BIN_DEST" ]; then
        cp -f "$src" "$BIN_DEST"
        chmod 0755 "$BIN_DEST"
    fi
    echo "Installed binary: $BIN_DEST"
    case ":$PATH:" in
        *":$dest_dir:"*) : ;;
        *) echo "note: $dest_dir is not on your PATH — the service uses the absolute path regardless." ;;
    esac
}

install_linux() {
    command -v systemctl >/dev/null 2>&1 || die "systemctl not found — see docs/daemon.md for a manual setup"
    unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
    mkdir -p "$unit_dir"
    cp -f "$SCRIPT_DIR/swarmd.service" "$unit_dir/swarmd.service"
    systemctl --user daemon-reload
    systemctl --user enable --now swarmd.service
    echo "swarmd is running as a systemd user service."
    echo "Connect URL (carries the token):  journalctl --user -u swarmd | grep 'Listening On'"
    echo "Follow logs:                      journalctl --user -u swarmd -f"
    echo "Enable start-at-boot without login: sudo loginctl enable-linger \"$USER\""
}

install_macos() {
    command -v launchctl >/dev/null 2>&1 || die "launchctl not found"
    log_dir="$HOME/Library/Logs"
    agents_dir="$HOME/Library/LaunchAgents"
    plist_dest="$agents_dir/dev.crimson.swarmd.plist"
    mkdir -p "$agents_dir"
    mkdir -p "$log_dir"; chmod 0700 "$log_dir"
    # The connect URL (with the daemon token) is written to the log, so the
    # log directory is 0700 — never world-readable, never /tmp.
    sed -e "s|@SWARMD_BIN@|$BIN_DEST|g" -e "s|@LOG_DIR@|$log_dir|g" \
        "$SCRIPT_DIR/dev.crimson.swarmd.plist" > "$plist_dest"
    domain="gui/$(id -u)"
    # bootout an earlier instance first so a re-run cleanly reloads.
    launchctl bootout "$domain/dev.crimson.swarmd" 2>/dev/null || true
    launchctl bootstrap "$domain" "$plist_dest"
    launchctl kickstart -k "$domain/dev.crimson.swarmd" 2>/dev/null || true
    echo "swarmd is running as a launchd LaunchAgent."
    echo "Connect URL (carries the token):  grep 'Listening On' \"$log_dir/swarmd.log\""
    echo "Follow logs:                      tail -f \"$log_dir/swarmd.log\""
}

src=$(find_source_binary) || die "no swarmd binary found — build it with \`cargo build -p swarmd --release\` or set \$SWARMD_BIN"
install_binary "$src"

case "$(uname -s)" in
    Linux)  install_linux ;;
    Darwin) install_macos ;;
    *)      die "unsupported OS $(uname -s) — on Windows run install.ps1 instead" ;;
esac
