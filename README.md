# pi-less-shitty

A monorepo of pi extensions that make it less shitty.

Some of these should go into pi-mono but trying to suggest issues and PRs to Mario Zechner turned out to be a shitty experience. Shitty Coders Club == contributors are being treated like shit. Thankfully soon to be sorted out by AI.

Vibed by my clanker. Use at your own risk. I test as I go.

## Packages

| Package | Description |
|---------|-------------|
| `@ironin/pi-autocomplete-base-paths` | Multi-directory `@` file autocomplete with per-project config (runtime patch) |
| `@ironin/pi-cascading-skills` | Walks parent dirs to collect skills from every `.pi/` level |
| `@ironin/pi-clear-on-double-esc` | Clear editor on double Escape |
| `@ironin/pi-content-filter` | Sanitizes profanity from prompts, memories, and tool results via wildcard patterns |
| `@ironin/pi-ctrl-a-multiline` | Rapid Ctrl+A presses navigate to previous lines |
| `@ironin/pi-ctrl-e-multiline` | Rapid Ctrl+E presses navigate to next lines |
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
| `@ironin/pi-queue-emojis` | Adds 🎯/📥 emojis to steer/follow-up queue displays |
| `@ironin/pi-read-full` | Read entire files with configurable cap (bypasses 50KB limit) |
| `@ironin/pi-session-recall` | Session info on exit, /q, /resume-last, /sessions |
| `@ironin/pi-session-title` | Auto-title sessions |
| `@ironin/pi-smart-compaction` | Heuristic turn scoring for compaction instead of blanket LLM summary |

## Dist Patches

After `npm update`, read `skills/dist-patches/SKILL.md`. It contains `.shitty-pi` patch files with inline diffs and instructions for re-applying changes to freshly installed dist files.

| Patch | Target | Purpose |
|-------|--------|---------|
| `user-message-borders` | `dist/modes/interactive/components/user-message.js` | Yellow borders + `OSC 133;A` iTerm2 mark + `● PROMPT` center marker |
| `clipboard-image-rendering` | `dist/modes/interactive/interactive-mode.js` | Render pasted clipboard images as 30-cell previews with clickable "Open in Preview" links |
| `anthropic-tool-parameters` | `node_modules/@mariozechner/pi-ai/dist/providers/anthropic.js` | Fix crash when tools lack `parameters` schema (`tool.parameters ?? {}`) |

## Settings

```json
{
  "defaultProvider": "kilocode",
  "defaultModel": "qwen3.6-plus",
  "defaultThinkingLevel": "high",
  "retry.maxRetries": 10,
  "steeringMode": "all",
  "followUpMode": "all",
  "theme": "dark-true",
  "hideThinkingBlock": false,
  "autocompleteMaxVisible": 10
}
```

## Prompt Architecture

### SYSTEM.md (replaces default prompt)
- Walks up tree from cwd, first `.pi/SYSTEM.md` wins, falls back to `~/.pi/agent/SYSTEM.md`
- Extension override via `resources_discover` event — cascading-skills returns `systemPromptPaths`

### APPEND_SYSTEM.md (appended after default/SYSTEM.md)
- Collects ALL `.pi/APPEND_SYSTEM.md` walking up tree (most-specific first), then `~/.pi/agent/APPEND_SYSTEM.md`

### Content preprocessing
- HTML comment stripping (`<!-- ... -->`) from all prompt files
- Triple+ newlines collapsed to double newlines

### Prompt Assembly Order
```
├─ SYSTEM.md (or Default prompt)
├─ APPEND_SYSTEM.md (cascading, all levels)
├─ # Project Context (all CLAUDE.md/AGENTS.md collected up the tree)
├─ <available_skills> (discovered from all .pi/skills/ dirs)
└─ Current date + cwd
```

### `--prompt-dump`
Global flag that prints the assembled system prompt and exits.

### `resources_discover` extension interface
Extended `ResourcesDiscoverResult`:
- `systemPromptPaths?: string[]` — cascading SYSTEM.md paths
- `appendSystemPromptPaths?: string[]` — cascading APPEND_SYSTEM.md paths

## Extensions (monorepo)

### pi-read-full
Read entire files with configurable cap (built-in `read` caps at 50KB / 2000 lines).
- **Default limit:** 150KB
- **Settings:** `~/.pi/agent/read-full.json` → `{ "maxBytes": 153600 }`
- **Commands:** `/read-full` · `set <N>kb|mb` · `reset`

### pi-smart-compaction
Intercepts `session_before_compact` to replace blanket LLM summarization with heuristic turn scoring.
- `keepThreshold: 6`, `dropThreshold: 5`, `summarizeHigh/Low: true`
- **Commands:** `/smart-compress` · `stat` · `tune [N]` · `review [N] [CLASS]` · `dry` · `hist [N]`

### pi-keybindings
Configurable key bindings with interactive wizard.

### pi-cascading-skills
Walks parent directories to collect skills from every `.pi/` level.

### pi-prompt-prefix
Visual-only prefix for user prompts in TUI. Zero token cost. Stripped for queued messages (Alt+Enter).

### pi-clear-on-double-esc
Clear editor on double Escape.

### pi-ctrl-a-multiline
Rapid Ctrl+A: first press → start of line, second (within 500ms) → start of previous line. Patches `editor.js` with state tracking.

### pi-ctrl-e-multiline
Rapid Ctrl+E: first press → end of line, second (within 500ms) → end of next line. Patches `editor.js` with state tracking.

### pi-loop-detector
Detects and breaks degenerate tool-call loops before they waste tokens.
- **Strategies:** `generic_repeat` · `poll_no_progress` · `ping_pong`
- **Modes:** `stop` (default) · `warn` · `prune`
- **Config:** `LOOP_DETECTION_ENABLED` · `WARNING_THRESHOLD` (3) · `CRITICAL_THRESHOLD` (5) · `MODE` (stop|warn|prune)

### pi-queue-emojis
🎯 Steer: message / 📥 Follow-up: message in pending queue status display.

### pi-git-permissions
Git-aware file permissions guard via `.ai-permissions` files with regex matching and default-deny policy.

### pi-session-title
Shows session name in terminal title bar via `ctx.ui.setTitle()`.

### pi-hooks
Regex-based permission system with `.pi-hooks` config files.
- **bash-safety** — blocks/asks for destructive commands (sudo, dd, mkfs, etc.)
- **pdf-guard** — blocks full reads of large PDFs
- **pdfenv-guard** — forces specific PDF scripts to use `/tmp/pdfenv/bin/python3`
- **trailing-spaces-guard** — warns when `edit` removes markdown double-space line breaks

### pi-prompt-stash
Prompt drafting and stash management. Per-CWD storage at `~/.pi/agent/stashes/<encoded-cwd>.json`.

| Shortcut | Action |
|----------|--------|
| `Ctrl+S` | Editor has text → stash + clear. Empty → pop latest into editor |
| `Ctrl+Shift+S` | Show stash picker |

| Command | Action |
|---------|--------|
| `/stash` | Interactive stash picker |
| `/stash <text>` | Save text directly |
| `/stash pop [n]` | Restore stash |
| `/stash clear` | Clear all |
| `/stash auto on/off` | Auto-stash every submitted prompt |

### pi-session-recall
Session info on exit, quick resume commands.
- **Exit output:** session ID, name, end time, `pi --session "..."` command
- **`/q`** — Quick quit
- **`/resume-last`** — Resume most recent session in current folder
- **`/sessions`** — Browse & switch between recent sessions (top 15, scoped to CWD)

### pi-hindsight
Domain-aware agent memory via [Hindsight](https://github.com/vectorize-io/hindsight). Auto-recall before each agent turn, auto-retain after completion.

| Tool | Detail |
|------|--------|
| `hindsight_recall` | Pull relevant context from project memory |
| `hindsight_retain` | Save insight with `scope: "project"` or `scope: "global"` |
| `hindsight_reflect` | Synthesize insights across past sessions |

**Commands:** `/hindsight status` · `/hindsight stats`

**Config:** `.hindsight/config.toml` — parent-traversal from CWD (child wins). `bank_id` (active project bank), `global_bank` (cross-scope shared pool).

**Hindsight server:** Docker on `localhost:8787`, LLM via OpenRouter (`qwen/qwen3.6-plus`).

### pi-kilocode-model-fix
Fixes custom-provider (kilocode, etc.) default model resolution at startup. Intercepts `session_start` to apply configured models after provider registration.

### pi-model-sort-fix
Fixes `:variant` sort order bug in `tryMatchModel` — base models preferred over `:free`, `:nitro`, etc.

### pi-model-registry-fix
Fixes apiKey validation too strict (#3043) and `registerProvider` wiping models.json (#3044).

### pi-content-filter
Sanitizes profanity from prompts, memories, and tool results via wildcard patterns.

### pi-autocomplete-base-paths
Multi-directory `@` file autocomplete with per-project config. Reads `autocompleteBasePaths` from `.pi/settings.json` and runs `fd` against cwd + base paths.

## Extensions (standalone)

### Shell wrapper (`~/.zshrc`)
Intercepts `pi --resume-last` / `-rl` to find and resume the latest session for the current directory.

### Skills

**Global** (`~/.pi/agent/git/github.com/badlogic/pi-skills/`):
- `browser-tools` — Chrome DevTools Protocol automation
- `brave-search` — Web search via Brave Search API
- `vscode` — Diff viewing and file comparison

**Via cascading-skills** (`~/Work/.pi/skills/`):
- `code-reviewer` · `codebase-inspection` · `github-auth` · `github-issues` · `github-workflow` · `multi-pr-fork` · `security-researcher` · `subagent-driven-dev` · `systematic-debugging` · `tdd` · `writing-plans`

**Project-specific** (`~/Work/Pi-Agent/.pi/skills/`):
- `pi-contributor` · `pi-less-shitty-monorepo`

## Themes

### `dark-true` (`~/.pi/agent/themes/dark-true.json`)
Custom dark theme: cyan accent `#00d7ff`, blue `#5f87ff`, green `#b5bd68`. Active via `settings.json` → `"theme": "dark-true"`.

## Keybindings

Custom keybindings at `~/Work/Pi-Agent/pi-less-shitty/packages/keybindings/`.

## Fork Patches (pi-mono)

### Core changes (built into local fork)
| Fix | File | Status |
|-----|------|--------|
| `:variant` sort order | `packages/coding-agent/src/core/model-resolver.ts` | Re-applied after upgrades |
| `gpt-tokenizer` dependency | `packages/coding-agent/package.json` — dev dep for `--prompt-dump` | Installed locally |

### `--prompt-dump` feature
CLI flag that prints assembled system prompt with token analysis (tiktoken), context file breakdown, resource discovery tree, and tool status.

### `resources_discover` extension interface
Extended `ResourcesDiscoverResult` with `systemPromptPaths` and `appendSystemPromptPaths`. Changes across `extensions/types.ts`, `extensions/runner.ts`, `agent-session.ts`.

### Cascading-skills extension
`discoverSystemMd(cwd)` and `discoverAppendSystemMd(cwd)` — walks cwd → HOME, collects all `.pi/SYSTEM.md` and `.pi/APPEND_SYSTEM.md` files.

## Open PRs (badlogic/pi-mono)

| # | PR | Description | Status |
|---|----|-------------|--------|
| 1 | #2957 | Regenerate models.generated.ts from live APIs | Open |
| 2 | #2958 | Fix `:variant` sort order in `tryMatchModel` | Open |
| 3+4 | #2959 | Skip redundant apiKey + models.json survives registerProvider | Open |
| 5 | — | kilocode `supportsDeveloperRole` fix | On branch `fix/developer-role-compat` in fork |

## Hindsight Server

Docker container on Orbstack:

| Item | Value |
|------|-------|
| Image | `ghcr.io/vectorize-io/hindsight:latest` |
| API | `http://localhost:8787` |
| UI | `http://localhost:9999` |
| LLM | OpenRouter `qwen/qwen3.6-plus` |
| Data | `~/.hindsight/pgdata` |

## Hermes Compressor Fixes (hermes-context-compressor)

| Fix | File | Detail |
|-----|------|--------|
| `score_all_turns` context bug | `scorer.py` | Was using `messages[head_end:...]` instead of `region[context_start:i]` |
| New HIGH signals | `scorer.py` | Code blocks, commit hashes, "I will use", more directive verbs |
| Adaptive threshold performance | `compressor.py` | Pre-compute message tokens once |
| Benchmark config | `benchmark.py` | `simulate_default_compressor` accepts configurable `context_length` |
| Tests | `test_scorer.py` | 3 new tests — 60 total passing |

## Session Files

Location: `~/.pi/agent/sessions/--<encoded-path>--/<timestamp>_<uuid>.jsonl`

## Local Commands

```bash
cd ~/Work/Pi-Agent/pi-kilocode/pi-kilocode && npm test
```

## License

MIT
