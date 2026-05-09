# Smart Compaction for Pi Agent

Replaces pi's blanket LLM summarization with **heuristic turn scoring** that distinguishes between high-value content (design decisions, fixes, key outputs) and low-value noise (retry loops, acknowledgments, iterative edits).

Ported from [hermes-context-compressor](https://github.com/iRonin/hermes-context-compressor) and adapted for pi's extension API and `AgentMessage` format.

## Quick Start

### Install

```bash
ln -s ~/Work/Pi-Agent/pi-smart-compaction/src ~/.pi/agent/extensions/smart-compaction
```

Then `/reload` in pi.

### Analyze a session from CLI

```bash
pi --smart-compress <session-id-or-name>
```

This loads the session, scores every message, shows the classification breakdown, and exits — **without** compacting anything. Perfect for threshold tuning.

```
pi --smart-compress 2026-04-17T14
pi --smart-compress "refactor auth module"
```

### In-session commands

All analysis is under one command:

```
/smart-compress              ← Quick status + last compaction
/smart-compress stat         ← Aggregate statistics across all compactions
/smart-compress tune [N]     ← Score histogram + threshold simulation
/smart-compress review [N] [CLASS] ← Tabular review of scored messages
/smart-compress dry          ← Dry-run on current session (no compaction)
/smart-compress hist [N]     ← Last N compaction events
```

## How It Works

Intercepts `session_before_compact` (fires for both auto-compaction and `/compact`). Returns a custom `CompactionResult` that pi saves instead of its default LLM summary.

### Scoring (0–10)

Each message is scored based on content signals:

| Score | Classification | Treatment |
|-------|---------------|-----------|
| ≥ `keepThreshold` (6) | **HIGH** | Kept verbatim in summary + LLM-summarized for iterative safety |
| `dropThreshold` to `keepThreshold`-1 (5) | **MEDIUM** | Deterministic structured summary (no LLM) |
| < `dropThreshold` (<5) | **LOW** | Included in structured summary (since `summarizeLow: true`) |

### Signal Weights

**HIGH signals (+points):**
| Signal | Weight | Roles |
|--------|--------|-------|
| User/bash directives: "fix", "change", "create", "install", "build", "run"… | +3 | `user`, `bashExecution` |
| Design decisions: "I'll use", "pattern", "because", "strategy" | +3 | `assistant` |
| Error diagnosis: "issue was", "fixed by", "root cause" | +3 | `assistant` |
| File success: "file written", "created", "saved" | +2 | `toolResult` |
| Test passes: "12 passed", "all tests passed" | +2 | `toolResult` |
| Specific values: file paths, line numbers, error codes | +2 | `user`, `assistant`, `toolResult`, `bashExecution` |
| First occurrence of a tool pattern | +1 | `assistant` with tool calls |
| Write/edit tool calls | +2 | `assistant` with `write`/`edit` |

**LOW signals (−points):**
| Signal | Weight |
|--------|--------|
| Retry language: "oops", "let me try", "actually" | −2 |
| Tool error with same-tool retry (context-aware) | −2 |
| Acknowledgments: "ok", "got it", "sure", "will do" | −2 |
| Empty content without tool calls | −3 |

### Retry Loop Detection

When the same tool operates on the same file within 3 consecutive turns (write → error → write), the loop is detected and collapsed into a single entry with the final result.

### Summary Format

```
## Previous Context Checkpoint        ← from prior compaction (if any)
## Goal                               ← from user HIGH turns
## Key Decisions                      ← from assistant HIGH turns
## Collapsed Retry Loops              ← detected patterns
## Context Summary (High-Value Turns) ← LLM summary for iterative safety
## Tool Activity                      ← deterministic (MEDIUM+LOW)
## Files Referenced                   ← deterministic
## Key Content                        ← deterministic excerpts
<read-files>...</read-files>          ← from pi's fileOps
<modified-files>...</modified-files>  ← from pi's fileOps
```

### Pi Compaction Internals Respected

| Detail | How it's handled |
|--------|-----------------|
| `messagesToSummarize` + `turnPrefixMessages` | Combined — both discarded after compaction |
| `isSplitTurn` | Turn prefix noted in summary |
| `previousSummary` | Prepended as "Previous Context Checkpoint" for iterative merge |
| `fileOps` | Used directly from `preparation.fileOps` (accumulated by pi) |
| `customInstructions` | Passed to LLM summary prompt (from `/compact "focus on X"`) |
| `signal` | Passed to LLM calls for abort support |
| `CompactionResult` shape | `{ summary, firstKeptEntryId, tokensBefore, details }` — matches pi exactly |

## Settings (matching Hermes config)

| Setting | Default | Description |
|---------|---------|-------------|
| `keepThreshold` | 6 | Score ≥ this → HIGH (verbatim + LLM summary) |
| `dropThreshold` | 5 | Score < this → LOW (included in structured summary) |
| `retryWindow` | 3 | Same tool+file within N turns → collapse retry loop |
| `summarizeHigh` | true | Generate LLM summary of HIGH turns for iterative safety |
| `summarizeLow` | true | Include LOW turns in structured summary |
| `skipUnderMessages` | 6 | Don't score if too few messages (fall through to default) |

Override via environment:
```bash
export PI_SMART_COMPACT_KEEP=7
export PI_SMART_COMPACT_DROP=4
```

## Data Collection & Analysis

Every compaction automatically saves a snapshot to `~/.pi/agent/smart-compaction-data/`.

### `/smart-compress` (no args)

Quick status showing current session context, settings, last compaction summary.

### `/smart-compress stat`

Aggregate statistics across all recorded compactions:

```
Aggregate Statistics (15 compactions)

Totals:
  Messages scored: 782
  HIGH: 353 (45.1%)
  MEDIUM: 297 (38.0%)
  LOW: 132 (16.9%)
  Retry loops: 23
  Tokens saved: ~675K
  Avg per compaction: ~45.0K

Settings used: 6/5

Aggregate Score Distribution:
  10 │ ████████████████████    125
   9 │ ███████████████████     118
   8 │ ████████████████        105
   ...

Tuning: 45.1% HIGH — thresholds look well-balanced.
```

### `/smart-compress tune [N]`

Score histogram for Nth most recent compaction (default: 1) + **threshold simulation** showing what would happen with different keep/drop values:

```
Tuning: Compaction #1 (2026-04-17 14:32:00)
Settings: keep≥6 drop<5
Messages: 52 | Saved: ~85.2K

Score Distribution:
  10 │ ████████████████████    15 HIGH
   9 │ ████████████████        12 HIGH
   8 │ ██████████████          11 HIGH
   7 │ █████████████           10 HIGH
   6 │ ██████████               7 HIGH
   5 │ ████████████████        12 MED
   4 │ ██████                   6 LOW
   3 │ ██                       2 LOW

Threshold Simulation:
  Keep  Drop  │  HIGH  MED  LOW  │  Output  Saved
  ────────────┼───────────────────┼──────────────
  4     2     │   35    5    12  │ ~28.1K  ~92.4K
  4     3     │   35    8     9  │ ~31.2K  ~89.3K
  5     2     │   23   17    12  │ ~35.8K  ~84.7K
  5     3     │   23   20     9  │ ~38.1K  ~82.4K
  5     4     │   23   23     6  │ ~41.5K  ~79.0K
  6     2     │   12   28    12  │ ~42.3K  ~78.2K
  6     3     │   12   31     9  │ ~45.1K  ~75.4K
  6     4     │   12   34     6  │ ~48.2K  ~72.3K ← current
  6     5     │   12   28    12  │ ~42.3K  ~78.2K
  7     2     │    7   33    12  │ ~48.5K  ~72.0K
  7     3     │    7   36     9  │ ~51.2K  ~69.3K
  7     4     │    7   39     6  │ ~54.8K  ~65.7K
  7     5     │    7   33    12  │ ~48.5K  ~72.0K
  7     6     │    7   28    17  │ ~43.1K  ~77.4K
  8     2     │    4   36    12  │ ~52.3K  ~68.2K
  8     3     │    4   39     9  │ ~55.1K  ~65.4K
  8     4     │    4   42     6  │ ~58.2K  ~62.3K
  8     5     │    4   36    12  │ ~52.3K  ~68.2K
  8     6     │    4   33    15  │ ~48.1K  ~72.4K
  8     7     │    4   28    20  │ ~43.5K  ~77.0K
```

The "current" row is marked. You can see exactly how changing thresholds would affect your compression.

### `/smart-compress review [N] [CLASS]`

Tabular review of all scored messages from Nth most recent compaction, optionally filtered by class:

```
Scoring Review (52 total, 52 shown)
Compaction #1 — 2026-04-17 14:32:00
Session: --Users-username-Projects-myapp-

Score | Class │ Role   │ Content (truncated)
──────┼───────┼────────┼────────────────────────────────────
  10   │ HIGH  │ user   │ Rewrite the auth module to use refresh tokens
   8   │ HIGH  │ user   │ Fix the session expiration bug
   7   │ HIGH  │ ass    │ I'll use a sliding window expiration pattern...
   5   │ MED   │ ass    │ Reading auth.ts to understand the current...
   3   │ LOW   │ ass    │ ok got it, will do that now
   2   │ LOW   │ ass    │ oops let me try with sudo this time
```

Filter: `/smart-compress review 1 HIGH` or `/smart-compress review LOW`

### `/smart-compress dry`

Dry-run analysis on the **current** session — scores all messages, shows classification, estimated savings — **without** actually compacting:

```
╔══════════════════════════════════════════════════════════╗
║          Smart Compaction Analysis                     ║
╚════════════════════════════════════════════════════════╝

Session: --Users-username-Projects-myapp-
Settings: keep≥6 drop<5 | summarizeHigh=true summarizeLow=true

── Overview ──
Messages analyzed: 85
Tokens before:     ~145.2K
Tokens after:      ~52.8K
Tokens saved:      ~92.4K (64%)
Retry loops:       2

── Classification ──
  HIGH (verbatim):  38 (45%)
  MEDIUM (summary): 32 (38%)
  LOW (dropped):    15 (17%)

── Score Distribution ──
  10 │ ████████████████    12 HIGH
   9 │ ██████████████      10 HIGH
   8 │ ████████████         9 HIGH
  ...

> This is a dry run — no compaction was performed.
> Run /compact to actually compact the session.
```

### `/smart-compress hist [N]`

Last N compaction events (default: 10).

## CLI: Offline Session Analysis

```bash
# Analyze by session ID (full or partial)
pi --smart-compress 2026-04-17T14

# Analyze by session name (partial match)
pi --smart-compress "refactor auth"

# Analyze a specific session file path
pi --smart-compress "hermes-context"
```

Searches sessions by ID, name, or file path (case-insensitive, first match wins). Loads the session, runs the scoring analysis, prints results to stdout, and exits — **no compaction performed**.

## Installation

### Symlink (recommended — auto-updates with source)

```bash
mkdir -p ~/.pi/agent/extensions
ln -s ~/Work/Pi-Agent/pi-smart-compaction/src ~/.pi/agent/extensions/smart-compaction
```

Then `/reload`.

## Architecture

```
pi-smart-compaction/
├── src/
│   ├── smart-compaction.ts   # Extension: events, summary builder, data collection, commands, CLI
│   ├── scorer.ts             # Pure functions: scoreTurn, classify, scoreAllMessages
│   └── pattern-detector.ts   # Pure functions: detectRetryLoops, RetryLoop type
└── README.md
```

Pure functions (`scorer.ts`, `pattern-detector.ts`) are testable in isolation. The extension layer wires them into pi's lifecycle events and handles data collection/analysis.

### Data Flow

```
session_before_compact
  │
  ├─► Score all messages (0–10)
  ├─► Classify: HIGH / MEDIUM / LOW
  ├─► Detect retry loops
  ├─► Build structured summary
  ├─► (Optional) LLM summary of HIGH turns
  ├─► Store snapshot → ~/.pi/agent/smart-compaction-data/
  └─► Return CompactionResult to pi

pi --smart-compress SESSION  ──► Load session → Score all → Print analysis → Exit (no compaction)
/compact                     ──► Triggers session_before_compact → Full flow above
auto-compaction              ──► Same as /compact
```

## Comparison with Default Compaction

| Feature | Default Pi | Smart Compaction |
|---------|-----------|-----------------|
| Summarization | All messages summarized by LLM | HIGH verbatim + LLM summary, MEDIUM+LOW deterministic |
| HIGH content | Lost in summary | Preserved verbatim + summarized for safety |
| Retry loops | Not detected | Collapsed with final result |
| Noise (ok, got it) | Summarized | Filtered or included in structured summary |
| Custom instructions | Passed to LLM | Passed to LLM for HIGH summary |
| Summary format | pi standard | pi standard + custom sections |
| Info preservation | ~30% | ~70% |
| LLM cost | 1 call (main model) | 0–1 calls (cheap Gemini Flash for HIGH only) |
| Data collection | None | Automatic snapshots for offline analysis |
| Threshold tuning | N/A | Simulation grid showing all keep/drop combos |
| CLI analysis | N/A | `pi --smart-compress SESSION` for dry-run |

## License

MIT
