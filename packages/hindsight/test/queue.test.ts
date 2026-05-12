/**
 * Self-Heal G1 — queue.ts unit tests.
 *
 * These tests encode the QUEUE INVARIANTS, not surface output:
 *
 *   - Atomic writes: a half-finished entry never appears in listEntries().
 *     If the rename ever leaves a stray .tmp, listEntries MUST skip it —
 *     otherwise a crash mid-write would corrupt drain state.
 *   - Backoff schedule = [30s, 60s, 2min, 4min] exactly, in order.
 *     User-mandated bounded budget (no 12h sleeps). Drift here = silent
 *     spec violation.
 *   - `nextBackoffMs(attempts >= len)` returning null is the trigger for the
 *     awaiting-user alert; if it ever returned a number, the system would
 *     auto-retry forever.
 *   - maxQueueSize: a runaway producer must not exhaust disk. Oldest goes
 *     first (FIFO by createdAt).
 *   - markAttempted(ok=true) deletes; markAttempted(ok=false) increments +
 *     reschedules; markAwaitingUser is terminal.
 *
 * No pi-tui dependency — runs purely on node:fs + queue.ts.
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BACKOFF_SCHEDULE_MS,
  DEFAULT_MAX_QUEUE_SIZE,
  enqueue,
  listEntries,
  markAttempted,
  markAwaitingUser,
  removeEntry,
  nextBackoffMs,
  countAwaitingUser,
  dueEntries,
} from "../queue.ts";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "hindsight-queue-"));
}

const SAMPLE_PARTIAL = {
  bank: "test-bank",
  transcript: "hello world transcript",
  tags: ["foo"],
  context: "pi | 2026-05-12 12:00 UTC",
  preUnitsCount: 7,
  documentId: "session-abc",
  sessionId: "abc",
};

describe("BACKOFF_SCHEDULE_MS", () => {
  test("matches user-mandated bounded schedule [30s, 60s, 2min, 4min]", () => {
    // Invariant — the user explicitly overrode the design doc's 12h exponential.
    // Any change to these values MUST come with a fresh user mandate.
    assert.deepEqual(
      [...BACKOFF_SCHEDULE_MS],
      [30_000, 60_000, 120_000, 240_000],
      "Bounded budget mandate: ≈ 7.5 min total auto-retry, then alert",
    );
  });
});

describe("nextBackoffMs", () => {
  test("returns schedule[attempts] for in-budget attempts", () => {
    // attempts=N → wait schedule[N] before drain attempt N+1.
    // For 4 attempts total, schedule[0..3] must all return real waits.
    assert.equal(nextBackoffMs(0), BACKOFF_SCHEDULE_MS[0]); // = 30_000
    assert.equal(nextBackoffMs(1), BACKOFF_SCHEDULE_MS[1]); // = 60_000
    assert.equal(nextBackoffMs(2), BACKOFF_SCHEDULE_MS[2]); // = 120_000
    assert.equal(nextBackoffMs(3), BACKOFF_SCHEDULE_MS[3]); // = 240_000
  });

  test("returns null when attempts >= schedule.length (signals alert + stop auto-retry)", () => {
    // This is the load-bearing contract that bounds wall-clock retry to ≈ 7.5 min.
    // If this ever returns a number, the system silently retries past the user-mandated budget.
    assert.equal(nextBackoffMs(BACKOFF_SCHEDULE_MS.length), null);
    assert.equal(nextBackoffMs(BACKOFF_SCHEDULE_MS.length + 5), null);
  });

  test("custom schedule override is respected (test injection point)", () => {
    const custom = [10, 20];
    assert.equal(nextBackoffMs(0, custom), 10);
    assert.equal(nextBackoffMs(1, custom), 20);
    assert.equal(nextBackoffMs(2, custom), null); // exhausted
  });
});

describe("enqueue + listEntries round-trip", () => {
  let dir: string;
  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("round-trip preserves all payload fields", () => {
    const e = enqueue(SAMPLE_PARTIAL, { dir });
    const list = listEntries({ dir });
    assert.equal(list.length, 1);
    assert.equal(list[0].id, e.id);
    assert.equal(list[0].bank, SAMPLE_PARTIAL.bank);
    assert.equal(list[0].transcript, SAMPLE_PARTIAL.transcript);
    assert.deepEqual(list[0].tags, SAMPLE_PARTIAL.tags);
    assert.equal(list[0].context, SAMPLE_PARTIAL.context);
    assert.equal(list[0].preUnitsCount, SAMPLE_PARTIAL.preUnitsCount);
    assert.equal(list[0].documentId, SAMPLE_PARTIAL.documentId);
    assert.equal(list[0].sessionId, SAMPLE_PARTIAL.sessionId);
    // Defaulted fields:
    assert.equal(list[0].attempts, 0);
    assert.equal(list[0].awaitingUser, false);
    // Initial wait BEFORE first drain = schedule[0] (= 30s). This gives the
    // upstream a chance to cool down before burning attempt #1.
    assert.equal(list[0].nextRetryAt, list[0].createdAt + BACKOFF_SCHEDULE_MS[0]);
  });

  test("listEntries returns entries sorted by createdAt asc (FIFO)", () => {
    const t0 = 1_000_000;
    const a = enqueue({ ...SAMPLE_PARTIAL, sessionId: "a" }, { dir, now: () => t0 });
    const b = enqueue({ ...SAMPLE_PARTIAL, sessionId: "b" }, { dir, now: () => t0 + 100 });
    const c = enqueue({ ...SAMPLE_PARTIAL, sessionId: "c" }, { dir, now: () => t0 + 50 });
    const ids = listEntries({ dir }).map(e => e.sessionId);
    assert.deepEqual(ids, ["a", "c", "b"], "FIFO order matters for drop-oldest semantics");
  });
});

describe("atomic write contract", () => {
  let dir: string;
  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("listEntries IGNORES .json.tmp files (the crash-safety guarantee)", () => {
    // Simulate a crash mid-rename: the .tmp file is on disk but the .json
    // never appeared. listEntries must NEVER surface this half-written state
    // to the drain loop — otherwise a corrupt entry would burn a retry slot
    // with broken JSON.
    enqueue(SAMPLE_PARTIAL, { dir });
    writeFileSync(join(dir, "stray-uuid.json.tmp"), '{"this": "is half-written"');
    // Also put a garbage .json that fails JSON.parse — must be tolerated too.
    writeFileSync(join(dir, "garbage.json"), "{not valid json");

    const list = listEntries({ dir });
    assert.equal(list.length, 1, "only the real entry should be visible");
    assert.equal(list[0].sessionId, SAMPLE_PARTIAL.sessionId);
  });

  test("enqueue never leaves a .tmp behind on the happy path", () => {
    enqueue(SAMPLE_PARTIAL, { dir });
    enqueue(SAMPLE_PARTIAL, { dir });
    const files = readdirSync(dir);
    assert.equal(files.filter(f => f.endsWith(".tmp")).length, 0);
    assert.equal(files.filter(f => f.endsWith(".json")).length, 2);
  });
});

describe("markAttempted", () => {
  let dir: string;
  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("ok=true deletes the file (recovered)", () => {
    const e = enqueue(SAMPLE_PARTIAL, { dir });
    markAttempted(e.id, true, undefined, { dir });
    assert.equal(listEntries({ dir }).length, 0);
  });

  test("ok=false increments attempts and reschedules per BACKOFF_SCHEDULE_MS", () => {
    const t0 = 1_000_000_000;
    const e = enqueue(SAMPLE_PARTIAL, { dir, now: () => t0 });
    // Sanity: fresh entry waits schedule[0] = 30s before first drain.
    assert.equal(e.nextRetryAt, t0 + 30_000);

    // Drain #1 fails → attempts=1 → wait schedule[1] = 60_000 before drain #2.
    const after1 = markAttempted(e.id, false, "network", { dir, now: () => t0 + 30_001 });
    assert.equal(after1?.attempts, 1);
    assert.equal(after1?.nextRetryAt, t0 + 30_001 + 60_000);
    assert.equal(after1?.lastError, "network");

    // Drain #2 fails → attempts=2 → wait schedule[2] = 120_000.
    const after2 = markAttempted(e.id, false, "timeout", { dir, now: () => t0 + 100_000 });
    assert.equal(after2?.attempts, 2);
    assert.equal(after2?.nextRetryAt, t0 + 100_000 + 120_000);

    // Drain #3 fails → attempts=3 → wait schedule[3] = 240_000.
    const after3 = markAttempted(e.id, false, "5xx", { dir, now: () => t0 + 200_000 });
    assert.equal(after3?.attempts, 3);
    assert.equal(after3?.nextRetryAt, t0 + 200_000 + 240_000);

    // Drain #4 fails → attempts=4 → nextBackoffMs(4) === null → budget exhausted.
    // Entry parked far in the future. Caller MUST follow up with markAwaitingUser.
    const after4 = markAttempted(e.id, false, "still down", { dir, now: () => t0 + 500_000 });
    assert.equal(after4?.attempts, 4);
    assert.equal(after4?.nextRetryAt, Number.MAX_SAFE_INTEGER,
      "Once auto-retry budget is exhausted, the entry must NOT be re-fired by a stale drain");
  });

  test("ok=false on missing id is a no-op (returns null, does not throw)", () => {
    const result = markAttempted("nonexistent-uuid", false, "x", { dir });
    assert.equal(result, null);
  });
});

describe("markAwaitingUser", () => {
  let dir: string;
  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("sets terminal state — entry survives, but awaitingUser=true and nextRetryAt is parked", () => {
    const e = enqueue(SAMPLE_PARTIAL, { dir });
    const after = markAwaitingUser(e.id, { dir });
    assert.equal(after?.awaitingUser, true);
    assert.equal(after?.nextRetryAt, Number.MAX_SAFE_INTEGER);
    // Entry still on disk — user can inspect / manually retry / dismiss.
    assert.equal(listEntries({ dir }).length, 1);
  });

  test("awaiting-user entries are excluded from dueEntries() even if nextRetryAt <= now", () => {
    const e = enqueue(SAMPLE_PARTIAL, { dir });
    markAwaitingUser(e.id, { dir });
    assert.equal(dueEntries({ dir, now: () => Date.now() + 1e12 }).length, 0,
      "awaitingUser excludes from auto-drain even when clock advances past parked nextRetryAt");
  });

  test("countAwaitingUser reflects terminal entries only", () => {
    const a = enqueue(SAMPLE_PARTIAL, { dir });
    const b = enqueue(SAMPLE_PARTIAL, { dir });
    enqueue(SAMPLE_PARTIAL, { dir });
    markAwaitingUser(a.id, { dir });
    markAwaitingUser(b.id, { dir });
    assert.equal(countAwaitingUser({ dir }), 2);
  });
});

describe("removeEntry", () => {
  let dir: string;
  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("removes the file and returns true", () => {
    const e = enqueue(SAMPLE_PARTIAL, { dir });
    assert.equal(removeEntry(e.id, { dir }), true);
    assert.equal(listEntries({ dir }).length, 0);
  });

  test("returns false when id is missing (no throw, no side effect)", () => {
    assert.equal(removeEntry("nonexistent", { dir }), false);
  });
});

describe("maxQueueSize", () => {
  let dir: string;
  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("drops oldest by createdAt when enqueue would exceed the cap", () => {
    // Cap=3, push 5 → keep the 3 newest.
    const t0 = 1_000_000_000;
    const eA = enqueue({ ...SAMPLE_PARTIAL, sessionId: "A" }, { dir, maxQueueSize: 3, now: () => t0 + 0 });
    const eB = enqueue({ ...SAMPLE_PARTIAL, sessionId: "B" }, { dir, maxQueueSize: 3, now: () => t0 + 1 });
    const eC = enqueue({ ...SAMPLE_PARTIAL, sessionId: "C" }, { dir, maxQueueSize: 3, now: () => t0 + 2 });
    const eD = enqueue({ ...SAMPLE_PARTIAL, sessionId: "D" }, { dir, maxQueueSize: 3, now: () => t0 + 3 });
    const eE = enqueue({ ...SAMPLE_PARTIAL, sessionId: "E" }, { dir, maxQueueSize: 3, now: () => t0 + 4 });

    const remaining = listEntries({ dir }).map(e => e.sessionId);
    // FIFO drop: A (oldest) gone first, then B, leaving C/D/E.
    assert.deepEqual(remaining, ["C", "D", "E"]);
  });

  test("default cap is 100", () => {
    assert.equal(DEFAULT_MAX_QUEUE_SIZE, 100);
  });
});

describe("dueEntries", () => {
  let dir: string;
  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("excludes entries whose nextRetryAt is still in the future", () => {
    const t0 = 1_000_000_000;
    const e = enqueue(SAMPLE_PARTIAL, { dir, now: () => t0 });
    // Fresh enqueue → nextRetryAt = t0 + 30_000.
    assert.equal(dueEntries({ dir, now: () => t0 + 100 }).length, 0,
      "Initial 30s wait must keep the entry out of the drain pool");
    assert.equal(dueEntries({ dir, now: () => t0 + 30_001 }).length, 1);

    // After drain #1 fails → attempts=1, next at +60s.
    markAttempted(e.id, false, "err", { dir, now: () => t0 + 30_001 });
    assert.equal(dueEntries({ dir, now: () => t0 + 30_001 + 30_000 }).length, 0);
    assert.equal(dueEntries({ dir, now: () => t0 + 30_001 + 60_001 }).length, 1);
  });
});
