---
title: Dist Patches
description: Reference for legacy `.shitty-pi` patch files. New patches should use the `patch-applier` skill (AI-driven specs + verify). This skill is now mostly historical documentation for patches that have not yet been migrated.
---

# Dist Patches

> **Status: legacy reference.** New patches MUST be authored as specs under `patch-applier`, not as `.shitty-pi` files. See `~/Work/.pi/skills/patch-applier/SKILL.md`. New code should resolve the dist via `findPiCodingAgentDistFromCaller` from `packages/pi-resolve/src/index.ts` rather than hardcoding the install path.
>
> The string-anchored patches in this folder break on every upstream pi refactor. The `.shitty-pi` files exist as fallback documentation — if `patch-applier` ever fails to derive edits and a human needs to step in, these files describe the intended transformation in pre-AI form.

Custom patches to pi's installed dist files (`/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/` on v0.74.0+, or `…/@mariozechner/pi-coding-agent/dist/` for pre-0.74.0 installs — both layouts are accepted; resolve via `packages/pi-resolve` rather than hardcoding the scope). These are **not extensions** — they modify upstream pi source directly.

## Preferred path: `patch-applier`

For any new pi customization that needs to modify dist files:

```bash
# Author a spec at:
~/Work/Pi-Agent/pi-less-shitty/packages/patch-applier/specs/<id>.ts

# Verify it (dry-run):
npx tsx ~/Work/Pi-Agent/pi-less-shitty/packages/patch-applier/src/cli.ts --check --spec <id>

# Apply it (dispatches an agent to derive minimal text edits):
npx tsx ~/Work/Pi-Agent/pi-less-shitty/packages/patch-applier/src/cli.ts --spec <id>
```

The spec format is: `intent` (durable plain-language) + `verify(content)` (programmatic behavior check, no text anchors). Read the patch-applier skill for full authoring rules.

## Legacy fallback workflow

For patches that have NOT yet been migrated to `patch-applier`, the legacy flow still works but is fragile:

For each `.shitty-pi` file in `patches/`:

> **Note:** Most patches target `dist/` under the pi-coding-agent package. The `anthropic-tool-parameters` patch targets `node_modules/@earendil-works/pi-ai/dist/` (or `@mariozechner/pi-ai/` on pre-0.74.0; a transitive dependency). Both live under the resolved pi-coding-agent install dir — use `findPiCodingAgentDistFromCaller` to locate it.

1. Read the patch file — it describes the target, purpose, and exact code to inject
2. Read the current upstream file at the target path
3. Apply the changes described in the patch file
4. Restart pi and verify

## Patches Not Yet Migrated (still using `.shitty-pi`)

| Patch | Target | Purpose |
|-------|--------|---------|
| `user-message-borders` | `dist/modes/interactive/components/user-message.js` | Yellow borders + OSC 133;A iTerm2 mark + ● PROMPT marker |
| `clipboard-image-rendering` | `dist/modes/interactive/interactive-mode.js` | Render pasted clipboard images inline after user prompts |
| `anthropic-tool-parameters` | `node_modules/@earendil-works/pi-ai/dist/providers/anthropic.js` (or `@mariozechner/pi-ai` pre-0.74.0; resolve via `packages/pi-resolve`) | Fix `Cannot read properties of undefined (reading 'properties')` crash on tools without parameter schemas |

**These should be migrated to `patch-applier` specs.** See migration map in the patch-applier skill.

## Patches Migrated to `patch-applier`

| Patch | Spec |
|-------|------|
| `queue-emojis` | `pi-less-shitty/packages/patch-applier/specs/queue-emojis.ts` |

## Migrating a `.shitty-pi` to a spec

1. Read the `.shitty-pi` file — understand the *intent*, not the text edits
2. Create `pi-less-shitty/packages/patch-applier/specs/<id>.ts`
3. Write `intent` as durable plain language (no variable names, no anchors)
4. Write `verify(content)` checking the BEHAVIORAL outcome (markers present + originals absent + no partial state)
5. Add tests in `test/applier.test.ts` including a future-version simulation (refactored variable name)
6. Verify with `patch-applier --check --spec <id>`
7. Apply with `patch-applier --spec <id>`
8. Once confirmed working, delete the `.shitty-pi` file and the legacy patcher package
