# Cascading SYSTEM.md Extension for pi

Walk ancestor directories for `.pi/SYSTEM.md`. Pi's stock `core/resource-loader.js` only checks two places: `<cwd>/.pi/SYSTEM.md` and `<agentDir>/SYSTEM.md`. Any intermediate `<ancestor>/.pi/SYSTEM.md` is invisible.

## Why this matters

A specialist SYSTEM.md (legal, scientific, role-specific) typically sits at the top of a working tree — e.g. `~/Work/Legal Opinion Action/.pi/SYSTEM.md` — while real work happens in deeper case- and phase-specific subfolders. Stock pi treats those subfolders as ordinary cwds and silently falls back to the built-in coding-agent base prompt. The specialist persona vanishes the moment you `cd` one level deeper.

This patches `discoverSystemPromptFile()` to walk `cwd → root` looking for `.pi/SYSTEM.md` (first match wins), then fall back to `<agentDir>/SYSTEM.md`, then return `undefined` so pi activates its built-in base.

## Semantics

Unlike its sibling `cascading-append-system` (additive — concatenates every match), `SYSTEM.md` is REPLACEMENT semantics: exactly one file replaces the built-in base prompt. So this extension is **first-match-wins**, deepest cwd ancestry preferred:

| Order | Source |
|-------|--------|
| 1 | `<cwd>/.pi/SYSTEM.md` |
| 2..N | `<ancestor>/.pi/SYSTEM.md` walked cwd → root |
| N+1 | `<agentDir>/SYSTEM.md` (global fallback) |
| else | `undefined` → pi loads its built-in base prompt |

## Solution

The extension patches `core/resource-loader.js` at extension load and re-applies on `session_start` to survive pi upgrades. One method body replacement (idempotent, marker-guarded).

## Idempotency

The new method body carries a marker comment (`PATCHED by @ironin/pi-cascading-system-md`); the patcher short-circuits if it's already present.

## Verification

```bash
# 1. dist patched
grep -c "PATCHED by @ironin/pi-cascading-system-md" \
  /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/resource-loader.js
# expect: 1

# 2. ancestor SYSTEM.md actually loads from a deeper cwd
cd "<ancestor>/<deep>/<subfolder>" && pi --prompt-dump 2>&1 | grep -E "SYSTEM\.md"
# expect: line pointing to <ancestor>/.pi/SYSTEM.md, not "<built-in base>"
```

## Patch Anchors

The patcher matches the legacy method body by regex. A future pi refactor that renames `discoverSystemPromptFile` or changes its body shape will make the patch a no-op (silent). Smoke-test after every pi upgrade.
