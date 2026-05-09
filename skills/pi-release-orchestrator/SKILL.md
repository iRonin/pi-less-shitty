---
name: pi-release-orchestrator
description: Maintain a complete pi release with ALL customizations — oh-pi, pi-less-shitty extensions, runtime patches, and dist modifications. The single source of truth for "is my pi fully customized?"
tags: [pi-coding-agent, oh-pi, release, upgrade, extensions, patches]
---

# Pi Release Orchestrator

Maintains a **complete pi release** with ALL customizations integrated. No more checking out single branches and calling it done.

## Architecture

```
Customizations are spread across 3 repos:

1. pi (npm package)                    — @earendil-works/pi-coding-agent
                                          (legacy: @mariozechner/pi-coding-agent, pre-0.74.0; now scope-aware via packages/pi-resolve)
   └─ Runtime patches applied to dist/ files at startup

2. oh-pi (local fork)                  — ~/Work/Pi-Agent/oh-pi
   └─ Branch: feat/all-local (ALL your changes merged)
   └─ Loaded from: ~/.pi/agent/settings.json → packages

3. pi-less-shitty (local monorepo)     — ~/Work/Pi-Agent/pi-less-shitty
   └─ 28 extensions loaded from package.json
```

## oh-pi: feat/all-local Branch

This branch has **ALL** your oh-pi changes merged from 10+ feature branches:

| Feature | Source Branch | Status |
|---------|--------------|--------|
| Cascading agent discovery | feat/cascading-agents | ✓ Merged |
| Explicit agent paths (.pi/settings.json) | feat/cascading-agents | ✓ Merged |
| Configurable parallel/concurrency limits | feat/subagent-configurable-limits | ✓ Merged |
| Custom tool resolution | fix/subagent-custom-tool-resolution | ✓ Merged |
| Extension tool filter (read_full etc.) | fix/subagent-extension-tool-filter | ✓ Merged |
| Idle timeout watchdog | fix/subagent-idle-timeout | ✓ Merged |
| Session model inheritance | fix/subagent-inherit-session-model | ✓ Merged |
| Widget wrap debug output | fix/subagent-widget-wrap-debug | ✓ Merged |
| Missing reference fixes | fix/subagent-missing-reference | ✓ Merged |
| CWD skill resolution tests | fix/subagent-cwd-skill-resolution | ✓ Merged |
| Verbose call params | ironin-release | ✓ Merged |
| Subagent harness | ironin-release | ✓ Merged |
| Agent path resolution fix | ironin-release | ✓ Merged |

**Settings loads from:** `~/.pi/agent/settings.json` → `packages: ["../../Work/Pi-Agent/oh-pi/packages/subagents"]`

**To activate:** `cd ~/Work/Pi-Agent/oh-pi && git checkout feat/all-local` then restart pi.

## Maintenance Workflow

### When upstream oh-pi has new releases

```bash
cd ~/Work/Pi-Agent/oh-pi

# 1. Fetch latest upstream
git fetch upstream main

# 2. Update main
git checkout main
git merge upstream/main --no-edit

# 3. Rebase all-local on top of new main
git checkout feat/all-local
git rebase main

# 4. Resolve any conflicts (your changes take priority)
# 5. Test: cd packages/subagents && npm test
# 6. Restart pi
```

### When you create a new oh-pi feature branch

```bash
# Create branch from feat/all-local (NOT from main)
cd ~/Work/Pi-Agent/oh-pi
git checkout feat/all-local
git checkout -b feat/my-new-feature

# When done, merge back into feat/all-local
git checkout feat/all-local
git merge feat/my-new-feature --no-edit
```

### After npm update (pi core)

```bash
# Runtime patches re-apply automatically at session_start
# Verify with /startup-status command
```

## Verification Checklist

### Quick check (agents use this)

```bash
cd ~/Work/Pi-Agent/pi-less-shitty && npx tsx scripts/release-check.ts
```

Exit code 0 = all checks pass. Output has ✓/✗ for each check.

### Patch-applier check (agents use this for runtime patches)

```bash
npx tsx ~/Work/Pi-Agent/pi-less-shitty/packages/patch-applier/src/cli.ts --check --json
```

Exit code 0 = all migrated specs verify clean. Use this BEFORE `npm update` to know what's currently good, and AFTER to re-derive anything that broke.

### Full verification

```bash
# 1. Check oh-pi branch
cd ~/Work/Pi-Agent/oh-pi
git branch --show-current  # Should be: feat/all-local

# 2. Run release check script
cd ~/Work/Pi-Agent/pi-less-shitty && npx tsx scripts/release-check.ts

# 3. Verify all migrated patch-applier specs
npx tsx ~/Work/Pi-Agent/pi-less-shitty/packages/patch-applier/src/cli.ts --check

# 4. After pi starts, run /startup-status or /release-check
```

## What Each Customization Does

### pi-less-shitty Extensions (28 packages)

| Package | Purpose |
|---------|---------|
| read-full | Read files up to 150KB with collapsible TUI output |
| smart-dequeue | Alt+Up: steer first, then follow-up, quick-press append |
| prompt-dump | /prompt-dump: replaces lost --prompt-dump CLI flag |
| startup-status | Reports runtime patch status at startup |
| smart-compaction | Heuristic turn scoring for context compression |
| loop-detector | Detects and breaks tool-call loops |
| model-sort-fix | Runtime patch: colon-aware model ranking |
| model-registry-fix | Runtime patch: apiKey + models.json survival |
| queue-emojis | 🎯/📥 emojis in pending queue display |
| agents-listing | `[Agents]` section in native startup header with ctrl+o expand |
| prompt-prefix | Visual prefix for user messages |
| prompt-stash | Prompt drafting and stash management |
| session-recall | Session ID on exit, quick resume |
| session-title | Terminal title bar |
| cascading-skills | Walk parent dirs for skills |
| hooks + safety-hooks | Permission system + safety guards |
| keybindings | Custom key bindings |
| ctrl-a-multiline | Ctrl+A navigation |
| ctrl-e-multiline | Ctrl+E navigation |
| git-permissions | Git-aware file permissions |
| clear-on-double-esc | Clear editor on double Escape |
| autocomplete-base-paths | Fuzzy file search across roots |
| content-filter | Content filtering |
| compaction-tokens | Token tracking |
| name-collision-detector | Agent/skill name collision warnings |
| kilocode-model-fix | KiloCode model compatibility |
| hindsight | Hindsight memory integration |
| subagent-tester | Subagent testing |

### oh-pi (feat/all-local)

| Feature | Detail |
|---------|--------|
| Cascading agents | Discover agents from ancestor `.pi/agents/` dirs |
| Explicit agent paths | `.pi/settings.json` → `agents: ["path1", "path2"]` |
| Configurable limits | `.pi/settings.json` → `subagent.maxParallel`, `subagent.maxConcurrency` |
| Extension tool filter | read_full and other extension tools work in subagents |
| Idle timeout | Kill stuck subagents after 15 min (configurable) |
| Session model inherit | Subagents inherit parent session model |
| Verbose call params | Detailed subagent call logging |
| Widget wrap debug | Debug output for async widgets |

### Runtime Patches (applied at startup)

| Patch | Target | Status Check |
|-------|--------|-------------|
| smart-dequeue | interactive-mode.js | `restoreQueuedMessagesToEditorSmart` |
| queue-emojis | interactive-mode.js | `🎯 Steer:` |
| agents-listing | interactive-mode.js | `// --- agents-listing patch ---` |
| model-sort-fix | model-resolver.js | `a.id.includes(":")` |
| model-registry-fix | model-registry.js | `authStorage.hasAuth(providerName)` |

## Important Rules

1. **NEVER** check out a single feature branch and call it "the release"
2. **ALWAYS** merge new branches into `feat/all-local` first
3. **ALWAYS** create new branches FROM `feat/all-local`, not from `main`
4. **NEVER** modify the fork (iRonin/pi-mono) — it's dead weight
5. **ALWAYS** verify with `npx tsx scripts/release-check.ts` after upgrades
6. **ALWAYS** verify migrated runtime patches with `patch-applier --check` after `npm update`
7. **ALWAYS** test with `npm test` in oh-pi after merges
8. **NEW patches MUST be authored as `patch-applier` specs**, not as legacy `.shitty-pi` files or string-anchored extension patchers — the spec format survives upstream refactors automatically
9. Agents: run `scripts/release-check.ts` to verify the release before doing any work

## Related skills and agent

- `~/Work/.pi/skills/patch-applier/SKILL.md` — AI-driven runtime patch authoring + application
- `~/Work/.pi/skills/pi-upgrade-checker/SKILL.md` — dry-run upstream impact analysis
- `~/Work/Pi-Agent/pi-less-shitty/skills/pi-upgrade/SKILL.md` — upgrade execution
- `~/Work/Pi-Agent/pi-less-shitty/skills/dist-patches/SKILL.md` — legacy `.shitty-pi` reference (deprecated path)
- Custom orchestration agents can tie all of the above together for autonomous upgrade workflows
