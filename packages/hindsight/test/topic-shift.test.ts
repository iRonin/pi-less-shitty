/**
 * Phase F — topic-shift detection for auto-recall.
 *
 * The heuristic is the contract between "recall fires on every turn"
 * (spammy, wastes hindsight CPU + injects noise) and "recall fires once
 * per session" (stale on long sessions). These tests pin the cases that
 * justified Phase F and the bounded worst-case shape.
 *
 * Strategy: import the pure `shouldRecall` / `jaccardSimilarity` /
 * `tokenizeForJaccard` / `buildSettings` exports directly. No network,
 * no pi runtime, no hindsight server. Mirrors how other tests in this
 * package avoid the top-level `@earendil-works/pi-tui` import.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
// We import from heuristic.ts directly — it is the no-deps module that
// holds the decision policy. The default export of index.ts pulls in
// @earendil-works/pi-tui at top level, which is not installed in this
// package's local node_modules during `npm test` (it's a peerDependency).
// All other test files in this package use the same workaround.
import {
  shouldRecall,
  jaccardSimilarity,
  tokenizeForJaccard,
  normalizeHeuristic,
  TOPIC_SHIFT_TRIGGER_RE,
  DEFAULT_TOPIC_SHIFT_SETTINGS,
  type TopicShiftRecallSettings,
} from "../heuristic.ts";

const DEFAULT_TS: TopicShiftRecallSettings = {
  enabled: true,
  heuristic: "hybrid",
  cooldownSeconds: 60,
  everyNTurns: 8,
  jaccardThreshold: 0.2,
};

const NOW = 1_700_000_000_000;

// ---------------------------------------------------------------------------
// tokenizeForJaccard — content-word extraction
// ---------------------------------------------------------------------------

describe("tokenizeForJaccard", () => {
  test("lowercases and strips punctuation", () => {
    const t = tokenizeForJaccard("Smart-Compaction's fallback POLICY!");
    assert.ok(t.has("smart-compaction"));
    assert.ok(t.has("fallback"));
    assert.ok(t.has("policy"));
  });

  test("drops stopwords", () => {
    const t = tokenizeForJaccard("what is the policy for compaction");
    assert.ok(!t.has("what"));
    assert.ok(!t.has("is"));
    assert.ok(!t.has("the"));
    assert.ok(!t.has("for"));
    assert.ok(t.has("policy"));
    assert.ok(t.has("compaction"));
  });

  test("drops tokens shorter than 2 chars", () => {
    const t = tokenizeForJaccard("a b cd");
    assert.ok(!t.has("a"));
    assert.ok(!t.has("b"));
    assert.ok(t.has("cd"));
  });

  test("dedupes", () => {
    const t = tokenizeForJaccard("compaction compaction compaction");
    assert.equal(t.size, 1);
  });

  test("handles empty string", () => {
    const t = tokenizeForJaccard("");
    assert.equal(t.size, 0);
  });
});

// ---------------------------------------------------------------------------
// jaccardSimilarity — overlap signal
// ---------------------------------------------------------------------------

describe("jaccardSimilarity", () => {
  test("same content → 1.0", () => {
    const sim = jaccardSimilarity(
      "smart-compaction fallback policy",
      "smart-compaction fallback policy",
    );
    assert.equal(sim, 1.0);
  });

  test("totally unrelated technical prompts → low similarity", () => {
    // These two are the canonical Phase F scenario (smoke test prompt 1 vs 3).
    const sim = jaccardSimilarity(
      "what is the smart-compaction fallback policy",
      "what was the loop-detector reasoning fixture threshold",
    );
    assert.ok(sim < 0.2, `expected sim < 0.2, got ${sim}`);
  });

  test("same-topic follow-up → high similarity", () => {
    // The canonical "do NOT re-fire" case from the Phase F smoke plan.
    const sim = jaccardSimilarity(
      "what is the smart-compaction fallback policy",
      "how does the smart-compaction fallback policy decide which provider to use",
    );
    assert.ok(sim >= 0.2, `expected sim >= 0.2, got ${sim}`);
  });

  test("empty + empty → 1 (no shift signal)", () => {
    assert.equal(jaccardSimilarity("", ""), 1);
  });

  test("non-empty vs empty → 0 (shift)", () => {
    assert.equal(jaccardSimilarity("foo bar baz", ""), 0);
    assert.equal(jaccardSimilarity("", "foo bar baz"), 0);
  });

  test("stopword-only prompts collapse to empty sets and report 1", () => {
    // Two stopword-only strings collapse to empty token sets. Returning 1
    // is the right "no signal" answer — better than the alternative of
    // misreporting them as different topics.
    assert.equal(jaccardSimilarity("what is the", "how can you"), 1);
  });
});

// ---------------------------------------------------------------------------
// TOPIC_SHIFT_TRIGGER_RE — high-precision phrase matching
// ---------------------------------------------------------------------------

describe("TOPIC_SHIFT_TRIGGER_RE", () => {
  test("matches explicit cross-session references", () => {
    assert.ok(TOPIC_SHIFT_TRIGGER_RE.test("we decided to use jaccard"));
    assert.ok(TOPIC_SHIFT_TRIGGER_RE.test("You said earlier that we should retry"));
    assert.ok(TOPIC_SHIFT_TRIGGER_RE.test("last session we agreed on cooldown=60s"));
    assert.ok(TOPIC_SHIFT_TRIGGER_RE.test("previously discussed in Phase D"));
    assert.ok(TOPIC_SHIFT_TRIGGER_RE.test("Do you remember when we picked Jaccard?"));
  });

  test("does NOT match single ambiguous words", () => {
    // Avoiding false-positives on words that appear in unrelated prompts.
    assert.ok(!TOPIC_SHIFT_TRIGGER_RE.test("remember to lint"));
    assert.ok(!TOPIC_SHIFT_TRIGGER_RE.test("earlier today"));
    assert.ok(!TOPIC_SHIFT_TRIGGER_RE.test("before lunch"));
    assert.ok(!TOPIC_SHIFT_TRIGGER_RE.test("recall the function signature"));
  });
});

// ---------------------------------------------------------------------------
// shouldRecall — composed decision policy
// ---------------------------------------------------------------------------

describe("shouldRecall — first turn always fires", () => {
  test("lastRecallAt=0 → fire regardless of other state", () => {
    const d = shouldRecall({
      currentPrompt: "anything",
      lastRecallPrompt: "",
      lastRecallAt: 0,
      turnsSinceLastRecall: 0,
      now: NOW,
      settings: DEFAULT_TS,
    });
    assert.equal(d.fire, true);
    assert.equal(d.reason, "first-turn");
  });

  test("first-turn fires even when enabled=false (legacy behavior preserved)", () => {
    const d = shouldRecall({
      currentPrompt: "anything",
      lastRecallPrompt: "",
      lastRecallAt: 0,
      turnsSinceLastRecall: 0,
      now: NOW,
      settings: { ...DEFAULT_TS, enabled: false },
    });
    assert.equal(d.fire, true, "enabled=false must not break first-turn auto-recall");
  });
});

describe("shouldRecall — enabled=false / heuristic=off", () => {
  test("enabled=false suppresses re-fire", () => {
    const d = shouldRecall({
      currentPrompt: "totally new topic",
      lastRecallPrompt: "old topic",
      lastRecallAt: NOW - 10 * 60 * 1000,
      turnsSinceLastRecall: 5,
      now: NOW,
      settings: { ...DEFAULT_TS, enabled: false },
    });
    assert.equal(d.fire, false);
    assert.equal(d.reason, "disabled");
  });

  test("heuristic=off suppresses re-fire", () => {
    const d = shouldRecall({
      currentPrompt: "totally new topic",
      lastRecallPrompt: "old topic",
      lastRecallAt: NOW - 10 * 60 * 1000,
      turnsSinceLastRecall: 99,
      now: NOW,
      settings: { ...DEFAULT_TS, heuristic: "off" },
    });
    assert.equal(d.fire, false);
    assert.equal(d.reason, "disabled");
  });
});

describe("shouldRecall — cooldown gate", () => {
  test("inside cooldown suppresses even a clear topic shift", () => {
    const d = shouldRecall({
      currentPrompt: "completely unrelated topic about widgets",
      lastRecallPrompt: "smart compaction fallback",
      lastRecallAt: NOW - 10_000, // 10s ago
      turnsSinceLastRecall: 1,
      now: NOW,
      settings: DEFAULT_TS, // cooldown=60s
    });
    assert.equal(d.fire, false);
    assert.equal(d.reason, "cooldown");
  });

  test("cooldown also suppresses N-turn fallback (the gate is unconditional)", () => {
    const d = shouldRecall({
      currentPrompt: "still on smart compaction",
      lastRecallPrompt: "smart compaction fallback",
      lastRecallAt: NOW - 30_000, // 30s ago
      turnsSinceLastRecall: 99,    // way over everyNTurns
      now: NOW,
      settings: DEFAULT_TS,
    });
    assert.equal(d.fire, false);
    assert.equal(d.reason, "cooldown");
  });

  test("cooldown=0 disables the gate", () => {
    const d = shouldRecall({
      currentPrompt: "different topic about widgets",
      lastRecallPrompt: "smart compaction fallback",
      lastRecallAt: NOW - 100,
      turnsSinceLastRecall: 1,
      now: NOW,
      settings: { ...DEFAULT_TS, cooldownSeconds: 0 },
    });
    assert.equal(d.fire, true);
    assert.equal(d.reason, "jaccard");
  });
});

describe("shouldRecall — jaccard signal", () => {
  test("low overlap → fire with reason=jaccard", () => {
    const d = shouldRecall({
      currentPrompt: "what was the loop-detector reasoning fixture threshold",
      lastRecallPrompt: "what is the smart-compaction fallback policy",
      lastRecallAt: NOW - 5 * 60 * 1000,
      turnsSinceLastRecall: 2,
      now: NOW,
      settings: DEFAULT_TS,
    });
    assert.equal(d.fire, true);
    assert.equal(d.reason, "jaccard");
  });

  test("high overlap → suppress with reason=similar", () => {
    const d = shouldRecall({
      currentPrompt: "how does the smart-compaction fallback policy decide which provider",
      lastRecallPrompt: "what is the smart-compaction fallback policy",
      lastRecallAt: NOW - 5 * 60 * 1000,
      turnsSinceLastRecall: 2,
      now: NOW,
      settings: DEFAULT_TS,
    });
    assert.equal(d.fire, false, `expected suppress, got fire=${d.fire} reason=${d.reason} detail=${d.detail}`);
    assert.equal(d.reason, "similar");
  });
});

describe("shouldRecall — N-turn fallback (hybrid only)", () => {
  test("hybrid: high overlap but turnsSinceLastRecall >= everyNTurns → fire", () => {
    const d = shouldRecall({
      currentPrompt: "smart compaction fallback variant",
      lastRecallPrompt: "smart compaction fallback policy",
      lastRecallAt: NOW - 5 * 60 * 1000,
      turnsSinceLastRecall: 8,
      now: NOW,
      settings: DEFAULT_TS,
    });
    assert.equal(d.fire, true);
    assert.equal(d.reason, "n-turn");
  });

  test("jaccard-only mode: N-turn does NOT trigger re-fire", () => {
    const d = shouldRecall({
      currentPrompt: "smart compaction fallback variant",
      lastRecallPrompt: "smart compaction fallback policy",
      lastRecallAt: NOW - 5 * 60 * 1000,
      turnsSinceLastRecall: 50,
      now: NOW,
      settings: { ...DEFAULT_TS, heuristic: "jaccard" },
    });
    assert.equal(d.fire, false);
    assert.equal(d.reason, "similar");
  });
});

describe("shouldRecall — trigger phrases (hybrid only)", () => {
  test("hybrid: high overlap but trigger phrase present → fire", () => {
    const d = shouldRecall({
      currentPrompt: "smart compaction fallback — we decided to drop the chain, right?",
      lastRecallPrompt: "what is the smart compaction fallback policy",
      lastRecallAt: NOW - 5 * 60 * 1000,
      turnsSinceLastRecall: 2,
      now: NOW,
      settings: DEFAULT_TS,
    });
    assert.equal(d.fire, true);
    assert.equal(d.reason, "trigger");
  });

  test("jaccard-only mode: trigger phrase does NOT cause re-fire", () => {
    const d = shouldRecall({
      currentPrompt: "smart compaction fallback — we decided to drop the chain, right?",
      lastRecallPrompt: "what is the smart compaction fallback policy",
      lastRecallAt: NOW - 5 * 60 * 1000,
      turnsSinceLastRecall: 2,
      now: NOW,
      settings: { ...DEFAULT_TS, heuristic: "jaccard" },
    });
    assert.equal(d.fire, false);
    assert.equal(d.reason, "similar");
  });
});

describe("shouldRecall — priority order", () => {
  test("first-turn beats cooldown", () => {
    // lastRecallAt=0 (never recalled) should fire even if the now/cooldown
    // arithmetic would otherwise gate. This proves the order: first-turn
    // is the top-most check.
    const d = shouldRecall({
      currentPrompt: "anything",
      lastRecallPrompt: "",
      lastRecallAt: 0,
      turnsSinceLastRecall: 0,
      now: 0, // would normally be "inside cooldown"
      settings: DEFAULT_TS,
    });
    assert.equal(d.reason, "first-turn");
  });

  test("cooldown beats jaccard signal", () => {
    const d = shouldRecall({
      currentPrompt: "completely different topic about widgets and gears",
      lastRecallPrompt: "smart compaction fallback policy",
      lastRecallAt: NOW - 5_000,
      turnsSinceLastRecall: 1,
      now: NOW,
      settings: DEFAULT_TS,
    });
    assert.equal(d.reason, "cooldown");
  });

  test("jaccard beats N-turn (and trigger) when both would fire", () => {
    // Both jaccard and N-turn would fire; the function reports jaccard first.
    // This pins the reason taxonomy for the audit log.
    const d = shouldRecall({
      currentPrompt: "completely different topic about widgets and gears",
      lastRecallPrompt: "smart compaction fallback policy",
      lastRecallAt: NOW - 5 * 60 * 1000,
      turnsSinceLastRecall: 99,
      now: NOW,
      settings: DEFAULT_TS,
    });
    assert.equal(d.reason, "jaccard");
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_TOPIC_SHIFT_SETTINGS — the shape that ships when no override exists
// ---------------------------------------------------------------------------

describe("DEFAULT_TOPIC_SHIFT_SETTINGS", () => {
  test("defaults are conservative-hybrid", () => {
    // The defaults below are the contract documented in CLAUDE.md and the
    // hindsight README. Changing any of these MUST be a deliberate choice
    // — they govern how often hindsight is hit per session, which is the
    // user-visible cost of Phase F.
    assert.equal(DEFAULT_TOPIC_SHIFT_SETTINGS.enabled, true);
    assert.equal(DEFAULT_TOPIC_SHIFT_SETTINGS.heuristic, "hybrid");
    assert.equal(DEFAULT_TOPIC_SHIFT_SETTINGS.cooldownSeconds, 60);
    assert.equal(DEFAULT_TOPIC_SHIFT_SETTINGS.everyNTurns, 8);
    assert.equal(DEFAULT_TOPIC_SHIFT_SETTINGS.jaccardThreshold, 0.2);
  });
});

describe("normalizeHeuristic", () => {
  test("accepts the three valid enums", () => {
    assert.equal(normalizeHeuristic("hybrid"), "hybrid");
    assert.equal(normalizeHeuristic("jaccard"), "jaccard");
    assert.equal(normalizeHeuristic("off"), "off");
  });

  test("rejects nonsense and falls back to default", () => {
    assert.equal(normalizeHeuristic("nonsense"), "hybrid");
    assert.equal(normalizeHeuristic(undefined), "hybrid");
    assert.equal(normalizeHeuristic(null), "hybrid");
    assert.equal(normalizeHeuristic(42), "hybrid");
  });
});
