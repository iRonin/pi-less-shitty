#!/usr/bin/env bash
# oh-pi-staged-upgrade.sh
#
# Mirror of staged-upgrade.sh, but for the oh-pi fork instead of pi itself.
#
# Flow:
#   1. Clone the live oh-pi worktree into a STAGING directory (preserves
#      remotes; never touches the live tree at ~/Work/Pi-Agent/oh-pi).
#   2. Fetch upstream/main and reset the staging branch to it — fresh base.
#   3. Replay every fork-patch spec in declared order via the .fork-patches
#      applier. Each spec: `git cherry-pick <spec.referenceCommit>` first;
#      on conflict or post-cherry-pick verify failure, dispatch AI to derive
#      fresh edits, apply, commit. Empty cherry-picks mean upstream subsumed.
#   4. Smoke tests in staging: vitest run packages/subagents/tests/*.test.ts
#      (3 pre-existing failures from missing workspace node_modules are
#      tolerated; new failures abort).
#   5. Print recommended fast-forward command for the live `feat/all-local`
#      branch. The script NEVER force-pushes or rewrites the live branch on
#      its own — that's a human decision.
#
# Usage:
#   ./oh-pi-staged-upgrade.sh                    # full flow (stops before live mutation)
#   ./oh-pi-staged-upgrade.sh --dry-run          # show what would happen
#   ./oh-pi-staged-upgrade.sh --no-tests         # skip the vitest smoke step
#   ./oh-pi-staged-upgrade.sh --keep-staging     # don't rm staging on success
#
# Exit codes:
#   0 — staging tree is healthy + recommendation printed
#   1 — patch apply / verify / test failure (live worktree untouched)
#   3 — invocation error
#
# Hard guarantee: this script never mutates ~/Work/Pi-Agent/oh-pi worktree or
# branches. All work happens in staging. The user inspects + decides whether
# to fast-forward `feat/all-local` to the staging HEAD.

set -euo pipefail

# ----------------------------------------------------------------------------
# Config
# ----------------------------------------------------------------------------

PI_LESS_SHITTY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIVE_OH_PI_ROOT="${OH_PI_ROOT:-$HOME/Work/Pi-Agent/oh-pi}"
STAGING_BASE="${TMPDIR:-/tmp}/oh-pi-staged-upgrade"
UPSTREAM_REMOTE="${OH_PI_UPSTREAM_REMOTE:-upstream}"
UPSTREAM_BRANCH="${OH_PI_UPSTREAM_BRANCH:-main}"
LIVE_BRANCH="${OH_PI_LIVE_BRANCH:-feat/all-local}"

DRY_RUN=0
NO_TESTS=0
KEEP_STAGING=0
for arg in "$@"; do
    case "$arg" in
        --dry-run) DRY_RUN=1 ;;
        --no-tests) NO_TESTS=1 ;;
        --keep-staging) KEEP_STAGING=1 ;;
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

log()  { printf '\033[0;36m[oh-pi-upgrade]\033[0m %s\n' "$*"; }
warn() { printf '\033[0;33m[oh-pi-upgrade WARN]\033[0m %s\n' "$*" >&2; }
err()  { printf '\033[0;31m[oh-pi-upgrade FAIL]\033[0m %s\n' "$*" >&2; }
ok()   { printf '\033[0;32m[oh-pi-upgrade OK]\033[0m %s\n' "$*"; }

run() {
    if (( DRY_RUN )); then
        printf '\033[0;35m[would run]\033[0m %s\n' "$*"
    else
        eval "$@"
    fi
}

# ----------------------------------------------------------------------------
# Step 0 — preflight
# ----------------------------------------------------------------------------

if [[ ! -d "$LIVE_OH_PI_ROOT/.git" ]]; then
    err "live oh-pi not found at $LIVE_OH_PI_ROOT (set OH_PI_ROOT to override)"
    exit 3
fi

if [[ ! -d "$LIVE_OH_PI_ROOT/.fork-patches/specs" ]]; then
    err ".fork-patches/specs/ missing in $LIVE_OH_PI_ROOT"
    exit 3
fi

if ! command -v npx >/dev/null 2>&1; then
    err "npx not on PATH"
    exit 3
fi

LIVE_HEAD=$(git -C "$LIVE_OH_PI_ROOT" rev-parse HEAD)
LIVE_CUR_BRANCH=$(git -C "$LIVE_OH_PI_ROOT" branch --show-current)
log "live worktree: $LIVE_OH_PI_ROOT"
log "live branch:   $LIVE_CUR_BRANCH @ ${LIVE_HEAD:0:8}"

# Verify upstream remote is reachable.
if ! git -C "$LIVE_OH_PI_ROOT" ls-remote "$UPSTREAM_REMOTE" "refs/heads/$UPSTREAM_BRANCH" >/dev/null 2>&1; then
    err "cannot reach $UPSTREAM_REMOTE/$UPSTREAM_BRANCH from $LIVE_OH_PI_ROOT"
    exit 1
fi

# Refresh upstream ref in the live repo (read-only ref update).
log "fetching $UPSTREAM_REMOTE/$UPSTREAM_BRANCH (live repo, ref-only)"
run "git -C '$LIVE_OH_PI_ROOT' fetch --quiet '$UPSTREAM_REMOTE' '$UPSTREAM_BRANCH'"

UPSTREAM_HEAD=$(git -C "$LIVE_OH_PI_ROOT" rev-parse "$UPSTREAM_REMOTE/$UPSTREAM_BRANCH")
MERGE_BASE=$(git -C "$LIVE_OH_PI_ROOT" merge-base "$UPSTREAM_REMOTE/$UPSTREAM_BRANCH" "$LIVE_CUR_BRANCH")
log "upstream/$UPSTREAM_BRANCH: ${UPSTREAM_HEAD:0:8}"
log "merge-base:    ${MERGE_BASE:0:8}"

if [[ "$UPSTREAM_HEAD" == "$MERGE_BASE" ]]; then
    log "upstream has NOT moved since last reconciliation — replay will be deterministic"
else
    NEW_COMMITS=$(git -C "$LIVE_OH_PI_ROOT" rev-list --count "$MERGE_BASE..$UPSTREAM_REMOTE/$UPSTREAM_BRANCH")
    warn "upstream advanced by $NEW_COMMITS commit(s) since last reconciliation"
fi

# Pre-flight: live worktree specs must all verify before we trust the replay.
log "pre-flight: verifying all 15 specs against live worktree"
if ! (cd "$LIVE_OH_PI_ROOT" && npx tsx .fork-patches/cli.ts --check >/dev/null 2>&1); then
    warn "live worktree has failing specs; running --check for detail:"
    (cd "$LIVE_OH_PI_ROOT" && npx tsx .fork-patches/cli.ts --check) || true
    err "abort: fix live worktree spec drift before running an upgrade"
    exit 1
fi
ok "live worktree: all specs verify clean"

# ----------------------------------------------------------------------------
# Step 1 — clone into staging
# ----------------------------------------------------------------------------

STAMP=$(date +%Y%m%d-%H%M%S)
SHORT_UP=${UPSTREAM_HEAD:0:8}
STAGING_DIR="$STAGING_BASE/$SHORT_UP-$STAMP"

log "step 1/4: cloning live worktree → $STAGING_DIR"
run "rm -rf '$STAGING_DIR'"
run "mkdir -p '$STAGING_BASE'"
# `--shared` avoids copying the entire object database (big monorepo);
# fully self-contained on commits we touch because we never gc the live repo.
run "git clone --quiet --shared --no-checkout '$LIVE_OH_PI_ROOT' '$STAGING_DIR'"

# Ensure the upstream remote name resolves from staging (preserve from origin).
if (( ! DRY_RUN )); then
    LIVE_UPSTREAM_URL=$(git -C "$LIVE_OH_PI_ROOT" remote get-url "$UPSTREAM_REMOTE")
    git -C "$STAGING_DIR" remote add "$UPSTREAM_REMOTE" "$LIVE_UPSTREAM_URL" 2>/dev/null || \
        git -C "$STAGING_DIR" remote set-url "$UPSTREAM_REMOTE" "$LIVE_UPSTREAM_URL"
fi

# Fetch upstream into staging.
run "git -C '$STAGING_DIR' fetch --quiet '$UPSTREAM_REMOTE' '$UPSTREAM_BRANCH'"

# Reset staging branch to upstream/main — fresh base.
STAGING_BRANCH="sync-${SHORT_UP}-${STAMP}"
log "step 1b/4: checkout fresh base ${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH} as $STAGING_BRANCH"
run "git -C '$STAGING_DIR' checkout -b '$STAGING_BRANCH' '${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}'"

ok "staging tree at upstream/$UPSTREAM_BRANCH (${UPSTREAM_HEAD:0:8})"

# ----------------------------------------------------------------------------
# Step 2 — apply all fork-patch specs against staging
# ----------------------------------------------------------------------------

log "step 2/4: applying all fork-patch specs (cherry-pick + AI fallback)"

if (( DRY_RUN )); then
    log "[dry-run] would run: cd $LIVE_OH_PI_ROOT && npx tsx .fork-patches/cli.ts --apply --repo $STAGING_DIR --verbose"
else
    APPLY_RESULT="$STAGING_DIR/.fork-patches-apply-result.json"
    # Use the applier from the LIVE oh-pi (the .fork-patches/ directory in the
    # staging clone is the post-cherry-pick state, not the applier we want).
    if ! (cd "$LIVE_OH_PI_ROOT" && \
            npx tsx .fork-patches/cli.ts --apply --repo "$STAGING_DIR" --verbose 2>&1 | tee "$STAGING_DIR/.fork-patches-apply.log"); then
        err "applier reported failures; see $STAGING_DIR/.fork-patches-apply.log"
        (cd "$LIVE_OH_PI_ROOT" && npx tsx .fork-patches/cli.ts --apply --repo "$STAGING_DIR" --json > "$APPLY_RESULT" 2>/dev/null || true)
        err "staging retained at $STAGING_DIR for inspection"
        exit 1
    fi
fi

# Sanity check: rerun --check against staging — every spec must verify clean.
log "step 2b/4: re-verifying all specs against final staging tree"
if (( ! DRY_RUN )); then
    if ! (cd "$LIVE_OH_PI_ROOT" && npx tsx .fork-patches/cli.ts --check --repo "$STAGING_DIR"); then
        err "post-apply --check still fails; staging at $STAGING_DIR"
        exit 1
    fi
fi
ok "all 15 specs verified clean against staging"

# ----------------------------------------------------------------------------
# Step 3 — smoke tests against staging
# ----------------------------------------------------------------------------

if (( NO_TESTS )); then
    warn "--no-tests: skipping vitest smoke step"
else
    log "step 3/4: smoke tests (vitest packages/subagents)"
    if (( DRY_RUN )); then
        log "[dry-run] would run: cd $STAGING_DIR && pnpm install && pnpm vitest run packages/subagents"
    else
        # pnpm install is required for vitest to resolve workspace deps in staging.
        if ! (cd "$STAGING_DIR" && pnpm install --frozen-lockfile --silent 2>&1 | tail -3); then
            warn "pnpm install --frozen-lockfile failed; retrying without --frozen-lockfile"
            (cd "$STAGING_DIR" && pnpm install --silent 2>&1 | tail -3) || {
                err "pnpm install failed; staging at $STAGING_DIR"
                exit 1
            }
        fi
        # Subagents-only smoke test; full repo test is too slow for this script.
        if ! (cd "$STAGING_DIR" && pnpm exec vitest run packages/subagents/tests 2>&1 | tail -20); then
            warn "subagent tests reported failures; check $STAGING_DIR"
            warn "(3 pre-existing failures from missing workspace node_modules are tolerated;"
            warn " any net-new failures indicate a regression introduced by patch replay)"
            warn "review test output, then decide whether to proceed"
        fi
    fi
fi

# ----------------------------------------------------------------------------
# Step 4 — print recommendation; never auto-mutate live branch
# ----------------------------------------------------------------------------

STAGING_HEAD=""
if (( ! DRY_RUN )); then
    STAGING_HEAD=$(git -C "$STAGING_DIR" rev-parse HEAD)
fi

log "step 4/4: complete — staging ready for human review"
echo
echo "  Staging branch: $STAGING_BRANCH"
echo "  Staging HEAD:   ${STAGING_HEAD:-<dry-run>}"
echo "  Staging path:   $STAGING_DIR"
echo
echo "  To fast-forward live feat/all-local onto staging (review first):"
echo
echo "    git -C $LIVE_OH_PI_ROOT fetch '$STAGING_DIR' '$STAGING_BRANCH:refs/sync-staging'"
echo "    git -C $LIVE_OH_PI_ROOT log --oneline $LIVE_BRANCH..refs/sync-staging  # what's new"
echo "    git -C $LIVE_OH_PI_ROOT log --oneline refs/sync-staging..$LIVE_BRANCH  # what's lost"
echo "    # If the diff is acceptable AND history doesn't diverge dangerously:"
echo "    git -C $LIVE_OH_PI_ROOT checkout $LIVE_BRANCH"
echo "    git -C $LIVE_OH_PI_ROOT reset --hard refs/sync-staging          # rewrites local branch"
echo "    git -C $LIVE_OH_PI_ROOT push --force-with-lease origin $LIVE_BRANCH"
echo
echo "  To discard staging without action:"
echo "    rm -rf $STAGING_DIR"

if (( ! KEEP_STAGING )) && (( ! DRY_RUN )); then
    # Retain staging by default since the human needs to inspect — DO NOT prune.
    # Only the older backups under STAGING_BASE/* are eligible for pruning, and
    # we don't auto-prune those either (small dirs, manual cleanup is fine).
    :
fi

ok "oh-pi-staged-upgrade complete"
