# Hooks System — V2 Redesign

## Problem

Current hooks system shows a user dialog for **every** potentially destructive command, regardless of context. This is:
- **Nagging** — `rm /tmp/build/artifacts` triggers a dialog even though /tmp is ephemeral
- **Dumb** — `kill -9 12345` on a process the agent spawned 2 seconds ago is fine, but prompts
- **Wasting context** — agent knows file is git-tracked (reversible), but we prompt anyway
- **rm over trash** — agent uses `rm` everywhere, user loses files outside git projects

## Proposed Architecture

### Layer 1: Hard Blocks (no change)
Never allowed. Returns `{ block: true, reason: "..." }` immediately.
- `sudo`, `dd`, `mkfs`, `diskutil`, device writes, destructive SQL, `kill -1`

### Layer 2: `rm` → `trash` Rewrite (transparent)
When `rm` targets files **outside `/tmp`**, rewrite the tool call to use `trash` instead.

**How**: Intercept at `tool_call`, check if command starts with `\brm\s+`, analyze paths. If any path is outside `/tmp`, rewrite `command` field from `rm /path/to/file` → `trash /path/to/file`.

- No dialog, no agent involvement — transparent rewrite
- Only rewrites the actual `rm` invocation, not `rm` inside `bash -c` (that's opaque)
- If `trash` is not installed, fall back to blocking with suggestion to install it
- User can override per-project via `.pi-hooks.json`: `{ "action": "allow", "command": "rm /specific/path" }`

### Layer 3: Agent Feedback (replaces user dialogs)
Instead of prompting the user, **block the command** and return a **structured analysis** as the tool result. The agent reads this and decides:

```json
{
  "block": true,
  "destructiveness": "moderate",
  "category": "file_operation",
  "summary": "Force-kills process 'myapp' (PID 5678)",
  "analysis": "kill -9 is irreversible. Process 'myapp' appears to be a development server running on port 3000. This action is likely safe if this is a process you started in this session.",
  "context": {
    "targets": ["PID 5678 (myapp)"],
    "reversible": false,
    "git_tracked": false,
    "in_tmp": false
  },
  "suggestion": "If unsure, use 'kill' (SIGTERM) instead of 'kill -9' (SIGKILL) to allow graceful shutdown. Or call notify_user to confirm with the user."
}
```

**Key insight**: The LLM can read this analysis and:
- If it's obviously safe (tmp files, its own processes) → adjust and retry with a safer command
- If unsure → call `notify_user` tool
- If the user configured a rule → the rule would have allowed it at Layer 3a

### Layer 3a: `.pi-hooks.json` Rules (user override)
User-configured rules bypass Layer 3. If a command matches an `allow` rule, it passes through silently. This is the user's "I know what I'm doing" escape hatch.

### Layer 4: `notify_user` Tool (new)
A tool the agent calls when it needs user confirmation:

```
notify_user(
  title: "Confirm destructive operation",
  description: "This will permanently delete 47 files in ~/Documents/old-projects/. These are NOT in git. OK to proceed?",
  choices: ["Proceed", "Use trash instead", "Cancel"]
)
```

Shows the same dialog UI as before, but:
- Triggered by the **agent** when it wants confirmation
- Shows a **human-readable description**, not a raw command
- Agent controls the wording — explains what will happen

### Layer 5: System Prompt Injection
Append to system prompt (via `before_agent_start`):

```
## Command Safety
- Use `trash` instead of `rm` for files outside /tmp (automatic rewrite is in place)
- Files in git repos are recoverable — `rm` on git-tracked files is fine
- /tmp, /private/tmp, and ~/Downloads are always safe for writes
- If you're unsure whether a command is safe, call `notify_user` to confirm
```

## What Gets Blocked → Analyzed vs What Passes

| Command | Current | New |
|---------|---------|-----|
| `rm /tmp/test` | passes | passes |
| `rm ~/Documents/report.pdf` | user dialog | transparent rewrite → `trash ~/Documents/report.pdf` |
| `rm src/index.ts` (git-tracked) | user dialog | passes (git-tracked = recoverable) |
| `kill -9 12345` (agent's process) | user dialog | blocked → analysis → agent retries with `kill 12345` |
| `kill -9 SystemUIServer` | user dialog | blocked → analysis → agent calls `notify_user` |
| `bash -c "find / -name foo"` | user dialog | blocked → analysis |
| `find ~/project -name "*.log" -delete` | user dialog | passes (project dir + git-tracked) |
| `sudo apt install foo` | hard block | hard block (no change) |

## Implementation Plan

### Phase 1: `notify_user` tool
- Register as custom tool via `pi.registerTool()`
- Returns `ctx.ui.select()` with configurable choices
- Plays attention sound

### Phase 2: Structured blocking (agent feedback)
- Replace `askPermission()` calls with `blockWithAnalysis()`
- Build analysis from: command type, path safety, git status, process ownership
- Return structured JSON as `reason` field

### Phase 3: `rm` → `trash` rewrite
- Detect `rm` in tool_call before any other check
- Parse target paths
- If any outside `/tmp`, rewrite command to use `trash`
- Verify `trash` is installed, suggest install if not

### Phase 4: System prompt injection
- Hook `before_agent_start`, append safety guidelines
- Keep it concise — 4-5 lines max

### Phase 5: Clean up
- Remove `permission-ui.ts` dialog code (except `notify_user` UI)
- Remove `safety-hooks.ts` permission dialog code
- Consolidate into single `index.ts` with clear layers

## What Stays vs What Goes

| Component | Status |
|-----------|--------|
| Hard blocks | **Keep** — unchanged |
| `.pi-hooks.json` config store | **Keep** — user override |
| Session allowlist | **Keep** — "allow for session" |
| `askPermission()` user dialog | **Remove** — replaced by analysis + notify_user |
| `rm` file ops prompts | **Remove** — replaced by transparent rewrite |
| Dangerous command prompts | **Remove** — replaced by analysis |
| ALWAYS_ASK prompts | **Remove** — replaced by analysis |
| `attentionSound()` / `agentDoneSound()` | **Keep** — for notify_user |
| `promptingFor` concurrency guard | **Keep** — if notify_user needs it |
| `safety-hooks.ts` | **Merge into index.ts** — single file |
