/**
 * Tests for Phase D — silent-failure detection via post-retain units delta.
 *
 * Phase B/C used `result_metadata.unit_ids_count` as the signal. That field
 * is only written by hindsight's streaming checkpoint path; most retains
 * bypass it, producing massive false-positive "0 facts" alerts. Phase D
 * replaces the metadata sniff with a real document-level units delta.
 *
 * The watcher (`watchRetainOperation`) lives in index.ts as a module-local
 * helper. To keep these tests fast (sub-second) and decoupled from the live
 * hindsight server, we re-implement the algorithm here and assert the same
 * branching contract. Any production drift between this test and index.ts
 * is itself a defect — they MUST stay in sync.
 *
 * Run: node --experimental-strip-types --test retain-polling.test.ts
 */

import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";

// Empirical threshold mirrored from index.ts. Below this, a zero-extraction
// outcome is treated as legitimate (trivial input). At/above, it's a likely
// LLM-extraction failure and we surface an alert.
const SUBSTANTIAL_TRANSCRIPT_CHARS = 500;

// ---------------------------------------------------------------------------
// Polling primitives — kept algorithmically identical to index.ts
// ---------------------------------------------------------------------------

interface OperationStatusResponse {
  operation_id: string;
  status: "pending" | "completed" | "failed" | "not_found" | string;
  error_message?: string | null;
  result_metadata?: Record<string, unknown> | null;
}

interface DocumentResponse {
  id: string;
  memory_unit_count?: number;
}

interface RetainSnapshot {
  documentId: string;
  preUnitsCount: number;
  transcriptLen: number;
}

function authHeader(key: string) { return { "Authorization": `Bearer ${key || ""}` }; }
function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

async function fetchOperation(
  fetchImpl: typeof fetch, apiUrl: string, apiKey: string, bank: string, operationId: string,
): Promise<OperationStatusResponse | null> {
  try {
    const res = await fetchImpl(`${apiUrl}/v1/default/banks/${bank}/operations/${operationId}`, {
      headers: authHeader(apiKey),
    } as any);
    if (!res.ok) return null;
    return (await res.json()) as OperationStatusResponse;
  } catch { return null; }
}

async function fetchDocumentUnitsCount(
  fetchImpl: typeof fetch, apiUrl: string, apiKey: string, bank: string, documentId: string,
): Promise<number | null> {
  try {
    const res = await fetchImpl(`${apiUrl}/v1/default/banks/${bank}/documents/${documentId}`, {
      headers: authHeader(apiKey),
    } as any);
    if (res.status === 404) return null;
    if (!res.ok) return null;
    const data = (await res.json()) as DocumentResponse;
    return typeof data.memory_unit_count === "number" ? data.memory_unit_count : null;
  } catch { return null; }
}

function extractDocumentIds(op: OperationStatusResponse): string[] {
  const ids = op.result_metadata?.document_ids;
  if (Array.isArray(ids)) return ids.filter((x): x is string => typeof x === "string");
  return [];
}

async function pollOperationUntilTerminal(
  fetchImpl: typeof fetch, apiUrl: string, apiKey: string, bank: string,
  operationId: string, pollIntervalMs: number, maxAttempts: number,
): Promise<OperationStatusResponse | null> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await sleep(pollIntervalMs);
    const op = await fetchOperation(fetchImpl, apiUrl, apiKey, bank, operationId);
    if (!op) continue;
    if (op.status === "completed" || op.status === "failed" || op.status === "not_found") return op;
  }
  return null;
}

type LogEntry = string;
type SentMessage = { customType: string; details: any };
type StatusUpdate = { status: string };

async function watchRetainOperation(
  fetchImpl: typeof fetch, apiUrl: string, apiKey: string, bank: string,
  operationId: string, t0: number, snapshot: RetainSnapshot,
  pollIntervalMs: number, maxAttempts: number,
  hooks: { log: (s: string) => void; sendMessage: (m: SentMessage) => void; setStatus: (s: string) => void },
): Promise<void> {
  const op = await pollOperationUntilTerminal(fetchImpl, apiUrl, apiKey, bank, operationId, pollIntervalMs, maxAttempts);
  const op_age_ms = Date.now() - t0;

  if (!op) {
    hooks.log(`retain-poll: timeout op=${operationId} bank=${bank} age_ms=${op_age_ms} status=pending`);
    return;
  }
  if (op.status === "failed") {
    const errMsg = op.error_message || "(no error_message)";
    hooks.log(`retain-poll: failed op=${operationId} bank=${bank} age_ms=${op_age_ms} error=${errMsg}`);
    hooks.setStatus("⚠ retain failed");
    hooks.sendMessage({
      customType: "hindsight-retain-failed-async",
      details: { bank, operation_id: operationId, op_age_ms, error_message: errMsg },
    });
    return;
  }
  if (op.status === "not_found") {
    hooks.log(`retain-poll: not_found op=${operationId} bank=${bank} age_ms=${op_age_ms}`);
    return;
  }
  // completed — compute units delta against the snapshot.
  const opDocIds = extractDocumentIds(op);
  const docId = opDocIds.includes(snapshot.documentId)
    ? snapshot.documentId
    : (opDocIds[0] || snapshot.documentId);
  const postUnits = await fetchDocumentUnitsCount(fetchImpl, apiUrl, apiKey, bank, docId);

  if (postUnits === null) {
    hooks.log(`retain-poll: no-post-units op=${operationId} bank=${bank} age_ms=${op_age_ms} doc=${docId}`);
    return;
  }

  const delta = postUnits - snapshot.preUnitsCount;
  const substantial = snapshot.transcriptLen >= SUBSTANTIAL_TRANSCRIPT_CHARS;

  if (delta <= 0 && substantial) {
    hooks.log(`retain-poll: zero-units op=${operationId} bank=${bank} age_ms=${op_age_ms} doc=${docId} pre=${snapshot.preUnitsCount} post=${postUnits} transcript_len=${snapshot.transcriptLen}`);
    hooks.setStatus("⚠ 0 units extracted");
    hooks.sendMessage({
      customType: "hindsight-retain-zero-units-extracted",
      details: {
        bank, operation_id: operationId, op_age_ms, document_id: docId,
        pre_units_count: snapshot.preUnitsCount, post_units_count: postUnits,
        transcript_len: snapshot.transcriptLen,
      },
    });
    return;
  }
  if (delta <= 0 && !substantial) {
    hooks.log(`retain-poll: legit-zero op=${operationId} bank=${bank} age_ms=${op_age_ms} doc=${docId} pre=${snapshot.preUnitsCount} post=${postUnits} transcript_len=${snapshot.transcriptLen}`);
    return;
  }
  hooks.log(`retain-poll: ok op=${operationId} bank=${bank} age_ms=${op_age_ms} doc=${docId} pre=${snapshot.preUnitsCount} post=${postUnits} delta=${delta}`);
}

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function jsonResponse(body: any, ok = true, status = 200): any {
  return { ok, status, json: async () => body };
}

function makeFetchSequence(responses: Array<(url: string) => any>): { fetchImpl: any; calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  return {
    fetchImpl: mock.fn(async (url: string) => {
      calls.push(url);
      if (i >= responses.length) throw new Error(`unexpected extra fetch: ${url}`);
      return responses[i++](url);
    }),
    calls,
  };
}

function makeHooks() {
  const logs: LogEntry[] = [];
  const sent: SentMessage[] = [];
  const statuses: StatusUpdate[] = [];
  return {
    logs, sent, statuses,
    hooks: {
      log: (s: string) => { logs.push(s); },
      sendMessage: (m: SentMessage) => { sent.push(m); },
      setStatus: (s: string) => { statuses.push({ status: s }); },
    },
  };
}

const SNAP = (over: Partial<RetainSnapshot> = {}): RetainSnapshot => ({
  documentId: "session-test",
  preUnitsCount: 0,
  transcriptLen: 2000, // substantial by default
  ...over,
});

// ---------------------------------------------------------------------------
// TESTS — happy paths (silent)
// ---------------------------------------------------------------------------

describe("retain-polling: happy path (silent)", () => {
  test("completed + post-count > pre-count: no message sent", async () => {
    const op: OperationStatusResponse = {
      operation_id: "op-1", status: "completed",
      result_metadata: { document_ids: ["session-test"], items_count: 1 },
    };
    const doc: DocumentResponse = { id: "session-test", memory_unit_count: 7 };
    const { fetchImpl, calls } = makeFetchSequence([
      (u) => { assert.ok(u.endsWith("/operations/op-1")); return jsonResponse(op); },
      (u) => { assert.ok(u.endsWith("/documents/session-test")); return jsonResponse(doc); },
    ]);
    const { hooks, logs, sent, statuses } = makeHooks();
    await watchRetainOperation(fetchImpl, "http://x", "key", "bank", "op-1", Date.now() - 1234, SNAP(), 1, 10, hooks);
    assert.equal(sent.length, 0, "no user message on success");
    assert.equal(statuses.length, 0, "no status update on success");
    assert.equal(calls.length, 2, "one op GET + one doc GET");
    assert.ok(logs.some(l => l.includes("retain-poll: ok") && l.includes("delta=7")));
  });

  test("completed + non-zero delta (append to existing doc): silent", async () => {
    const op: OperationStatusResponse = {
      operation_id: "op", status: "completed",
      result_metadata: { document_ids: ["session-test"] },
    };
    const { fetchImpl } = makeFetchSequence([
      () => jsonResponse(op),
      () => jsonResponse({ id: "session-test", memory_unit_count: 12 }),
    ]);
    const { hooks, sent, logs } = makeHooks();
    await watchRetainOperation(fetchImpl, "http://x", "key", "bank", "op", Date.now(),
      SNAP({ preUnitsCount: 9 }), 1, 10, hooks);
    assert.equal(sent.length, 0);
    assert.ok(logs.some(l => l.includes("delta=3")));
  });
});

// ---------------------------------------------------------------------------
// TESTS — zero-units-extracted detection (the real bug)
// ---------------------------------------------------------------------------

describe("retain-polling: zero-units-extracted detection", () => {
  test("substantial transcript + zero delta: fires hindsight-retain-zero-units-extracted", async () => {
    const op: OperationStatusResponse = {
      operation_id: "op-0", status: "completed",
      result_metadata: { document_ids: ["session-test"] },
    };
    const { fetchImpl } = makeFetchSequence([
      () => jsonResponse(op),
      () => jsonResponse({ id: "session-test", memory_unit_count: 0 }),
    ]);
    const { hooks, sent, statuses } = makeHooks();
    await watchRetainOperation(fetchImpl, "http://x", "key", "bank", "op-0", Date.now() - 5000,
      SNAP({ preUnitsCount: 0, transcriptLen: 2500 }), 1, 10, hooks);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].customType, "hindsight-retain-zero-units-extracted");
    assert.equal(sent[0].details.bank, "bank");
    assert.equal(sent[0].details.operation_id, "op-0");
    assert.equal(sent[0].details.pre_units_count, 0);
    assert.equal(sent[0].details.post_units_count, 0);
    assert.equal(sent[0].details.transcript_len, 2500);
    assert.equal(sent[0].details.document_id, "session-test");
    assert.ok(typeof sent[0].details.op_age_ms === "number" && sent[0].details.op_age_ms >= 5000);
    assert.equal(statuses.length, 1);
    assert.equal(statuses[0].status, "⚠ 0 units extracted");
  });

  test("substantial transcript + post == pre (append produced nothing): fires alert", async () => {
    const op: OperationStatusResponse = {
      operation_id: "op", status: "completed",
      result_metadata: { document_ids: ["session-test"] },
    };
    const { fetchImpl } = makeFetchSequence([
      () => jsonResponse(op),
      () => jsonResponse({ id: "session-test", memory_unit_count: 9 }),
    ]);
    const { hooks, sent } = makeHooks();
    await watchRetainOperation(fetchImpl, "http://x", "key", "bank", "op", Date.now(),
      SNAP({ preUnitsCount: 9, transcriptLen: 4000 }), 1, 10, hooks);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].customType, "hindsight-retain-zero-units-extracted");
  });

  test("transcript exactly at threshold (500 chars) + zero delta: fires alert", async () => {
    const op: OperationStatusResponse = {
      operation_id: "op", status: "completed",
      result_metadata: { document_ids: ["session-test"] },
    };
    const { fetchImpl } = makeFetchSequence([
      () => jsonResponse(op),
      () => jsonResponse({ id: "session-test", memory_unit_count: 0 }),
    ]);
    const { hooks, sent } = makeHooks();
    await watchRetainOperation(fetchImpl, "http://x", "key", "bank", "op", Date.now(),
      SNAP({ preUnitsCount: 0, transcriptLen: 500 }), 1, 10, hooks);
    assert.equal(sent.length, 1, "exactly at the threshold should fire");
  });
});

// ---------------------------------------------------------------------------
// TESTS — legitimate zero-extraction (silent)
// ---------------------------------------------------------------------------

describe("retain-polling: legitimate zero extraction (false-positive guard)", () => {
  test("trivial transcript (< 500 chars) + zero delta: STAYS SILENT", async () => {
    const op: OperationStatusResponse = {
      operation_id: "op", status: "completed",
      result_metadata: { document_ids: ["session-test"] },
    };
    const { fetchImpl } = makeFetchSequence([
      () => jsonResponse(op),
      () => jsonResponse({ id: "session-test", memory_unit_count: 0 }),
    ]);
    const { hooks, sent, statuses, logs } = makeHooks();
    await watchRetainOperation(fetchImpl, "http://x", "key", "bank", "op", Date.now(),
      SNAP({ preUnitsCount: 0, transcriptLen: 120 }), 1, 10, hooks);
    assert.equal(sent.length, 0, "trivial input + zero extraction must NOT fire alert (false-positive guard)");
    assert.equal(statuses.length, 0);
    assert.ok(logs.some(l => l.includes("legit-zero")));
  });

  test("trivial transcript (499 chars, just below threshold) + zero delta: STAYS SILENT", async () => {
    const op: OperationStatusResponse = {
      operation_id: "op", status: "completed",
      result_metadata: { document_ids: ["session-test"] },
    };
    const { fetchImpl } = makeFetchSequence([
      () => jsonResponse(op),
      () => jsonResponse({ id: "session-test", memory_unit_count: 0 }),
    ]);
    const { hooks, sent } = makeHooks();
    await watchRetainOperation(fetchImpl, "http://x", "key", "bank", "op", Date.now(),
      SNAP({ preUnitsCount: 0, transcriptLen: 499 }), 1, 10, hooks);
    assert.equal(sent.length, 0);
  });

  test("missing unit_ids_count in result_metadata (the Phase B/C false-positive trigger) is NO LONGER a signal", async () => {
    // The exact production payload from operation 3fc36b5a (no unit_ids_count
    // in result_metadata, but units WERE extracted successfully).
    const op: OperationStatusResponse = {
      operation_id: "3fc36b5a", status: "completed",
      result_metadata: {
        items_count: 1,
        document_ids: ["session-test"],
        sub_batch_index: 1,
        total_sub_batches: 1,
        // CRUCIALLY: no unit_ids_count
      },
    };
    const { fetchImpl } = makeFetchSequence([
      () => jsonResponse(op),
      () => jsonResponse({ id: "session-test", memory_unit_count: 74 }), // doc has real units
    ]);
    const { hooks, sent } = makeHooks();
    await watchRetainOperation(fetchImpl, "http://x", "key", "bank", "3fc36b5a", Date.now(),
      SNAP({ preUnitsCount: 50, transcriptLen: 20000 }), 1, 10, hooks);
    assert.equal(sent.length, 0, "the Phase B false-positive case must now stay silent");
  });
});

// ---------------------------------------------------------------------------
// TESTS — document_id fallback
// ---------------------------------------------------------------------------

describe("retain-polling: document_id resolution", () => {
  test("uses snapshot.documentId when result_metadata.document_ids missing", async () => {
    const op: OperationStatusResponse = {
      operation_id: "op", status: "completed",
      result_metadata: {}, // no document_ids
    };
    const { fetchImpl, calls } = makeFetchSequence([
      () => jsonResponse(op),
      (u) => { assert.ok(u.endsWith("/documents/session-test")); return jsonResponse({ id: "session-test", memory_unit_count: 3 }); },
    ]);
    const { hooks, sent } = makeHooks();
    await watchRetainOperation(fetchImpl, "http://x", "key", "bank", "op", Date.now(),
      SNAP({ preUnitsCount: 0, transcriptLen: 2000 }), 1, 10, hooks);
    assert.equal(sent.length, 0);
    assert.equal(calls.length, 2);
  });

  test("op-declared document_ids preferred over snapshot when they match", async () => {
    const op: OperationStatusResponse = {
      operation_id: "op", status: "completed",
      result_metadata: { document_ids: ["session-test"] },
    };
    const { fetchImpl, calls } = makeFetchSequence([
      () => jsonResponse(op),
      (u) => { assert.ok(u.endsWith("/documents/session-test")); return jsonResponse({ id: "session-test", memory_unit_count: 5 }); },
    ]);
    const { hooks } = makeHooks();
    await watchRetainOperation(fetchImpl, "http://x", "key", "bank", "op", Date.now(),
      SNAP(), 1, 10, hooks);
    assert.equal(calls.length, 2);
  });

  test("post-units fetch fails (network/404) → stay silent (avoid FP)", async () => {
    const op: OperationStatusResponse = {
      operation_id: "op", status: "completed",
      result_metadata: { document_ids: ["session-test"] },
    };
    const { fetchImpl } = makeFetchSequence([
      () => jsonResponse(op),
      () => jsonResponse({}, false, 404),
    ]);
    const { hooks, sent, logs } = makeHooks();
    await watchRetainOperation(fetchImpl, "http://x", "key", "bank", "op", Date.now(),
      SNAP({ transcriptLen: 5000 }), 1, 10, hooks);
    assert.equal(sent.length, 0, "uncertain state → stay silent (false-negative bias)");
    assert.ok(logs.some(l => l.includes("no-post-units")));
  });
});

// ---------------------------------------------------------------------------
// TESTS — explicit failure (unchanged contract)
// ---------------------------------------------------------------------------

describe("retain-polling: failed status", () => {
  test("status=failed surfaces hindsight-retain-failed-async with error_message", async () => {
    const op: OperationStatusResponse = {
      operation_id: "op-x", status: "failed",
      error_message: "OpenAI HTTP 402: Insufficient credits in your account",
    };
    const { fetchImpl } = makeFetchSequence([() => jsonResponse(op)]);
    const { hooks, sent, statuses } = makeHooks();
    await watchRetainOperation(fetchImpl, "http://x", "key", "bank", "op-x", Date.now() - 8000,
      SNAP(), 1, 10, hooks);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].customType, "hindsight-retain-failed-async");
    assert.ok(sent[0].details.error_message.includes("Insufficient credits"));
    assert.equal(statuses[0].status, "⚠ retain failed");
  });

  test("status=failed with null error_message: still surfaces with placeholder", async () => {
    const op: OperationStatusResponse = { operation_id: "op", status: "failed", error_message: null };
    const { fetchImpl } = makeFetchSequence([() => jsonResponse(op)]);
    const { hooks, sent } = makeHooks();
    await watchRetainOperation(fetchImpl, "http://x", "key", "bank", "op", Date.now(),
      SNAP(), 1, 10, hooks);
    assert.equal(sent[0].details.error_message, "(no error_message)");
  });
});

// ---------------------------------------------------------------------------
// TESTS — terminal states
// ---------------------------------------------------------------------------

describe("retain-polling: timeout and not_found", () => {
  test("always pending → logs only, no user-facing message", async () => {
    const pending: OperationStatusResponse = { operation_id: "op", status: "pending" };
    const { fetchImpl, calls } = makeFetchSequence([
      () => jsonResponse(pending),
      () => jsonResponse(pending),
      () => jsonResponse(pending),
    ]);
    const { hooks, sent, statuses, logs } = makeHooks();
    await watchRetainOperation(fetchImpl, "http://x", "key", "bank", "op", Date.now() - 60000,
      SNAP(), 1, 3, hooks);
    assert.equal(sent.length, 0);
    assert.equal(statuses.length, 0);
    assert.equal(calls.length, 3);
    assert.ok(logs.some(l => l.includes("timeout")));
  });

  test("status=not_found stays silent", async () => {
    const op: OperationStatusResponse = { operation_id: "op", status: "not_found" };
    const { fetchImpl } = makeFetchSequence([() => jsonResponse(op)]);
    const { hooks, sent, statuses } = makeHooks();
    await watchRetainOperation(fetchImpl, "http://x", "key", "bank", "op", Date.now(),
      SNAP(), 1, 10, hooks);
    assert.equal(sent.length, 0);
    assert.equal(statuses.length, 0);
  });
});

// ---------------------------------------------------------------------------
// TESTS — fetchDocumentUnitsCount helper
// ---------------------------------------------------------------------------

describe("retain-polling: fetchDocumentUnitsCount helper", () => {
  test("returns memory_unit_count when document exists", async () => {
    const { fetchImpl } = makeFetchSequence([
      () => jsonResponse({ id: "d1", memory_unit_count: 42 }),
    ]);
    const r = await fetchDocumentUnitsCount(fetchImpl, "http://x", "k", "b", "d1");
    assert.equal(r, 42);
  });

  test("returns null on 404", async () => {
    const { fetchImpl } = makeFetchSequence([
      () => jsonResponse({}, false, 404),
    ]);
    const r = await fetchDocumentUnitsCount(fetchImpl, "http://x", "k", "b", "missing");
    assert.equal(r, null);
  });

  test("returns null on network error", async () => {
    const { fetchImpl } = makeFetchSequence([
      () => { throw new Error("ECONNREFUSED"); },
    ]);
    const r = await fetchDocumentUnitsCount(fetchImpl, "http://x", "k", "b", "d1");
    assert.equal(r, null);
  });

  test("returns null when memory_unit_count missing from response", async () => {
    const { fetchImpl } = makeFetchSequence([
      () => jsonResponse({ id: "d1" }),
    ]);
    const r = await fetchDocumentUnitsCount(fetchImpl, "http://x", "k", "b", "d1");
    assert.equal(r, null);
  });
});

// ---------------------------------------------------------------------------
// TESTS — buildPreRetainSnapshot helper (Phase D regression coverage)
//
// Regression context: between Phase D ship and the next refactor, the
// `agent_end` handler’s pre-retain snapshot loop referenced three locals
// (`documentId`, `transcriptLen`, `preCounts`) that were never defined in
// scope. The resulting `ReferenceError` was swallowed by an enclosing
// `try/catch (e) { log(...) }`, so the watcher never received a real
// snapshot and the Phase D zero-units detector silently went offline.
//
// These tests pin the invariant: the snapshot helper must populate every
// requested bank with a numeric count, and the production source must
// define the three locals BEFORE the snapshot construction site.
// ---------------------------------------------------------------------------

// Local mirror of the production helper. Kept algorithmically identical to
// `buildPreRetainSnapshot` in index.ts — any drift is itself a defect.
async function buildPreRetainSnapshot(
  fetchImpl: typeof fetch, apiUrl: string, apiKey: string,
  banks: string[], documentId: string,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const results = await Promise.allSettled(
    banks.map(async (b) => {
      const n = await fetchDocumentUnitsCount(fetchImpl, apiUrl, apiKey, b, documentId);
      return { bank: b, count: n ?? 0 };
    }),
  );
  for (const r of results) {
    if (r.status === "fulfilled") out.set(r.value.bank, r.value.count);
  }
  for (const b of banks) {
    if (!out.has(b)) out.set(b, 0);
  }
  return out;
}

describe("retain-polling: buildPreRetainSnapshot", () => {
  test("populates every requested bank with a numeric count", async () => {
    const { fetchImpl, calls } = makeFetchSequence([
      () => jsonResponse({ id: "session-x", memory_unit_count: 5 }),
      () => jsonResponse({ id: "session-x", memory_unit_count: 12 }),
    ]);
    const snap = await buildPreRetainSnapshot(fetchImpl, "http://x", "k", ["bank-a", "bank-b"], "session-x");
    assert.equal(snap.size, 2);
    assert.equal(snap.get("bank-a"), 5);
    assert.equal(snap.get("bank-b"), 12);
    // Both GETs should target the snapshot documentId, not anything else.
    assert.ok(calls[0].includes("/banks/bank-a/documents/session-x"));
    assert.ok(calls[1].includes("/banks/bank-b/documents/session-x"));
  });

  test("maps 404 (brand-new document) to 0 — not null, not missing", async () => {
    const { fetchImpl } = makeFetchSequence([
      () => jsonResponse({}, false, 404),
      () => jsonResponse({ id: "session-x", memory_unit_count: 3 }),
    ]);
    const snap = await buildPreRetainSnapshot(fetchImpl, "http://x", "k", ["new-bank", "old-bank"], "session-x");
    assert.equal(snap.get("new-bank"), 0);
    assert.equal(snap.get("old-bank"), 3);
  });

  test("network errors on one bank do not poison the others", async () => {
    const { fetchImpl } = makeFetchSequence([
      () => { throw new Error("ECONNREFUSED"); },
      () => jsonResponse({ id: "session-x", memory_unit_count: 9 }),
    ]);
    const snap = await buildPreRetainSnapshot(fetchImpl, "http://x", "k", ["down", "up"], "session-x");
    assert.equal(snap.get("down"), 0);
    assert.equal(snap.get("up"), 9);
  });

  test("empty banks list → empty map (no fetches)", async () => {
    const { fetchImpl, calls } = makeFetchSequence([]);
    const snap = await buildPreRetainSnapshot(fetchImpl, "http://x", "k", [], "session-x");
    assert.equal(snap.size, 0);
    assert.equal(calls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// TESTS — source-level regression guard for the original bug.
//
// This test reads index.ts as text and asserts that the three locals are
// defined in the same `agent_end` scope BEFORE the snapshot construction
// site. The earlier bug would have passed every algorithmic test (because
// the algorithm was right) yet still silently broken Phase D in production
// (because the variables were never bound). Encode the actual failure mode.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

describe("retain-polling: source-level regression — snapshot locals in scope", () => {
  test("agent_end handler defines documentId, transcriptLen, preCounts before snapshot use", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, "..", "index.ts"), "utf-8");

    // Locate the snapshot construction site — the exact lines that broke.
    const snapshotIdx = src.indexOf("const snapshot: RetainSnapshot = {");
    assert.ok(snapshotIdx > 0, "snapshot construction site not found in index.ts");

    // Locate the agent_end handler that contains the snapshot loop. Walk
    // backwards from the snapshot site to the nearest `pi.on("agent_end"`.
    const handlerIdx = src.lastIndexOf("pi.on(\"agent_end\"", snapshotIdx);
    assert.ok(handlerIdx > 0, "agent_end handler not found before snapshot site");

    const scope = src.slice(handlerIdx, snapshotIdx);
    assert.match(scope, /const\s+documentId\s*=/,
      "documentId must be defined in agent_end scope before snapshot construction");
    assert.match(scope, /const\s+transcriptLen\s*=/,
      "transcriptLen must be defined in agent_end scope before snapshot construction");
    assert.match(scope, /const\s+preCounts\s*=/,
      "preCounts must be defined in agent_end scope before snapshot construction");
  });
});

// ---------------------------------------------------------------------------
// TESTS — Phase D watcher dispatch order vs pi.sendMessage (pi -p mode fix).
//
// Bug: in `pi -p` single-shot mode the runtime disposes ctx before the
// queued agent_end handler runs, so `pi.sendMessage(...)` throws a
// "stale after session replacement or reload" error. The original handler
// called pi.sendMessage BEFORE the `for (... watchRetainOperation(...))`
// loop, so the throw aborted the surrounding try-block and Phase D
// silent-failure detection never fired in print mode.
//
// Two invariants pin the fix:
//
//   (a) Source-level: the watcher dispatch loop must appear BEFORE every
//       pi.sendMessage call in the agent_end handler. This is the actual
//       fix — ordering is the contract.
//
//   (b) Source-level: each pi.sendMessage call in the agent_end handler
//       must be wrapped in try/catch that swallows the
//       "stale after session replacement or reload" string (matches the
//       session-title fix in commit 971552b). Belt-and-braces defense
//       against the same race surfacing through a different code path.
//
// Together (a) and (b) make the bug structurally impossible to re-introduce:
// a refactor that calls sendMessage before the dispatch loop would fail (a);
// a refactor that drops the stale-ctx try/catch would fail (b).
//
// A behavioral test (mock pi.sendMessage to throw, observe the poll fetch)
// is intentionally NOT included here — index.ts runtime-imports
// `@earendil-works/pi-tui` and this package's test harness has no installed
// peer deps (the same reason every other test in this file uses a local
// mirror of the production helpers). The source-level invariants above
// encode the same contract more robustly than a timer/fetch behavioral
// mock that would otherwise be required.
// ---------------------------------------------------------------------------

describe("retain-polling: dispatch order survives pi.sendMessage throw", () => {
  test("(a) source-level — watchRetainOperation dispatch loop appears before pi.sendMessage in agent_end handler", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, "..", "index.ts"), "utf-8");

    // Slice the agent_end handler body. Start at the `pi.on("agent_end"`
    // anchor, end at the next top-level `pi.registerCommand(` ("// ───
    // Commands" section). This is robust against renames within the
    // handler body itself.
    const handlerStart = src.indexOf("pi.on(\"agent_end\"");
    assert.ok(handlerStart > 0, "agent_end handler not found in index.ts");
    const handlerEnd = src.indexOf("pi.registerCommand(", handlerStart);
    assert.ok(handlerEnd > handlerStart, "agent_end handler end marker not found");
    const body = src.slice(handlerStart, handlerEnd);

    const dispatchIdx = body.indexOf("watchRetainOperation(pi");
    assert.ok(
      dispatchIdx > 0,
      "watchRetainOperation(pi, ...) dispatch site not found inside agent_end handler",
    );

    // Every pi.sendMessage call inside the handler must occur AFTER the
    // dispatch site. Walk every match.
    const sendRe = /pi\.sendMessage\s*\(/g;
    let m: RegExpExecArray | null;
    let sendCount = 0;
    while ((m = sendRe.exec(body)) !== null) {
      sendCount++;
      assert.ok(
        m.index > dispatchIdx,
        `pi.sendMessage at body offset ${m.index} appears BEFORE watchRetainOperation dispatch at offset ${dispatchIdx} — print-mode regression: stale-ctx throw will abort dispatch loop`,
      );
    }
    assert.ok(sendCount >= 2, `expected ≥ 2 pi.sendMessage calls in agent_end (success + failure paths), got ${sendCount}`);
  });

  test("(b) source-level — each pi.sendMessage in agent_end is wrapped in try/catch that swallows stale-ctx error", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, "..", "index.ts"), "utf-8");

    const handlerStart = src.indexOf("pi.on(\"agent_end\"");
    const handlerEnd = src.indexOf("pi.registerCommand(", handlerStart);
    const body = src.slice(handlerStart, handlerEnd);

    // For each pi.sendMessage call inside agent_end, look backward for the
    // enclosing `try {` within a small window and forward for the matching
    // `catch (` that mentions the stale-ctx string. We don't need a full
    // AST — a coarse proximity check is enough to pin the invariant.
    const sendRe = /pi\.sendMessage\s*\(/g;
    let m: RegExpExecArray | null;
    const offsets: number[] = [];
    while ((m = sendRe.exec(body)) !== null) offsets.push(m.index);

    assert.ok(offsets.length >= 2, "expected at least 2 pi.sendMessage calls");

    for (const off of offsets) {
      // Look ~400 chars before for the nearest `try {`
      const before = body.slice(Math.max(0, off - 400), off);
      const tryIdx = before.lastIndexOf("try {");
      assert.ok(tryIdx >= 0, `pi.sendMessage at offset ${off} not preceded by a nearby try { — stale-ctx error will propagate`);

      // Look ~600 chars after for the catch block that swallows stale-ctx
      const after = body.slice(off, off + 600);
      assert.match(
        after,
        /catch\s*\([^)]*\)\s*\{[\s\S]*?stale after session replacement or reload/,
        `pi.sendMessage at offset ${off} not followed by a catch that mentions "stale after session replacement or reload" — race fix missing for this call site`,
      );
    }
  });

});
