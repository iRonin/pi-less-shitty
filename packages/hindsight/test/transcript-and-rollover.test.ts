/**
 * Tests for two retain-side defects fixed together:
 *
 *   A. `getLastUserMessage` JSON.stringify pollution
 *      Before: structured user content (text + image blocks, multi-block
 *      arrays) was `JSON.stringify`'d into the retain transcript, dumping
 *      raw block arrays (incl. base64 images) into the hindsight document
 *      store. Verified in the wild via `legal-mosquito/session-019dc18a-…`
 *      where `original_text` began with
 *      `[role: user]\n[{"type":"text","text":"check exacly the authorites..."}]`.
 *
 *      After: text-only extraction. Non-text blocks are silently dropped.
 *      Unknown/empty shape returns "" rather than a JSON dump.
 *
 *   B. Document rollover at 80K chars
 *      Before: every retain appended to `session-<sessionId>`. Sessions ran
 *      for days; docs grew to 500K+ chars; the extraction LLM
 *      (gpt-oss-120b on Cerebras, 131K-token / ≈525K-char context window)
 *      silently dropped to 0 extracted units once the doc no longer fit.
 *
 *      After: pi-side rollover. When `session-<id>` ≥ threshold, retains
 *      go to `session-<id>-2`, then `-3`, etc. Threshold tunable via
 *      `HINDSIGHT_DOC_ROLLOVER_CHARS`. MAX_DOC_ROLLOVER_PARTS cap (50)
 *      keeps the probe bounded.
 *
 * Like every other test in this package, we re-implement the helpers
 * byte-equivalently to index.ts. Importing index.ts directly is impossible
 * here because it pulls in `@earendil-works/pi-tui` which isn't installed
 * during `npm test`. Drift between this file and index.ts is itself a
 * defect — they MUST stay in sync.
 *
 * Run: node --experimental-strip-types --test transcript-and-rollover.test.ts
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ────────────────────────────────────────────────────────────────────────
// Fix A — re-implementation of `getLastUserMessage`
// Must match index.ts behavior exactly. Any divergence is a defect.
// ────────────────────────────────────────────────────────────────────────

function getLastUserMessage(ctx: any, fallback: string): string {
  try {
    const entries = ctx.sessionManager?.getEntries() || [];
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e?.type === "message" && e.message?.role === "user") {
        const content = e.message.content;
        if (typeof content === "string") return content;
        if (Array.isArray(content)) {
          const text = content
            .filter((b: any) => b?.type === "text" && typeof b.text === "string")
            .map((b: any) => b.text)
            .join("\n");
          if (text) return text;
          return "";
        }
        return "";
      }
    }
  } catch {}
  return fallback;
}

function mkCtx(entries: any[]): any {
  return { sessionManager: { getEntries: () => entries } };
}
function userEntry(content: any): any {
  return { type: "message", message: { role: "user", content } };
}

describe("Fix A — getLastUserMessage: structured-content extraction", () => {
  test("string content → returned verbatim", () => {
    const ctx = mkCtx([userEntry("plain text prompt")]);
    assert.equal(getLastUserMessage(ctx, "FALLBACK"), "plain text prompt");
  });

  test("single text block → just the text (no JSON, no markers)", () => {
    const ctx = mkCtx([
      userEntry([{ type: "text", text: "check exacly the authorites..." }]),
    ]);
    const out = getLastUserMessage(ctx, "FALLBACK");
    assert.equal(out, "check exacly the authorites...");
    // Anti-regression: the legacy JSON.stringify path would produce
    // a string starting with `[{"type":"text"` — pin that it doesn't.
    assert.ok(!out.startsWith("[{"), "must NOT JSON-stringify the block array");
    assert.ok(!out.includes('"type":"text"'), "must NOT leak block-shape JSON");
  });

  test("text + image blocks → just the text (image silently dropped)", () => {
    const ctx = mkCtx([
      userEntry([
        { type: "text", text: "describe this picture" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA…" } },
      ]),
    ]);
    const out = getLastUserMessage(ctx, "FALLBACK");
    assert.equal(out, "describe this picture");
    assert.ok(!out.includes("base64"), "image base64 must not leak into transcript");
    assert.ok(!out.includes("image/png"), "image media_type must not leak into transcript");
  });

  test("multiple text blocks → newline-joined in order", () => {
    const ctx = mkCtx([
      userEntry([
        { type: "text", text: "first paragraph" },
        { type: "text", text: "second paragraph" },
      ]),
    ]);
    assert.equal(
      getLastUserMessage(ctx, "FALLBACK"),
      "first paragraph\nsecond paragraph",
    );
  });

  test("all-image blocks → empty string (NOT JSON dump, NOT [object Object])", () => {
    const ctx = mkCtx([
      userEntry([
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } },
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "BBB" } },
      ]),
    ]);
    const out = getLastUserMessage(ctx, "FALLBACK");
    assert.equal(out, "", "image-only message must yield empty string");
    assert.ok(!out.includes("[object"), "must not produce '[object Object]'");
    assert.ok(!out.includes("base64"), "must not contain block-shape JSON");
  });

  test("malformed entry (non-array, non-string content) → empty string", () => {
    // Note: returns "" — fallback only applies when NO user message exists
    // at all. This matches the original try/catch shape: a found-but-malformed
    // entry yields "" rather than the fallback (which is reserved for the
    // truly-missing-entry case).
    const ctx = mkCtx([userEntry({ type: "weird-object" })]);
    assert.equal(getLastUserMessage(ctx, "FALLBACK"), "");
  });

  test("content === undefined → empty string (no JSON dump of undefined)", () => {
    const ctx = mkCtx([userEntry(undefined)]);
    assert.equal(getLastUserMessage(ctx, "FALLBACK"), "");
  });

  test("no user message in entries → fallback used", () => {
    const ctx = mkCtx([
      { type: "message", message: { role: "assistant", content: "hi" } },
    ]);
    assert.equal(getLastUserMessage(ctx, "FALLBACK"), "FALLBACK");
  });

  test("empty entries → fallback used", () => {
    const ctx = mkCtx([]);
    assert.equal(getLastUserMessage(ctx, "FALLBACK"), "FALLBACK");
  });

  test("sessionManager throws → fallback used (try/catch guard)", () => {
    const ctx = { sessionManager: { getEntries: () => { throw new Error("boom"); } } };
    assert.equal(getLastUserMessage(ctx, "FALLBACK"), "FALLBACK");
  });

  test("most recent user message wins (loop walks from end)", () => {
    const ctx = mkCtx([
      userEntry("oldest"),
      { type: "message", message: { role: "assistant", content: "in between" } },
      userEntry([{ type: "text", text: "newest" }]),
    ]);
    assert.equal(getLastUserMessage(ctx, "FALLBACK"), "newest");
  });
});

// ────────────────────────────────────────────────────────────────────────
// Fix B — re-implementation of rollover logic
// Must match index.ts behavior exactly. Any divergence is a defect.
// ────────────────────────────────────────────────────────────────────────

const DEFAULT_DOC_ROLLOVER_CHARS = 80_000;
const MAX_DOC_ROLLOVER_PARTS = 50;

function authHeader(key: string) { return { "Authorization": `Bearer ${key || ""}` }; }

function getDocRolloverThreshold(): number {
  const v = parseInt(process.env.HINDSIGHT_DOC_ROLLOVER_CHARS || "", 10);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_DOC_ROLLOVER_CHARS;
}

async function fetchDocumentTextLength(
  apiUrl: string,
  apiKey: string,
  bank: string,
  documentId: string,
  fetchImpl: typeof fetch,
): Promise<number | null> {
  try {
    const res = await fetchImpl(
      `${apiUrl}/v1/default/banks/${bank}/documents/${documentId}`,
      { headers: authHeader(apiKey) } as any,
    );
    if (res.status === 404) return null;
    if (!res.ok) return null;
    const data = (await res.json()) as { text_length?: number; original_text?: string };
    if (typeof data.text_length === "number") return data.text_length;
    if (typeof data.original_text === "string") return data.original_text.length;
    return 0;
  } catch {
    return null;
  }
}

async function resolveSessionDocumentId(
  apiUrl: string,
  apiKey: string,
  bank: string,
  sessionId: string,
  threshold: number,
  fetchImpl: typeof fetch,
): Promise<string> {
  const baseId = `session-${sessionId}`;
  for (let part = 1; part <= MAX_DOC_ROLLOVER_PARTS; part++) {
    const id = part === 1 ? baseId : `${baseId}-${part}`;
    const length = await fetchDocumentTextLength(apiUrl, apiKey, bank, id, fetchImpl);
    if (length === null) return id;
    if (length < threshold) return id;
  }
  return `${baseId}-${MAX_DOC_ROLLOVER_PARTS}`;
}

// Helper: mocked fetch returning a stub map of {docId -> length-or-404}.
function makeFetch(docs: Map<string, number | "404">): typeof fetch {
  return (async (url: string) => {
    const m = url.match(/\/documents\/([^?]+)$/);
    const docId = m ? m[1] : "";
    const v = docs.get(docId);
    if (v === undefined || v === "404") {
      return { status: 404, ok: false, json: async () => ({}) } as any;
    }
    return {
      status: 200, ok: true,
      json: async () => ({ text_length: v as number }),
    } as any;
  }) as any;
}

describe("Fix B — getDocRolloverThreshold env override", () => {
  const saved = process.env.HINDSIGHT_DOC_ROLLOVER_CHARS;
  afterEach(() => {
    if (saved === undefined) delete process.env.HINDSIGHT_DOC_ROLLOVER_CHARS;
    else process.env.HINDSIGHT_DOC_ROLLOVER_CHARS = saved;
  });

  test("unset → default 80_000", () => {
    delete process.env.HINDSIGHT_DOC_ROLLOVER_CHARS;
    assert.equal(getDocRolloverThreshold(), DEFAULT_DOC_ROLLOVER_CHARS);
  });

  test("valid positive integer → respected", () => {
    process.env.HINDSIGHT_DOC_ROLLOVER_CHARS = "40000";
    assert.equal(getDocRolloverThreshold(), 40000);
  });

  test("zero → falls back to default (zero would disable rollover entirely)", () => {
    process.env.HINDSIGHT_DOC_ROLLOVER_CHARS = "0";
    assert.equal(getDocRolloverThreshold(), DEFAULT_DOC_ROLLOVER_CHARS);
  });

  test("negative → falls back to default", () => {
    process.env.HINDSIGHT_DOC_ROLLOVER_CHARS = "-1";
    assert.equal(getDocRolloverThreshold(), DEFAULT_DOC_ROLLOVER_CHARS);
  });

  test("garbage → falls back to default", () => {
    process.env.HINDSIGHT_DOC_ROLLOVER_CHARS = "not-a-number";
    assert.equal(getDocRolloverThreshold(), DEFAULT_DOC_ROLLOVER_CHARS);
  });
});

describe("Fix B — fetchDocumentTextLength", () => {
  test("404 → null", async () => {
    const f = makeFetch(new Map<string, number | "404">());
    const out = await fetchDocumentTextLength("http://x", "", "bank", "session-1", f);
    assert.equal(out, null);
  });

  test("existing doc with text_length → returns that value", async () => {
    const f = makeFetch(new Map<string, number | "404">([["session-1", 12345]]));
    const out = await fetchDocumentTextLength("http://x", "", "bank", "session-1", f);
    assert.equal(out, 12345);
  });

  test("falls back to original_text.length when text_length absent", async () => {
    const f = (async () => ({
      status: 200, ok: true,
      json: async () => ({ original_text: "x".repeat(777) }),
    })) as any;
    const out = await fetchDocumentTextLength("http://x", "", "bank", "session-1", f);
    assert.equal(out, 777);
  });

  test("fetch throw → null (defensive)", async () => {
    const f = (async () => { throw new Error("net"); }) as any;
    const out = await fetchDocumentTextLength("http://x", "", "bank", "session-1", f);
    assert.equal(out, null);
  });
});

describe("Fix B — resolveSessionDocumentId", () => {
  test("baseId fits under threshold → returned as-is (no rollover)", async () => {
    const f = makeFetch(new Map<string, number | "404">([
      ["session-abc", 50_000], // under 80K threshold
    ]));
    const out = await resolveSessionDocumentId("http://x", "", "bank", "abc", 80_000, f);
    assert.equal(out, "session-abc");
  });

  test("baseId 404 (fresh session) → returns baseId without probing further", async () => {
    let probes = 0;
    const f = (async (url: string) => {
      probes++;
      // every doc 404s — but the resolver should stop at the first probe
      return { status: 404, ok: false, json: async () => ({}) } as any;
    }) as any;
    const out = await resolveSessionDocumentId("http://x", "", "bank", "abc", 80_000, f);
    assert.equal(out, "session-abc");
    assert.equal(probes, 1, "must short-circuit on first 404 (no spurious probes)");
  });

  test("baseId full, part-2 doesn't exist → returns -2 (404 path)", async () => {
    const f = makeFetch(new Map<string, number | "404">([
      ["session-abc", 90_000],   // full
      // session-abc-2 missing → 404 from default
    ]));
    const out = await resolveSessionDocumentId("http://x", "", "bank", "abc", 80_000, f);
    assert.equal(out, "session-abc-2");
  });

  test("baseId + part-2 both full → returns -3", async () => {
    const f = makeFetch(new Map<string, number | "404">([
      ["session-abc", 100_000],
      ["session-abc-2", 100_000],
    ]));
    const out = await resolveSessionDocumentId("http://x", "", "bank", "abc", 80_000, f);
    assert.equal(out, "session-abc-3");
  });

  test("part-2 has room → returns -2 (not -3 even if probe would 404)", async () => {
    const f = makeFetch(new Map<string, number | "404">([
      ["session-abc", 100_000], // full
      ["session-abc-2", 30_000], // has room
    ]));
    const out = await resolveSessionDocumentId("http://x", "", "bank", "abc", 80_000, f);
    assert.equal(out, "session-abc-2");
  });

  test("respects HINDSIGHT_DOC_ROLLOVER_CHARS override at call site", async () => {
    // Caller pulls threshold from getDocRolloverThreshold(), which reads env.
    const saved = process.env.HINDSIGHT_DOC_ROLLOVER_CHARS;
    process.env.HINDSIGHT_DOC_ROLLOVER_CHARS = "1000";
    try {
      const threshold = getDocRolloverThreshold();
      assert.equal(threshold, 1000);
      const f = makeFetch(new Map<string, number | "404">([
        ["session-abc", 1500], // under default 80K, OVER override 1K → rollover
      ]));
      const out = await resolveSessionDocumentId("http://x", "", "bank", "abc", threshold, f);
      assert.equal(out, "session-abc-2", "must roll over once override threshold is exceeded");
    } finally {
      if (saved === undefined) delete process.env.HINDSIGHT_DOC_ROLLOVER_CHARS;
      else process.env.HINDSIGHT_DOC_ROLLOVER_CHARS = saved;
    }
  });

  test("MAX_PARTS cap respected when every part is full", async () => {
    let probes = 0;
    const f = (async () => {
      probes++;
      // every probe returns a full doc → never satisfies threshold
      return { status: 200, ok: true, json: async () => ({ text_length: 999_999 }) } as any;
    }) as any;
    const out = await resolveSessionDocumentId("http://x", "", "bank", "abc", 80_000, f);
    assert.equal(out, `session-abc-${MAX_DOC_ROLLOVER_PARTS}`,
      "last-resort return when every part is over threshold");
    assert.equal(probes, MAX_DOC_ROLLOVER_PARTS,
      "should probe exactly MAX_DOC_ROLLOVER_PARTS times, no more, no less");
  });

  test("probes baseId first (no suffix for part=1)", async () => {
    const probedIds: string[] = [];
    const f = (async (url: string) => {
      const m = url.match(/\/documents\/([^?]+)$/);
      probedIds.push(m ? m[1] : "");
      return { status: 404, ok: false, json: async () => ({}) } as any;
    }) as any;
    await resolveSessionDocumentId("http://x", "", "bank", "xyz", 80_000, f);
    assert.equal(probedIds[0], "session-xyz", "first probe must be baseId, NOT session-xyz-1");
  });
});

// ────────────────────────────────────────────────────────────────────────
// Source-level pins — prevent silent regression of either fix.
// ────────────────────────────────────────────────────────────────────────

describe("source-level invariants (anti-regression for both fixes)", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, "..", "index.ts"), "utf-8");

  test("Fix A — getLastUserMessage MUST NOT call JSON.stringify on message content", () => {
    // Locate the function block.
    const fnStart = src.indexOf("function getLastUserMessage(");
    assert.ok(fnStart > 0, "getLastUserMessage not found in index.ts");
    // Find the next top-level function/export after it.
    const fnEnd = src.indexOf("\n}\n", fnStart);
    assert.ok(fnEnd > fnStart);
    const body = src.slice(fnStart, fnEnd);
    assert.ok(!body.includes("JSON.stringify"),
      "getLastUserMessage MUST NOT contain JSON.stringify — that was the pollution bug. " +
      "Re-derive text from text blocks instead.");
    assert.match(body, /b\?\.type\s*===\s*"text"|type:\s*"text"|"type":\s*"text"/,
      "getLastUserMessage must explicitly filter for type === 'text' blocks");
  });

  test("Fix B — rollover constants and resolver are exported", () => {
    assert.match(src, /export const DEFAULT_DOC_ROLLOVER_CHARS\s*=\s*80_?000/,
      "DEFAULT_DOC_ROLLOVER_CHARS must be exported and equal 80_000");
    assert.match(src, /export function getDocRolloverThreshold/,
      "getDocRolloverThreshold must be exported");
    assert.match(src, /export async function resolveSessionDocumentId/,
      "resolveSessionDocumentId must be exported");
    assert.match(src, /export const MAX_DOC_ROLLOVER_PARTS\s*=\s*50/,
      "MAX_DOC_ROLLOVER_PARTS must be exported and equal 50 (sanity cap on probes)");
  });

  test("Fix B — agent_end handler wires resolveSessionDocumentId into per-bank dispatch", () => {
    const handlerIdx = src.lastIndexOf("pi.on(\"agent_end\"");
    assert.ok(handlerIdx > 0);
    // Find end of the handler via the next top-level `pi.registerCommand` (the
    // /hindsight command registers right after the agent_end handler).
    const handlerEnd = src.indexOf("pi.registerCommand(\"hindsight\"", handlerIdx);
    assert.ok(handlerEnd > handlerIdx, "could not locate end of agent_end handler");
    const scope = src.slice(handlerIdx, handlerEnd);
    assert.match(scope, /resolveSessionDocumentId\s*\(/,
      "agent_end must invoke resolveSessionDocumentId() per bank — otherwise rollover is inert");
    assert.match(scope, /document_id:\s*docId/,
      "POST body must use the per-bank resolved docId, not a single shared documentId");
  });
});
