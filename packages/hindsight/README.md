# pi-hindsight — Domain-aware agent memory for Pi

Integrates [Hindsight](https://github.com/vectorize-io/hindsight) into the Pi coding agent as a seamless memory extension. Sessions become stateful — the agent remembers decisions, patterns, and solutions across sessions.

## What it does

- **Auto-recall** — Memories from past sessions are injected into context on the first user turn, and re-injected when a topic shift is detected (Phase F)
- **Auto-retain** — After each agent turn, the conversation is saved to Hindsight (delta-only, append mode)
- **Domain-aware isolation** — Memory is scoped by project via `.hindsight/config.toml` files with parent-traversal
- **Manual tools** — `hindsight_recall`, `hindsight_retain`, `hindsight_reflect`, `hindsight_promote` for explicit control
- **Commands** — `/hindsight status`, `/hindsight stats`, `/hindsight health`, `/hindsight reset`, `/hindsight refresh` for monitoring and recovery
- **Topic-shift recall** (Phase F) — jaccard-overlap + N-turn fallback + trigger-phrase heuristic re-fires recall mid-session when the topic drifts; bounded by cooldown to avoid thrash
- **Health gate** (Phase C) — opt-in policy that blocks new prompts when hindsight silently fails, so you don't keep losing memory writes without noticing

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
global_bank = "global"

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

## Recall lifecycle commands

| Command | Effect |
|---|---|
| `/hindsight reset` | Clear the unhealthy flag (if any) AND reset the topic-shift recall state. Next turn fires fresh recall. |
| `/hindsight refresh` | Like reset for the recall side only: forces the next user turn to fire a fresh recall regardless of topic-shift heuristic. Use when you want to manually pull fresh memories (mimics `/clear` for context). |

## Robustness settings (Phase C)

User-tunable via `~/.pi/agent/hindsight.json`. Project-scoped overrides via flat snake_case keys in `.hindsight/config.toml` (project values win over user-wide JSON).

```json
{
  "healthGate": "warn",
  "recallRetry": { "attempts": 3, "backoffMs": 1000 },
  "recallTimeoutMs": 5000,
  "topicShiftRecall": {
    "enabled": true,
    "heuristic": "hybrid",
    "cooldownSeconds": 60,
    "everyNTurns": 8,
    "jaccardThreshold": 0.2
  }
}
```

| Setting | Default | Description |
|---|---|---|
| `healthGate` | `"warn"` | `"off"` — never warns or blocks. `"warn"` — status bar only (current behavior). `"block"` — abort the next turn (calls `ctx.abort()`) if hindsight is unhealthy, with an injected message explaining how to recover. |
| `recallRetry.attempts` | `3` | Per-call retry attempts on transient errors (timeout, 5xx, network). Clamped 1–10. |
| `recallRetry.backoffMs` | `1000` | Initial backoff between retries; doubles each attempt, capped at 30s. Clamped 0–60000. |
| `recallTimeoutMs` | `5000` | Per-attempt timeout in ms (bumped from pre-Phase-C 2000ms — the root cause of the persistent `⚠ retrying` status bar; production recall against a real bank with remote LLM rerank typically takes 2.0–2.4s). Clamped 500–60000. |
| `topicShiftRecall.enabled` | `true` | Phase F master switch. When false, auto-recall fires only on the first user turn (pre-F behavior). |
| `topicShiftRecall.heuristic` | `"hybrid"` | `"jaccard"` — token-overlap only. `"hybrid"` — jaccard + N-turn fallback + high-precision trigger phrases. `"off"` — equivalent to `enabled: false`. |
| `topicShiftRecall.cooldownSeconds` | `60` | Unconditional minimum interval between recalls. Beats every shift signal. Clamped 0–86400. |
| `topicShiftRecall.everyNTurns` | `8` | Hybrid only: force a re-fire after this many turns regardless of similarity. Clamped 1–1000. |
| `topicShiftRecall.jaccardThreshold` | `0.2` | Re-fire when token-set overlap drops below this. Clamped 0–1. |

### What marks hindsight UNHEALTHY?

- A zero-facts retain detected by Phase B's background watcher (silent LLM failure)
- Auth error (HTTP 401/403) on every configured bank during recall
- Recall exhausted all retries on the FINAL session attempt

### What clears UNHEALTHY?

- A subsequent successful recall (self-heal once the upstream LLM gateway recovers)
- `/hindsight reset` (manual override after fixing the root cause)

### Equivalent TOML keys (project scope)

```toml
health_gate = "block"
recall_retry_attempts = "3"
recall_retry_backoff_ms = "1000"
recall_timeout_ms = "5000"
```

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
