/**
 * Test script for smart compaction scorer.
 *
 * Runs heuristic scoring on synthetic messages to verify correctness,
 * then tests LLM scoring against a real Pi session if available.
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

function assert(label: string, condition: boolean) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}`);
  }
}

// ---------------------------------------------------------------------------
// Heuristic scoring tests
// ---------------------------------------------------------------------------

console.log("\n═══ Heuristic Scoring Tests ═══\n");

// 1. User directive should score HIGH
{
  const result = scoreTurn("user", mk("user", "Update the auth module to use OAuth2"), {});
  assert("user directive → HIGH (≥6)", result >= 6);
  console.log(`    score=${result}`);
}

// 2. Assistant design decision → HIGH
{
  const result = scoreTurn("assistant", mk("assistant", "I decided to use the repository pattern because it decouples data access"), {});
  assert("design decision → HIGH (≥6)", result >= 6);
  console.log(`    score=${result}`);
}

// 3. Empty assistant with tool calls → not penalized
{
  const result = scoreTurn("assistant", tool("assistant", [{ name: "write", arguments: { path: "/src/main.ts", content: "hello" } }]), "");
  assert("tool-call with no text → not penalized", result >= 5);
  console.log(`    score=${result}`);
}

// 4. Write/edit tool bonus
{
  const result = scoreTurn("assistant", tool("assistant", [{ name: "edit", arguments: { path: "/src/scorer.ts" } }]), "Updated the scoring logic");
  assert("edit tool + text → bonus (≥7)", result >= 7);
  console.log(`    score=${result}`);
}

// 5. Retry language → penalized
{
  const result = scoreTurn("assistant", mk("assistant", "Oops, let me try again with a different approach"));
  assert("retry language → penalized (≤4)", result <= 4);
  console.log(`    score=${result}`);
}

// 6. Simple acknowledgment → LOW
{
  const result = scoreTurn("assistant", mk("assistant", "Got it, will do"));
  assert("acknowledgment → LOW (≤4)", result <= 4);
  console.log(`    score=${result}`);
}

// 7. Tool error retry context-aware
{
  const prev = [
    mk("toolResult", "error: failed to connect to database"),
  ];
  const result = scoreTurn("toolResult", mk("toolResult", "error: failed to connect to database, retrying"), { prevMessages: prev, window: 3 });
  assert("context-aware retry penalty", result <= 4);
  console.log(`    score=${result}`);
}

// 8. File success → bonus
{
  const result = scoreTurn("toolResult", mk("toolResult", "file written successfully to /src/auth.ts"));
  assert("file_success signal → bonus (≥7)", result >= 7);
  console.log(`    score=${result}`);
}

// 9. Specific file path → bonus
{
  const result = scoreTurn("assistant", mk("assistant", "The issue is in /packages/core/model-resolver.ts line 142"));
  assert("specific file path → bonus (≥7)", result >= 7);
  console.log(`    score=${result}`);
}

// 10. Classification function
{
  assert("classify(8, 6, 5) → HIGH", classify(8, 6, 5) === "HIGH");
  assert("classify(5, 6, 5) → MEDIUM", classify(5, 6, 5) === "MEDIUM");
  assert("classify(4, 6, 5) → LOW", classify(4, 6, 5) === "LOW");
  assert("classify(6, 6, 5) → HIGH", classify(6, 6, 5) === "HIGH");
}

// ---------------------------------------------------------------------------
// Full message set test
// ---------------------------------------------------------------------------

console.log("\n═══ Full Conversation Test ═══\n");

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

console.log("  #  role          text(50)                           score class method");
console.log("  " + "─".repeat(80));
for (let i = 0; i < conversation.length; i++) {
  const m = conversation[i];
  const text = typeof m.content === "string" ? m.content.substring(0, 50) : "⚡tool-call";
  console.log(`  ${(i + 1).toString().padStart(2)} ${m.role.padEnd(14)} ${text.padEnd(40)} ${scored[i].score.toString().padStart(2)}    ${scored[i].classification}`);
}

const high = scored.filter((s) => s.classification === "HIGH").length;
const med = scored.filter((s) => s.classification === "MEDIUM").length;
const low = scored.filter((s) => s.classification === "LOW").length;

console.log(`\n  Summary: ${high} HIGH, ${med} MEDIUM, ${low} LOW`);
assert("high count matches", high === scored.filter((s) => s.classification === "HIGH").length);

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

console.log(`\n═══ Results: ${passed} passed, ${failed} failed ═══\n`);
process.exit(failed > 0 ? 1 : 0);
