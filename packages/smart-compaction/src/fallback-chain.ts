// Pure helpers for the smart-compaction summarization fallback chain.
//
// Kept in a separate module from smart-compaction.ts so the helpers can be
// unit-tested without pulling in the @earendil-works/pi-coding-agent and
// @earendil-works/pi-ai peer deps (mirrors the pattern used by scorer.ts).
//
// The full integration (auth + actual `complete()` calls) lives in
// smart-compaction.ts; this file owns:
//   - the model fallback chain construction (order + dedup),
//   - the model-spec resolver,
//   - the deterministic last-resort summary builder.

import type { RetryLoop } from "./pattern-detector.js";

// Same shape as the local helpers in smart-compaction.ts. Duplicated here to
// keep this module dependency-free.
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c: any) => c?.type === "text" && typeof c.text === "string")
    .map((c: any) => c.text)
    .join("\n");
}

function extractToolCalls(content: unknown): Array<{ name: string }> {
  if (!Array.isArray(content)) return [];
  return content
    .filter((c: any) => c?.type === "toolCall")
    .map((c: any) => ({ name: c.name ?? "" }));
}

// Resolve a "provider/model" or bare "model" string against the registry.
// Returns null when not resolvable so the chain can skip it silently.
export function resolveModelString(spec: string, modelRegistry: any): any | null {
  if (!spec) return null;
  const slash = spec.indexOf("/");
  if (slash > 0) {
    const providerId = spec.slice(0, slash);
    const modelId = spec.slice(slash + 1);
    const m = modelRegistry.find?.(providerId, modelId);
    if (m) return m;
    // Fall through to bare-id lookup below — some specs are stored as
    // "openrouter/google/gemini-..." but registered as "google/gemini-..."
    // under the openrouter provider. The bare-id lookup catches both.
  }
  const bare = slash > 0 ? spec.slice(slash + 1) : spec;
  const avail = modelRegistry.getAvailable?.() ?? [];
  for (const m of avail) {
    if (m.id === bare || m.id.endsWith("/" + bare)) return m;
  }
  return null;
}

// Build the candidate model chain: [primary, primary-retry, ...fallbacks, session].
// - primary appears twice so a transient hiccup gets one immediate retry on
//   the same model before we move to a different provider.
// - fallback specs that don't resolve are silently skipped.
// - session model is last so a kilo gateway hiccup doesn't take down the
//   anthropic session model too. It's deduped against earlier slots.
export function buildModelChain(
  primary: any,
  ctx: any,
  modelRegistry: any,
  settings: { compactionFallbackModels?: string[] },
): any[] {
  const seen = new Set<string>();
  const out: any[] = [];
  const push = (m: any | null | undefined) => {
    if (!m) return;
    const key = `${m.provider}/${m.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(m);
  };

  // 1. Primary first, then primary again (one transient retry) by adding it
  //    via a separate non-deduped slot.
  push(primary);
  if (out.length === 1) out.push(primary); // explicit retry slot — same instance

  // 2. User-configured fallbacks
  for (const spec of settings.compactionFallbackModels ?? []) {
    push(resolveModelString(spec, modelRegistry));
  }

  // 3. Session model as last LLM resort
  push(ctx?.model);
  push(modelRegistry?.currentModel);

  return out;
}

// Deterministic non-LLM fallback. Emits a pi-style markdown summary built
// from the scored messages themselves. NEVER throws — the worst case is a
// short summary, but the session continues.
//
// This is the hard guarantee that motivated the whole refactor: even when
// every configured summarization model returns empty / errors / times out,
// pi's /compact must NOT crash the session. The next agent turn gets the
// top-scored verbatim turns plus structural metadata and can recover.
export function buildDeterministicSummary(
  scoredFlat: Array<{ role: string; content: unknown; score: number; classification: string }>,
  loops: RetryLoop[],
  previousSummary: string | undefined,
  readFiles: string[] | undefined,
  modifiedFiles: string[] | undefined,
  attemptDiagnostics: string[],
): string {
  const lines: string[] = [];
  lines.push("## Context");
  lines.push(
    "_(Smart compaction fell back to deterministic summary — every configured "
    + "summarization model failed. The next turn has the raw HIGH-scored turns "
    + "plus structural metadata. No LLM-distilled narrative is available for "
    + "this compaction window.)_",
  );
  if (previousSummary && previousSummary.trim()) {
    lines.push("");
    lines.push("### Previous summary (preserved verbatim)");
    lines.push(previousSummary.trim());
  }

  const high = scoredFlat.filter((m) => m.classification === "HIGH");
  const medium = scoredFlat.filter((m) => m.classification === "MEDIUM");
  const low = scoredFlat.filter((m) => m.classification === "LOW");

  lines.push("");
  lines.push("## Current State");
  lines.push(`- Compaction window: ${scoredFlat.length} turns (HIGH=${high.length}, MEDIUM=${medium.length}, LOW=${low.length}).`);
  if ((readFiles?.length ?? 0) > 0) lines.push(`- Files read: ${readFiles!.join(", ")}`);
  if ((modifiedFiles?.length ?? 0) > 0) lines.push(`- Files modified: ${modifiedFiles!.join(", ")}`);
  if (loops.length > 0) {
    lines.push("");
    lines.push("### Retry loops detected");
    for (const l of loops) lines.push(`- ${l.description}${l.lastResult ? ` → ${l.lastResult}` : ""}`);
  }

  // Quote the top-scoring turns verbatim (truncated) so the next agent has
  // real content to anchor on. Limit total output to ~6000 chars to stay
  // well under any model's context window.
  const ranked = [...scoredFlat].sort((a, b) => b.score - a.score).slice(0, 12);
  if (ranked.length > 0) {
    lines.push("");
    lines.push("## Key Turns (verbatim, top-scored)");
    let budget = 6000;
    for (const m of ranked) {
      const text = extractText(m.content) || `[${extractToolCalls(m.content).map((t) => t.name).join(", ") || "non-text turn"}]`;
      const snippet = text.length > 800 ? text.slice(0, 800) + "…" : text;
      const block = `\n### ${m.role} (score=${m.score} ${m.classification})\n${snippet}\n`;
      if (block.length > budget) break;
      lines.push(block);
      budget -= block.length;
    }
  }

  lines.push("");
  lines.push("## What's Next");
  lines.push("- Continue the in-progress task. Use the verbatim turns above to reconstruct context.");
  lines.push("- If something feels missing, ask the user to restate the goal.");

  lines.push("");
  lines.push("## Compaction diagnostics");
  for (const d of attemptDiagnostics) lines.push(`- ${d}`);

  return lines.join("\n");
}
