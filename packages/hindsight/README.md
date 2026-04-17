# pi-hindsight — Domain-aware agent memory for Pi

Integrates [Hindsight](https://github.com/vectorize-io/hindsight) into the Pi coding agent as a seamless memory extension. Sessions become stateful — the agent remembers decisions, patterns, and solutions across sessions.

## What it does

- **Auto-recall** — Before each agent turn, relevant memories from past sessions are injected into context
- **Auto-retain** — After each agent turn, the conversation is saved to Hindsight (delta-only, append mode)
- **Domain-aware isolation** — Memory is scoped by project via `.hindsight/config.toml` files with parent-traversal
- **Manual tools** — `hindsight_recall`, `hindsight_retain`, `hindsight_reflect` for explicit control
- **Commands** — `/hindsight status` and `/hindsight stats` for monitoring

## Prerequisites

1. **Hindsight server** running (Docker recommended):

```bash
docker run -d --name hindsight --restart unless-stopped \
  -p 8787:8888 -p 9999:9999 \
  -e HINDSIGHT_API_LLM_PROVIDER=openrouter \
  -e HINDSIGHT_API_LLM_API_KEY=sk-or-v1-xxx \
  -e HINDSIGHT_API_LLM_MODEL=qwen/qwen3.6-plus \
  -v ~/.hindsight/pgdata:/home/hindsight/.pg0 \
  ghcr.io/vectorize-io/hindsight:latest
```

2. **Config file** at `~/.hindsight/config.toml`:

```toml
api_url = "http://localhost:8787"
api_key = ""
recall_types = "observation"
```

## Project configuration

Place `.hindsight/config.toml` in any project directory. The extension walks up from CWD and merges all configs (child wins).

```toml
# ~/.hindsight/config.toml — user defaults
api_url = "http://localhost:8787"

# ~/Work/.hindsight/config.toml — shared across all Work projects
global_bank = "work-all"

# ~/Work/MyProject/.hindsight/config.toml — project-specific
bank_id = "project-MyProject"
```

### Config keys

| Key | Purpose | Required |
|---|---|---|
| `bank_id` | Active project bank — scope boundary for retain/recall | **Yes** (or bank is skipped) |
| `global_bank` | Cross-project shared pool — always queried in recall | No |
| `api_url` | Hindsight server URL | No (default: `http://localhost:8888`) |
| `recall_types` | Memory types to recall (comma-separated) | No (default: `observation`) |

### Recall behavior

- Always queries `bank_id` + `global_bank` (if set)
- Results merged and injected as `<hindsight_memories>` in context

### Retain behavior

- Retains to `bank_id` only by default
- `#global` or `#me` in user prompt → also retains to `global_bank`

## Install

Add to your `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    "../pi-hindsight"
  ]
}
```

Restart Pi. The extension loads automatically — no further setup needed.

## Verify

In Pi, run:
```
/hindsight status
```

Should show bank name, server health, and hook status.

## Opt-out

| Tag | Effect |
|---|---|
| `#nomem` or `#skip` | Skip retain for this turn |

**Retain strategy**: Auto-retain → project bank only. For cross-domain learnings, agent calls `hindsight_retain` with `scope: "global"` → resolves to domain's `global_bank` automatically.
| `#bug`, `#architecture`, etc. | Attached as Hindsight tags for filtering |

## Bootstrap: migrate past sessions

```bash
cd ~/Work/Pi-Agent/Hindsight/pi-hindsight

# Dry run — see what would be migrated
node --experimental-strip-types bootstrap.ts --limit 20

# Actually retain to Hindsight
node --experimental-strip-types bootstrap.ts --commit --limit 50

# Verbose (shows skipped sessions)
node --experimental-strip-types bootstrap.ts --verbose
```

The bootstrap script:
- Scans `~/.pi/agent/sessions/**/*.jsonl`
- Extracts user/assistant turn pairs
- Routes each session to the correct bank based on CWD → parent-traversal of `.hindsight/config.toml`
- Skips sessions without explicit `bank_id` (no implicit banks)
- Newest sessions first (more weight)
- Dry run by default

## Architecture

```
Pi Session                     Hindsight Server
    │                                │
    │── session_start ──────────────→│ verify connectivity
    │── before_agent_start ─────────→│ recall memories → inject context
    │── agent_end ──────────────────→│ retain turn (append mode)
    │── session_compact ────────────→│ reset recall state
```

## License

MIT
