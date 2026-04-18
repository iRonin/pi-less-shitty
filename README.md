# pi-less-shitty

A monorepo of pi extensions that make it less shitty.

Some of these should go into pi-mono but trying to suggest issues and PRs to Mario Zechner truned out to be a shitty experience. Shitty Coders Club == contributors are being treated like shit. Thankfully soon to be sorted out by AI.

Vibed by my clanker. Use at your own risk. I test as I go.

## Packages

| Package | Description |
|---------|-------------|
| `@ironin/pi-autocomplete-base-paths` | Multi-directory `@` file autocomplete with per-project config (runtime patch) |
| `@ironin/pi-cascading-skills` | Walks parent dirs to collect skills from every `.pi/` level |
| `@ironin/pi-clear-on-double-esc` | Clear editor on double Escape |
| `@ironin/pi-git-permissions` | Git-aware file permissions guard |
| `@ironin/pi-hindsight` | Domain-aware persistent memory via Hindsight (recall/retain/reflect) |
| `@ironin/pi-hooks` | Regex-based permission system with `.pi-hooks` files |
| `@ironin/pi-keybindings` | Custom keybindings with wizard |
| `@ironin/pi-kilocode-model-fix` | Fixes custom-provider (kilocode, etc.) default model resolution at startup |
| `@ironin/pi-loop-detector` | Detects and prevents infinite retry loops |
| `@ironin/pi-model-sort-fix` | Fixes `:variant` sort order bug — base models preferred over `:free`, `:nitro`, etc. |
| `@ironin/pi-model-registry-fix` | Fixes apiKey validation (#3043) and models.json wipe (#3044) in model registry |
| `@ironin/pi-prompt-prefix` | Visual-only prefix for user prompts in TUI |
| `@ironin/pi-prompt-stash` | Ctrl+S stash/pop, Ctrl+Shift+S stash picker, per-CWD storage |
| `@ironin/pi-read-full` | Read entire files with configurable cap (bypasses 50KB limit) |
| `@ironin/pi-session-recall` | Session info on exit, /q, /resume-last, /sessions |
| `@ironin/pi-session-title` | Auto-title sessions |
| `@ironin/pi-smart-compaction` | Heuristic turn scoring for compaction instead of blanket LLM summary |
| `@ironin/pi-content-filter` | Sanitizes profanity from prompts, memories, and tool results via wildcard patterns |

## Install

Individual packages:
```bash
pi install npm:@ironin/pi-hindsight
pi install npm:@ironin/pi-read-full
pi install npm:@ironin/pi-smart-compaction
pi install npm:@ironin/pi-autocomplete-base-paths
```

Or install the whole suite via npm workspace:
```bash
pi install npm:@ironin/pi-less-shitty
```

## Local dev

```bash
cd ~/Work/Pi-Agent/pi-less-shitty
# Install dependencies (pi will handle this via package.json pi manifest)
```

## Dist Patches

After `npm update`, read `skills/dist-patches/SKILL.md`. It contains inline diffs and instructions for re-applying patches to the freshly installed dist files.

## License

MIT
