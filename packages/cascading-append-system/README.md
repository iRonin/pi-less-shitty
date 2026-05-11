# Cascading APPEND_SYSTEM.md Extension for pi

Cascade `APPEND_SYSTEM.md` across parent directories. Pi's stock `core/resource-loader.js` only ever loads one `APPEND_SYSTEM.md` (project else global). This extension patches the loader so every ancestor `<dir>/.pi/APPEND_SYSTEM.md` plus the global `<agentDir>/APPEND_SYSTEM.md` is appended.

## Problem

Pi's `discoverAppendSystemPromptFile()` returns the first match:

```text
project/.pi/APPEND_SYSTEM.md   ← used if it exists
else
~/.pi/agent/APPEND_SYSTEM.md   ← global fallback
```

Any intermediate `<ancestor>/.pi/APPEND_SYSTEM.md` is silently shadowed. So a layered architecture like:

```text
~/.pi/agent/APPEND_SYSTEM.md   GLOBAL
~/Work/.pi/APPEND_SYSTEM.md    DEV
~/Work/project/.pi/APPEND_SYSTEM.md  project
```

…only ever loads the project one when running from `~/Work/project/`. The other two are dead files.

## Solution

The extension patches `core/resource-loader.js` at extension load (and re-applies on `session_start` to survive pi upgrades). Two changes:

1. **Method body:** `discoverAppendSystemPromptFile()` becomes a back-compat wrapper. A new `discoverAppendSystemPromptFiles()` method returns the full cascade as an ordered array.

2. **Call site:** The single `appendSources` construction in `compute()` is rewritten to use the new array method.

## Cascade Order

Loaded LAST-overrides-FIRST narratively (pi just concatenates with `\n\n`):

| Order | Source |
|-------|--------|
| 1 | `<agentDir>/APPEND_SYSTEM.md` — global |
| 2..N | Every `<ancestor>/.pi/APPEND_SYSTEM.md` walked from root → cwd |

`<cwd>/.pi/APPEND_SYSTEM.md` is therefore appended LAST, giving it final-word position for the model.

## Idempotency

Both patches include a marker comment (`PATCHED by @ironin/pi-cascading-append-system`) and short-circuit if already applied. Safe to re-run on every session start.

## Verification

Use `pi --prompt-dump-dry` (from `@ironin/pi-prompt-dump`) to confirm the cascade is active:

```text
APPEND_SYSTEM.md (CASCADE active — all matches loaded, agentDir + cwd → root)
    ✓ used    ~/.pi/agent/APPEND_SYSTEM.md (agentDir)
    ✓ used    ~/Work/.pi/APPEND_SYSTEM.md (/Users/ironin/Work)
    ✓ used    ~/Work/project/.pi/APPEND_SYSTEM.md (cwd)

...

  ✓ APPEND_SYSTEM.md cascade: 3/3 loaded (CASCADE active)
```

If the verification reports `1/3 loaded (stock pi single-match)`, the patches did not apply — check extension load order and pi version drift.

## Patch Anchors

The patcher matches the legacy method body and call site by regex. If a future pi upgrade refactors `discoverAppendSystemPromptFile` (renames it, inlines it, changes the loader shape), the regex will miss and the patch will be a no-op. The verification step in `--prompt-dump-dry` will flag this as drift, prompting an anchor refresh.
