---
name: hindsight
description: Hindsight persistent memory system — retain/recall/reflect across sessions. Use when working on unfamiliar code, debugging recurring issues, or making architectural decisions.
---

# Hindsight Memory

Persistent memory for Pi sessions. Memories survive compaction and session restart.

## How It Works

- **Auto-recall**: Before each turn, relevant memories injected from project + global banks
- **Auto-retain**: After each turn, conversation saved to project bank (delta-only)
- **Manual tools**: `hindsight_recall`, `hindsight_retain`, `hindsight_reflect`, `hindsight_promote`

## When to Use Tools

| Tool | When |
|---|---|
| `hindsight_retain` | Turn contains insight worth remembering beyond this session |
| `hindsight_recall` | Working on unfamiliar code, need historical context |
| `hindsight_reflect` | Need to synthesize patterns across multiple past sessions |
| `hindsight_promote` | After a session — copy cross-project knowledge to global bank |

### Cross-Bank Access

Tools support explicit `bank` and `banks` parameters to query or write to any bank by name:

```typescript
// Query another project's memories
hindsight_recall(query="build system setup", bank="project-Hermes")

// Query multiple banks
hindsight_recall(query="auth patterns", banks=["project-Pi-Agent", "project-Hermes", "work-all"])

// Write directly to a specific bank
hindsight_retain(content="Use jiti for TypeScript extension loading", bank="project-Hermes")

// Copy memories between any two banks
hindsight_promote(query="tool preferences", from="project-Pi-Agent", to="work-all")
```

## Auto-retain vs Manual

**Auto-retain** fires after every turn — all routine conversation is saved to the project bank automatically. You don't need to call `hindsight_retain` for normal work.

**Use `hindsight_retain` when** a turn contains something important that should be easily findable as a standalone memory:

| Scope | Use for | Examples |
|---|---|---|
| `project` | Project-specific knowledge | "We use Zustand, not Redux", "API key is in env, not config" |
| `global` | Cross-project knowledge | "Always run `npm run build` first", "OpenRouter rate limits at 60 req/min" |

**Default scope is `project`**. Only use `global` when the insight genuinely applies across multiple projects.

## When NOT to Use

| Situation | Why |
|---|---|
| Routine coding tasks | Auto-retain handles it |
| Obvious facts ("this is a React component") | Not worth persisting |
| Temporary debugging steps | Noise, not signal |

## Commands

- `/hindsight status` — Server health, bank auth, hook status
- `/hindsight stats` — Memory/document counts per bank

## Tags

| Tag | Effect |
|---|---|
| `#nomem` / `#skip` | Skip retain for this turn |
| `#global` / `#me` | Also retain to global bank |
| `#bug`, `#architecture`, etc. | Attached as Hindsight tags |

## Configurable Strip Patterns

Before retaining, the transcript is cleaned by removing matched patterns. Configure via `.hindsight/config.toml`:

```toml
strip_patterns = "Error:.*\\n", "at .*\\.js:\\d+.*"
```

**Defaults** (always applied, no config needed):
- `<hindsight_memories>` blocks — prevents feedback loops
- `<antThinking>`, `<thinking>`, `<reasoning>` blocks — reasoning is process noise
- Base64 image data — massive noise for text memory

**Suggested additions** for your config:
- Error stack traces: `"Error:.*\\n"`
- Node.js stack frames: `"at .*\\.js:\\d+.*"`
- Boilerplate: `"^Sure,? I.*"`
