# Hindsight Self-Heal on Extraction LLM Failure — Design

Status: design, no implementation yet.
Scope: extend Phase D so that when "substantial input → 0 facts extracted" fires (the user-visible warning),
the turn's transcript is recovered automatically once the extraction LLM is healthy again,
without requiring a pi reload.

Source incident (verbatim from user):

```
💾 Hindsight saved turn to memory → legal-sewage  ‣ ctrl+o
⚠ Hindsight retain completed but added 0 units → legal-sewage (95s) [649 chars in]
  Substantial input → 0 facts extracted suggests the extraction LLM is down.
  Check `docker logs hindsight --tail 50` and `~/Work/llm-mode.sh status`.
```

The 95s / 0 units / 649 chars combination — and what `docker logs hindsight` shows in parallel
around 2026-05-12 21:02–21:04 UTC — is consistent with kilocode `limit_burst_rate` 429s during the
hindsight container's internal LLM retry budget (attempt=1/4 … 2/4 retain_extract_facts). See
"Failure mode taxonomy" below.

This document covers:

1. What the live code does today.
2. The taxonomy of "0 units" causes and which are recoverable.
3. Three self-heal alternatives, with pros/cons.
4. A phased recommendation.
5. Open questions.
6. Cross-references to prior commits.

---

## 1. Current state inventory

Live code: `packages/hindsight/index.ts` (1585 lines). The retain flow is split between three pi
lifecycle hooks and a fire-and-forget background watcher.

### 1.1 Retain flow path

The full path from "user finished a turn" → "memory committed":

```
pi.on("agent_end", async (event, ctx) => {            // index.ts:1320
  const config   = resolveConfig(process.cwd());      // parent-traversal of .hindsight/config.toml
  const prompt   = getLastUserMessage(ctx, currentPrompt);
  const skipCheck = shouldSkipRetain(prompt);         // length < 5, trivial regex, #nomem/#skip
  const bank     = getActiveBank(config);
  const tags     = extractTags(prompt);               // #foo hashtags, minus reserved
  const banks    = getRetainBanks(config, prompt);    // bank_id + global_bank if #global/#me
  const stripPatterns = getStripPatterns(config);

  const rawTranscript = buildTranscript(prompt, event.messages || [], stripPatterns);
  let transcript = rawTranscript.length > 50000
    ? rawTranscript.slice(0, 50000) + "\n...[TRUNCATED]"
    : rawTranscript;

  const sessionId    = ctx.sessionManager?.getSessionId?.() || `unknown-${Date.now()}`;
  const documentId   = `session-${sessionId}`;
  const transcriptLen = transcript.length;
  const preCounts    = await buildPreRetainSnapshot(api_url, api_key, banks, documentId);
  const t0           = Date.now();

  // Per-bank: POST /v1/default/banks/{bank}/memories with async: true
  //   body { items: [{ content, document_id, update_mode: "append", context, timestamp, tags }] }
  //   captures operation_id from response
  const results = await Promise.allSettled(banks.map(POST_memories));

  // Phase D background watchers — fire-and-forget, NOT awaited:
  for (const { bank, operationId } of fulfilled) {
    if (!operationId) continue;
    const snapshot: RetainSnapshot = {
      documentId,
      preUnitsCount: preCounts.get(bank) ?? 0,
      transcriptLen,
    };
    void watchRetainOperation(pi, ctx, config, bank, operationId, t0, snapshot);
  }

  // ... then pi.sendMessage("hindsight-retain") / "hindsight-retain-failed"
});
```

`watchRetainOperation` (index.ts:354) polls `/operations/{id}` every `POLL_INTERVAL_MS=5000` up to
`POLL_MAX_ATTEMPTS=24` (120 s max). On terminal status:

- `failed`                        → `pi.sendMessage({ customType: "hindsight-retain-failed-async", … })`
- `completed` + delta == 0 + substantial → `pi.sendMessage({ customType: "hindsight-retain-zero-units-extracted", … })`
- `completed` + delta > 0         → silent ok log
- `completed` + delta == 0 + small input → silent legit-zero log
- `not_found`                     → silent log
- 120 s timeout still pending     → silent log

### 1.2 What IS captured at the failure point

Inside `watchRetainOperation`, when the zero-units gate fires, this is the live scope:

```typescript
// index.ts:411 — the zero-units branch
if (delta <= 0 && substantial) {
  log(`retain-poll: zero-units op=${operationId} bank=${bank} age_ms=${op_age_ms}
       doc=${docId} pre=${snapshot.preUnitsCount} post=${postUnits}
       transcript_len=${snapshot.transcriptLen}`);
  try { ctx.ui.setStatus?.("hindsight", "⚠ 0 units extracted"); } catch {}
  try {
    const settings = loadSettings();
    if (settings.healthGate !== "off") markUnhealthy("zero units extracted");
  } catch (e) { log(`retain-poll: loadSettings failed ${e}`); }
  pi.sendMessage(
    {
      customType: "hindsight-retain-zero-units-extracted",
      content: "",
      display: true,
      details: {
        bank,
        operation_id: operationId,
        op_age_ms,
        document_id: docId,
        pre_units_count: snapshot.preUnitsCount,
        post_units_count: postUnits,
        transcript_len: snapshot.transcriptLen,
      },
    },
    { deliverAs: "nextTurn" },
  );
  return;
}
```

Available locally:

| name             | where bound          | useful for retry? |
|------------------|----------------------|-------------------|
| `bank`           | watcher arg          | yes (target)      |
| `operationId`    | watcher arg          | only for `failed` status; current op is `completed` |
| `docId`          | from `result_metadata.document_ids` fallback to `snapshot.documentId` | yes |
| `snapshot.preUnitsCount` | watcher arg  | yes (diagnostic)  |
| `snapshot.transcriptLen` | watcher arg  | gate decision     |
| `config`         | watcher arg          | yes (api_url, key, banks) |
| `op.error_message` | from /operations GET | absent on `completed` |

**Critical gap:** the actual transcript **text** is **not** in `RetainSnapshot`. By the time the
watcher fires (5–120 s after agent_end returned), the `transcript` local in the agent_end
closure is unreachable from the watcher's scope. The closure that holds it is on the watcher
chain only via `snapshot` — which intentionally stores `transcriptLen` and not the body.

This is the load-bearing fact for any self-heal: **a retry needs the transcript, so we either
have to thread it into the snapshot, persist it before POSTing, or re-derive it from
`event.messages`** — which is only available inside `agent_end`.

The `RetainSnapshot` type (index.ts:330):

```typescript
export interface RetainSnapshot {
  documentId: string;
  preUnitsCount: number; // 0 if document didn't exist yet
  transcriptLen: number;
}
```

### 1.3 What is LOST when zero-units fires

- The full transcript body (only its length is kept).
- The original `tags` extracted from the prompt.
- The original `context` string (`pi | YYYY-MM-DD HH:MM TZ`).
- The full multi-bank fan-out (the watcher only knows its own bank; the second bank in `banks`
  may also have failed but is tracked by a sibling watcher).

The status bar is set to `⚠ 0 units extracted` and `healthState` is marked unhealthy. The
unhealthy flag self-heals on the next successful recall (`markHealthy()` at index.ts:1267) — but
the lost transcript is not recovered by that path.

### 1.4 Phase D warning emit path

Customtype: `hindsight-retain-zero-units-extracted` (sendMessage with `deliverAs: "nextTurn"`).

Renderer (index.ts:1078):

```typescript
pi.registerMessageRenderer("hindsight-retain-zero-units-extracted", (msg, _opt, theme) => {
  const d = (msg.details as any) ?? {};
  let t = theme.fg("warning", "⚠ Hindsight");
  t += theme.fg("muted", " retain completed but added 0 units");
  if (d.bank) t += theme.fg("dim", ` → ${d.bank}`);
  if (typeof d.op_age_ms === "number") t += theme.fg("dim", ` (${Math.round(d.op_age_ms / 1000)}s)`);
  if (typeof d.transcript_len === "number") t += theme.fg("dim", ` [${d.transcript_len} chars in]`);
  t += "\n" + theme.fg("dim", "  Substantial input → 0 facts extracted suggests the extraction LLM is down.");
  t += "\n" + theme.fg("dim", "  Check `docker logs hindsight --tail 50` and `~/Work/llm-mode.sh status`.");
  return new Text(t, 0, 0);
});
```

Details payload sent to pi: `{ bank, operation_id, op_age_ms, document_id, pre_units_count,
post_units_count, transcript_len }`. No transcript, no tags, no original payload.

### 1.5 Current recovery: none

Confirmed by reading the entire 1585 lines of `index.ts`:

- There is no persistent queue.
- There is no retry of the retain payload (the only retry in the file is `recallBankWithRetry`,
  which retries a `/memories/recall` POST — not a retain).
- The hindsight server exposes `POST /v1/default/banks/{bank}/operations/{op}/retry`, summary
  *"Re-queue a failed async operation so the worker picks it up again"* — but the docstring is
  clear: it only applies to operations in `failed` status. The user's symptom is `completed` +
  zero units, which is not eligible.
- `/hindsight reset` clears `healthState.healthy` and resets the recall state machine. It does
  not recover any lost retain.
- `markHealthy()` flips `healthState` back to healthy on the next successful recall. It does
  **not** re-trigger retain.

User-visible result: the only recovery is to **manually copy the relevant content into a fresh
turn with `#me` / `#global` or call `hindsight_retain` explicitly** — and most users will not
notice in time.

### 1.6 State of polling / retry config — extension points

```typescript
// index.ts:283
const POLL_INTERVAL_MS = 5000;
const POLL_MAX_ATTEMPTS = 24; // 5s * 24 = 120s
export const SUBSTANTIAL_TRANSCRIPT_CHARS = 500;
```

`HindsightSettings` already supports:

```typescript
export interface HindsightSettings {
  healthGate: "off" | "warn" | "block";
  recallRetry: { attempts: number; backoffMs: number };
  recallTimeoutMs: number;
  topicShiftRecall: TopicShiftRecallSettings;
}
```

There is no `retainRetry`, no queue config, and no extraction-LLM-probe config — these would be
new keys.

`recallBankWithRetry` (index.ts:1056) is a good shape to copy for the retain side: HTTP-aware
backoff, no retry on 4xx-auth, retry on 408/429/5xx and network/timeout. A `retainBankWithRetry`
would look almost identical.

---

## 2. Failure mode taxonomy

Every cause of "0 units" we have evidence for, plus how detection and recovery differ. Captured
from `docker logs hindsight` around the live failure window (2026-05-12 ~21:02–21:04):

```
2026-05-12 21:03:01,091 - APIStatusError (openrouter/qwen/qwen3.6-plus, scope=retain_extract_facts,
    attempt 1/4): HTTP 429: {"message": "Request rate increased too quickly. … "type":
    "limit_burst_rate", "code": "limit_burst_rate"}
2026-05-12 21:03:43,315 - APIConnectionError (HTTP None), attempt 5: Request timed out.
2026-05-12 21:03:51,822 - APIConnectionError (HTTP None), attempt 10: Request timed out.
2026-05-12 21:03:38,894 - slow llm call: scope=retain_extract_facts, model=openrouter/qwen/qwen3.6-plus,
    input_tokens=3248, output_tokens=2043, time=40.910s
```

| #  | Cause | How to detect (client side) | Recovery viable? | Notes |
|----|-------|-----------------------------|------------------|-------|
| F1 | Kilocode OAuth bearer expired (>365d, or revoked) | `/operations/{id}` returns `status=failed`, `error_message` contains `401`/`Unauthorized`/`Bearer`; container shows `APIStatusError ... HTTP 401` | **Not by retry alone** — token must be refreshed first (run `~/.hindsight/start.sh` to re-source from `~/.pi/agent/auth.json`). Once refreshed, retain payload retries cleanly. | The container has no refresh logic — `start.sh` reads `auth.json` once at boot. |
| F2 | Kilocode 429 `limit_burst_rate` | `error_message` contains `429` / `limit_burst_rate`; or hindsight succeeds via internal retry → `completed` status | Yes, with backoff ≥ 60 s. Hindsight's internal `attempt=1/4..4/4` may already have handled it; user sees the failure only when all 4 are exhausted or the slow path yields empty extraction. | Most common in practice based on the live log. |
| F3 | Kilocode connection refused / gateway down | `error_message` empty or contains `APIConnectionError`; eventually `failed`; container logs `APIConnectionError (HTTP None)` | Yes, with backoff. Could be transient (5–60 s) or persistent until kilocode recovers. | Same backoff family as F2. |
| F4 | LM Studio (local) unreachable when in `local` mode | `error_message` mentions `ECONNREFUSED` `host.docker.internal:1234` | Yes — but recovery is user-initiated (start LM Studio, or `~/Work/llm-mode.sh remote`). Worth flagging in renderer. | Mode is in `~/.hindsight/mode`. |
| F5 | Hindsight container's LLM config bad (wrong model id, wrong base_url) | Persistent failure across attempts with `404 model not found` or `400 invalid model` | **Not by client retry** — config must be edited and container restarted. Surface as a "fatal" badge. | |
| F6 | Hindsight container OOM / crash | `/health` returns 5xx or unreachable; operation stuck `pending` past `POLL_MAX_ATTEMPTS` | No — needs `docker restart hindsight`. Surface as separate error class. | |
| F7 | LLM returned valid response but empty extraction (genuine semantic zero) | `completed` + delta == 0 + substantial transcript, no error_message | **Borderline.** Phase D fires on this. If the transcript is truly trivia despite being >500 chars, retry will produce 0 again — but that's the rare leg of `SUBSTANTIAL_TRANSCRIPT_CHARS` undershoot. In observed corpus, >500-char transcripts produce ≥1 unit. | One retry suffices to disambiguate; further retries waste tokens. |
| F8 | Hindsight orchestrator path that skips `unit_ids_count` after the LLM call eventually times out internally | `completed` + delta == 0, container log shows multiple `APIConnectionError ... attempt 10: Request timed out` | Yes — retry after backoff, but if upstream is still degraded, expect another zero. | Plausibly what the 95s/0 units case actually was: the 11-attempt internal retry ladder exhausts ~95s of wall time, last attempt times out, orchestrator marks complete with no units. |

Bucketing by recovery strategy:

- **Backoff-and-retry good enough:** F2, F3, F7, F8 (and F4 if user switches modes).
- **Need user/admin action:** F1 (token refresh), F5 (config edit), F6 (container restart).
- **Need a probe before retrying** to avoid burning the queue on a known-bad upstream: all of
  the above — a cheap GET to a small known-good endpoint (e.g. a 1-token completion against
  the configured LLM via a hindsight `/llm-health` route, if added) would let the drain skip a
  cycle without consuming the retry budget. Today no such endpoint exists.

---

## 3. Self-heal design — three alternatives

Each alternative is sized against the existing structure: 1585 LOC `index.ts`, 191 tests across
6 suites, fire-and-forget watcher pattern already in place.

### Alt 1 — Persistent disk queue + hook-driven drain

**Sketch.**

On Phase D `zero-units` AND on `retain-failed-async`, before emitting the warning, persist a
queue entry:

```
~/.hindsight/queue/<sessionId>-<bank>-<unix_ms>.json
{
  "v": 1,
  "bank": "legal-sewage",
  "document_id": "session-<sessionId>",
  "transcript": "<full text, max 50000>",
  "context": "pi | 2026-05-12 21:02 America/New_York",
  "tags": ["foo"],
  "session_id": "<sessionId>",
  "first_failed_at": "2026-05-12T21:04:00.000Z",
  "last_attempt_at": "2026-05-12T21:04:00.000Z",
  "attempts": 1,
  "cause": "zero-units" | "failed-async",
  "last_error": "kilocode 429 limit_burst_rate"
}
```

Required upstream change in `agent_end`: thread `transcript` and `tags` and `context` into
`RetainSnapshot` (or a new `RetainPayload` companion) so the watcher can persist them.

Drain triggers (no `setInterval` needed — pi extensions have no clean lifecycle for it):

1. **`session_start`** — read queue dir, try each entry once. Best win/risk ratio: the user
   has just started pi, so the LLM has likely recovered since the last failure.
2. **First successful retain in a session** — after a normal `agent_end` POST returns ok and
   the watcher sees delta > 0, opportunistically drain ≤ N entries (cap to avoid blocking).
3. **`/hindsight retry`** — explicit user command.
4. **(stretch)** Per-turn drain in `before_agent_start` when `healthState.healthy === true`,
   gated on a `lastDrainAt` cooldown to keep the per-turn overhead bounded.

Drain algorithm per entry:

```
if attempts >= MAX_DRAIN_ATTEMPTS (5):
    move to ~/.hindsight/queue/poison/, fire "hindsight-retain-poisoned"
    return

attempts += 1; last_attempt_at = now()
res = POST /v1/default/banks/{bank}/memories {
  items: [{
    content: transcript,
    document_id,
    update_mode: "append",
    context,
    timestamp: <orig>,
    tags,
  }],
  async: true,
}
if !res.ok: persist and exit (network/server still down)
operationId = res.operation_id

# wait for terminal status (reuse pollOperationUntilTerminal)
op = await pollOperationUntilTerminal(...)
if op == null or op.status == "pending": persist and exit
if op.status == "failed": persist with last_error and exit
postUnits = await fetchDocumentUnitsCount(...)
delta = postUnits - preUnits_at_first_attempt  # delta vs ORIGINAL pre-snapshot
if delta > 0:
    delete entry, increment metrics.recovered
    fire "hindsight-retain-recovered" customType (display: true, sticky)
else:
    persist (extraction still empty)
```

Pros:

- Survives pi restart, OS reboot, the user CTRL-Cing pi in frustration.
- Decouples retry from session lifetime.
- Trivially testable: drain has pure inputs (queue dir, mock fetch) and pure outputs
  (filesystem mutations + sendMessage calls).
- Mirrors a pattern the user already trusts (`prompt-stash`, `session-recall`, etc. all touch
  per-user state files).
- One new customType (`hindsight-retain-recovered`) and one renderer; queue depth surfaces
  through `/hindsight status`.

Cons:

- New on-disk state shape and forward compatibility (`v: 1` discipline).
- **Dedup risk.** Re-POSTing with the same `document_id` + `update_mode: "append"` will
  chunk-append the same transcript into the document a second time. Hindsight does not
  text-dedupe chunks at write time (verified by inspecting the OpenAPI for `/memories` — no
  idempotency key field). Mitigation: drain only when the original `preUnitsCount` for
  `document_id` is unchanged from when we snapshotted (we know it was 0-delta then; if it's
  still equal now, the original write left no content and re-posting is safe). If it has
  grown, **another retain has succeeded for the same session document** and we should
  discard the queue entry rather than dupe.
- Drain timing on session_start: if the user starts pi 10s after the failure, kilocode is
  still in burst-rate cooldown. Need a minimum age gate (e.g. don't attempt within 60s of
  `first_failed_at` on the **first** drain) + exponential per-entry backoff.
- LOC: ~250 net new lines in `index.ts` + ~150 test lines. New file
  `packages/hindsight/queue.ts` recommended to keep the queue store isolated.
- Test surface: ~25 new tests (queue read/write, drain decision tree, dedup detection,
  poison promotion, renderer of recovered/poisoned customTypes).

### Alt 2 — Synchronous in-band retry with exponential backoff

**Sketch.**

When the watcher hits the zero-units gate, before emitting the warning, immediately:

```
for attempt in 1..3:
  await sleep(backoff[attempt])  # e.g. 5s, 30s, 120s
  if not isExtractionLLMHealthy(): continue
  re-POST the retain, poll, check delta
  if delta > 0: fire "hindsight-retain-recovered", return
fire the existing zero-units warning
```

Pros:

- No new on-disk state.
- Linear with the existing watcher — the same closure already has documentId, bank, config.
  Adding transcript to the closure is one parameter.
- Test surface is small: extend `retain-polling.test.ts`.

Cons:

- The watcher is fire-and-forget but in the same Node process as the agent. A 3-attempt loop
  with 5/30/120 s backoff means the watcher can stay alive for ~3 minutes after `agent_end`
  returned. That's already true (POLL_MAX_ATTEMPTS=24×5s=120s); extending to ~5 min is
  borderline.
- If the process dies (pi exit / Ctrl-C) before the retry completes, the retain is lost — same
  as today.
- Backoff is uncoordinated across multiple turns: two consecutive failed turns trigger two
  parallel retry loops, both retrying against the same dead upstream — amplifies the 429.
- If the extraction LLM was down for >95s already (the user's observed `(95s)`), an immediate
  retry will almost certainly hit the same 429/timeout. Backoff must be ≥ 5 min for the
  in-band case to be useful.
- LOC: ~80 net new lines + ~10 test lines.
- The current zero-units gate already runs ~120s late by the time it fires — adding 3
  retries in band turns "0 units detected after 95s" into "0 units recovered/declared after
  5 min". The notification UX gets worse, not better.

### Alt 3 — Tool-surface retry (agent or user initiated)

**Sketch.**

Two new surfaces:

- Tool `hindsight_retry_last_failed`: callable by the agent. Reads the last N failed retains
  from an in-memory ring buffer and re-POSTs them. Returns success/failure summary.
- Command `/hindsight retry`: drains all in-memory failed retains.

Persist nothing to disk; the buffer is process-lifetime only. Buffer is populated by the
zero-units / retain-failed-async branches.

Pros:

- Minimal LOC (~120 lines).
- Zero new on-disk state.
- The agent can react to the warning customType (`hindsight-retain-zero-units-extracted`) and
  call the tool — matches the user's mental model "tell the agent to retry".
- Mirrors the existing `hindsight_retain` tool surface.

Cons:

- Lost on pi restart. The user's specific complaint ("retry reconnect with hindsight without
  need to reload the agent") is satisfied **only if** the user notices the warning and acts
  before restart. In practice they don't notice.
- Adds an agent capability that the agent rarely thinks to invoke without a system prompt
  nudge. We'd need a guidance phrase in the warning renderer that explicitly tells the agent
  "call `hindsight_retry_last_failed`".
- Buffer cap is a footgun: pick too small and you lose retains in a multi-failure window;
  pick too large and you keep a lot of transcripts in memory.

### Sizing summary

| Alt | LOC | Tests | Survives restart? | User-action required? |
|-----|-----|-------|-------------------|------------------------|
| 1   | ~250 + ~150 test | ~25 new tests in a new suite | Yes | No (auto) |
| 2   | ~80 + ~10 test | ~5 new tests | No | No |
| 3   | ~120 + ~50 test | ~10 new tests | No | Yes (agent or user) |

Today: 6 suites, ~191 tests. None of the alternatives should require existing tests to change;
all new behavior should be additive and gated on a settings flag (default off in phase 1).

---

## 4. Recommendation

**Adopt Alt 1, phased.** Reasons:

- The user's stated frustration is "retry without reloading pi" — Alt 1 is the only option
  that holds when the user closes pi between failure and recovery.
- The drain is hook-driven, not timer-driven — no new `setInterval` semantics, no cleanup
  questions, no risk of leaked timers across `session_start` re-registration.
- The pattern is identical to existing per-user state (`~/.pi/agent/hindsight.json`,
  `~/.pi/agent/sessions/…`, `~/Work/.pi/…`) so the maintenance cost is paid in the same
  currency as the rest of the project.
- It is the only option that lets us add a `/hindsight queue` introspection surface — useful
  during long-running outages.
- Alt 2 (in-band) makes the UX worse: it pushes the warning out by minutes. Alt 3 (tool) only
  works when the agent/user notices the warning during the same session.

Implementation order — each phase is independently shippable:

### Phase G1 — Persistent queue + drain on session_start (lowest risk, biggest win)

1. New file `packages/hindsight/queue.ts`:
   - `enqueueFailedRetain(entry: FailedRetain): void`
   - `listQueue(): FailedRetain[]`
   - `markAttempt(id, op, last_error)`, `removeEntry(id)`, `promotePoison(id)`
   - Pure filesystem; no fetch calls. Unit-testable with `mkdtemp` fixtures.
2. Extend `RetainSnapshot` to add `transcript`, `tags`, `context`, `originalTimestamp`. Thread
   them through `agent_end` → `watchRetainOperation`. Mind the 50 KB transcript cap (already
   applied upstream).
3. Inside the watcher's zero-units AND failed-async branches: before sending the warning,
   `enqueueFailedRetain(...)` with `cause`.
4. New `drainQueue(pi, ctx)` helper in `index.ts`. On `session_start`, **after** the existing
   server + bank-auth probes succeed, call it once.
5. Drain decision per entry:
   - Skip entries younger than `MIN_RETRY_AGE_MS` (60s).
   - Backoff: skip if `now - last_attempt_at < backoff[attempts]` where
     `backoff = [60s, 5min, 30min, 2h, 12h]`.
   - At `attempts >= MAX_DRAIN_ATTEMPTS` (5), move to `~/.hindsight/queue/poison/` and fire
     `hindsight-retain-poisoned`.
   - Dedup: before posting, fetch current `memory_unit_count` for `document_id`. If it has
     grown vs the entry's pre_units_count, mark `recovered_externally` and drop without
     re-posting.
6. New customTypes + renderers:
   - `hindsight-retain-recovered` (success path, dim ✓)
   - `hindsight-retain-poisoned` (final failure, error, with `hindsight_retain` hint)
7. Extend `/hindsight status` to show queue depth + oldest entry age + drain history (last
   timestamp).
8. New command `/hindsight retry` — forces a drain.
9. New tests in `packages/hindsight/test/queue.test.ts` and additions to
   `retain-polling.test.ts`.

### Phase G2 — Background drain mid-session (handles long-running sessions)

10. Drain hook on `before_agent_start`, gated on:
    - `healthState.healthy === true` (don't drain while the extraction LLM is known-down)
    - `Date.now() - lastDrainAt > DRAIN_COOLDOWN_MS` (default 5 min)
    - Queue depth > 0
11. Best-effort: drain ≤ N entries per call (cap 3). Cap prevents long sessions with a fat
    queue from blocking `before_agent_start` past its existing recall budget.

### Phase G3 — Extraction-LLM-health probe (detect BEFORE the retain)

12. Add a server-side endpoint to hindsight, or use the existing healthcheck more
    intelligently: GET `/v1/default/banks/{bank}/llm-health` returning
    `{ status: "ok"|"degraded"|"down", last_success_at, last_error }`. This requires an
    upstream PR to vectorize-io/hindsight.
13. While the endpoint doesn't exist, fall back to a synthetic probe: a tiny POST
    `/memories` with content `"."` and an `idempotency_key` that the client throws away. This
    is wasteful — defer until G2 is shipped and we see whether the queue alone is enough.

### Phase G4 — Token refresh integration

14. Detect the F1 pattern (`error_message` contains `401` / `Unauthorized` / `Bearer`).
15. Mark `healthState` unhealthy with `reason: "token expired"` and surface a renderer that
    suggests running `~/.hindsight/start.sh`. (Optional: spawn it under user confirmation —
    out of scope here.)

---

## 5. Open questions

1. **Does hindsight container expose an extraction-LLM-health endpoint?**
   - Current OpenAPI (verified live, 2026-05-12 21:03 UTC): only `/health` (DB only) and
     `/version` (feature flags). No LLM-health endpoint. Would need either an upstream PR or
     a synthetic probe.
   - `/operations` (GET) with a status filter could be used to count recent `failed` ops as a
     proxy for "extraction LLM degraded" — heuristic only, but free.
   - `/operations/{id}/retry` exists but **only for `failed` operations**, not the silent
     `completed`-with-zero-units case. Confirmed in OpenAPI description:
     *"Re-queue a failed async operation so the worker picks it up again"*. So even when the
     server-side retry is applicable (F1, F3 with internal-retries-exhausted), the client
     still has to POST `/memories` again for the zero-units cases.

2. **Is the transcript text still in scope when Phase D's watcher fires?**
   - **No, not in the watcher's scope.** It is in the closure of the `agent_end` handler
     (`transcript` local), and the watcher only receives `snapshot` (which intentionally
     stores `transcriptLen` but not the body). Any retry MUST snapshot the transcript
     earlier — at watcher dispatch in `agent_end`. This is the single biggest API change for
     Alt 1.

3. **Does retrying the same `document_id` + `update_mode: "append"` create duplicates?**
   - **Yes, by design.** Hindsight chunks each `items[].content` into the document on every
     POST; there is no client-supplied idempotency key in the OpenAPI body for `/memories`.
     Mitigation: dedup-on-drain by re-snapshotting `memory_unit_count` before re-posting and
     skipping if it has grown since the original failed attempt.
   - Open follow-up: file an upstream issue for an `idempotency_key` on `/memories` so the
     server can dedupe identical retries within a TTL.

4. **What is the right backoff?**
   - Per-entry exponential: `[60s, 5min, 30min, 2h, 12h]`, cap at 5 attempts. Rationale:
     - 60s — covers F2 burst-rate cooldown.
     - 5min — covers most transient kilocode outages observed.
     - 30min / 2h — covers extraction LLM brownouts and OOMs we would manually fix in ≤ 1h.
     - 12h — last-chance heroic.
   - No "forever" — at 5 attempts, promote to `poison/` and emit a high-visibility message
     once. The user can manually `cp` the transcript back into the session if they want.

5. **Does pi v0.74.0 allow `setInterval` in an extension?**
   - The runtime is Node 22 (`engines.node: ">=22"`). `setInterval` works, but pi extensions
     have no documented teardown hook (`session_start` is called per session, not per
     extension shutdown). Existing pi-less-shitty extensions do not use `setInterval`
     (verified — only one match in `autocomplete-base-paths/patches/`, and that is vendored
     pi dist code, not our extension). Recommend avoiding `setInterval` for self-heal and
     using `before_agent_start` as the periodic tick. Lower lifecycle risk.

6. **`/hindsight retry` while a drain is already in flight?**
   - Need an in-process mutex (`isDraining: boolean`) to avoid double-posting from the
     queue. Trivial; add it in G1.

7. **Should we surface queue depth in the persistent status bar?**
   - Current bar shows `🧠 <bank>`. Proposal: when queue depth > 0, show
     `🧠 <bank> · 📥 N`. Implement after G1 ships and we have real depth data.

8. **What if the user is in `local` (LM Studio) mode and the queue accumulated under `remote`
   (kilocode) before the switch?**
   - Hindsight is agnostic — the queue entries don't store the mode. They just re-POST to
     the same container; the container uses whichever LLM `start.sh` configured. So a mode
     swap transparently retries against the new model. Worth noting in the design but not
     blocking.

9. **Multi-bank fan-out: should one bank's failure poison the other?**
   - No. Each watcher fires independently; each enqueues independently. Drains are per-entry.

10. **Interaction with the uncommitted dispatch-order fix (worker `4040bfaa`).**
    - Working-tree diff at `packages/hindsight/index.ts:1396` (verified via `git diff HEAD`):
      reorders agent_end so `void watchRetainOperation(...)` is dispatched **before**
      `pi.sendMessage(...)`, and wraps the `sendMessage` calls in `try/catch` for the
      `"stale after session replacement or reload"` error. This is orthogonal to self-heal
      but fixes the same race that motivated commit `971552b` for session-title. Treat it as
      a prerequisite for Alt 1 in `pi -p` single-shot mode (without it, the watcher might
      never dispatch on session teardown). Recommended: land that fix before starting G1.

---

## 6. Cross-references

| Ref | What | Why it matters here |
|-----|------|---------------------|
| `e398a5c` — "hindsight Phase D: replace false-positive zero-facts with real units check" | Introduced the document-delta-based silent-failure gate that fires the warning we are trying to self-heal. The `RetainSnapshot` interface and `watchRetainOperation` function are defined here. | Self-heal must hook into the same gate (extend the snapshot, persist before fire). |
| `aa62d04` — "hindsight Phase F: re-fire recall on topic shift" | Recall side already self-heals: a successful recall flips `healthState` back to healthy (`markHealthy()` at index.ts:1267). Retain has no equivalent — this proposal is the symmetric fix. | Confirms the design pattern: heal on success signal, not on timer. |
| `ed499c7` — "hindsight: restore Phase D pre-retain snapshot (regression fix)" | Re-introduces the pre-retain snapshot so delta math is correct. | The queue must carry `pre_units_count` from that snapshot so the dedup check during drain is meaningful. |
| `971552b` — "session-title: fix stale-ctx error on session end" | Same race: agent_end handler runs after disposeRuntime in `pi -p`, ctx is stale. Wraps `setTitle` in try/catch on the specific error message. | The drain (G2 mid-session) and any sendMessage from the watcher must apply the same try/catch on `"stale after session replacement or reload"`. The uncommitted Phase D dispatch-order fix replicates this defense. |
| Uncommitted worker `4040bfaa` (working-tree diff at `packages/hindsight/index.ts:1396`) | Moves `watchRetainOperation` dispatch ahead of `sendMessage` and adds the same stale-ctx try/catch around `sendMessage`. | Prerequisite to G1: ensures the watcher is dispatched even when the agent_end handler has been queued past session teardown. Treat as not-yet-merged; the self-heal design assumes the fix is in place. |

---

## TL;DR

Pi's hindsight extension currently detects "extraction LLM returned 0 units for a substantial
transcript" via a fire-and-forget watcher (Phase D, commit `e398a5c`), but the transcript text
is not retained past the agent_end closure and there is no retry: the warning is the end of
the line. Recommended fix is a small persistent queue under `~/.hindsight/queue/`, populated
on the zero-units and failed-async gates (carrying transcript + tags + context +
pre-units-count), and drained on `session_start`, on first successful retain of the next
session, and via a new `/hindsight retry` command, with per-entry exponential backoff and
dedup-by-document-growth to avoid double-chunking on retry. Phase G1 (queue + session_start
drain) is ~250 LOC + ~25 tests, ships independently of G2 (mid-session drain), G3 (LLM-health
probe — requires upstream hindsight PR), and G4 (token-refresh detection); land the
uncommitted Phase D dispatch-order fix first because the watcher must be dispatched in `pi -p`
single-shot mode for any of this to work.
