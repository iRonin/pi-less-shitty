---
name: pi-upgrade
description: Safely upgrade pi to the latest npm version while preserving all customizations. Checks for new version, applies runtime patches, verifies extensions load, and waits for user confirmation before installing.
tags: [pi-coding-agent, upgrade, compatibility, extensions, pi-less-shitty]
---

# Pi Upgrade Skill

Safely upgrade pi to the latest release while preserving all custom extensions and runtime patches.

> **Scope rename (May 2026, pi v0.74.0+).** The package was renamed from `@mariozechner/pi-coding-agent` → `@earendil-works/pi-coding-agent`, and the upstream repo from `github.com/badlogic/pi-mono` → `github.com/earendil-works/pi-mono`. Our infrastructure is now scope-aware:
>
> - `staged-upgrade.sh` auto-detects which upstream the staged build resolves to, and handles cross-scope swaps (old install dir is preserved as a backup until you delete it manually).
> - Patches and extensions resolve the live dist via `findPiCodingAgentDistFromCaller` (`packages/pi-resolve/src/index.ts`) instead of hardcoding the install path.
> - Examples below still show `@mariozechner/...` literal paths for the pre-0.74.0 install layout — substitute `@earendil-works/...` once you've upgraded; both names are accepted by the resolver.

## When to Use

- On request to upgrade pi
- After `npm update` to verify patches survived
- Periodic audit of what changed upstream

## Architecture

All customizations live in `pi-less-shitty`. No fork needed.

```
pi-less-shitty/
├── packages/                    # Extensions
│   ├── read-full/              # read_full tool with TUI rendering
│   ├── smart-dequeue/          # Alt+Up smart queue retrieval
│   ├── prompt-dump/            # /prompt-dump command
│   ├── prompt-prefix/          # Visual prefix for user prompts
│   ├── cascading-skills/       # Walk parent dirs for skills
│   ├── hooks/                  # Regex-based permission system
│   ├── keybindings/            # Custom key bindings
│   ├── prompt-stash/           # Prompt drafting and stash management
│   ├── session-recall/         # Session ID on exit, quick resume
│   ├── session-title/          # Terminal title bar
│   ├── ctrl-a-multiline/       # Rapid Ctrl+A navigation
│   ├── ctrl-e-multiline/       # Rapid Ctrl+E navigation
│   ├── queue-emojis/           # 🎯/📥 emojis in queue display
│   ├── git-permissions/        # Git-aware file permissions
│   ├── clear-on-double-esc/    # Clear editor on double Escape
│   ├── smart-compaction/       # Heuristic turn scoring
│   ├── loop-detector/          # Detect tool-call loops
│   ├── autocomplete-base-paths/ # Fuzzy file search across roots
│   ├── content-filter/         # Content filtering
│   ├── model-sort-fix/         # Runtime patch: model-resolver.js
│   └── model-registry-fix/     # Runtime patch: model-registry.js
├── skills/
│   ├── pi-upgrade/             # This skill
│   └── dist-patches/           # Runtime patch documentation
└── scripts/
    └── apply-patches.sh        # Manual patch re-application
```

## Execution Plan

### Step 1: Check versions

Version source is `origin/main` of `earendil-works/pi-mono` (formerly `badlogic/pi-mono` pre-0.74.0; auto-detected by `staged-upgrade.sh`) — NOT the npm registry. We rebuild from source for every upgrade.

```bash
# Use whichever scope is currently installed; the resolver in packages/pi-resolve handles both.
PI_PKG_DIR=$(node -e "const r=require('@earendil-works/pi-coding-agent/package.json'); console.log(require.resolve('@earendil-works/pi-coding-agent/package.json'))" 2>/dev/null \
  || node -e "console.log(require.resolve('@mariozechner/pi-coding-agent/package.json'))")
LOCAL_VER=$(node -e "console.log(require('$PI_PKG_DIR').version)")
LOCAL_COMMIT=$(node -e "const p=require('$PI_PKG_DIR'); console.log(p.gitHead || 'unknown')")
LATEST_COMMIT=$(git ls-remote https://github.com/earendil-works/pi-mono.git refs/heads/main | awk '{print $1}')
echo "Local: v$LOCAL_VER ($LOCAL_COMMIT)"
echo "Latest origin/main: $LATEST_COMMIT"
```

If `LOCAL_COMMIT == LATEST_COMMIT`, report "Already up to date" and stop.

### Step 2: Dry-run upgrade check (patch-applier)

Before actually upgrading, run `patch-applier --check` to verify all patches are currently in a known-good state:

```bash
npx tsx ~/Work/Pi-Agent/pi-less-shitty/packages/patch-applier/src/cli.ts --check --json
```

The CLI walks every spec in `pi-less-shitty/packages/patch-applier/specs/`, runs each spec's `verify(content)` against the current dist, and reports `verified` / `failed` with specific failure messages.

**Interpretation:**
- `0 failed` — everything is currently well-patched; safe to proceed to npm update
- `N failed` — patches are currently broken (likely from a prior partial upgrade); STOP and run `patch-applier` to repair before upgrading

For any *legacy* `.shitty-pi` patches that have not yet been migrated to specs, fall back to the manual grep checks documented in `dist-patches/SKILL.md`.

Legacy patterns (still useful for unmigrated patches):

```bash
# Resolve the live dist via pi-resolve instead of hardcoding the scope.
DIST=$(node -e "import('/Users/ironin/Work/Pi-Agent/pi-less-shitty/packages/pi-resolve/src/index.ts').then(m=>{const r=m.findPiCodingAgentDist({});if(r)console.log(r.distDir);else process.exit(1)})" 2>/dev/null \
  || echo "/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/dist")  # legacy fallback
# user-message-borders target
grep -q "\\u001b]133;A" "$DIST/modes/interactive/components/user-message.js" && echo "user-message-borders: OK" || echo "user-message-borders: CHANGED"
# clipboard-image-rendering target
grep -q "clipboardImage" "$DIST/modes/interactive/interactive-mode.js" && echo "clipboard-image: OK" || echo "clipboard-image: CHANGED"
```

### Step 3: Staged upgrade from origin/main (with user confirmation)

**Hard requirement:** the live install must never be broken during an upgrade. The flow is **build → patch → test → swap**, with the live install untouched until the swap succeeds and the post-swap smoke test passes.

Use `staged-upgrade.sh`. It does all of this atomically:

```bash
~/Work/Pi-Agent/pi-less-shitty/scripts/staged-upgrade.sh
```

What it does, in order:

1. **Pre-flight** — verifies the current dist patches all pass `patch-applier --check`. If the current install is already broken, refuse to upgrade (would just propagate the breakage).
2. **Stage clone + build** — fresh clone of `origin/main` into `/tmp/pi-staged-upgrade/<short-hash>-<timestamp>/src/`, runs `npm install` and `npm run build` there. **Never touches live.**
3. **Stage package** — `npm install --prefix <staging>/install` to produce a self-contained `@earendil-works/pi-coding-agent/` directory (or `@mariozechner/pi-coding-agent/` for pre-0.74.0 builds — auto-detected) with all transitive deps under its own `node_modules/`. **Never touches live.**
4. **Patch staging** — runs `patch-applier --dist <staging>/install/.../dist` to derive and apply every spec against the staged dist. Verifies all specs pass `--check` before continuing. **Never touches live.**
5. **Smoke test staging** — runs `node <staged>/dist/cli.js --version`, `--help`, and an optional non-interactive smoke session. **Never touches live.**
6. **Atomic swap** — `mv` live to `pi-coding-agent.backup-<ver>-<hash>-<timestamp>`, then `mv` staging into live. Both renames are atomic on the same filesystem.
7. **Post-swap verify** — runs `node <live>/dist/cli.js --version`. If it fails, automatically rolls back to the backup.
8. **Retention** — keeps the 3 most recent backups, prunes older.

Useful flags:

```bash
# Dry-run: log what would happen, change nothing
staged-upgrade.sh --dry-run

# Build + patch + test only, don't swap (inspect the staged install manually)
staged-upgrade.sh --build-only

# Keep the staging dir after a successful swap (for inspection)
PI_KEEP_STAGING=1 staged-upgrade.sh
```

Exit codes:
- `0` — success; live is now origin/main, patched, verified
- `1` — failure during build/patch/test; **live install untouched**
- `2` — failure during swap (rare); auto-rollback attempted; check for `.failed-<timestamp>` dir
- `3` — invocation error

### Rollback

If a post-upgrade session reveals deeper breakage that the smoke tests didn't catch:

```bash
~/Work/Pi-Agent/pi-less-shitty/scripts/rollback.sh           # restore most recent backup
~/Work/Pi-Agent/pi-less-shitty/scripts/rollback.sh --list     # show available backups
~/Work/Pi-Agent/pi-less-shitty/scripts/rollback.sh --backup <path>   # restore a specific backup
```

The broken install is moved aside (kept as `.failed-<timestamp>`) for diagnosis.

### Step 4: Re-derive any broken patches with patch-applier

After `npm update`, the dist files are overwritten. Patches must be re-applied. The legacy extension `session_start` handlers do this automatically for unmigrated patches. For specs in `patch-applier`, run:

```bash
# Re-apply all specs (dispatches an AI agent for any that need updating)
npx tsx ~/Work/Pi-Agent/pi-less-shitty/packages/patch-applier/src/cli.ts --json
```

**Output to expect:**
- `applied` for any spec where the AI agent had to derive new text edits (e.g. because pi refactored a function and the old anchors no longer matched)
- `already` for specs that survived the upgrade unchanged
- `failed` — STOP. Read the failure message; it tells you whether the spec needs updating (intent unclear, verify too strict) or whether the agent needs more hint context

For unmigrated `.shitty-pi` patches, restart pi and check stderr for `[extension-name] patched / already / FAILED` from the legacy `session_start` re-applier.

### Step 5: Test pi starts

```bash
# Quick smoke test - start pi with --help to verify it loads
pi --help > /dev/null 2>&1 && echo "pi starts OK" || echo "pi failed to start"
```

### Step 6: Verify extensions load

Check that all pi-less-shitty extensions are loaded:

```bash
# After pi starts, verify in the startup header or via /extensions command
```

### Step 7: Report to user

```
## Pi Upgrade Report

**Local:** 0.67.6 → **Latest:** 0.67.68

### Patch Survival

| Extension | Status | Notes |
|-----------|--------|-------|
| model-sort-fix | ✅ Survived | Patch pattern still matches |
| model-registry-fix | ✅ Survived | Both patches match |
| smart-dequeue | ⚠️ Needs update | handleDequeue signature changed |
| queue-emojis | ✅ Survived | Emoji markers still present |
| user-message-borders | ✅ Survived | Border patterns match |
| ... | | |

### Extension API Changes
- [ ] None found ✅
- [x] <specific change> — affects <extension>

### Recommended Actions
1. <action item>
```

## Automated Upgrade Loop

For fully automated upgrades (with user confirmation before install):

1. **Check** for new version
2. **Clone** both versions for diff comparison
3. **Analyze** breaking changes (Extension API, tool signatures, etc.)
4. **Check** runtime patch survival
5. **Upgrade** npm package
6. **Apply** patches (session_start handlers do this automatically)
7. **Test** pi starts
8. **Report** status and wait for user confirmation
9. **Install** (restart pi)

## Important Notes

- **Patch-applier specs auto-recover** when upstream pi refactors break the old text anchors — the AI agent reads the new dist and derives the right edits
- **Legacy `.shitty-pi` patchers do NOT auto-recover** — they fail silently when upstream changes shape; migrate them to specs (see `patch-applier` skill)
- **Extensions with `session_start` handlers** re-check and re-apply patches on every session start (legacy and patch-applier alike)
- **If a spec verify fails**, fix the SPEC, not a hardcoded edit — the spec is the durable artifact
- **The fork on GitHub is NOT used** — all customizations are in pi-less-shitty
- **Always run `patch-applier --check` after upgrade** before marking the upgrade as complete
