#!/usr/bin/env bash
# rollback.sh
#
# Restore the most recent pi backup created by staged-upgrade.sh. The current
# live install is kept as `.failed-<timestamp>` in case the user wants to
# inspect what broke.
#
# Scope-aware: searches both `@mariozechner/` and `@earendil-works/` scope
# directories for backups, and handles the case where the live install moved
# scope between the original install and the backup it's restoring.
#
# Usage:
#   ./rollback.sh              # restore most recent backup (auto-detects)
#   ./rollback.sh --list       # list backups across both scopes
#   ./rollback.sh --backup <path>   # restore a specific backup
#
# Exit codes:
#   0 — rollback succeeded (or --list completed)
#   1 — rollback failed
#   2 — no backup available
#   3 — invocation error

set -euo pipefail

PREFIX_DIR="/opt/homebrew/lib/node_modules"
LIVE_BIN="/opt/homebrew/bin/pi"
SCOPE_NEW="@earendil-works"
SCOPE_OLD="@mariozechner"
PKG_BASENAME="pi-coding-agent"

log()  { printf '\033[0;36m[rollback]\033[0m %s\n' "$*"; }
warn() { printf '\033[0;33m[rollback WARN]\033[0m %s\n' "$*" >&2; }
err()  { printf '\033[0;31m[rollback FAIL]\033[0m %s\n' "$*" >&2; }
ok()   { printf '\033[0;32m[rollback OK]\033[0m %s\n' "$*"; }

# Detect currently-installed pi by scanning both known scopes.
# Sets globals: LIVE_PKG, LIVE_PKG_SCOPE
detect_live_install() {
    for scope in "$SCOPE_NEW" "$SCOPE_OLD"; do
        candidate="$PREFIX_DIR/$scope/$PKG_BASENAME"
        if [[ -d "$candidate" && -f "$candidate/package.json" ]]; then
            LIVE_PKG="$candidate"
            LIVE_PKG_SCOPE="$scope"
            return 0
        fi
    done
    return 1
}

# Collect backups from both scope dirs, newest first.
# Sets BACKUPS array.
collect_backups() {
    BACKUPS=()
    for scope in "$SCOPE_NEW" "$SCOPE_OLD"; do
        local dir="$PREFIX_DIR/$scope"
        [[ -d "$dir" ]] || continue
        while IFS= read -r line; do
            [[ -n "$line" ]] && BACKUPS+=("$line")
        done < <(ls -dt "$dir/$PKG_BASENAME".backup-* 2>/dev/null || true)
    done
    # Sort by mtime across the merged list (deterministic ordering)
    if (( ${#BACKUPS[@]} > 0 )); then
        # Use stat -f %m on macOS for portability with the existing code style
        local sorted
        sorted=$(printf '%s\n' "${BACKUPS[@]}" | while read -r p; do
            mtime=$(stat -f "%m" "$p" 2>/dev/null || stat -c "%Y" "$p" 2>/dev/null || echo 0)
            printf '%s\t%s\n' "$mtime" "$p"
        done | sort -rn | cut -f2)
        BACKUPS=()
        while IFS= read -r line; do
            [[ -n "$line" ]] && BACKUPS+=("$line")
        done <<< "$sorted"
    fi
}

# Determine the scope dir of a backup path.
backup_scope() {
    local b="$1"
    local parent
    parent="$(dirname "$b")"
    basename "$parent"
}

# ---------------------------------------------------------------------------
# Args
# ---------------------------------------------------------------------------

LIST=0
SPECIFIC=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --list) LIST=1; shift ;;
        --backup) SPECIFIC="$2"; shift 2 ;;
        --help|-h) sed -n '2,/^$/p' "${BASH_SOURCE[0]}" | sed 's/^# //;s/^#$//'; exit 0 ;;
        *) err "unknown arg: $1"; exit 3 ;;
    esac
done

if ! detect_live_install; then
    err "no live pi install found at $PREFIX_DIR/{$SCOPE_NEW,$SCOPE_OLD}/$PKG_BASENAME"
    exit 2
fi

collect_backups

if (( LIST )); then
    if (( ${#BACKUPS[@]} == 0 )); then
        log "no backups available"
        exit 0
    fi
    log "live install: $LIVE_PKG (scope $LIVE_PKG_SCOPE)"
    log "available backups (newest first):"
    for b in "${BACKUPS[@]}"; do
        VER=$(node -e "console.log(require('$b/package.json').version)" 2>/dev/null || echo "?")
        SCOPE=$(backup_scope "$b")
        printf '  %s/%s  v%s  %s\n' "$SCOPE" "$PKG_BASENAME" "$VER" "$b"
    done
    exit 0
fi

if [[ -n "$SPECIFIC" ]]; then
    BACKUP="$SPECIFIC"
else
    if (( ${#BACKUPS[@]} == 0 )); then
        err "no backups available — was the most recent upgrade run via staged-upgrade.sh?"
        exit 2
    fi
    BACKUP="${BACKUPS[0]}"
fi

if [[ ! -d "$BACKUP" ]]; then
    err "backup not found: $BACKUP"
    exit 2
fi

CURR_VER=$(node -e "console.log(require('$LIVE_PKG/package.json').version)" 2>/dev/null || echo "?")
BACKUP_VER=$(node -e "console.log(require('$BACKUP/package.json').version)" 2>/dev/null || echo "?")
BACKUP_SCOPE_NAME=$(backup_scope "$BACKUP")

log "current live: $LIVE_PKG (v$CURR_VER, scope $LIVE_PKG_SCOPE)"
log "rolling back to: $BACKUP (v$BACKUP_VER, scope $BACKUP_SCOPE_NAME)"

STAMP=$(date +%Y%m%d-%H%M%S)
FAILED_DIR="${LIVE_PKG}.failed-${STAMP}"

# Determine target install path. Backups are RESTORED to their ORIGINAL scope
# (the dir they were sitting in), which equals their backup_scope. If the
# backup's scope ≠ the current live scope, this is a cross-scope rollback —
# we'll need to update the symlink and remove the current live dir.
TARGET_PKG="$PREFIX_DIR/$BACKUP_SCOPE_NAME/$PKG_BASENAME"
CROSS_SCOPE=0
if [[ "$TARGET_PKG" != "$LIVE_PKG" ]]; then
    CROSS_SCOPE=1
    warn "CROSS-SCOPE rollback: $LIVE_PKG_SCOPE → $BACKUP_SCOPE_NAME"
fi

# Capture the current symlink target so we can restore on failure
OLD_LIVE_BIN_TARGET=$(readlink "$LIVE_BIN" 2>/dev/null || echo "")

if (( CROSS_SCOPE )); then
    # Move CURRENT live aside as failed-stamp
    mv "$LIVE_PKG" "$FAILED_DIR"
    # Promote backup
    mv "$BACKUP" "$TARGET_PKG"
    # Repoint symlink
    if ! ln -sf "$TARGET_PKG/dist/cli.js" "$LIVE_BIN"; then
        err "could not update symlink at $LIVE_BIN"
        err "rolling back the rollback"
        mv "$TARGET_PKG" "$BACKUP"
        mv "$FAILED_DIR" "$LIVE_PKG"
        if [[ -n "$OLD_LIVE_BIN_TARGET" ]]; then
            ln -sf "$OLD_LIVE_BIN_TARGET" "$LIVE_BIN"
        fi
        exit 1
    fi
else
    # Same-scope rollback: atomic swap
    if ! mv "$LIVE_PKG" "$FAILED_DIR"; then
        err "could not move live install aside"
        exit 1
    fi
    if ! mv "$BACKUP" "$LIVE_PKG"; then
        err "could not promote backup to live; restoring failed install"
        mv "$FAILED_DIR" "$LIVE_PKG"
        exit 1
    fi
fi

# Verify
if ! node "$TARGET_PKG/dist/cli.js" --version >/dev/null 2>&1; then
    err "rolled-back pi fails --version too; restoring failed install"
    if (( CROSS_SCOPE )); then
        mv "$TARGET_PKG" "$BACKUP"
        mv "$FAILED_DIR" "$LIVE_PKG"
        if [[ -n "$OLD_LIVE_BIN_TARGET" ]]; then
            ln -sf "$OLD_LIVE_BIN_TARGET" "$LIVE_BIN"
        fi
    else
        mv "$LIVE_PKG" "$BACKUP"
        mv "$FAILED_DIR" "$LIVE_PKG"
    fi
    exit 1
fi

ok "rolled back to v$BACKUP_VER (scope $BACKUP_SCOPE_NAME)"
log "broken install retained at: $FAILED_DIR"
log "(delete it manually once you've inspected the failure cause)"
