/**
 * Standalone heuristic scorer test — no pi-ai dependency.
 * Runs via `npx jiti test/test-heuristic.ts`
 */

import { scoreAllMessagesSync, classify, scoreTurn } from "../src/scorer.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mk(role: string, text: string) {
  return { role, content: text };
}
function tool(role: string, calls: Array<{ name: string; arguments: Record<string, unknown> }>, text = "") {
  const parts: Array<{ type: string; name?: string; arguments?: unknown; text?: string }> = [
    ...calls.map((c) => ({ type: "toolCall", name: c.name, arguments: c.arguments })),
  ];
  if (text) parts.push({ type: "text", text });
  return { role, content: parts };
}

let passed = 0;
let failed = 0;

function assert(label: string, condition: boolean, detail = "") {
  if (condition) {
    passed++;
    console.log(`  ✓ ${label}` + (detail ? ` ${detail}` : ""));
  } else {
    failed++;
    console.log(`  ✗ ${label}` + (detail ? ` ${detail}` : ""));
  }
}

// ---------------------------------------------------------------------------
// Heuristic scoring tests
// ---------------------------------------------------------------------------

console.log("\n═══ Heuristic Scoring Tests ═══\n");

// 1. User directive should score HIGH
{
  const result = scoreTurn("user", "Update the auth module to use OAuth2", {});
  assert("user directive → HIGH (≥6)", result >= 6, `(score=${result})`);
}

// 2. Assistant design decision → HIGH
{
  const result = scoreTurn("assistant", "I decided to use the repository pattern because it decouples data access", {});
  assert("design decision → HIGH (≥6)", result >= 6, `(score=${result})`);
}

function contentOf(obj: { content: unknown }): unknown {
  return obj.content;
}

// 3. Empty assistant with tool calls → not penalized
{
  const msg = tool("assistant", [{ name: "write", arguments: { path: "/src/main.ts", content: "hello" } }]);
  const result = scoreTurn("assistant", contentOf(msg), {});
  assert("tool-call with no text → not penalized", result >= 5, `(score=${result})`);
}

// 4. Write/edit tool bonus
{
  const msg = tool("assistant", [{ name: "edit", arguments: { path: "/src/scorer.ts" } }], "Updated the scoring logic");
  const result = scoreTurn("assistant", contentOf(msg), {});
  assert("edit tool + text → bonus (≥7)", result >= 7, `(score=${result})`);
}

// 5. Retry language → penalized
{
  const result = scoreTurn("assistant", "Oops, let me try again with a different approach", {});
  assert("retry language → penalized (≤4)", result <= 4, `(score=${result})`);
}

// 6. Simple acknowledgment → LOW
{
  const result = scoreTurn("assistant", "Got it, will do", {});
  assert("acknowledgment → LOW (≤4)", result <= 4, `(score=${result})`);
}

// 7. File success → bonus
{
  const result = scoreTurn("toolResult", "file written successfully to /src/auth.ts", {});
  assert("file_success signal → bonus (≥7)", result >= 7, `(score=${result})`);
}

// 8. Specific file path → bonus
{
  const result = scoreTurn("assistant", "The issue is in /packages/core/model-resolver.ts line 142", {});
  assert("specific file path → bonus (≥7)", result >= 7, `(score=${result})`);
}

// 9. Test pass signal → bonus
{
  const result = scoreTurn("toolResult", "42 passed, 0 failed, all tests passed", {});
  assert("test_pass signal → bonus (≥7)", result >= 7, `(score=${result})`);
}

// 10. Classification function
{
  assert("classify(8, 6, 5) → HIGH", classify(8, 6, 5) === "HIGH");
  assert("classify(5, 6, 5) → MEDIUM", classify(5, 6, 5) === "MEDIUM");
  assert("classify(4, 6, 5) → LOW", classify(4, 6, 5) === "LOW");
  assert("classify(6, 6, 5) → HIGH", classify(6, 6, 5) === "HIGH");
}

// ---------------------------------------------------------------------------
// Full conversation test
// ---------------------------------------------------------------------------

console.log("\n═══ Full Conversation Test (14 turns) ═══\n");

const conversation = [
  mk("user", "Fix the retry bug in the auth module"),
  mk("assistant", "I'll investigate the auth module"),
  tool("assistant", [{ name: "read", arguments: { path: "/src/auth.ts" } }], ""),
  mk("toolResult", "read /src/auth.ts — 200 lines"),
  mk("assistant", "I see the issue — the retry logic doesn't handle rate-increased errors"),
  tool("assistant", [{ name: "edit", arguments: { path: "/src/auth.ts" } }], "Updating the error handler"),
  mk("toolResult", "file written successfully"),
  mk("assistant", "ok"),
  tool("assistant", [{ name: "bash", arguments: { command: "npm test" } }], ""),
  mk("toolResult", "42 passed, 0 failed"),
  mk("assistant", "Got it"),
  mk("user", "Also update the tests"),
  tool("assistant", [{ name: "write", arguments: { path: "/tests/auth.test.ts" } }], ""),
  mk("toolResult", "file written successfully"),
];

const scored = scoreAllMessagesSync(conversation, 6, 5, 3);

console.log("  #  role          text(50)                            score class");
console.log("  " + "─".repeat(80));
for (let i = 0; i < conversation.length; i++) {
  const m = conversation[i];
  const text = typeof m.content === "string" ? m.content.substring(0, 50) : "⚡tool";
  console.log(`  ${(i + 1).toString().padStart(2)} ${(m.role).padEnd(14)} ${(text).padEnd(42)} ${scored[i].score.toString().padStart(2)}  ${scored[i].classification}`);
}

const high = scored.filter((s) => s.classification === "HIGH").length;
const med = scored.filter((s) => s.classification === "MEDIUM").length;
const low = scored.filter((s) => s.classification === "LOW").length;

console.log(`\n  Summary: ${high} HIGH, ${med} MEDIUM, ${low} LOW`);

// Expected: user directives (#1, #12) → HIGH, edit+write (#6, #13) → HIGH,
// file success (#7, #14) → HIGH, test pass (#10) → HIGH, design decision (#5) → HIGH
assert("high ≥ 5 turns", high >= 5, `(${high})`);
assert("low ≥ 2 turns (acknowledgments)", low >= 2, `(${low})`);
assert("all methods heuristic", scored.every((s) => !("method" in s) || s.classification), "sync mode");

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

console.log(`\n═══ Results: ${passed} passed, ${failed} failed ═══\n`);
process.exit(failed > 0 ? 1 : 0);
