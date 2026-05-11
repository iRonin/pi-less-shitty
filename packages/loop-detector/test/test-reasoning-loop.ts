/**
 * Tests for the reasoning-content loop detector.
 *
 * Runs under `node --test --experimental-strip-types`. Lives next to the
 * vitest tool-loop tests but uses node:test so we honor the spec literally
 * (no test-runner coupling beyond stdlib).
 *
 * Required cases (per Phase B spec):
 *   1. Canonical fixture qwen-35b-safari-loop (units A..F repeated 3x) -> critical fires fast.
 *   2. Legitimate iterative refinement (3 turns on different files) -> none.
 *   3. Single "going in circles" mid-trace -> none.
 *   4. Near-duplicate via Jaccard (unit B + canonical paraphrase) -> detected.
 *   5. Empty / one-paragraph input -> none.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ReasoningLoopDetector,
  detectInText,
  normalizeParagraph,
  shingles,
  jaccard,
  segmentBuffer,
} from "../src/reasoning-loop-detector.ts";

// -- Canonical fixture units (verbatim from tasks/loop-fixtures/qwen-35b-safari-loop.md) --

const UNIT_A = `OK, I'm going in circles. Let me just check the code for Safari-specific
issues and fix them.`;

const UNIT_B = `Actually, I think the issue might be simpler. Let me check if Safari has
issues with the ES module imports or if there's a specific Canvas API
that Safari doesn't support the same way.`;

const UNIT_C = `Let me look at the code for Safari-specific issues. I'll check:
1. devicePixelRatio - Safari supports this, but might return a different value
2. Canvas 2D API - Safari supports most Canvas 2D features, but might have some differences
3. ES modules - Safari supports ES modules, but might have different caching behavior`;

const UNIT_D = `Actually, I think the most likely issue is that Safari's devicePixelRatio
is not being handled correctly, causing the canvas to be sized incorrectly
or the rendering to be off-screen.`;

const UNIT_E = `Let me check the resizeCanvas function and the rendering code for
Safari-specific issues.`;

// UNIT_F has internal blank lines so the segmenter splits it into 3 paragraphs.
// That's the real text from the fixture; we preserve it verbatim.
const UNIT_F = `OK, I need to stop going in circles and actually fix the issue. Let me
check the code for Safari-specific issues and fix them.

The most likely Safari issues:
1. devicePixelRatio - Safari might return a different value
2. Canvas rendering - Safari might handle certain Canvas 2D calls differently
3. Visibility API - Safari might handle visibilitychange differently
4. ES module caching - Safari might cache old versions

Let me check the code and fix these issues.`;

// -- Helpers --

function join(...paragraphs: string[]): string {
  return paragraphs.join("\n\n") + "\n\n";
}

// ----------------------------------------------------------------------------

test("normalizeParagraph lowercases, strips a leading list marker and trailing punctuation", () => {
  assert.equal(normalizeParagraph("1. Foo Bar."), "foo bar");
  assert.equal(normalizeParagraph("- Foo bar!"), "foo bar");
  assert.equal(
    normalizeParagraph("Hello,    world.\n  Multiple   spaces."),
    "hello, world. multiple spaces",
  );
  // Only strips ONE leading marker; nested-prefix is left as-is.
  assert.equal(normalizeParagraph("1) 2) deep"), "2) deep");
});

test("shingles + jaccard: identical strings -> 1.0", () => {
  const a = shingles("hello world", 3);
  const b = shingles("hello world", 3);
  assert.equal(jaccard(a, b), 1);
});

test("shingles + jaccard: completely different strings -> ~0", () => {
  const a = shingles("the quick brown fox", 3);
  const b = shingles("zyxwvutsrqponmlkj", 3);
  assert.ok(jaccard(a, b) < 0.1, `expected near-zero, got ${jaccard(a, b)}`);
});

test("segmentBuffer: closes paragraphs only at blank lines, leaves open paragraph in remainder", () => {
  const out = segmentBuffer("first para\n\nsecond para\n\nopen", 2000);
  assert.deepEqual(out.paragraphs, ["first para", "second para"]);
  assert.equal(out.remainder, "open");
});

test("segmentBuffer: force-splits at sentence boundary when buffer exceeds maxLen", () => {
  const sentence = "A very long sentence. ".repeat(200); // ~4400 chars, no blank lines
  const out = segmentBuffer(sentence, 1000);
  assert.ok(out.paragraphs.length >= 4, `expected >=4 splits, got ${out.paragraphs.length}`);
});

// -- Canonical fixture: A..F repeated 3x must trigger early --
//
// Note: UNIT_F has internal blank lines, so the segmenter sees 8 paragraphs
// per cycle, not 6. The spec said "by paragraph 9" assuming monolithic
// units; the realistic equivalent is "well within the 2nd cycle" = within
// 2 repetitions of any single-paragraph unit (A/B/C/D/E).

test("canonical fixture: A..F repeated 3x -> critical fires within 2 cycles", () => {
  // Window K=16 holds all 8 segmented sub-units + a few repeats.
  const detector = new ReasoningLoopDetector({ windowSize: 16 });
  const stream = join(
    UNIT_A, UNIT_B, UNIT_C, UNIT_D, UNIT_E, UNIT_F, // cycle 1
    UNIT_A, UNIT_B, UNIT_C, UNIT_D, UNIT_E, UNIT_F, // cycle 2
    UNIT_A, UNIT_B, UNIT_C, UNIT_D, UNIT_E, UNIT_F, // cycle 3
  );
  const v = detector.record(stream);
  assert.equal(
    v.severity, "critical",
    `expected critical, got ${v.severity} (repeats=${v.repeatCount}, paras=${v.paragraphsSeen})`,
  );
  assert.ok(v.repeatCount >= 3, `repeatCount=${v.repeatCount}`);
});

test("canonical fixture: critical fires inside the 2nd cycle (no 3rd cycle needed)", () => {
  const detector = new ReasoningLoopDetector({ windowSize: 16 });
  const twoCycles = join(
    UNIT_A, UNIT_B, UNIT_C, UNIT_D, UNIT_E, UNIT_F,
    UNIT_A, UNIT_B, UNIT_C, UNIT_D, UNIT_E, UNIT_F,
  );
  const v = detector.record(twoCycles);
  assert.equal(
    v.severity, "critical",
    `expected critical inside 2 cycles, got ${v.severity} (repeats=${v.repeatCount}, paras=${v.paragraphsSeen})`,
  );
});

test("canonical fixture: streaming chunk-by-chunk also triggers", () => {
  const detector = new ReasoningLoopDetector({ windowSize: 16 });
  const stream = join(
    UNIT_A, UNIT_B, UNIT_C, UNIT_D, UNIT_E, UNIT_F,
    UNIT_A, UNIT_B, UNIT_C, UNIT_D, UNIT_E, UNIT_F,
  );
  // Feed in tiny 17-char chunks to simulate token-level deltas.
  let critical = false;
  for (let i = 0; i < stream.length; i += 17) {
    const v = detector.record(stream.slice(i, i + 17));
    if (v.severity === "critical") { critical = true; break; }
  }
  assert.equal(critical, true);
});

// -- Negative: legitimate iterative refinement --

test("legitimate iterative refinement (3 different files) -> none", () => {
  const detector = new ReasoningLoopDetector();
  detector.record(
    "I'm going to fix the Safari rendering bug in `canvas.js`. The function `resizeCanvas` " +
      "uses `devicePixelRatio` without accounting for Safari's behavior. I'll update it now.\n\n",
  );
  detector.record(
    "Now I need to look at `events.js`. Safari handles the `visibilitychange` event differently " +
      "from Chrome - it fires later and sometimes not at all on tab switch. I'll add a fallback timer.\n\n",
  );
  detector.record(
    "Finally `module-loader.js`. The ES module cache in Safari is more aggressive than in " +
      "Chrome. I'll add a cache-busting query string for development builds only.\n\n",
  );
  const v = detector.flush();
  assert.equal(v.severity, "none", `false positive: ${JSON.stringify(v)}`);
});

// -- Negative: single "going in circles" mid-trace --

test("single 'going in circles' phrase mid-trace -> none", () => {
  const detector = new ReasoningLoopDetector();
  const trace = join(
    "First, let me read the file to understand the current structure.",
    "I see the function is called from three places. Let me grep for those.",
    "OK, I'm going in circles. Let me step back and check the actual error.",
    "Looking at the stack trace, the error happens inside `resizeCanvas`.",
    "I'll add a guard for undefined `devicePixelRatio` and re-run the tests.",
  );
  const v = detector.record(trace);
  assert.equal(v.severity, "none", `false positive: ${JSON.stringify(v)}`);
});

// -- Tier 2: Jaccard near-duplicate --

test("Jaccard near-duplicate detection: unit B then its canonical paraphrase -> near match", () => {
  // Per fixture: the only paraphrase observed in the wild is
  // "issue might be simpler" -> "issue might be something simpler"
  // (one-word insertion). Exact variation called out in the fixture spec.
  const detector = new ReasoningLoopDetector({ threshold: 2 });
  detector.record(
    "Looking at the bug report. Safari is showing canvas content shifted off-screen on retina displays.\n\n",
  );
  detector.record(UNIT_B + "\n\n");
  const paraphrase = UNIT_B.replace("issue might be simpler", "issue might be something simpler") + "\n\n";
  const v = detector.record(paraphrase);
  assert.equal(v.matchType, "near", `expected near, got ${v.matchType} (repeat=${v.repeatCount})`);
  assert.ok(v.repeatCount >= 1, "expected at least 1 repeat");
});

test("Jaccard direct: unit B vs its canonical one-word paraphrase >= 0.8", () => {
  const a = shingles(normalizeParagraph(UNIT_B), 3);
  const b = shingles(
    normalizeParagraph(
      UNIT_B.replace("issue might be simpler", "issue might be something simpler"),
    ),
    3,
  );
  const sim = jaccard(a, b);
  assert.ok(sim >= 0.8, `paraphrase similarity ${sim.toFixed(3)} must be >= 0.8 per spec`);
});

// -- Empty / one-paragraph --

test("empty input -> none", () => {
  const detector = new ReasoningLoopDetector();
  const v = detector.record("");
  assert.equal(v.severity, "none");
  assert.equal(v.paragraphsSeen, 0);
});

test("single paragraph -> none", () => {
  const detector = new ReasoningLoopDetector();
  detector.record("This is the only paragraph in the assistant's reply.\n\n");
  const v = detector.flush();
  assert.equal(v.severity, "none");
  assert.equal(v.paragraphsSeen, 1);
  assert.equal(v.repeatCount, 0);
});

test("two non-matching paragraphs -> none", () => {
  const detector = new ReasoningLoopDetector();
  detector.record("Paragraph alpha about cats and their behavior on rainy days.\n\n");
  detector.record("Paragraph beta about completely different topic: train timetables.\n\n");
  const v = detector.flush();
  assert.equal(v.severity, "none");
});

// -- Per-model override / config update plumbing --

test("updateConfig: lower threshold -> critical fires sooner", () => {
  const detector = new ReasoningLoopDetector({ threshold: 3 });
  detector.updateConfig({ threshold: 2 });
  detector.record(join(UNIT_A, UNIT_B, UNIT_A, UNIT_B));
  // After 4 paras: A B A B -> 2 repeats -> with threshold=2 must be critical.
  const v = detector.flush();
  assert.equal(v.severity, "critical");
  assert.equal(detector.getConfig().threshold, 2);
});

// -- reset() --

test("reset() clears all state", () => {
  const detector = new ReasoningLoopDetector();
  detector.record(join(UNIT_A, UNIT_B, UNIT_C, UNIT_A, UNIT_B, UNIT_C, UNIT_A));
  detector.reset();
  const v = detector.record("first paragraph in fresh state.\n\n");
  assert.equal(v.severity, "none");
  assert.equal(v.paragraphsSeen, 1);
});

// -- detectInText convenience for offline replay --

test("detectInText: fires on canonical fixture in one call", () => {
  const stream = join(
    UNIT_A, UNIT_B, UNIT_C, UNIT_D, UNIT_E, UNIT_F,
    UNIT_A, UNIT_B, UNIT_C, UNIT_D, UNIT_E, UNIT_F,
    UNIT_A, UNIT_B, UNIT_C, UNIT_D, UNIT_E, UNIT_F,
  );
  // window=16 holds all 8 segmented sub-units plus repeats.
  const v = detectInText(stream, { windowSize: 16 });
  assert.equal(v.severity, "critical");
});

test("detectInText: does not fire on non-looping text", () => {
  const text =
    "Reading the file now.\n\nFound the bug - it's an off-by-one in the renderer.\n\n" +
    "Applied the fix and added a regression test.\n\n";
  const v = detectInText(text);
  assert.equal(v.severity, "none");
});
