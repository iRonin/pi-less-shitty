/**
 * Tests for the zero-units-extracted renderer enrichment (May 2026).
 *
 * Covers the five additive enrichments:
 *   1. op_id surfacing + ready-to-paste curl using the resolved api_url
 *   2. transcript preview (head + ctrl+o full)
 *   3. pre/post unit counts + delta + fresh-bank distinction
 *   4. per-bank consecutive-zero streak counter + reset semantics
 *   5. duration bucket label (< 1s / 1-10s / 10-30s / > 30s)
 *
 * The pure helpers live in zero-units-render.ts (no pi-tui peer dep) so we
 * exercise them directly. Reset-on-session_start and reset-on-/hindsight-reset
 * are pinned by source-level greps to encode the wiring contract.
 *
 * Run: node --experimental-strip-types --test test/zero-units-render.test.ts
 */

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bumpConsecutiveZero,
  resetConsecutiveZero,
  getConsecutiveZero,
  __getConsecutiveZeroMapForTests,
  durationBucketLabel,
  transcriptHead,
  TRANSCRIPT_HEAD_MAX,
  streakOrdinal,
  buildInspectCurl,
  renderZeroUnitsMessage,
} from "../zero-units-render.ts";

// Pass-through theme so we can assert on plain text. The renderer only uses
// theme.fg(color, s) so this is the entire surface area.
const passthroughTheme = { fg: (_color: string, s: string) => s };

// Default details payload — every test overrides only the fields it asserts on.
function makeDetails(over: Record<string, unknown> = {}): any {
  return {
    bank: "legal-tools",
    operation_id: "01HG-test-op",
    op_age_ms: 8200,
    document_id: "session-x",
    pre_units_count: 47,
    post_units_count: 47,
    transcript_len: 2150,
    transcript: "check exacly the authorites, peer revied research and exhibits i filed\ni need to be able to use them",
    error_message: null,
    legit_empty: false,
    api_url: "http://localhost:8787",
    consecutive_zero_streak: 1,
    ...over,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Consecutive-zero counter
// ───────────────────────────────────────────────────────────────────────────

describe("consecutive-zero counter", () => {
  beforeEach(() => resetConsecutiveZero());

  test("three zero-unit retains to bank X → counter is 3, render shows 3rd consecutive", () => {
    assert.equal(bumpConsecutiveZero("legal-tools"), 1);
    assert.equal(bumpConsecutiveZero("legal-tools"), 2);
    assert.equal(bumpConsecutiveZero("legal-tools"), 3);
    assert.equal(getConsecutiveZero("legal-tools"), 3);

    const out = renderZeroUnitsMessage(
      makeDetails({ consecutive_zero_streak: 3 }),
      false,
      passthroughTheme,
    );
    assert.match(out, /streak: 3rd consecutive 0-unit retain to legal-tools/);
  });

  test("two zeros then a per-bank reset → counter is 0, success render omits streak line", () => {
    bumpConsecutiveZero("legal-tools");
    bumpConsecutiveZero("legal-tools");
    assert.equal(getConsecutiveZero("legal-tools"), 2);

    // Production wiring: any retain with delta > 0 to that bank calls
    // resetConsecutiveZero(bank). Mirror that here.
    resetConsecutiveZero("legal-tools");
    assert.equal(getConsecutiveZero("legal-tools"), 0);

    // A subsequent zero is now a fresh 1 — single-zero is noise; renderer
    // suppresses the streak line.
    const streak = bumpConsecutiveZero("legal-tools");
    assert.equal(streak, 1);
    const out = renderZeroUnitsMessage(
      makeDetails({ consecutive_zero_streak: streak }),
      false,
      passthroughTheme,
    );
    assert.doesNotMatch(out, /streak:/, "streak=1 must not render the streak line");
  });

  test("counter is module-level → state survives across logical 'watcher dispatches' within one process", () => {
    // Simulate two independent watcher invocations: each just calls bump
    // for its own bank. The module-level Map carries state forward.
    bumpConsecutiveZero("bank-a");
    bumpConsecutiveZero("bank-a");
    bumpConsecutiveZero("bank-b");
    const snapshot = __getConsecutiveZeroMapForTests();
    assert.equal(snapshot.get("bank-a"), 2);
    assert.equal(snapshot.get("bank-b"), 1);

    // Independent buckets — resetting bank-b does NOT touch bank-a.
    resetConsecutiveZero("bank-b");
    assert.equal(getConsecutiveZero("bank-a"), 2);
    assert.equal(getConsecutiveZero("bank-b"), 0);
  });

  test("resetConsecutiveZero() with no arg clears EVERY bank (session_start / /hindsight reset semantics)", () => {
    bumpConsecutiveZero("a");
    bumpConsecutiveZero("b");
    bumpConsecutiveZero("c");
    assert.equal(__getConsecutiveZeroMapForTests().size, 3);
    resetConsecutiveZero();
    assert.equal(__getConsecutiveZeroMapForTests().size, 0);
  });

  test("single-zero (count = 1) does NOT render the streak line — only ≥ 2", () => {
    const out1 = renderZeroUnitsMessage(makeDetails({ consecutive_zero_streak: 1 }), false, passthroughTheme);
    assert.doesNotMatch(out1, /streak:/);

    const out2 = renderZeroUnitsMessage(makeDetails({ consecutive_zero_streak: 2 }), false, passthroughTheme);
    assert.match(out2, /streak: 2nd consecutive/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Source-level wiring: session_start and /hindsight reset both call
// resetConsecutiveZero() so a fresh session / explicit reset clears the
// per-bank streak. Pinned by greps so a refactor that drops one of these
// wirings is caught structurally (Rule 9).
// ───────────────────────────────────────────────────────────────────────────

describe("counter reset wiring (source-level)", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, "..", "index.ts"), "utf-8");

  test("session_start handler calls resetConsecutiveZero()", () => {
    const sessionStartIdx = src.indexOf("pi.on(\"session_start\"");
    assert.ok(sessionStartIdx > 0, "session_start handler missing");
    const sessionCompactIdx = src.indexOf("pi.on(\"session_compact\"", sessionStartIdx);
    assert.ok(sessionCompactIdx > sessionStartIdx, "session_compact marker missing");
    const handlerBody = src.slice(sessionStartIdx, sessionCompactIdx);
    assert.match(
      handlerBody,
      /resetConsecutiveZero\s*\(\s*\)/,
      "session_start must call resetConsecutiveZero() to clear stale streak from prior session",
    );
  });

  test('/hindsight reset subcommand calls resetConsecutiveZero()', () => {
    const resetIdx = src.indexOf("if (sub === \"reset\")");
    assert.ok(resetIdx > 0, "/hindsight reset block missing");
    // Walk forward until the next `if (sub ===` or end-of-block. 800 chars
    // is more than enough; the reset block is small.
    const slice = src.slice(resetIdx, resetIdx + 800);
    assert.match(
      slice,
      /resetConsecutiveZero\s*\(\s*\)/,
      "/hindsight reset must call resetConsecutiveZero() to clear all per-bank streaks",
    );
  });

  test("zero-units branch in watchRetainOperation calls bumpConsecutiveZero(bank)", () => {
    // Pin: the production watcher must increment the per-bank counter inside
    // the substantial-zero-delta branch so the streak surfaces in details.
    const watcherIdx = src.indexOf("async function watchRetainOperation");
    assert.ok(watcherIdx > 0, "watchRetainOperation declaration missing");
    const watcherEnd = src.indexOf("async function buildPreRetainSnapshot", watcherIdx);
    const body = src.slice(watcherIdx, watcherEnd > 0 ? watcherEnd : watcherIdx + 5000);
    assert.match(body, /bumpConsecutiveZero\s*\(\s*bank\s*\)/);
    // And the success branch resets it so a recovered LLM clears the streak.
    assert.match(body, /resetConsecutiveZero\s*\(\s*bank\s*\)/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Duration bucketing
// ───────────────────────────────────────────────────────────────────────────

describe("durationBucketLabel — boundary behavior", () => {
  test("< 1s → fast", () => {
    assert.equal(durationBucketLabel(0), "fast — LLM likely bailed or rejected content");
    assert.equal(durationBucketLabel(400), "fast — LLM likely bailed or rejected content");
    assert.equal(durationBucketLabel(999), "fast — LLM likely bailed or rejected content");
  });

  test("1s boundary: 1000 ms → normal", () => {
    assert.equal(durationBucketLabel(1000), "normal");
    assert.equal(durationBucketLabel(5000), "normal");
    assert.equal(durationBucketLabel(9999), "normal");
  });

  test("10s boundary: 10_000 ms → slow", () => {
    assert.equal(durationBucketLabel(10_000), "slow");
    assert.equal(durationBucketLabel(15_000), "slow");
    assert.equal(durationBucketLabel(29_999), "slow");
  });

  test("30s boundary: 30_000 ms → very slow", () => {
    assert.equal(durationBucketLabel(30_000), "very slow — possible timeout");
    assert.equal(durationBucketLabel(120_000), "very slow — possible timeout");
  });

  test("bucket label surfaces in rendered output", () => {
    const fast = renderZeroUnitsMessage(makeDetails({ op_age_ms: 400 }), false, passthroughTheme);
    assert.match(fast, /\(0\.4s, fast \u2014 LLM likely bailed or rejected content\)/);

    const slow = renderZeroUnitsMessage(makeDetails({ op_age_ms: 15_000 }), false, passthroughTheme);
    assert.match(slow, /\(15\.0s, slow\)/);

    const veryslow = renderZeroUnitsMessage(makeDetails({ op_age_ms: 35_200 }), false, passthroughTheme);
    assert.match(veryslow, /\(35\.2s, very slow \u2014 possible timeout\)/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Op_id + curl inspect line uses the configured api_url (not hardcoded)
// ───────────────────────────────────────────────────────────────────────────

describe("op_id and curl-inspect line", () => {
  test("op_id appears verbatim in collapsed render", () => {
    const out = renderZeroUnitsMessage(makeDetails({ operation_id: "01HG-uuid-abc-123" }), false, passthroughTheme);
    assert.match(out, /op_id: 01HG-uuid-abc-123/);
  });

  test("buildInspectCurl uses the resolved api_url (NOT hardcoded localhost:8787)", () => {
    // Custom non-default port — confirms the helper threads api_url through.
    const curl = buildInspectCurl("http://localhost:9999", "legal-tools", "01HG-op");
    assert.equal(
      curl,
      "curl -s http://localhost:9999/v1/default/banks/legal-tools/operations/01HG-op | jq",
    );
  });

  test("expanded render surfaces the curl line using the configured api_url", () => {
    const out = renderZeroUnitsMessage(
      makeDetails({ api_url: "http://localhost:9090", operation_id: "01HG-op-x", bank: "B" }),
      true,
      passthroughTheme,
    );
    assert.match(out, /inspect: curl -s http:\/\/localhost:9090\/v1\/default\/banks\/B\/operations\/01HG-op-x \| jq/);
  });

  test("collapsed render advertises ctrl+o, expanded render does not", () => {
    const collapsed = renderZeroUnitsMessage(makeDetails(), false, passthroughTheme);
    assert.match(collapsed, /ctrl\+o for full transcript/);

    const expanded = renderZeroUnitsMessage(makeDetails(), true, passthroughTheme);
    assert.doesNotMatch(expanded, /ctrl\+o for full transcript/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Transcript preview
// ───────────────────────────────────────────────────────────────────────────

describe("transcriptHead — preview generation", () => {
  test("truncates at 200 chars with ellipsis", () => {
    const long = "x".repeat(500);
    const head = transcriptHead(long);
    assert.equal(head.length, TRANSCRIPT_HEAD_MAX + 1, "200 chars + ellipsis");
    assert.ok(head.endsWith("…"));
  });

  test("encodes newlines as ⏎", () => {
    const head = transcriptHead("line one\nline two\r\nline three\rline four");
    assert.equal(head, "line one⏎line two⏎line three⏎line four");
    assert.doesNotMatch(head, /[\r\n]/);
  });

  test("preview is empty-safe — empty string → sentinel", () => {
    assert.equal(transcriptHead(""), "(no transcript captured)");
  });

  test("preview is empty-safe — null/undefined → sentinel (no crash)", () => {
    assert.equal(transcriptHead(null), "(no transcript captured)");
    assert.equal(transcriptHead(undefined), "(no transcript captured)");
  });

  test("missing transcript in details renders sentinel without crashing", () => {
    const d = makeDetails();
    delete d.transcript;
    const out = renderZeroUnitsMessage(d, false, passthroughTheme);
    assert.match(out, /input head: \(no transcript captured\)/);
  });

  test("short transcript renders verbatim with newlines flattened", () => {
    const out = renderZeroUnitsMessage(
      makeDetails({ transcript: "hello\nworld" }),
      false,
      passthroughTheme,
    );
    assert.match(out, /input head: hello\u23ceworld/);
  });

  test("expanded render shows the FULL transcript (newlines preserved, indented)", () => {
    const t = "line a\nline b\nline c";
    const out = renderZeroUnitsMessage(makeDetails({ transcript: t }), true, passthroughTheme);
    assert.match(out, /\u2500\u2500 full transcript \u2500\u2500/);
    // Two-space indent per line in expanded body
    assert.match(out, /  line a\n  line b\n  line c/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Units delta line
// ───────────────────────────────────────────────────────────────────────────

describe("units-delta line", () => {
  test("existing bank, no delta: shows '47 → 47 (Δ 0)'", () => {
    const out = renderZeroUnitsMessage(
      makeDetails({ pre_units_count: 47, post_units_count: 47 }),
      false,
      passthroughTheme,
    );
    assert.match(out, /units: 47 \u2192 47 \(\u0394 0\)/);
  });

  test("fresh bank (pre=0, post=0): shows fresh-bank explanation", () => {
    const out = renderZeroUnitsMessage(
      makeDetails({ pre_units_count: 0, post_units_count: 0 }),
      false,
      passthroughTheme,
    );
    assert.match(out, /units: 0 \u2192 0 \(fresh bank, no facts extracted\)/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Streak ordinal helper
// ───────────────────────────────────────────────────────────────────────────

describe("streakOrdinal — English suffix table", () => {
  test("1, 2, 3 special suffixes", () => {
    assert.equal(streakOrdinal(1), "1st");
    assert.equal(streakOrdinal(2), "2nd");
    assert.equal(streakOrdinal(3), "3rd");
  });
  test("11, 12, 13 are 'th' (teens trap)", () => {
    assert.equal(streakOrdinal(11), "11th");
    assert.equal(streakOrdinal(12), "12th");
    assert.equal(streakOrdinal(13), "13th");
  });
  test("21, 22, 23 use 'st/nd/rd' again", () => {
    assert.equal(streakOrdinal(21), "21st");
    assert.equal(streakOrdinal(22), "22nd");
    assert.equal(streakOrdinal(23), "23rd");
  });
  test("default → 'th'", () => {
    assert.equal(streakOrdinal(4), "4th");
    assert.equal(streakOrdinal(100), "100th");
    assert.equal(streakOrdinal(111), "111th");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Full message sample: integration of all five enrichments
// ───────────────────────────────────────────────────────────────────────────

describe("full render — combined enrichments", () => {
  test("legit-empty branch carries all five enrichments", () => {
    const out = renderZeroUnitsMessage(
      makeDetails({
        legit_empty: true,
        op_age_ms: 400,
        consecutive_zero_streak: 3,
        operation_id: "01HG-X",
      }),
      false,
      passthroughTheme,
    );
    // 1. duration bucket
    assert.match(out, /\(0\.4s, fast \u2014 LLM likely bailed or rejected content\)/);
    // 2. legit-empty header
    assert.match(out, /\u2139 Hindsight: 0 facts extracted/);
    // 3. units delta line
    assert.match(out, /units: 47 \u2192 47/);
    // 4. streak (3rd)
    assert.match(out, /streak: 3rd consecutive 0-unit retain to legal-tools/);
    // 5. op_id
    assert.match(out, /op_id: 01HG-X/);
    // transcript preview
    assert.match(out, /input head: check exacly the authorites/);
    // ctrl+o hint
    assert.match(out, /ctrl\+o for full transcript/);
  });

  test("real-down branch carries the warning header + error line", () => {
    const out = renderZeroUnitsMessage(
      makeDetails({
        legit_empty: false,
        op_age_ms: 8200,
        error_message: "Connection refused: dial tcp 127.0.0.1:8080",
        consecutive_zero_streak: 2,
      }),
      false,
      passthroughTheme,
    );
    assert.match(out, /\u26a0 Hindsight retain completed but added 0 units/);
    assert.match(out, /\(8\.2s, normal\)/);
    assert.match(out, /Connection refused: dial tcp 127\.0\.0\.1:8080/);
    assert.match(out, /streak: 2nd consecutive 0-unit retain to legal-tools/);
  });
});
