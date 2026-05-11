#!/usr/bin/env node
/**
 * Phase F smoke test — end-to-end demonstration that the topic-shift
 * heuristic produces the three behaviors required by the Phase F plan:
 *
 *   Prompt 1 (first turn)               → recall FIRES (baseline)
 *   Prompt 2 (same topic, immediate)    → recall does NOT fire (cooldown)
 *   Prompt 2b (same topic, post-cooldown) → recall does NOT fire (similar)
 *   Prompt 3 (unrelated topic, post-cooldown) → recall FIRES (jaccard shift)
 *
 * This script imports the pure decision policy from heuristic.ts and runs
 * it against synthetic timestamps so the behavior is deterministic and
 * hermetic — no hindsight container required.
 *
 * Run:
 *   node test/smoke-phase-f.mjs
 */

import { shouldRecall, jaccardSimilarity, DEFAULT_TOPIC_SHIFT_SETTINGS } from "../heuristic.ts";

// ANSI helpers
const c = (s, code) => `\x1b[${code}m${s}\x1b[0m`;
const green = s => c(s, 32);
const red = s => c(s, 31);
const yellow = s => c(s, 33);
const dim = s => c(s, 2);
const bold = s => c(s, 1);

function step(n, label) {
  console.log("");
  console.log(bold(`──── Turn ${n}: ${label} ────`));
}
function ok(msg) { console.log(green("  ✓ ") + msg); }
function fail(msg) { console.log(red("  ✗ ") + msg); process.exitCode = 1; }
function note(msg) { console.log(dim("    ") + dim(msg)); }

const settings = DEFAULT_TOPIC_SHIFT_SETTINGS;
console.log(bold("Phase F smoke — topic-shift recall"));
console.log(dim(`  heuristic=${settings.heuristic} cooldown=${settings.cooldownSeconds}s everyN=${settings.everyNTurns} jaccard<${settings.jaccardThreshold}`));

// Simulated session state. We bump `now` between turns to control cooldown.
let lastRecallPrompt = "";
let lastRecallAt = 0;
let turnsSinceLastRecall = 0;
let now = 1_700_000_000_000; // synthetic epoch ms

function turn(label, prompt, expectFire, expectedReason) {
  turnsSinceLastRecall++;
  const decision = shouldRecall({
    currentPrompt: prompt,
    lastRecallPrompt,
    lastRecallAt,
    turnsSinceLastRecall,
    now,
    settings,
  });
  const sim = jaccardSimilarity(prompt, lastRecallPrompt);
  step(label, prompt.length > 60 ? prompt.slice(0, 57) + "…" : prompt);
  note(`jaccard(current, lastRecallPrompt) = ${sim.toFixed(3)}`);
  note(`turnsSinceLastRecall = ${turnsSinceLastRecall}`);
  note(`now - lastRecallAt = ${lastRecallAt ? Math.round((now - lastRecallAt) / 1000) + "s" : "∞ (never)"}`);
  const arrow = decision.fire ? green("FIRE") : yellow("skip");
  console.log(`  decision: ${arrow}  reason=${decision.reason}${decision.detail ? ` (${decision.detail})` : ""}`);
  if (decision.fire === expectFire && (!expectedReason || decision.reason === expectedReason)) {
    ok(`expected: fire=${expectFire}${expectedReason ? ` reason=${expectedReason}` : ""}`);
  } else {
    fail(`expected: fire=${expectFire}${expectedReason ? ` reason=${expectedReason}` : ""}; got fire=${decision.fire} reason=${decision.reason}`);
  }
  // Simulate the post-fire bookkeeping the extension does on success.
  if (decision.fire) {
    lastRecallPrompt = prompt;
    lastRecallAt = now;
    turnsSinceLastRecall = 0;
  }
  return decision;
}

// ─── Scenario from the Phase F plan ──────────────────────────────────────

// Turn 1: about smart-compaction → recall fires (baseline, first-turn).
turn("1", "what is the smart-compaction fallback policy and how does it pick a provider", true, "first-turn");

// Turn 2: same topic, immediate follow-up. Cooldown gate suppresses.
now += 10_000; // 10s later
turn("2 (immediate follow-up, inside cooldown)", "how does the smart-compaction fallback choose between auto and off", false, "cooldown");

// Turn 2b: same topic, AFTER the cooldown expires. Should still suppress
// because the prompts overlap heavily (jaccard).
now += 60_000; // 60s later — past cooldown
turn("2b (same topic, past cooldown)", "what triggers the smart-compaction fallback policy to flip", false, "similar");

// Turn 3: unrelated topic. Past cooldown. Should fire because jaccard
// overlap with lastRecallPrompt drops below the threshold.
now += 5_000;
turn("3 (unrelated topic, past cooldown)", "what was the loop-detector reasoning fixture threshold and how was it measured", true, "jaccard");

// Turn 4 (bonus): trigger phrase. The previous turn established the
// "loop detector reasoning fixture threshold" topic; we now ask a heavily
// overlapping follow-up that DOES include a trigger phrase. Jaccard alone
// would suppress this re-fire (overlap above 0.2), so the only way it can
// re-fire is via the trigger-phrase signal. Cooldown must be cleared first.
now += 70_000;
turn("4 (trigger phrase, past cooldown, high overlap)", "the loop detector reasoning fixture threshold — we decided to use 12 tokens, right?", true, "trigger");

console.log("");
if (process.exitCode) {
  console.log(red(bold("Phase F smoke FAILED")));
} else {
  console.log(green(bold("Phase F smoke PASSED — all 5 scenarios match expected decisions")));
}
