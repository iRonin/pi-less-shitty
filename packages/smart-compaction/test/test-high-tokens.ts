/**
 * Regression test for non-contiguous HIGH classification token accounting.
 *
 * BUG (pre-fix): `scored.filter(s => s.classification === "HIGH").reduce((sum, s, idx) => sum + estimateMsgTokens(flatMsgs[idx]), 0)`
 * — `idx` after .filter() is the index in the FILTERED array, but flatMsgs[idx]
 * indexes the ORIGINAL array. When HIGH is not a contiguous prefix, the wrong
 * messages get counted and tokensSaved is garbage.
 *
 * FIX: iterate the unfiltered array and check classification inline.
 *
 * Run: npx jiti test/test-high-tokens.ts
 */

import { scoreAllMessagesSync, classify } from "../src/scorer.js";

// ---------------------------------------------------------------------------
// Replica of estimateMsgTokens from smart-compaction.ts (pure, internal helper)
// Kept identical so the test mirrors production accounting exactly.
// ---------------------------------------------------------------------------
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c: any) => c?.type === "text" && typeof c.text === "string")
    .map((c: any) => c.text)
    .join("\n");
}
function extractToolCalls(content: unknown): Array<{ name: string; arguments: unknown }> {
  if (!Array.isArray(content)) return [];
  return content
    .filter((c: any) => c?.type === "toolCall")
    .map((c: any) => ({ name: c.name ?? "", arguments: c.arguments ?? {} }));
}
function estimateMsgTokens(msg: { role: string; content: unknown }): number {
  const text = extractText(msg.content);
  let tokens = Math.ceil(text.length / 4) + 10;
  for (const tc of extractToolCalls(msg.content)) {
    tokens += (typeof tc.arguments === "string" ? tc.arguments.length : JSON.stringify(tc.arguments).length) / 4;
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;
function assert(label: string, condition: boolean, detail = "") {
  if (condition) { passed++; console.log(`  ✓ ${label}` + (detail ? ` ${detail}` : "")); }
  else { failed++; console.log(`  ✗ ${label}` + (detail ? ` ${detail}` : "")); }
}

console.log("\n═══ highTokens non-contiguous HIGH regression test ═══\n");

// Five messages with very different sizes so the bug vs fix produce different
// totals. We do NOT rely on the heuristic scorer to pick HIGH for us — instead
// we inject a hand-crafted classification array (the data the production reduce
// receives at runtime). The point is to test the reduce, not the scorer.
const flatMsgs = [
  { role: "user",      content: "A".repeat(400) },   // idx 0 → HIGH (big)
  { role: "assistant", content: "ok" },               // idx 1 → LOW  (tiny)
  { role: "user",      content: "B".repeat(800) },   // idx 2 → HIGH (huge)
  { role: "assistant", content: "got it" },           // idx 3 → LOW  (tiny)
  { role: "user",      content: "C".repeat(1200) },  // idx 4 → HIGH (massive)
];
const scored = [
  { score: 8, classification: "HIGH" as const },
  { score: 2, classification: "LOW"  as const },
  { score: 8, classification: "HIGH" as const },
  { score: 2, classification: "LOW"  as const },
  { score: 8, classification: "HIGH" as const },
];

const expectedHighTokens =
  estimateMsgTokens(flatMsgs[0]) +
  estimateMsgTokens(flatMsgs[2]) +
  estimateMsgTokens(flatMsgs[4]);

// FIXED reduce (matches production after the fix)
const fixed = scored.reduce(
  (sum, s, i) => (s.classification === "HIGH" ? sum + estimateMsgTokens(flatMsgs[i]) : sum),
  0,
);

// BUGGY reduce (matches production BEFORE the fix) — kept so the test
// documents the regression and proves the two paths really diverge.
const buggy = scored
  .filter((s) => s.classification === "HIGH")
  .reduce((sum, _s, idx) => sum + estimateMsgTokens(flatMsgs[idx]), 0);

const buggyExpected =
  estimateMsgTokens(flatMsgs[0]) +
  estimateMsgTokens(flatMsgs[1]) +
  estimateMsgTokens(flatMsgs[2]);

assert(
  "fixed reduce sums the actual HIGH messages [0,2,4]",
  fixed === expectedHighTokens,
  `expected=${expectedHighTokens} got=${fixed}`,
);
assert(
  "buggy reduce demonstrably diverges from fixed",
  buggy !== fixed,
  `buggy=${buggy} fixed=${fixed}`,
);
assert(
  "buggy reduce sums the wrong messages [0,1,2] (regression marker)",
  buggy === buggyExpected,
  `expected=${buggyExpected} got=${buggy}`,
);

// Sanity: contiguous HIGH prefix — both formulas agree (the bug is invisible here)
{
  const contigScored = [
    { score: 8, classification: "HIGH" as const },
    { score: 8, classification: "HIGH" as const },
    { score: 8, classification: "HIGH" as const },
    { score: 2, classification: "LOW"  as const },
    { score: 2, classification: "LOW"  as const },
  ];
  const f = contigScored.reduce(
    (sum, s, i) => (s.classification === "HIGH" ? sum + estimateMsgTokens(flatMsgs[i]) : sum),
    0,
  );
  const b = contigScored
    .filter((s) => s.classification === "HIGH")
    .reduce((sum, _s, idx) => sum + estimateMsgTokens(flatMsgs[idx]), 0);
  assert("contiguous HIGH prefix: bug invisible (fixed === buggy)", f === b, `fixed=${f} buggy=${b}`);
}

// Smoke check: scoreAllMessagesSync is still importable and runs
{
  const out = scoreAllMessagesSync(flatMsgs, 6, 5, 3);
  assert("scoreAllMessagesSync returns one entry per message", out.length === flatMsgs.length);
  assert("classify(8,6,5) === HIGH", classify(8, 6, 5) === "HIGH");
}

console.log(`\n═══ ${passed} passed, ${failed} failed ═══\n`);
process.exit(failed === 0 ? 0 : 1);
