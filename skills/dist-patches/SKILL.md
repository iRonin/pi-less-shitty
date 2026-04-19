---
title: Dist Patches
description: Re-apply custom patches to pi dist files after npm update
---

# Dist Patches

Custom patches to pi's installed dist files (`/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/dist/`). These are **not extensions** — they modify upstream pi source directly.

After every `npm update @mariozechner/pi-coding-agent`, re-apply them.

## How to Apply

For each `.shitty-pi` file in `patches/`:

> **Note:** Most patches target `dist/` under the pi-coding-agent package. The `anthropic-tool-parameters` patch targets `node_modules/@mariozechner/pi-ai/dist/` (a transitive dependency). Both live under `/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/`.
1. Read the patch file — it describes the target, purpose, and exact code to inject
2. Read the current upstream file at the target path
3. Apply the changes described in the patch file
4. Restart pi and verify

## Active Patches

| Patch | Target | Purpose |
|-------|--------|---------|
| `user-message-borders` | `dist/modes/interactive/components/user-message.js` | Yellow borders + OSC 133;A iTerm2 mark + ● PROMPT marker |
| `clipboard-image-rendering` | `dist/modes/interactive/interactive-mode.js` | Render pasted clipboard images inline after user prompts |
| `anthropic-tool-parameters` | `node_modules/@mariozechner/pi-ai/dist/providers/anthropic.js` | Fix `Cannot read properties of undefined (reading 'properties')` crash on tools without parameter schemas |

## How to Add a New Patch

1. Create `patches/<name>.shitty-pi`
2. Write header: target path, what it does, how to apply
3. Write the exact code blocks to inject/replace
4. List each change with "Before"/"After" context
5. Include "If upstream changed" fallback instructions
