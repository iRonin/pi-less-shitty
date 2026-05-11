/**
 * Phase E — agent-driven recall on demand.
 *
 * The `hindsight_recall` tool's description IS the primary signal that
 * tells the LLM when to invoke it. Sessions audit (2026-05-11) showed
 * the main agent called the tool in ~1% of sessions because the prior
 * description was bland and didn't say WHEN to invoke. This test pins
 * the sharpened description so it doesn't silently regress to vague.
 *
 * We assert on the source text of index.ts rather than loading the
 * default export, because that export pulls in @earendil-works/pi-tui
 * at the top level and tui isn't in this package's local node_modules.
 * The other test files dodge the import the same way.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const indexSource = readFileSync(join(__dirname, "..", "index.ts"), "utf8");

function descriptionForTool(toolName: string): string {
  // Match the registerTool block for the named tool and extract its
  // description value. The description may be a single string literal
  // or a `"…" + "…" + "…"` concatenation across multiple lines, so we
  // slurp from `description:` up to the next `,\n    parameters:` boundary.
  const re = new RegExp(
    `name:\\s*"${toolName}"[\\s\\S]*?description:\\s*([\\s\\S]*?),\\n\\s*parameters:`,
    "m",
  );
  const m = re.exec(indexSource);
  if (!m) throw new Error(`No description block found for tool ${toolName}`);
  return m[1];
}

describe("hindsight_recall tool description (Phase E)", () => {
  const desc = descriptionForTool("hindsight_recall");

  test("explicitly tells the LLM when to invoke", () => {
    // The audit showed agents almost never called recall because the
    // description didn't say WHEN. The new description must have an
    // explicit "USE THIS TOOL when:" or equivalent directive.
    assert.match(desc, /USE THIS TOOL when/i);
  });

  test("explains the auto-recall firing model so the LLM knows when manual recall is needed", () => {
    // Phase F: auto-recall is no longer once-per-session; it re-fires on
    // detected topic shifts. The description must still communicate the
    // firing model so the LLM understands when its injected context is
    // likely stale and a manual recall is warranted.
    assert.match(desc, /auto-recall|first user turn|topic shift|first turn/i);
  });

  test("warns against spamming the tool", () => {
    // We want recall called when needed, not on every prompt.
    assert.match(desc, /do not spam|not spam|skip when|prefer over guessing/i);
  });

  test("mentions cost is cheap to encourage use over guessing", () => {
    // The LLM's revealed bias is to skip optional tools. Naming the cost
    // ('cheap', '<2s') counters that bias.
    assert.match(desc, /cheap|<\s*\d+s/i);
  });
});

describe("hindsight_recall query parameter doc (Phase E)", () => {
  test("guides the LLM toward specific queries", () => {
    // Generic queries like 'compaction' return mediocre recall; a
    // specific multi-term query returns the right memories. The param
    // doc should signal this.
    const re = /name:\s*"hindsight_recall"[\s\S]*?query:\s*Type\.String\(\s*\{\s*description:\s*"([^"]+)"/m;
    const m = re.exec(indexSource);
    assert.ok(m, "could not locate query parameter description");
    assert.match(m![1], /specific|e\.g\./i);
  });
});
