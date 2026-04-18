---
title: Dist Patches
description: How to apply custom patches to pi dist files after npm update
---

# Dist Patches

Custom patches applied to the installed pi package at `/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/dist/`.

These modify upstream pi source — **not extensions**. After every `npm update`, you must re-apply them.

## Quick Apply

```bash
bash ~/Work/Pi-Agent/pi-less-shitty/scripts/apply-patches.sh
```

This copies patched files from `patches/*/dist-backup/` over the npm originals.

## Active Patches

### user-message-borders

**File:** `dist/modes/interactive/components/user-message.js`

**What it does:**
- Adds yellow horizontal borders (warning color) around each user prompt
- Injects `OSC 133;A` iTerm2 shell integration mark at each prompt (enables Cmd+Shift+Up/Down navigation)
- Adds centered `● PROMPT` text in the top border for visual scanning

**Source:** `patches/user-message-borders/dist-backup/user-message.js`

**Upstream change detection:** If the upstream `UserMessageComponent.render()` method signature or structure changes, the patch will still apply (it's a full file copy) but may break behavior. After npm update, verify:
1. Yellow borders still appear on user prompts
2. No TUI rendering errors in console
3. Restart pi and test

**If upstream changes break it:**
- Compare new upstream `user-message.js` with our `dist-backup/user-message.js`
- Re-implement the three features (borders, OSC mark, text marker) in the new upstream structure
- Update `patches/user-message-borders/dist-backup/user-message.js` with the new implementation
- The diff between upstream and our patch is in `patches/user-message-borders/user-message.patch`

## How to Add a New Patch

1. Create directory: `patches/<name>/`
2. Copy the **original upstream file** to `patches/<name>/upstream.js` (for diffing)
3. Apply your changes, save to `patches/<name>/dist-backup/<filename>`
4. Generate diff: `diff -u patches/<name>/upstream.js patches/<name>/dist-backup/<filename> > patches/<name>/<filename>.patch`
5. Add entry to `scripts/apply-patches.sh`
6. Document the patch below
