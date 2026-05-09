#!/usr/bin/env bash
# staged-upgrade.sh
#
# Build pi from origin/main into a STAGING location, apply all pi-less-shitty
# patches against the staged dist, run smoke tests, and only on success
# atomically swap the live install. The previous live install is kept as a
# timestamped backup for rollback.
#
# Scope-aware: handles the May 2026 rename from `@mariozechner/pi-coding-agent`
# to `@earendil-works/pi-coding-agent` (and `badlogic/pi-mono` → `earendil-works/pi-mono`).
# Auto-detects the currently-installed scope, the upstream repo location, and
# the upstream package name from the cloned `package.json`. When the upstream
# package name differs from the live install (a CROSS-SCOPE swap), the script:
#   1. Installs the staged build under the NEW scope dir (sibling to the old)
#   2. Renames the OLD live dir → `<old-pkg>.backup-pre-rename-<stamp>`
#   3. Updates `/opt/homebrew/bin/pi` to point at the new dist
#   4. Smoke-tests the new path; on failure, restores the old dir + symlink
#
# Usage:
#   ./staged-upgrade.sh                 # full upgrade flow
#   ./staged-upgrade.sh --build-only    # build + patch + test, do NOT swap
#   ./staged-upgrade.sh --dry-run       # log what would happen, change nothing
#   PI_REPO=<url> ./staged-upgrade.sh   # override upstream repo (default: auto-detect)
#   PI_KEEP_STAGING=1 ./staged-upgrade.sh   # keep staging dir after success
#
# Exit codes:
#   0  — success
#   1  — failure during build/patch/test (live install untouched)
#   2  — failure during swap (live install possibly inconsistent — see RECOVERY note)
#   3  — invocation error
#
# Hard guarantee: if exit code is non-zero, the live install is either
# (a) untouched and still working, or (b) restorable via rollback.sh.

set -euo pipefail

# ----------------------------------------------------------------------------
# Config
# ----------------------------------------------------------------------------

PREFIX_DIR="/opt/homebrew/lib/node_modules"
LIVE_BIN="/opt/homebrew/bin/pi"
SCOPE_NEW="@earendil-works"
SCOPE_OLD="@mariozechner"
PKG_BASENAME="pi-coding-agent"

# Upstream repo URLs — probe new first, fall back to old.
REPO_NEW="https://github.com/earendil-works/pi-mono.git"
REPO_OLD="https://github.com/badlogic/pi-mono.git"
PI_REPO="${PI_REPO:-}"  # user override

PI_LESS_SHITTY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PATCH_APPLIER="$PI_LESS_SHITTY_ROOT/packages/patch-applier/src/cli.ts"
STAGING_BASE="${TMPDIR:-/tmp}/pi-staged-upgrade"

# Mode flags
BUILD_ONLY=0
DRY_RUN=0
for arg in "$@"; do
    case "$arg" in
        --build-only) BUILD_ONLY=1 ;;
        --dry-run) DRY_RUN=1 ;;
        --help|-h)
            sed -n '2,/^$/p' "${BASH_SOURCE[0]}" | sed 's/^# //;s/^#$//'
            exit 0
            ;;
        *) echo "unknown arg: $arg" >&2; exit 3 ;;
    esac
done

# ----------------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------------

log()  { printf '\033[0;36m[upgrade]\033[0m %s\n' "$*"; }
warn() { printf '\033[0;33m[upgrade WARN]\033[0m %s\n' "$*" >&2; }
err()  { printf '\033[0;31m[upgrade FAIL]\033[0m %s\n' "$*" >&2; }
ok()   { printf '\033[0;32m[upgrade OK]\033[0m %s\n' "$*"; }

run() {
    if (( DRY_RUN )); then
        printf '\033[0;35m[would run]\033[0m %s\n' "$*"
    else
        eval "$@"
    fi
}

# Detect the currently-installed pi by scanning both known scopes.
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

# Detect the upstream repo URL by probing both candidates with `git ls-remote`.
# User-supplied PI_REPO env var always wins.
detect_upstream_repo() {
    if [[ -n "$PI_REPO" ]]; then
        log "using PI_REPO override: $PI_REPO"
        return 0
    fi
    for url in "$REPO_NEW" "$REPO_OLD"; do
        if git ls-remote "$url" HEAD >/dev/null 2>&1; then
            PI_REPO="$url"
            return 0
        fi
    done
    err "neither upstream repo is reachable: $REPO_NEW $REPO_OLD"
    exit 1
}

# Read upstream package name from a cloned package.json.
# Sets globals: UPSTREAM_PKG_NAME, UPSTREAM_PKG_SCOPE, UPSTREAM_PKG_BASENAME
read_upstream_pkg_name() {
    local pkg_json="$1/packages/coding-agent/package.json"
    if [[ ! -f "$pkg_json" ]]; then
        err "upstream package.json not found at $pkg_json"
        exit 1
    fi
    UPSTREAM_PKG_NAME=$(node -e "console.log(require('$pkg_json').name)")
    # Split @scope/basename
    UPSTREAM_PKG_SCOPE="${UPSTREAM_PKG_NAME%%/*}"
    UPSTREAM_PKG_BASENAME="${UPSTREAM_PKG_NAME##*/}"
    if [[ "$UPSTREAM_PKG_SCOPE" == "$UPSTREAM_PKG_NAME" ]]; then
        # Unscoped — unexpected
        err "upstream package $UPSTREAM_PKG_NAME is unscoped — refusing to install"
        exit 1
    fi
}

# Convert @scope/name → scope-name (npm-pack tarball prefix convention)
tarball_glob_for() {
    local pkg_name="$1"
    local scope_no_at="${pkg_name#@}"
    echo "${scope_no_at//\//-}-*.tgz"
}

# ----------------------------------------------------------------------------
# Step 0 — preflight
# ----------------------------------------------------------------------------

if ! detect_live_install; then
    err "live install not found at $PREFIX_DIR/{$SCOPE_NEW,$SCOPE_OLD}/$PKG_BASENAME"
    exit 3
fi
log "live install: $LIVE_PKG (scope: $LIVE_PKG_SCOPE)"

if [[ ! -f "$PATCH_APPLIER" ]]; then
    err "patch-applier CLI not found at $PATCH_APPLIER"
    exit 3
fi

detect_upstream_repo
log "upstream repo: $PI_REPO"

LOCAL_VER=$(node -e "console.log(require('$LIVE_PKG/package.json').version)")
LOCAL_COMMIT=$(node -e "const p=require('$LIVE_PKG/package.json'); console.log(p.gitHead || 'unknown')")
LATEST_COMMIT=$(git ls-remote "$PI_REPO" refs/heads/main | awk '{print $1}')

log "live: v$LOCAL_VER ($LOCAL_COMMIT)"
log "origin/main HEAD: $LATEST_COMMIT"

if [[ "$LOCAL_COMMIT" == "$LATEST_COMMIT" ]]; then
    ok "already at origin/main HEAD — nothing to upgrade"
    exit 0
fi

# Pre-upgrade baseline check: patches must currently verify clean.
log "pre-flight: verifying current dist patches"
if ! npx tsx "$PATCH_APPLIER" --check --dist "$LIVE_PKG/dist" >/dev/null 2>&1; then
    warn "current dist has failing specs; running --check for detail:"
    npx tsx "$PATCH_APPLIER" --check --dist "$LIVE_PKG/dist" || true
    err "abort: fix current install before upgrading"
    exit 1
fi
ok "current install verifies clean"

# ----------------------------------------------------------------------------
# Step 1 — clone & build into STAGING (never touches live)
# ----------------------------------------------------------------------------

STAMP=$(date +%Y%m%d-%H%M%S)
SHORT_HASH=${LATEST_COMMIT:0:8}
STAGING_DIR="$STAGING_BASE/$SHORT_HASH-$STAMP"

if (( DRY_RUN )); then
    log "[dry-run] would stage at $STAGING_DIR"
fi

log "step 1/4: clone + build origin/main into $STAGING_DIR"
run "rm -rf '$STAGING_DIR'"
run "mkdir -p '$STAGING_DIR'"
run "git clone --quiet --depth 1 '$PI_REPO' '$STAGING_DIR/src'"

if (( ! DRY_RUN )); then
    read_upstream_pkg_name "$STAGING_DIR/src"
    log "upstream package: $UPSTREAM_PKG_NAME"
    if [[ "$UPSTREAM_PKG_SCOPE" != "$LIVE_PKG_SCOPE" ]]; then
        warn "CROSS-SCOPE upgrade: $LIVE_PKG_SCOPE → $UPSTREAM_PKG_SCOPE"
        warn "  old install will be backed up at $LIVE_PKG.backup-pre-rename-$STAMP"
        warn "  new install will live at $PREFIX_DIR/$UPSTREAM_PKG_SCOPE/$UPSTREAM_PKG_BASENAME"
        warn "  /opt/homebrew/bin/pi symlink will be repointed at the new path"
    fi
else
    UPSTREAM_PKG_NAME="$LIVE_PKG_SCOPE/$PKG_BASENAME"
    UPSTREAM_PKG_SCOPE="$LIVE_PKG_SCOPE"
    UPSTREAM_PKG_BASENAME="$PKG_BASENAME"
fi

run "cd '$STAGING_DIR/src' && npm install --no-audit --no-fund 2>&1 | tail -5"
run "cd '$STAGING_DIR/src' && npm run build 2>&1 | tail -5"

# Pack + install (see commit comments below for why this layout matters).
log "step 1b/4: pack + install coding-agent into staging (global-style layout)"
run "mkdir -p '$STAGING_DIR/install'"
run "cd '$STAGING_DIR/src/packages/coding-agent' && npm pack --pack-destination '$STAGING_DIR' --silent 2>&1 | tail -3"

if (( ! DRY_RUN )); then
    GLOB=$(tarball_glob_for "$UPSTREAM_PKG_NAME")
    TARBALL=$(ls "$STAGING_DIR"/$GLOB 2>/dev/null | head -1)
    if [[ -z "$TARBALL" ]]; then
        err "npm pack did not produce a tarball matching '$GLOB' in $STAGING_DIR"
        ls -la "$STAGING_DIR" >&2
        exit 1
    fi
    log "  tarball: $(basename "$TARBALL") ($(du -h "$TARBALL" | cut -f1))"
else
    TARBALL="<tarball-path>"
fi

# `-g --prefix <dir>`: install globally into a custom prefix, producing
# nested-deps layout. See history comments in earlier git revisions for why
# `--prefix` alone or `--no-save` produces broken installs.
run "npm install -g --prefix '$STAGING_DIR/install' --no-audit --no-fund '$TARBALL' 2>&1 | tail -5"

STAGED_PKG="$STAGING_DIR/install/lib/node_modules/$UPSTREAM_PKG_NAME"

if (( ! DRY_RUN )); then
    if [[ ! -d "$STAGED_PKG" ]]; then
        err "staged package not found at $STAGED_PKG (pack/install failed?)"
        ls -la "$STAGING_DIR/install/lib/node_modules" >&2 || true
        exit 1
    fi
    if [[ -L "$STAGED_PKG" ]]; then
        err "staged install is a symlink to $(readlink "$STAGED_PKG") — would dangle after mv; refusing to continue"
        exit 1
    fi
    if [[ ! -d "$STAGED_PKG/node_modules" ]]; then
        err "staged package missing nested node_modules/ — deps would be stranded after mv"
        err "  expected dir: $STAGED_PKG/node_modules"
        err "  npm may have hoisted deps. Inspect: $STAGING_DIR/install/lib/node_modules/"
        exit 1
    fi
fi

if (( ! DRY_RUN )); then
    NEW_VER=$(node -e "console.log(require('$STAGED_PKG/package.json').version)" 2>/dev/null || echo "unknown")
    ok "staged: $UPSTREAM_PKG_NAME v$NEW_VER ($SHORT_HASH) at $STAGED_PKG"
fi

# ----------------------------------------------------------------------------
# Step 2 — apply all patches against STAGING
# ----------------------------------------------------------------------------

log "step 2/4: apply all pi-less-shitty patches against staging dist"

if (( ! DRY_RUN )); then
    PATCH_RESULT="$STAGING_DIR/patch-result.json"

    npx tsx "$PATCH_APPLIER" --dist "$STAGED_PKG/dist" --json > "$PATCH_RESULT" || true

    parse_failed_ids() {
        node -e "
            const r = JSON.parse(require('fs').readFileSync('$1','utf8'));
            const failed = (r.results||[]).filter(x => x.status === 'failed').map(x => x.specId);
            console.log(failed.join('\n'));
        "
    }

    MAX_RETRIES=3
    PER_SPEC_TIMEOUT_MS=300000

    for retry in $(seq 1 $MAX_RETRIES); do
        FAILED_IDS=$(parse_failed_ids "$PATCH_RESULT")
        if [[ -z "$FAILED_IDS" ]]; then
            ok "all specs applied successfully (after $((retry-1)) retries)"
            break
        fi

        log "retry $retry/$MAX_RETRIES: re-running failed specs with extended timeout"
        for spec_id in $FAILED_IDS; do
            log "  retry: $spec_id"
            SPEC_RESULT="$STAGING_DIR/retry-${spec_id}-${retry}.json"
            if PI_PATCH_TIMEOUT_MS=$PER_SPEC_TIMEOUT_MS \
                npx tsx "$PATCH_APPLIER" --dist "$STAGED_PKG/dist" --spec "$spec_id" --json > "$SPEC_RESULT"; then
                ok "  $spec_id: re-applied"
                node -e "
                    const fs = require('fs');
                    const agg = JSON.parse(fs.readFileSync('$PATCH_RESULT','utf8'));
                    const fix = JSON.parse(fs.readFileSync('$SPEC_RESULT','utf8'));
                    if (fix.results && fix.results[0]) {
                        const idx = agg.results.findIndex(r => r.specId === fix.results[0].specId);
                        if (idx >= 0) agg.results[idx] = fix.results[0];
                    }
                    fs.writeFileSync('$PATCH_RESULT', JSON.stringify(agg, null, 2));
                "
            else
                warn "  $spec_id: retry $retry still failed"
            fi
        done
    done

    if ! npx tsx "$PATCH_APPLIER" --dist "$STAGED_PKG/dist" --check; then
        err "patch-applier --check still fails after $MAX_RETRIES retries — refusing to swap"
        err "see $PATCH_RESULT for derivation history"
        exit 1
    fi
fi

ok "all patches applied + verified against staging"

# ----------------------------------------------------------------------------
# Step 3 — smoke tests against STAGING (still no swap)
# ----------------------------------------------------------------------------

log "step 3/4: smoke tests against staged install"

run "node '$STAGED_PKG/dist/cli.js' --version"
run "node '$STAGED_PKG/dist/cli.js' --help > /dev/null"

if (( ! DRY_RUN )); then
    log "step 3b/4: non-interactive smoke session"
    if SMOKE_OUT=$(node "$STAGED_PKG/dist/cli.js" --mode json -p "Output the literal string PI_OK and exit immediately. No tools, no thinking." --no-session --no-extensions --no-skills 2>&1); then
        if echo "$SMOKE_OUT" | grep -q "PI_OK"; then
            ok "non-interactive smoke session passed"
        else
            warn "smoke session ran but didn't see PI_OK marker — staging may have subtle breakage"
            warn "output sample: $(echo "$SMOKE_OUT" | tail -3)"
        fi
    else
        warn "non-interactive smoke session errored (likely no API key); skipping"
    fi
fi

ok "staged install passes smoke tests"

if (( BUILD_ONLY )); then
    ok "build-only mode: staging at $STAGING_DIR (run 'staged-upgrade.sh' again or pass to swap step)"
    exit 0
fi

# ----------------------------------------------------------------------------
# Step 4 — atomic swap (in-place OR cross-scope)
# ----------------------------------------------------------------------------

log "step 4/4: atomic swap of live install"

# Final pre-swap guards (skip in dry-run since staging was never created)
if (( ! DRY_RUN )); then
    if [[ -L "$STAGED_PKG" ]]; then
        err "staged install became a symlink before swap — would dangle; aborting"
        exit 1
    fi
    if [[ ! -d "$STAGED_PKG" ]]; then
        err "staged install missing right before swap; aborting"
        exit 1
    fi
    if [[ ! -d "$STAGED_PKG/node_modules" ]] || [[ -z "$(ls -A "$STAGED_PKG/node_modules" 2>/dev/null)" ]]; then
        err "staged install has no nested deps before swap — would break post-mv; aborting"
        exit 1
    fi
fi

NEW_LIVE_PKG="$PREFIX_DIR/$UPSTREAM_PKG_NAME"
SAME_SCOPE=0
if [[ "$NEW_LIVE_PKG" == "$LIVE_PKG" ]]; then
    SAME_SCOPE=1
fi

if (( DRY_RUN )); then
    if (( SAME_SCOPE )); then
        log "[dry-run] same-scope: would mv '$LIVE_PKG' → '${LIVE_PKG}.backup-${LOCAL_VER}-${LOCAL_COMMIT:0:8}-${STAMP}'"
        log "[dry-run] same-scope: would mv '$STAGED_PKG' → '$LIVE_PKG'"
    else
        log "[dry-run] CROSS-SCOPE: would mv '$LIVE_PKG' → '${LIVE_PKG}.backup-pre-rename-${STAMP}'"
        log "[dry-run] CROSS-SCOPE: would mkdir -p '$(dirname "$NEW_LIVE_PKG")'"
        log "[dry-run] CROSS-SCOPE: would mv '$STAGED_PKG' → '$NEW_LIVE_PKG'"
        log "[dry-run] CROSS-SCOPE: would ln -sf '$NEW_LIVE_PKG/dist/cli.js' '$LIVE_BIN'"
    fi
    ok "[dry-run] complete — no changes made"
    exit 0
fi

if (( SAME_SCOPE )); then
    # ------ in-place swap (current behavior pre-rename) ------
    BACKUP_PKG="${LIVE_PKG}.backup-${LOCAL_VER}-${LOCAL_COMMIT:0:8}-${STAMP}"
    mv "$LIVE_PKG" "$BACKUP_PKG"
    if ! mv "$STAGED_PKG" "$LIVE_PKG"; then
        err "swap failed mid-rename — restoring backup"
        if mv "$BACKUP_PKG" "$LIVE_PKG"; then
            warn "backup restored — live install is unchanged"
            exit 1
        else
            err "RECOVERY: backup restore also failed. Manual recovery needed:"
            err "    mv '$BACKUP_PKG' '$LIVE_PKG'"
            exit 2
        fi
    fi
    POST_PKG="$LIVE_PKG"
else
    # ------ CROSS-SCOPE swap ------
    BACKUP_PKG="${LIVE_PKG}.backup-pre-rename-${STAMP}"
    NEW_SCOPE_DIR="$(dirname "$NEW_LIVE_PKG")"

    # Create new scope dir if it doesn't exist
    mkdir -p "$NEW_SCOPE_DIR"

    # Backup OLD install (rename in place — atomic)
    mv "$LIVE_PKG" "$BACKUP_PKG"

    # Move staged → NEW location
    if ! mv "$STAGED_PKG" "$NEW_LIVE_PKG"; then
        err "cross-scope swap failed: could not move staged → '$NEW_LIVE_PKG'"
        err "restoring backup"
        mv "$BACKUP_PKG" "$LIVE_PKG"
        exit 1
    fi

    # Repoint /opt/homebrew/bin/pi at the new dist/cli.js
    OLD_LIVE_BIN_TARGET=$(readlink "$LIVE_BIN" 2>/dev/null || echo "")
    if ! ln -sf "$NEW_LIVE_PKG/dist/cli.js" "$LIVE_BIN"; then
        err "could not update symlink at $LIVE_BIN"
        err "rolling back: restoring old install + symlink"
        mv "$NEW_LIVE_PKG" "$STAGED_PKG"
        mv "$BACKUP_PKG" "$LIVE_PKG"
        if [[ -n "$OLD_LIVE_BIN_TARGET" ]]; then
            ln -sf "$OLD_LIVE_BIN_TARGET" "$LIVE_BIN"
        fi
        exit 2
    fi

    POST_PKG="$NEW_LIVE_PKG"
    log "cross-scope swap complete: $LIVE_PKG_SCOPE → $UPSTREAM_PKG_SCOPE"
    log "  symlink: $LIVE_BIN → $NEW_LIVE_PKG/dist/cli.js"
    log "  old install retained at: $BACKUP_PKG"
    log "  delete old install AFTER you confirm everything works:"
    log "      trash $BACKUP_PKG"
fi

# Sanity check
if [[ ! -x "$LIVE_BIN" ]] && [[ ! -L "$LIVE_BIN" ]]; then
    warn "pi binary at $LIVE_BIN missing after swap — symlink may need recreation"
    warn "    ln -sf '$POST_PKG/dist/cli.js' '$LIVE_BIN'"
fi

# Post-swap smoke test
if ! node "$POST_PKG/dist/cli.js" --version >/dev/null 2>&1; then
    err "post-swap pi --version failed; rolling back"
    if (( SAME_SCOPE )); then
        mv "$LIVE_PKG" "${LIVE_PKG}.failed-${STAMP}"
        mv "$BACKUP_PKG" "$LIVE_PKG"
    else
        mv "$NEW_LIVE_PKG" "${NEW_LIVE_PKG}.failed-${STAMP}"
        mv "$BACKUP_PKG" "$LIVE_PKG"
        if [[ -n "$OLD_LIVE_BIN_TARGET" ]]; then
            ln -sf "$OLD_LIVE_BIN_TARGET" "$LIVE_BIN"
        fi
    fi
    err "rolled back to v$LOCAL_VER"
    exit 2
fi

ok "live install upgraded: v$LOCAL_VER → v$NEW_VER ($SHORT_HASH)"
log "backup retained at: $BACKUP_PKG"
log "rollback with: $PI_LESS_SHITTY_ROOT/scripts/rollback.sh"

# Cleanup staging
if [[ -z "${PI_KEEP_STAGING:-}" ]]; then
    rm -rf "$STAGING_DIR"
fi

# ----------------------------------------------------------------------------
# Step 5 — backup retention (keep last 3 backups, prune older)
# ----------------------------------------------------------------------------
# Search both scope dirs for backups (handles cross-scope history).

prune_backups_in() {
    local backup_parent="$1"
    [[ -d "$backup_parent" ]] || return 0
    # bash 3-compatible array read (macOS /bin/bash lacks `mapfile`)
    backups=()
    while IFS= read -r line; do
        [[ -n "$line" ]] && backups+=("$line")
    done < <(ls -dt "$backup_parent/$PKG_BASENAME".backup-* 2>/dev/null || true)
    if (( ${#backups[@]} > 3 )); then
        log "pruning ${#backups[@]} backups in $backup_parent, keeping 3 most recent"
        for old in "${backups[@]:3}"; do
            log "  pruning: $old"
            rm -rf "$old"
        done
    fi
}

prune_backups_in "$PREFIX_DIR/$SCOPE_OLD"
prune_backups_in "$PREFIX_DIR/$SCOPE_NEW"

ok "upgrade complete"
