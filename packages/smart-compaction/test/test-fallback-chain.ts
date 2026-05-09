// Tests for the model-fallback chain + deterministic last-resort summary
// added in response to: "Smart compaction: LLM returned no text content
// (model: kilocode/qwen/qwen3.6-plus). Content types: []. Response: []"
//
// What we guarantee here:
//  1. buildModelChain order is: primary, primary-retry, ...fallbacks, session.
//  2. Empty / unresolvable fallback specs are silently skipped.
//  3. Same provider+id is deduped after the explicit retry slot.
//  4. resolveModelString accepts both "provider/id" and bare "id".
//  5. buildDeterministicSummary NEVER throws and always returns useful text
//     even when given empty inputs (this is the hard guarantee that the
//     session continues even when every configured LLM is unreachable).
//  6. The deterministic summary surfaces the diagnostics so the user can see
//     which models failed.

import { buildModelChain, resolveModelString, buildDeterministicSummary } from "../src/fallback-chain.js";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log("  ✓", name, detail); }
  else { fail++; console.log("  ✗", name, detail); }
}

function fakeRegistry(models: Array<{ provider: string; id: string }>) {
  return {
    find: (provider: string, id: string) =>
      models.find((m) => m.provider === provider && m.id === id) ?? null,
    getAvailable: () => models,
    currentModel: null,
  };
}

console.log("\n═══ buildModelChain order + dedup ═══\n");

await (async () => {
  const reg = fakeRegistry([
    { provider: "openrouter", id: "google/gemini-2.5-flash-lite" },
    { provider: "openrouter", id: "anthropic/claude-haiku-4.5" },
    { provider: "anthropic", id: "claude-sonnet-4.5" },
  ]);
  const primary = { provider: "kilocode", id: "qwen/qwen3.6-plus" };
  const session = { provider: "anthropic", id: "claude-sonnet-4.5" };
  const settings = {
    compactionFallbackModels: [
      "openrouter/google/gemini-2.5-flash-lite",
      "openrouter/anthropic/claude-haiku-4.5",
      "openrouter/does-not-exist", // silently skipped
    ],
  } as any;

  const chain = buildModelChain(primary, { model: session }, reg, settings);
  // Expected order: primary, primary (retry slot), gemini, haiku, session
  ok("chain length is 5", chain.length === 5, `(got ${chain.length})`);
  ok("slot 0 is primary", chain[0].provider === "kilocode" && chain[0].id === "qwen/qwen3.6-plus");
  ok("slot 1 is primary retry (same instance)", chain[1] === chain[0]);
  ok("slot 2 is gemini fallback", chain[2].provider === "openrouter" && chain[2].id === "google/gemini-2.5-flash-lite");
  ok("slot 3 is haiku fallback", chain[3].provider === "openrouter" && chain[3].id === "anthropic/claude-haiku-4.5");
  ok("slot 4 is session model (anthropic sonnet)", chain[4].provider === "anthropic" && chain[4].id === "claude-sonnet-4.5");
  ok("unresolvable fallback was silently skipped", !chain.some((m) => m.id === "does-not-exist"));
})();

console.log("\n═══ buildModelChain dedup when session === fallback ═══\n");

await (async () => {
  const reg = fakeRegistry([{ provider: "openrouter", id: "google/gemini-2.5-flash-lite" }]);
  const primary = { provider: "openrouter", id: "google/gemini-2.5-flash-lite" };
  const session = { provider: "openrouter", id: "google/gemini-2.5-flash-lite" };
  const chain = buildModelChain(primary, { model: session }, reg, {
    compactionFallbackModels: ["openrouter/google/gemini-2.5-flash-lite"],
  } as any);
  // Primary, primary retry — fallback dedup'd, session dedup'd
  ok("dedup leaves primary + retry only", chain.length === 2, `(got ${chain.length})`);
  ok("both slots are the same primary model", chain[0] === chain[1]);
})();

console.log("\n═══ resolveModelString ═══\n");

{
  const reg = fakeRegistry([
    { provider: "openrouter", id: "google/gemini-2.5-flash-lite" },
    { provider: "anthropic", id: "claude-sonnet-4.5" },
  ]);
  ok("provider/id form resolves",
    resolveModelString("openrouter/google/gemini-2.5-flash-lite", reg)?.id === "google/gemini-2.5-flash-lite");
  ok("bare id resolves via getAvailable",
    resolveModelString("claude-sonnet-4.5", reg)?.provider === "anthropic");
  ok("unknown spec returns null",
    resolveModelString("totally/not-a-model", reg) === null);
  ok("empty spec returns null",
    resolveModelString("", reg) === null);
}

console.log("\n═══ buildDeterministicSummary never throws ═══\n");

{
  // Worst case: empty conversation, no previous, no files, no loops, no diagnostics.
  // Must still return a non-empty string with the structural sections so the next
  // turn knows compaction degraded.
  let summary = "";
  let threw = false;
  try {
    summary = buildDeterministicSummary([], [], undefined, undefined, undefined, []);
  } catch (e) {
    threw = true;
  }
  ok("does not throw on empty input", !threw);
  ok("returns non-empty markdown", summary.length > 100, `(len=${summary.length})`);
  ok("includes Context section", summary.includes("## Context"));
  ok("includes Current State section", summary.includes("## Current State"));
  ok("includes What's Next section", summary.includes("## What's Next"));
  ok("warns user that LLM summarization failed",
    /every configured summarization model failed/i.test(summary));
}

console.log("\n═══ buildDeterministicSummary surfaces diagnostics ═══\n");

{
  const summary = buildDeterministicSummary(
    [{ role: "user", content: "fix the auth bug", score: 9, classification: "HIGH" }],
    [],
    undefined, undefined, undefined,
    ["kilocode/qwen/qwen3.6-plus: empty response", "openrouter/google/gemini: HTTP 503"],
  );
  ok("includes Compaction diagnostics section", summary.includes("## Compaction diagnostics"));
  ok("lists kilo failure", summary.includes("kilocode/qwen/qwen3.6-plus: empty response"));
  ok("lists openrouter failure", summary.includes("openrouter/google/gemini: HTTP 503"));
  ok("quotes the high-scored user turn verbatim", summary.includes("fix the auth bug"));
  ok("annotates the quoted turn with score+class", /score=9 HIGH/.test(summary));
}

console.log("\n═══ buildDeterministicSummary preserves previous summary ═══\n");

{
  const prev = "## Previous Context\nWorking on the auth flow.";
  const summary = buildDeterministicSummary([], [], prev, undefined, undefined, []);
  ok("includes the previous summary verbatim", summary.includes("Working on the auth flow."));
  ok("labels it as preserved", summary.includes("preserved verbatim"));
}

console.log("\n═══ buildDeterministicSummary handles tool-call-only turns ═══\n");

{
  const summary = buildDeterministicSummary(
    [{
      role: "assistant",
      content: [{ type: "toolCall", name: "edit", arguments: { path: "x.ts" } }],
      score: 7,
      classification: "HIGH",
    }],
    [], undefined, undefined, undefined, [],
  );
  ok("renders a placeholder for non-text turns", summary.includes("[edit]"));
  ok("includes the high-scored turn header", summary.includes("score=7 HIGH"));
}

console.log("\n═══ buildDeterministicSummary truncates each quoted turn ═══\n");

{
  const longText = "x".repeat(5000);
  const summary = buildDeterministicSummary(
    [{ role: "user", content: longText, score: 10, classification: "HIGH" }],
    [], undefined, undefined, undefined, [],
  );
  // Snippet trimmed to 800 chars + ellipsis
  ok("truncates >800-char turns with ellipsis", summary.includes("…"));
  ok("does not include full 5000-char text",
    !summary.includes("x".repeat(2000)));
}

console.log(`\n═══ ${pass} passed, ${fail} failed ═══\n`);
if (fail > 0) process.exit(1);
