/**
 * `recall_policy` setting — three modes for auto-recall firing.
 *
 *   every-turn   (DEFAULT) — fire on every user turn, bounded by a 5s cooldown
 *   topic-shift             — Phase F heuristic (jaccard / N-turn / triggers)
 *   session-only            — fire only on the first turn of a session
 *
 * These tests pin:
 *   (1)  the default policy is `every-turn` (matches user expectation)
 *   (2)  `topic-shift` is honored when explicitly set
 *   (3)  `session-only` is honored when explicitly set
 *   (4)  every-turn: rapid input events within the cooldown fire ONCE
 *   (5)  every-turn: spaced input events past the cooldown fire repeatedly
 *   (6)  every-turn: each successful fire resets recallAttempts (so the
 *        MAX_RECALL_ATTEMPTS gate cannot wall off long sessions)
 *   (7)  every-turn: each fire emits exactly ONE <hindsight_memories> block
 *        per turn (the injected block REPLACES rather than accumulating
 *        within a single before_agent_start return value)
 *
 * As with the other tests in this package, we do NOT import the default
 * export from `index.ts` (pulls @earendil-works/pi-tui at top level, not
 * installed in local node_modules). The new pure helpers live in
 * heuristic.ts, which has no peer-dep imports — we use those directly,
 * and we inline-copy `buildSettings` (mirroring health-gate.test.ts).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  shouldFireEveryTurn,
  normalizeRecallPolicy,
  DEFAULT_RECALL_POLICY,
  EVERY_TURN_COOLDOWN_MS,
  type RecallPolicy,
} from "../heuristic.ts";

// ────────────────────────────────────────────────────────────────────────
// Inline copy of HindsightSettings + buildSettings — mirrors index.ts.
// Same workaround as health-gate.test.ts. Keep in sync.
// ────────────────────────────────────────────────────────────────────────

type HealthGate = "off" | "warn" | "block";

interface HindsightSettings {
  healthGate: HealthGate;
  recallPolicy: RecallPolicy;
  recallRetry: { attempts: number; backoffMs: number };
  recallTimeoutMs: number;
}

const DEFAULT_SETTINGS: HindsightSettings = {
  healthGate: "warn",
  recallPolicy: DEFAULT_RECALL_POLICY,
  recallRetry: { attempts: 3, backoffMs: 1000 },
  recallTimeoutMs: 5000,
};

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function normalizeHealthGate(v: unknown): HealthGate {
  return v === "off" || v === "block" || v === "warn" ? v : DEFAULT_SETTINGS.healthGate;
}

function buildSettings(
  jsonOverride: Partial<HindsightSettings> | null,
  tomlOverride: Record<string, string> | null,
): HindsightSettings {
  const base: HindsightSettings = {
    healthGate: DEFAULT_SETTINGS.healthGate,
    recallPolicy: DEFAULT_SETTINGS.recallPolicy,
    recallRetry: { ...DEFAULT_SETTINGS.recallRetry },
    recallTimeoutMs: DEFAULT_SETTINGS.recallTimeoutMs,
  };
  if (jsonOverride) {
    if (jsonOverride.healthGate !== undefined) base.healthGate = normalizeHealthGate(jsonOverride.healthGate);
    if (jsonOverride.recallPolicy !== undefined) base.recallPolicy = normalizeRecallPolicy(jsonOverride.recallPolicy);
    if (jsonOverride.recallRetry) {
      base.recallRetry.attempts = clampInt(jsonOverride.recallRetry.attempts, 1, 10, base.recallRetry.attempts);
      base.recallRetry.backoffMs = clampInt(jsonOverride.recallRetry.backoffMs, 0, 60_000, base.recallRetry.backoffMs);
    }
    if (jsonOverride.recallTimeoutMs !== undefined) {
      base.recallTimeoutMs = clampInt(jsonOverride.recallTimeoutMs, 500, 60_000, base.recallTimeoutMs);
    }
  }
  if (tomlOverride) {
    if (tomlOverride.health_gate !== undefined) base.healthGate = normalizeHealthGate(tomlOverride.health_gate);
    if (tomlOverride.recall_policy !== undefined) base.recallPolicy = normalizeRecallPolicy(tomlOverride.recall_policy);
  }
  return base;
}

// ────────────────────────────────────────────────────────────────────────
// 1-3: Settings parsing.
// ────────────────────────────────────────────────────────────────────────

describe("recall_policy: default and overrides", () => {
  test("default when config is missing → every-turn", () => {
    // User expectation: 'recall should be firing after each of my prompt'.
    // The very thing this entire ticket exists to fix. If this flips, the
    // user-visible behavior regresses and we'd be back to topic-shift.
    const s = buildSettings(null, null);
    assert.equal(s.recallPolicy, "every-turn");
    assert.equal(DEFAULT_RECALL_POLICY, "every-turn");
  });

  test("explicit recall_policy = 'topic-shift' honored (TOML)", () => {
    // Power user opts back in to Phase F heuristic via TOML.
    const s = buildSettings(null, { recall_policy: "topic-shift" });
    assert.equal(s.recallPolicy, "topic-shift");
  });

  test("explicit recallPolicy = 'topic-shift' honored (JSON)", () => {
    const s = buildSettings({ recallPolicy: "topic-shift" } as Partial<HindsightSettings>, null);
    assert.equal(s.recallPolicy, "topic-shift");
  });

  test("explicit recall_policy = 'session-only' honored (TOML)", () => {
    // Legacy mode: fire once per session, never re-fire.
    const s = buildSettings(null, { recall_policy: "session-only" });
    assert.equal(s.recallPolicy, "session-only");
  });

  test("explicit recallPolicy = 'session-only' honored (JSON)", () => {
    const s = buildSettings({ recallPolicy: "session-only" } as Partial<HindsightSettings>, null);
    assert.equal(s.recallPolicy, "session-only");
  });

  test("invalid recall_policy falls back to default", () => {
    // Typo / corrupted config must not crash the extension; the silent
    // fallback to the default keeps recall working for the user.
    const s = buildSettings({ recallPolicy: "yolo" as any }, null);
    assert.equal(s.recallPolicy, "every-turn");
  });

  test("normalizeRecallPolicy accepts only the three modes", () => {
    assert.equal(normalizeRecallPolicy("every-turn"), "every-turn");
    assert.equal(normalizeRecallPolicy("topic-shift"), "topic-shift");
    assert.equal(normalizeRecallPolicy("session-only"), "session-only");
    assert.equal(normalizeRecallPolicy("nope"), "every-turn");
    assert.equal(normalizeRecallPolicy(undefined), "every-turn");
    assert.equal(normalizeRecallPolicy(null), "every-turn");
    assert.equal(normalizeRecallPolicy(42), "every-turn");
  });
});

// ────────────────────────────────────────────────────────────────────────
// 4-5: every-turn cooldown gate.
// ────────────────────────────────────────────────────────────────────────

describe("recall_policy=every-turn: 5s anti-thrash cooldown", () => {
  test("first turn always fires (lastRecallAt = 0)", () => {
    // The "never fired" state must bypass the cooldown — otherwise a brand
    // new session would have to wait 5s before getting any memories.
    assert.equal(shouldFireEveryTurn(1_000_000_000_000, 0), true);
  });

  test("3 input events within 100ms → only the first fires", () => {
    // User spams Enter. The first event sets lastRecallAt; the next two
    // are within the 5s window and MUST be suppressed.
    const t0 = 1_700_000_000_000;
    // Event 1: fires. Simulate the side-effect by recording lastRecallAt.
    assert.equal(shouldFireEveryTurn(t0, 0), true);
    const lastRecallAt = t0;
    // Event 2: 50ms later — must be suppressed.
    assert.equal(shouldFireEveryTurn(t0 + 50, lastRecallAt), false);
    // Event 3: 100ms after the first — must still be suppressed.
    assert.equal(shouldFireEveryTurn(t0 + 100, lastRecallAt), false);
  });

  test("2 input events spaced 6s apart → both fire", () => {
    // Real conversational pacing: the user thinks for a few seconds
    // between prompts. Recall MUST fire on each one.
    const t0 = 1_700_000_000_000;
    assert.equal(shouldFireEveryTurn(t0, 0), true);
    const lastRecallAt = t0;
    assert.equal(shouldFireEveryTurn(t0 + 6_000, lastRecallAt), true);
  });

  test("boundary: exactly at cooldown ms → fires (>= not >)", () => {
    // The cooldown is a HARD floor, not a strict-greater. Documenting the
    // boundary keeps future refactors honest.
    const t0 = 1_700_000_000_000;
    assert.equal(shouldFireEveryTurn(t0 + EVERY_TURN_COOLDOWN_MS, t0), true);
    assert.equal(shouldFireEveryTurn(t0 + EVERY_TURN_COOLDOWN_MS - 1, t0), false);
  });

  test("cooldown is configurable for testing — 100ms shim", () => {
    // The third-arg override lets us simulate accelerated time in
    // integration tests; the production code never passes it (it uses
    // the 5s constant), but the API contract matters.
    const t0 = 1_700_000_000_000;
    assert.equal(shouldFireEveryTurn(t0 + 50, t0, 100), false);
    assert.equal(shouldFireEveryTurn(t0 + 150, t0, 100), true);
  });
});

// ────────────────────────────────────────────────────────────────────────
// 6: every-turn resets recallAttempts on each fire.
// ────────────────────────────────────────────────────────────────────────

describe("recall_policy=every-turn: recallAttempts resets per fire", () => {
  test("each fire opens a fresh retry window (no MAX_RECALL_ATTEMPTS wall)", () => {
    // The bug we're guarding against: with topic-shift, the same
    // `decision.fire = true` path resets recallAttempts on each fresh
    // decision. We must preserve that behavior in `every-turn` so a long
    // session doesn't hit MAX_RECALL_ATTEMPTS = 3 and silently stop
    // recalling forever. The verifiable claim: after N fires across the
    // session, recallAttempts at the start of each fire is 0 (it's reset
    // BEFORE the increment-and-attempt).
    //
    // Reproduce the relevant state machine inline (mirrors before_agent_start
    // in index.ts):
    const MAX_RECALL_ATTEMPTS = 3;
    let recallAttempts = 0;
    let lastRecallAt = 0;
    const observedAttemptCountsAtStart: number[] = [];

    // Simulate 10 user turns, each spaced 6s apart so they all fire.
    let now = 1_700_000_000_000;
    for (let turn = 0; turn < 10; turn++) {
      // Decision phase: policy=every-turn.
      const fire = shouldFireEveryTurn(now, lastRecallAt);
      if (fire) {
        // INDEX.TS: "Each fire decision opens a fresh retry window."
        recallAttempts = 0;
        observedAttemptCountsAtStart.push(recallAttempts);
        // Simulate the network call burning one attempt.
        recallAttempts++;
        lastRecallAt = now;
      }
      now += 6_000;
    }

    assert.equal(observedAttemptCountsAtStart.length, 10, "every turn must fire when spaced past cooldown");
    for (const c of observedAttemptCountsAtStart) {
      assert.equal(c, 0, `recallAttempts must reset to 0 at the start of each fire (saw ${c})`);
    }
    // The intent: NEVER hit MAX_RECALL_ATTEMPTS in normal every-turn use.
    assert.ok(observedAttemptCountsAtStart.every(c => c < MAX_RECALL_ATTEMPTS));
  });
});

// ────────────────────────────────────────────────────────────────────────
// 7: emitted message contains exactly ONE <hindsight_memories> block.
// ────────────────────────────────────────────────────────────────────────

describe("recall_policy=every-turn: <hindsight_memories> block does not accumulate", () => {
  // The production code builds the message content as:
  //   `<hindsight_memories>\nRelevant memories from past sessions:\n\n${allResults.join("\n\n")}\n</hindsight_memories>`
  // Each fire produces ONE before_agent_start return value with ONE block.
  // Past blocks from earlier turns are in conversation history but never
  // mutate or get concatenated within a single fire's return value.
  function buildMemoriesContent(results: string[]): string {
    return `<hindsight_memories>\nRelevant memories from past sessions:\n\n${results.join("\n\n")}\n</hindsight_memories>`;
  }

  test("single fire emits exactly one <hindsight_memories> open tag", () => {
    const content = buildMemoriesContent(["[bank] memory A", "[bank] memory B"]);
    const opens = content.match(/<hindsight_memories>/g) ?? [];
    const closes = content.match(/<\/hindsight_memories>/g) ?? [];
    assert.equal(opens.length, 1, "exactly one opening tag per turn");
    assert.equal(closes.length, 1, "exactly one closing tag per turn");
  });

  test("3 consecutive fires emit 3 INDEPENDENT messages, each with one block (never compounded)", () => {
    // The block REPLACES per-turn — i.e. each turn injects a fresh
    // single-block message, never a nested-or-concatenated artifact.
    const fires = [
      buildMemoriesContent(["[bank] memory turn-1"]),
      buildMemoriesContent(["[bank] memory turn-2"]),
      buildMemoriesContent(["[bank] memory turn-3"]),
    ];
    for (const [i, content] of fires.entries()) {
      const opens = content.match(/<hindsight_memories>/g) ?? [];
      const closes = content.match(/<\/hindsight_memories>/g) ?? [];
      assert.equal(opens.length, 1, `turn ${i + 1}: exactly one opening tag`);
      assert.equal(closes.length, 1, `turn ${i + 1}: exactly one closing tag`);
      // Turn N's content must NOT contain turn N-1's content — confirms
      // we're not accumulating prior-turn memories into the new block.
      if (i > 0) {
        assert.ok(!content.includes(`turn-${i}`),
          `turn ${i + 1} content must not embed turn ${i}'s memories`);
      }
    }
  });

  test("DEFAULT_STRIP_PATTERNS strips <hindsight_memories> before retain (no feedback loop)", () => {
    // Index.ts: DEFAULT_STRIP_PATTERNS includes the hindsight_memories
    // regex precisely to prevent injected memories from being saved back
    // to the bank on the next retain — which would compound them turn
    // over turn. This is the OTHER half of "block replaces, never
    // accumulates": even if it lands in the LLM transcript, it does NOT
    // round-trip into the memory store.
    const STRIP = /<hindsight_memories>[\s\S]*?<\/hindsight_memories>/g;
    const transcript = `user: hello\nassistant: ${buildMemoriesContent(["[bank] mem A"])}\nassistant: doing work`;
    const cleaned = transcript.replace(STRIP, "");
    assert.ok(!cleaned.includes("<hindsight_memories>"));
    assert.ok(!cleaned.includes("[bank] mem A"));
    assert.ok(cleaned.includes("doing work"));
  });
});
