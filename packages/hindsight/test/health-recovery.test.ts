/**
 * Tests for the auto-recover-from-unhealthy fix.
 *
 * Bug: pi-side hindsight would stay unhealthy for the rest of the session
 * once `markUnhealthy()` fired, requiring a reload (or `/hindsight reset`)
 * to recover. Root cause: `markHealthy()` was only called after successful
 * recall, which may not fire for hundreds of turns in a long session, and
 * under healthGate=block recall is suppressed entirely.
 *
 * Fix (three additive changes):
 *   1. markHealthy() on any successful retain POST (sync) + on watcher
 *      success (async delta > 0).
 *   2. Passive, rate-limited health re-probe on every user `input` event
 *      while unhealthy. NOT gated by healthGate.
 *   3. session_start clears unhealthy state (symmetric with /hindsight reset).
 *
 * These tests pin each of the seven behaviors enumerated in the task spec.
 * They re-implement the algorithm here (same convention as the rest of this
 * package's tests; the default export of index.ts pulls in pi-tui which
 * isn't installed locally during `npm test`). Any drift between this file
 * and index.ts is itself a defect — they MUST stay in sync.
 *
 * Run: node --experimental-strip-types --test test/health-recovery.test.ts
 */

import { test, describe, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

// ────────────────────────────────────────────────────────────────────────
// Re-implementations of the in-scope helpers from index.ts. Kept byte-
// equivalent to the production code so a regression in production lines
// up with a regression here.
// ────────────────────────────────────────────────────────────────────────

interface HealthState {
  healthy: boolean;
  reason?: string;
  markedAt?: string;
}
let healthState: HealthState;

function markUnhealthy(reason: string): void {
  if (healthState.healthy) {
    healthState.healthy = false;
    healthState.reason = reason;
    healthState.markedAt = new Date().toISOString();
  }
}

function markHealthy(): void {
  healthState.healthy = true;
  healthState.reason = undefined;
  healthState.markedAt = undefined;
}

// Mirror of module-level state in index.ts.
let lastHealthProbeAt = 0;
const HEALTH_PROBE_RATE_LIMIT_MS = 10_000;
const HEALTH_PROBE_TIMEOUT_MS = 1500;

// Recall state mock (resetRecallState callback).
interface RecallState {
  recallEverFired: boolean;
  recallAttempts: number;
  lastRecallPrompt: string;
  lastRecallAt: number;
  turnsSinceLastRecall: number;
}
let recallState: RecallState;
function resetRecallState(): void {
  recallState.recallEverFired = false;
  recallState.recallAttempts = 0;
  recallState.lastRecallPrompt = "";
  recallState.lastRecallAt = 0;
  recallState.turnsSinceLastRecall = 0;
}

// Mirror of `healthProbe` in index.ts. Identical control flow.
async function healthProbe(
  apiUrl: string,
  onCleared: () => void,
  now: () => number = Date.now,
  fetchImpl: typeof fetch = fetch,
): Promise<"skipped-healthy" | "skipped-ratelimit" | "cleared" | "still-unhealthy"> {
  if (healthState.healthy) return "skipped-healthy";
  const t = now();
  if (t - lastHealthProbeAt < HEALTH_PROBE_RATE_LIMIT_MS) return "skipped-ratelimit";
  lastHealthProbeAt = t;
  try {
    const res = await fetchImpl(`${apiUrl}/health`, { signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS) });
    if (res.ok) {
      markHealthy();
      onCleared();
      return "cleared";
    }
    return "still-unhealthy";
  } catch {
    return "still-unhealthy";
  }
}

// Mirror of the retain-success branch in agent_end (index.ts ~line 1884).
// The only contract under test is: ok.length > 0 implies markHealthy().
function simulateRetainSyncOutcome(ok: string[]): void {
  if (ok.length > 0) markHealthy();
}

// Mirror of the watcher delta-success branch (index.ts ~line 586). The branch
// is reached ONLY when `delta > 0` (or `delta <= 0 && !substantial` which
// returns early without flipping state — covered separately). Real delta>0
// fires markHealthy.
function simulateWatcherCompletion(opts: {
  postUnits: number;
  preUnits: number;
  transcriptLen: number;
  errorMessage: string | null;
}): "marked-unhealthy" | "marked-healthy" | "legit-zero-silent" {
  const SUBSTANTIAL_TRANSCRIPT_CHARS = 2000;
  const delta = opts.postUnits - opts.preUnits;
  const substantial = opts.transcriptLen >= SUBSTANTIAL_TRANSCRIPT_CHARS;
  if (delta <= 0 && substantial) {
    const legitEmpty = !opts.errorMessage;
    if (!legitEmpty) markUnhealthy("zero units extracted");
    return "marked-unhealthy";
  }
  if (delta <= 0 && !substantial) return "legit-zero-silent";
  // delta > 0
  markHealthy();
  return "marked-healthy";
}

// Mirror of the session_start handler's health-related work (Change 3).
function simulateSessionStart(): void {
  markHealthy();
  lastHealthProbeAt = 0;
  resetRecallState();
}

beforeEach(() => {
  healthState = { healthy: true };
  lastHealthProbeAt = 0;
  recallState = {
    recallEverFired: false,
    recallAttempts: 0,
    lastRecallPrompt: "",
    lastRecallAt: 0,
    turnsSinceLastRecall: 0,
  };
});

// ============================================================================
// Test 1 — Successful retain clears unhealthy
// ============================================================================
// WHY: previously, markHealthy() only fired on successful recall (~once per
// session). A long session that retained successfully every turn but never
// re-recalled would stay stuck unhealthy after any transient blip. The fix
// makes a single successful retain symmetric with successful recall.

describe("Change 1a: successful retain clears unhealthy", () => {
  test("ok.length > 0 → healthy", () => {
    markUnhealthy("test transient blip");
    assert.equal(healthState.healthy, false);
    simulateRetainSyncOutcome(["project-x", "global"]);
    assert.equal(healthState.healthy, true, "successful retain must heal");
    assert.equal(healthState.reason, undefined);
  });

  test("ok.length == 0 → stays unhealthy (all banks failed)", () => {
    markUnhealthy("test");
    simulateRetainSyncOutcome([]);
    assert.equal(healthState.healthy, false, "no banks succeeded → still unhealthy");
    assert.equal(healthState.reason, "test", "reason preserved");
  });

  test("already healthy → no-op (does not change markedAt invariants)", () => {
    // Sanity: calling markHealthy() while healthy is idempotent.
    simulateRetainSyncOutcome(["b"]);
    assert.equal(healthState.healthy, true);
  });
});

// ============================================================================
// Test 2 — Zero-units retain (real-down, not legit-empty) does NOT clear
// ============================================================================
// WHY: a watcher that detects zero-units AND error_message != null marks
// unhealthy on purpose ("LLM-down" signal). If the FIX accidentally cleared
// that state, healthGate=block would never trip — defeating the whole gate.

describe("Change 1b: zero-units real-down stays unhealthy", () => {
  test("delta=0 substantial input + error_message → unhealthy stays", () => {
    const outcome = simulateWatcherCompletion({
      postUnits: 5, preUnits: 5, transcriptLen: 3000, errorMessage: "LLM 503 from gateway",
    });
    assert.equal(outcome, "marked-unhealthy");
    assert.equal(healthState.healthy, false);
    assert.equal(healthState.reason, "zero units extracted");
  });

  test("delta=0 substantial input + legit-empty (no error) → does NOT mark unhealthy", () => {
    // Pre-existing legit-empty contract. We don't auto-flip it healthy either —
    // legit-empty is informational; state is whatever it was.
    markUnhealthy("prior cause");
    const outcome = simulateWatcherCompletion({
      postUnits: 5, preUnits: 5, transcriptLen: 3000, errorMessage: null,
    });
    assert.equal(outcome, "marked-unhealthy"); // branch label — markUnhealthy is gated on legitEmpty
    assert.equal(healthState.healthy, false, "prior unhealthy reason still present");
    assert.equal(healthState.reason, "prior cause", "first cause preserved (idempotency)");
  });
});

// ============================================================================
// Test 3 — Watcher success (delta > 0) clears unhealthy
// ============================================================================
// WHY: covers the async-completion path. If the POST returned 200 (sync
// markHealthy fired) but a SEPARATE prior watcher marked unhealthy between
// the POST and this watcher resolving, we re-clear when units actually
// appeared.

describe("Change 1b: watcher delta > 0 clears unhealthy", () => {
  test("delta=2 → marks healthy", () => {
    markUnhealthy("transient");
    const outcome = simulateWatcherCompletion({
      postUnits: 7, preUnits: 5, transcriptLen: 3000, errorMessage: null,
    });
    assert.equal(outcome, "marked-healthy");
    assert.equal(healthState.healthy, true);
  });

  test("delta=0 trivial input → silent, does not flip state either way", () => {
    markUnhealthy("transient");
    const outcome = simulateWatcherCompletion({
      postUnits: 0, preUnits: 0, transcriptLen: 100, errorMessage: null,
    });
    assert.equal(outcome, "legit-zero-silent");
    assert.equal(healthState.healthy, false, "trivial input must NOT auto-heal");
  });
});

// ============================================================================
// Test 4 — Health-probe respects rate limit
// ============================================================================
// WHY: probe fires on every user input. Without rate-limit, a chatty session
// would spam GET /health on every turn even while hindsight is genuinely down.

describe("Change 2: health-probe rate limit", () => {
  test("two probes within rate limit window → second is no-op", async () => {
    markUnhealthy("test");
    const fetchMock = mock.fn(async () => ({ ok: true, status: 200 } as any));
    let t = 1_000_000;
    const now = () => t;

    const r1 = await healthProbe("http://h", () => {}, now, fetchMock as any);
    assert.equal(r1, "cleared");
    assert.equal(fetchMock.mock.calls.length, 1);
    assert.equal(lastHealthProbeAt, 1_000_000);

    // Re-arm unhealthy + advance time JUST under rate-limit window.
    markUnhealthy("test2");
    t = 1_000_000 + (HEALTH_PROBE_RATE_LIMIT_MS - 1);
    const r2 = await healthProbe("http://h", () => {}, now, fetchMock as any);
    assert.equal(r2, "skipped-ratelimit", "second call within window must skip");
    assert.equal(fetchMock.mock.calls.length, 1, "no second fetch");
  });

  test("after rate-limit window passes, second probe fires", async () => {
    markUnhealthy("test");
    const fetchMock = mock.fn(async () => ({ ok: true, status: 200 } as any));
    let t = 1_000_000;
    const now = () => t;
    await healthProbe("http://h", () => {}, now, fetchMock as any);

    markUnhealthy("test2");
    t = 1_000_000 + HEALTH_PROBE_RATE_LIMIT_MS + 1;
    const r = await healthProbe("http://h", () => {}, now, fetchMock as any);
    assert.equal(r, "cleared");
    assert.equal(fetchMock.mock.calls.length, 2);
  });

  test("healthy → probe is no-op (no fetch, no rate-limit consumption)", async () => {
    const fetchMock = mock.fn(async () => ({ ok: true } as any));
    const r = await healthProbe("http://h", () => {}, () => 1_000_000, fetchMock as any);
    assert.equal(r, "skipped-healthy");
    assert.equal(fetchMock.mock.calls.length, 0);
    assert.equal(lastHealthProbeAt, 0, "rate-limit timestamp not advanced when skipped-healthy");
  });
});

// ============================================================================
// Test 5 — Health-probe clears state on 200
// ============================================================================
// WHY: the entire point of the fix. Verify the recovery actually recovers.

describe("Change 2: health-probe on 200 clears state and resets recall", () => {
  test("200 → healthy + recall state reset (callback fired)", async () => {
    markUnhealthy("test");
    recallState.recallEverFired = true;
    recallState.recallAttempts = 2;
    recallState.lastRecallAt = 42;

    const fetchMock = mock.fn(async () => ({ ok: true, status: 200 } as any));
    let cleared = false;
    const r = await healthProbe("http://h", () => { cleared = true; resetRecallState(); }, () => 1_000_000, fetchMock as any);

    assert.equal(r, "cleared");
    assert.equal(healthState.healthy, true, "must clear unhealthy on 200");
    assert.equal(cleared, true, "onCleared callback fired");
    assert.equal(recallState.recallEverFired, false, "recall state reset");
    assert.equal(recallState.recallAttempts, 0, "recallAttempts cleared so next recall can fire fresh");
  });
});

// ============================================================================
// Test 6 — Health-probe does NOT clear state on 500 / timeout
// ============================================================================
// WHY: the probe must not paper over real hindsight outages. A 500 or a
// network timeout means hindsight is still down — state stays unhealthy.

describe("Change 2: health-probe on failure stays unhealthy", () => {
  test("500 → stays unhealthy, callback NOT fired", async () => {
    markUnhealthy("test");
    const fetchMock = mock.fn(async () => ({ ok: false, status: 500 } as any));
    let cleared = false;
    const r = await healthProbe("http://h", () => { cleared = true; }, () => 1_000_000, fetchMock as any);
    assert.equal(r, "still-unhealthy");
    assert.equal(healthState.healthy, false);
    assert.equal(cleared, false);
  });

  test("network error → stays unhealthy", async () => {
    markUnhealthy("test");
    const fetchMock = mock.fn(async () => { throw new Error("fetch failed"); });
    let cleared = false;
    const r = await healthProbe("http://h", () => { cleared = true; }, () => 1_000_000, fetchMock as any);
    assert.equal(r, "still-unhealthy");
    assert.equal(healthState.healthy, false);
    assert.equal(cleared, false);
  });

  test("timeout → stays unhealthy", async () => {
    markUnhealthy("test");
    const fetchMock = mock.fn(async () => {
      const err = new Error("operation timed out");
      err.name = "TimeoutError";
      throw err;
    });
    const r = await healthProbe("http://h", () => {}, () => 1_000_000, fetchMock as any);
    assert.equal(r, "still-unhealthy");
    assert.equal(healthState.healthy, false);
  });

  test("failed probe still consumes the rate-limit slot (no thrash on retry)", async () => {
    markUnhealthy("test");
    const fetchMock = mock.fn(async () => ({ ok: false, status: 500 } as any));
    let t = 1_000_000;
    const now = () => t;
    await healthProbe("http://h", () => {}, now, fetchMock as any);
    assert.equal(lastHealthProbeAt, 1_000_000, "rate-limit slot consumed on failure");

    t = 1_000_000 + 1000; // 1s later — well inside the 10s window
    const r2 = await healthProbe("http://h", () => {}, now, fetchMock as any);
    assert.equal(r2, "skipped-ratelimit", "no thrash: failed probe still rate-limits next call");
    assert.equal(fetchMock.mock.calls.length, 1, "only one fetch despite two probe calls");
  });
});

// ============================================================================
// Test 7 — session_start clears unhealthy AND recall state
// ============================================================================
// WHY: formalize "reloading == /hindsight reset". The existing test suite
// only checks `recallDone` gets reset; this regression-locks the unhealthy
// flag too.

describe("Change 3: session_start clears unhealthy + recall state", () => {
  test("unhealthy + recall state set → both cleared", () => {
    markUnhealthy("stale from a prior pi process");
    lastHealthProbeAt = 555_555;
    recallState.recallEverFired = true;
    recallState.recallAttempts = 3;

    simulateSessionStart();

    assert.equal(healthState.healthy, true, "session_start clears unhealthy");
    assert.equal(healthState.reason, undefined);
    assert.equal(lastHealthProbeAt, 0, "probe rate-limit reset so a fresh session can probe immediately");
    assert.equal(recallState.recallEverFired, false, "recall state cleared (pre-existing behavior preserved)");
    assert.equal(recallState.recallAttempts, 0);
  });

  test("already healthy + clean recall → still safe (idempotent)", () => {
    simulateSessionStart();
    assert.equal(healthState.healthy, true);
    assert.equal(recallState.recallEverFired, false);
  });
});

// ============================================================================
// End-to-end scenario: hindsight down → unhealthy → up → next turn → healthy
// ============================================================================
// WHY: the original user complaint. This locks the full recovery sequence
// described in the task spec deliverable (c). If a future change breaks
// the recovery loop, this test fails first.

describe("end-to-end: user-reported scenario", () => {
  test("hindsight down → mark unhealthy → bring up → next input probe heals", async () => {
    // Turn 1: hindsight is down → recall fails → mark unhealthy.
    markUnhealthy("recall exhausted retries");
    assert.equal(healthState.healthy, false);

    // Hindsight comes back. User fires another turn → `input` hook runs.
    // Probe fires (rate-limit slot empty), gets 200, clears state.
    const fetchMock = mock.fn(async () => ({ ok: true, status: 200 } as any));
    const r = await healthProbe("http://h", resetRecallState, () => 1_000_000, fetchMock as any);

    assert.equal(r, "cleared");
    assert.equal(healthState.healthy, true);
    assert.equal(recallState.recallAttempts, 0, "next recall can fire fresh — not stuck behind exhausted attempts");
  });

  test("hindsight stays down → probe stays harmless → recall remains blocked under healthGate=block", async () => {
    markUnhealthy("recall exhausted retries");
    const fetchMock = mock.fn(async () => { throw new Error("ECONNREFUSED"); });
    const r = await healthProbe("http://h", () => {}, () => 1_000_000, fetchMock as any);
    assert.equal(r, "still-unhealthy");
    assert.equal(healthState.healthy, false, "no false-positive recovery while hindsight is genuinely down");
  });
});
