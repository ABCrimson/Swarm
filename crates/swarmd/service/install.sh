#!/usr/bin/env sh
# Installs swarmd as a per-user background service: a systemd user unit on
# Linux, a launchd LaunchAgent on macOS. Idempotent: re-run it to upgrade the
# binary or refresh the unit; a running daemon is restarted onto the new
# binary. The service gets the PATH of the shell that runs this script (so
# agent CLIs such as `claude` and `codex` are found): re-run it after
# installing new CLIs. See docs/daemon.md.
#
# Binary source, in order of preference:
#   1. $SWARMD_BIN
#   2. swarmd-<target> next to this script: the release asset for this
#      machine, e.g. swarmd-x86_64-unknown-linux-gnu or swarmd-aarch64-apple-darwin
#   3. swarmd next to this script
#   4. ../../../target/release/swarmd (repository build)
#   5. swarmd on PATH
# It is installed to ~/.local/bin/swarmd ($SWARMD_BIN_DEST overrides).
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
BIN_DEST="${SWARMD_BIN_DEST:-$HOME/.local/bin/swarmd}"
LABEL=dev.crimson.swarmd

die() { printf 'install.sh: %s\n' "$*" >&2; exit 1; }

# The release target triple for this machine.
release_target() {
    case "$(uname -m)" in
        x86_64 | amd64) arch=x86_64 ;;
        arm64 | aarch64) arch=aarch64 ;;
        *) return 1 ;;
    esac
    case "$(uname -s)" in
        Linux) printf '%s-unknown-linux-gnu\n' "$arch" ;;
        Darwin) printf '%s-apple-darwin\n' "$arch" ;;
        *) return 1 ;;
    esac
}

find_source_binary() {
    if [ -n "${SWARMD_BIN:-}" ]; then
        [ -f "$SWARMD_BIN" ] || die "\$SWARMD_BIN ($SWARMD_BIN) is not a file"
        printf '%s\n' "$SWARMD_BIN"
        return 0
    fi
    target=$(release_target) || target=unknown
    # A downloaded release asset may lack the executable bit; the installed
    # copy gets it regardless.
    for candidate in \
        "$SCRIPT_DIR/swarmd-$target" \
        "$SCRIPT_DIR/swarmd" \
        "$SCRIPT_DIR/../../../target/release/swarmd" \
        "$(command -v swarmd 2>/dev/null || true)"; do
        if [ -n "$candidate" ] && [ -f "$candidate" ]; then
            printf '%s\n' "$candidate"
            return 0
        fi
    done
    return 1
}

# Copies the binary beside its destination and renames it into place, which
# also works while the old binary is running.
install_binary() {
    src=$1
    dest_dir=$(dirname -- "$BIN_DEST")
    mkdir -p -- "$dest_dir"
    if ! [ "$src" -ef "$BIN_DEST" ]; then
        staged="$BIN_DEST.new.$$"
        cp -- "$src" "$staged"
        chmod 0755 "$staged"
        mv -f -- "$staged" "$BIN_DEST"
    fi
    echo "Installed binary: $BIN_DEST"
}

# A double-quoted systemd unit value: backslashes and quotes escaped, and
# `%` doubled so it is not read as a specifier. (`$` needs no escaping in
# the two places it is used: ExecStart='s executable path and Environment=.)
systemd_quote() {
    printf '"%s"' "$(printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/%/%%/g')"
}

install_linux() {
    command -v systemctl >/dev/null 2>&1 || die "systemctl not found; see docs/daemon.md for a manual setup"
    unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
    dropin_dir="$unit_dir/swarmd.service.d"
    mkdir -p -- "$dropin_dir"
    install -m 0644 "$SCRIPT_DIR/swarmd.service" "$unit_dir/swarmd.service"
    # The unit's ExecStart assumes ~/.local/bin; the drop-in names the real
    # destination and passes this shell's PATH.
    {
        echo "# Written by swarmd's install.sh; re-run it to refresh."
        echo "[Service]"
        echo "ExecStart="
        echo "ExecStart=$(systemd_quote "$BIN_DEST")"
        echo "Environment=$(systemd_quote "PATH=$PATH")"
    } > "$dropin_dir/install.conf"
    systemctl --user daemon-reload
    systemctl --user enable swarmd.service
    # `enable --now` would leave an already running daemon on the old binary.
    systemctl --user restart swarmd.service
    echo "swarmd is running as a systemd user service."
    echo "Connect URL (carries the token):    \"$BIN_DEST\" connect-url"
    echo "Follow logs:                        journalctl --user -u swarmd -f"
    echo "Start at boot, without logging in:  sudo loginctl enable-linger \"${USER:-$(id -un)}\""
}

# Escapes a value for the plist (XML), then for the sed replacement below.
plist_value() {
    printf '%s' "$1" |
        sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' |
        sed -e 's/[\\|&]/\\&/g'
}

install_macos() {
    command -v launchctl >/dev/null 2>&1 || die "launchctl not found"
    # A swarmd-owned directory: the shared ~/Library/Logs keeps its mode.
    log_dir="$HOME/Library/Logs/swarmd"
    agents_dir="$HOME/Library/LaunchAgents"
    plist_dest="$agents_dir/$LABEL.plist"
    mkdir -p -- "$agents_dir" "$log_dir"
    chmod 0700 "$log_dir"
    sed -e "s|@SWARMD_BIN@|$(plist_value "$BIN_DEST")|g" \
        -e "s|@LOG_DIR@|$(plist_value "$log_dir")|g" \
        -e "s|@PATH@|$(plist_value "$PATH")|g" \
        "$SCRIPT_DIR/$LABEL.plist" > "$plist_dest.new"
    mv -f -- "$plist_dest.new" "$plist_dest"
    domain="gui/$(id -u)"
    # Unload an earlier instance so the new binary and plist take effect.
    # bootout returns before the job is fully gone, so retry the bootstrap.
    launchctl bootout "$domain/$LABEL" 2>/dev/null || true
    tries=0
    until launchctl bootstrap "$domain" "$plist_dest" 2>/dev/null; do
        tries=$((tries + 1))
        [ "$tries" -lt 10 ] || die "launchctl bootstrap $domain $plist_dest failed"
        sleep 1
    done
    echo "swarmd is running as a launchd LaunchAgent."
    echo "Connect URL (carries the token):  \"$BIN_DEST\" connect-url"
    echo "Follow logs:                      tail -f \"$log_dir/swarmd.log\""
    for old in "$HOME/Library/Logs/swarmd.log" "$HOME/Library/Logs/swarmd.err.log"; do
        if [ -f "$old" ]; then
            echo "note: $old is from an earlier install and may hold the old connect URL (with its token); delete it."
        fi
    done
}

case "$BIN_DEST$PATH" in
    *'
'*) die "paths containing a newline are not supported" ;;
esac

src=$(find_source_binary) || die "no swarmd binary found; build it with \`cargo build -p swarmd --release\` or set \$SWARMD_BIN"
install_binary "$src"

case "$(uname -s)" in
    Linux) install_linux ;;
    Darwin) install_macos ;;
    *) die "unsupported OS $(uname -s); on Windows run install.ps1 instead" ;;
esac
