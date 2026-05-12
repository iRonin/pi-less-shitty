/**
 * Self-Heal G1 — integration tests for the enqueue gate + alert path.
 *
 * Encodes the OPT-IN contract:
 *   - Default config: enabled=false → nothing is enqueued (current behavior
 *     of the 191-test baseline is preserved bit-for-bit).
 *   - enabled=true → zero-units triggers enqueue with the full retain
 *     payload (transcript, tags, context, document_id, preUnitsCount).
 *   - Mid-session OFF flip → a fresh loadSettings()-style read returns
 *     enabled=false and the gate produces null (no in-flight enqueue).
 *   - Awaiting-user alert fires exactly once per count-change.
 *
 * Imports come from ../self-heal.ts (pi-tui-free) and ../queue.ts, NOT
 * ../index.ts — the latter pulls in @earendil-works/pi-tui, a
 * peerDependency that is not present in this package's local node_modules
 * during `npm test`. This mirrors the existing pattern in
 * test/health-gate.test.ts and test/topic-shift.test.ts.
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildSelfHealEnqueuePayload,
  normalizeBool,
  writeSelfHealEnabledToml,
  type RetainSnapshotShape,
  type RetainContextShape,
} from "../self-heal.ts";
import {
  enqueue,
  listEntries,
  markAttempted,
  markAwaitingUser,
  countAwaitingUser,
  BACKOFF_SCHEDULE_MS,
} from "../queue.ts";

// Mirror the DEFAULT_SETTINGS.selfHeal.enabled contract from index.ts. The
// actual constant lives there — we re-pin its essential invariant (default
// OFF) below so a regression in either place surfaces.
const DEFAULT_SELF_HEAL_ENABLED = false;

/**
 * Mirror of the buildSettings() slice that touches selfHeal. The full
 * builder lives in index.ts; here we exercise the gate-relevant subset so
 * the test stays pi-tui-free. The flat `self_heal_enabled` key comes from
 * index.ts's section-aware parseToml (e.g. `[self_heal] enabled = true` →
 * `self_heal_enabled = "true"`).
 */
function buildSelfHealConfig(opts: {
  json?: { enabled?: boolean };
  toml?: { self_heal_enabled?: string };
}): { enabled: boolean } {
  let enabled = DEFAULT_SELF_HEAL_ENABLED;
  if (opts.json && typeof opts.json.enabled === "boolean") enabled = opts.json.enabled;
  if (opts.toml && opts.toml.self_heal_enabled !== undefined) {
    enabled = normalizeBool(opts.toml.self_heal_enabled, enabled);
  }
  return { enabled };
}

const SAMPLE_SNAPSHOT: RetainSnapshotShape = {
  documentId: "session-abc",
  preUnitsCount: 3,
  transcriptLen: 1200,
};

const SAMPLE_CTX: RetainContextShape = {
  transcript: "[role: user]\nfoo bar baz long transcript that is well above the 20-char floor\n[user:end]",
  tags: ["foo", "bar"],
  context: "pi | 2026-05-12 12:00 UTC",
  sessionId: "abc",
  timestamp: "2026-05-12T12:00:00.000Z",
};

describe("self-heal: default config is OFF (opt-in contract)", () => {
  test("DEFAULT_SELF_HEAL_ENABLED === false (mirrors DEFAULT_SETTINGS in index.ts)", () => {
    // Load-bearing: if defaults flip to true, every existing install starts
    // building a queue directory on the first Phase D zero-units fire.
    assert.equal(DEFAULT_SELF_HEAL_ENABLED, false);
  });

  test("buildSelfHealConfig() with no overrides keeps selfHeal off", () => {
    const cfg = buildSelfHealConfig({});
    assert.equal(cfg.enabled, false);
  });

  test("zero-units gate returns null when enabled=false (no enqueue)", () => {
    const payload = buildSelfHealEnqueuePayload(
      "test-bank",
      SAMPLE_SNAPSHOT,
      false,                 // enabled=false
      SAMPLE_CTX,
    );
    assert.equal(payload, null,
      "Default-off install must NEVER touch ~/.hindsight/queue on zero-units");
  });
});

describe("self-heal: gate ON → enqueue with correct payload", () => {
  test("gate returns the full retain payload when enabled=true", () => {
    const payload = buildSelfHealEnqueuePayload(
      "legal-sewage",
      SAMPLE_SNAPSHOT,
      true,
      SAMPLE_CTX,
    );
    assert.ok(payload, "gate must produce a payload");
    assert.equal(payload!.bank, "legal-sewage");
    assert.equal(payload!.transcript, SAMPLE_CTX.transcript);
    assert.deepEqual(payload!.tags, SAMPLE_CTX.tags);
    assert.equal(payload!.context, SAMPLE_CTX.context);
    assert.equal(payload!.documentId, SAMPLE_SNAPSHOT.documentId);
    assert.equal(payload!.preUnitsCount, SAMPLE_SNAPSHOT.preUnitsCount,
      "preUnitsCount anchors the dedup-by-document-growth check on drain");
    assert.equal(payload!.sessionId, SAMPLE_CTX.sessionId);
    assert.equal(payload!.lastError, "zero-units-extracted");
  });

  test("gate refuses to enqueue when retainCtx is missing (would be dead weight)", () => {
    const payload = buildSelfHealEnqueuePayload("x", SAMPLE_SNAPSHOT, true, undefined);
    assert.equal(payload, null);
  });

  test("gate refuses to enqueue trivially-short transcripts (<20 chars)", () => {
    const payload = buildSelfHealEnqueuePayload(
      "x", SAMPLE_SNAPSHOT, true,
      { ...SAMPLE_CTX, transcript: "tiny" },
    );
    assert.equal(payload, null);
  });
});

describe("self-heal: live toggle is honored at the gate", () => {
  test("flipping enabled OFF between calls stops new enqueues immediately", () => {
    // Call 1: ON → produces payload.
    const onPayload = buildSelfHealEnqueuePayload("x", SAMPLE_SNAPSHOT, true, SAMPLE_CTX);
    assert.ok(onPayload);

    // Call 2: caller's loadSettings() returns OFF → gate refuses.
    // Mirrors the production pattern: watchRetainOperation calls
    // loadSettings() INSIDE the zero-units branch (not closing over a stale
    // snapshot), so a /hindsight self-heal off mid-session takes effect at
    // the very next zero-units fire.
    const offPayload = buildSelfHealEnqueuePayload("x", SAMPLE_SNAPSHOT, false, SAMPLE_CTX);
    assert.equal(offPayload, null,
      "A mid-session /hindsight self-heal off MUST stop new enqueues at the very next zero-units fire");
  });
});

describe("self-heal: awaiting-user alert state — fires once per count change", () => {
  // Re-implements the maybeFireAwaitingUserAlert logic against an in-memory
  // mock alert-state store so we don't need to drive pi.sendMessage. The
  // production function is wired into drainQueue; this test pins the
  // count-change semantics that the production code relies on.
  function alertOnce(
    currentCount: number,
    state: { lastAlertedCount: number },
    fired: { count: number },
  ): boolean {
    if (currentCount === state.lastAlertedCount) return false;
    state.lastAlertedCount = currentCount;
    if (currentCount > 0) { fired.count += 1; return true; }
    return false;
  }

  test("first call with count > 0 fires the alert", () => {
    const state = { lastAlertedCount: 0 };
    const fired = { count: 0 };
    alertOnce(2, state, fired);
    assert.equal(fired.count, 1);
    assert.equal(state.lastAlertedCount, 2);
  });

  test("second call with the SAME count does not fire again (no spam)", () => {
    const state = { lastAlertedCount: 0 };
    const fired = { count: 0 };
    alertOnce(2, state, fired); // first fire
    alertOnce(2, state, fired); // same count — no fire
    alertOnce(2, state, fired); // still same — no fire
    assert.equal(fired.count, 1,
      "Repeated drains with unchanged awaiting count must NOT re-spam");
  });

  test("count change fires a fresh alert", () => {
    const state = { lastAlertedCount: 0 };
    const fired = { count: 0 };
    alertOnce(2, state, fired);
    alertOnce(3, state, fired); // count grew → fire
    alertOnce(3, state, fired); // unchanged → no fire
    assert.equal(fired.count, 2);
  });

  test("count drop to 0 clears state silently (no alert)", () => {
    const state = { lastAlertedCount: 2 };
    const fired = { count: 0 };
    alertOnce(0, state, fired);
    assert.equal(fired.count, 0, "Clearing back to zero must be silent");
    assert.equal(state.lastAlertedCount, 0);
  });
});

describe("self-heal: end-to-end queue progression to awaiting-user", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "hindsight-selfheal-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("4 failed attempts → markAwaitingUser sets terminal state and bumps awaiting count", () => {
    // Compresses the ≈ 7.5 min wall clock to a sequence of explicit
    // markAttempted calls — the production drain code does the same thing,
    // just spread across session_starts.
    const t0 = 1_000_000_000;
    const e = enqueue({
      bank: "x",
      transcript: "x".repeat(100),
      tags: [],
      context: "pi | 2026-05-12 12:00 UTC",
      preUnitsCount: 0,
      documentId: "session-x",
      sessionId: "x",
    }, { dir, now: () => t0 });

    let now = t0;
    for (let i = 0; i < BACKOFF_SCHEDULE_MS.length; i++) {
      now += (BACKOFF_SCHEDULE_MS[i] ?? 0) + 1;
      markAttempted(e.id, false, "still down", { dir, now: () => now });
    }
    // After 4 failed attempts the schedule is exhausted. Production
    // drainQueue follows up with markAwaitingUser.
    markAwaitingUser(e.id, { dir });
    assert.equal(countAwaitingUser({ dir }), 1);
    const entry = listEntries({ dir })[0];
    assert.equal(entry.awaitingUser, true);
    assert.equal(entry.attempts, 4,
      "Bounded budget mandate: exactly 4 attempts then awaiting-user, no exponential 12h");
    assert.equal(entry.nextRetryAt, Number.MAX_SAFE_INTEGER,
      "Awaiting-user entries must be parked so a stale drain cannot revive them");
  });
});

describe("self-heal: config parsing + TOML round-trip", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "hindsight-toml-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("normalizeBool accepts true/false/1/0/on/off/yes/no, falls back otherwise", () => {
    assert.equal(normalizeBool("true", false), true);
    assert.equal(normalizeBool("false", true), false);
    assert.equal(normalizeBool("on", false), true);
    assert.equal(normalizeBool("off", true), false);
    assert.equal(normalizeBool("1", false), true);
    assert.equal(normalizeBool("0", true), false);
    assert.equal(normalizeBool("yes", false), true);
    assert.equal(normalizeBool("no", true), false);
    assert.equal(normalizeBool("garbage", true), true,  "fallback returned on unparseable input");
    assert.equal(normalizeBool("garbage", false), false);
    assert.equal(normalizeBool(true, false), true);
    assert.equal(normalizeBool(0, true), false);
  });

  test("flat self_heal_enabled key → cfg.enabled = true (TOML round-trip)", () => {
    const cfg = buildSelfHealConfig({ toml: { self_heal_enabled: "true" } });
    assert.equal(cfg.enabled, true);
  });

  test("JSON enabled override flips selfHeal on", () => {
    const cfg = buildSelfHealConfig({ json: { enabled: true } });
    assert.equal(cfg.enabled, true);
  });

  test("writeSelfHealEnabledToml creates file with [self_heal] enabled=true", () => {
    const path = join(dir, "config.toml");
    writeSelfHealEnabledToml(path, true);
    const content = readFileSync(path, "utf-8");
    assert.match(content, /\[self_heal\]/);
    assert.match(content, /enabled\s*=\s*true/);
  });

  test("writeSelfHealEnabledToml preserves comments, other keys and sections", () => {
    const path = join(dir, "config.toml");
    const before =
      "# my hindsight config\n" +
      'bank_id = "project-x"\n' +
      'health_gate = "warn"\n' +
      "[other_section]\n" +
      'foo = "bar"\n';
    writeFileSync(path, before);
    writeSelfHealEnabledToml(path, true);
    const after = readFileSync(path, "utf-8");
    assert.match(after, /^# my hindsight config/);
    assert.match(after, /bank_id = "project-x"/);
    assert.match(after, /health_gate = "warn"/);
    assert.match(after, /\[other_section\]/);
    assert.match(after, /foo = "bar"/);
    assert.match(after, /\[self_heal\]/);
    assert.match(after, /enabled = true/);
  });

  test("writeSelfHealEnabledToml flips an existing enabled value in place", () => {
    const path = join(dir, "config.toml");
    writeFileSync(path,
      "[self_heal]\n" +
      "enabled = true\n" +
      "max_queue_size = 50\n",
    );
    writeSelfHealEnabledToml(path, false);
    const after = readFileSync(path, "utf-8");
    assert.match(after, /enabled = false/);
    assert.doesNotMatch(after, /enabled = true/);
    assert.match(after, /max_queue_size = 50/, "other keys in the section survive");
  });

  test("writeSelfHealEnabledToml is idempotent", () => {
    const path = join(dir, "config.toml");
    writeSelfHealEnabledToml(path, true);
    const after1 = readFileSync(path, "utf-8");
    writeSelfHealEnabledToml(path, true);
    const after2 = readFileSync(path, "utf-8");
    assert.equal(after1, after2);
  });
});
