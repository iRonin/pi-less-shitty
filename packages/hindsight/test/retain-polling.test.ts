/**
 * Tests for Phase B — silent-failure detection via operation polling.
 *
 * The polling helpers (`fetchOperation`, `aggregateUnitsCount`,
 * `pollOperationUntilTerminal`, `watchRetainOperation`) live inside index.ts
 * as module-local helpers. To keep this test fast (sub-second total) and
 * fully decoupled from the live hindsight server, we re-implement the
 * detection logic here under the same algorithm and assert the same
 * branching contract. Any production drift between this test and index.ts
 * is itself a defect — they MUST stay in sync.
 *
 * Run: node --experimental-strip-types --test retain-polling.test.ts
 */

import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Polling primitives — kept byte-for-byte algorithmically identical to index.ts
// ---------------------------------------------------------------------------

interface OperationStatusResponse {
  operation_id: string;
  status: "pending" | "completed" | "failed" | "not_found" | string;
  error_message?: string | null;
  result_metadata?: Record<string, unknown> | null;
  child_operations?: Array<{ operation_id: string; status: string; error_message?: string | null }> | null;
}

function authHeader(key: string) { return { "Authorization": `Bearer ${key || ""}` }; }
function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

async function fetchOperation(
  fetchImpl: typeof fetch,
  apiUrl: string,
  apiKey: string,
  bank: string,
  operationId: string,
): Promise<OperationStatusResponse | null> {
  try {
    const res = await fetchImpl(`${apiUrl}/v1/default/banks/${bank}/operations/${operationId}`, {
      headers: authHeader(apiKey),
    } as any);
    if (!res.ok) return null;
    return (await res.json()) as OperationStatusResponse;
  } catch { return null; }
}

async function aggregateUnitsCount(
  fetchImpl: typeof fetch,
  apiUrl: string,
  apiKey: string,
  bank: string,
  op: OperationStatusResponse,
): Promise<number | null> {
  let total = 0;
  let anyFieldSeen = false;
  const direct = op.result_metadata?.unit_ids_count;
  if (typeof direct === "number") { total += direct; anyFieldSeen = true; }
  if (Array.isArray(op.child_operations) && op.child_operations.length > 0) {
    for (const child of op.child_operations) {
      const childOp = await fetchOperation(fetchImpl, apiUrl, apiKey, bank, child.operation_id);
      const c = childOp?.result_metadata?.unit_ids_count;
      if (typeof c === "number") { total += c; anyFieldSeen = true; }
    }
  }
  return anyFieldSeen ? total : null;
}

async function pollOperationUntilTerminal(
  fetchImpl: typeof fetch,
  apiUrl: string,
  apiKey: string,
  bank: string,
  operationId: string,
  pollIntervalMs: number,
  maxAttempts: number,
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
  fetchImpl: typeof fetch,
  apiUrl: string,
  apiKey: string,
  bank: string,
  operationId: string,
  t0: number,
  pollIntervalMs: number,
  maxAttempts: number,
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
  // completed
  const units = await aggregateUnitsCount(fetchImpl, apiUrl, apiKey, bank, op);
  if (units === null || units === 0) {
    hooks.log(`retain-poll: zero-facts op=${operationId} bank=${bank} age_ms=${op_age_ms} units=${units}`);
    hooks.setStatus("⚠ 0 facts retained");
    hooks.sendMessage({
      customType: "hindsight-retain-zero-facts",
      details: { bank, operation_id: operationId, op_age_ms, units_count: units },
    });
    return;
  }
  hooks.log(`retain-poll: ok op=${operationId} bank=${bank} age_ms=${op_age_ms} units=${units}`);
}

// ---------------------------------------------------------------------------
// Mock fetch builder
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
      const handler = responses[i++];
      return handler(url);
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

// ---------------------------------------------------------------------------
// TESTS
// ---------------------------------------------------------------------------

describe("retain-polling: happy path (silent)", () => {
  test("completed with unit_ids_count > 0 directly on op: no message sent", async () => {
    const op: OperationStatusResponse = {
      operation_id: "op-1", status: "completed",
      result_metadata: { unit_ids_count: 7 },
      child_operations: null,
    };
    const { fetchImpl, calls } = makeFetchSequence([
      (u) => { assert.ok(u.endsWith("/operations/op-1")); return jsonResponse(op); },
    ]);
    const { hooks, logs, sent, statuses } = makeHooks();
    await watchRetainOperation(fetchImpl, "http://x", "key", "bank", "op-1", Date.now() - 1234, 1, 10, hooks);
    assert.equal(sent.length, 0, "no user message");
    assert.equal(statuses.length, 0, "no status update");
    assert.equal(calls.length, 1, "single GET, no child polling");
    assert.ok(logs.some(l => l.includes("retain-poll: ok")), "logs OK line");
    assert.ok(logs.some(l => l.includes("units=7")));
  });

  test("completed batch_retain parent with non-zero unit_ids_count across children: silent", async () => {
    const parent: OperationStatusResponse = {
      operation_id: "parent", status: "completed",
      result_metadata: { is_parent: true, items_count: 1, total_tokens: 3000, num_sub_batches: 2 },
      child_operations: [
        { operation_id: "c1", status: "completed" },
        { operation_id: "c2", status: "completed" },
      ],
    };
    const c1: OperationStatusResponse = { operation_id: "c1", status: "completed", result_metadata: { unit_ids_count: 3 } };
    const c2: OperationStatusResponse = { operation_id: "c2", status: "completed", result_metadata: { unit_ids_count: 2 } };
    const { fetchImpl } = makeFetchSequence([
      () => jsonResponse(parent),
      (u) => { assert.ok(u.includes("/c1")); return jsonResponse(c1); },
      (u) => { assert.ok(u.includes("/c2")); return jsonResponse(c2); },
    ]);
    const { hooks, sent, logs } = makeHooks();
    await watchRetainOperation(fetchImpl, "http://x", "key", "bank", "parent", Date.now(), 1, 10, hooks);
    assert.equal(sent.length, 0);
    assert.ok(logs.some(l => l.includes("units=5")));
  });
});

describe("retain-polling: zero-facts detection", () => {
  test("completed with unit_ids_count === 0 explicit: fires hindsight-retain-zero-facts", async () => {
    const op: OperationStatusResponse = {
      operation_id: "op-0", status: "completed",
      result_metadata: { unit_ids_count: 0 },
    };
    const { fetchImpl } = makeFetchSequence([() => jsonResponse(op)]);
    const { hooks, sent, statuses, logs } = makeHooks();
    await watchRetainOperation(fetchImpl, "http://x", "key", "bank", "op-0", Date.now() - 5000, 1, 10, hooks);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].customType, "hindsight-retain-zero-facts");
    assert.equal(sent[0].details.bank, "bank");
    assert.equal(sent[0].details.operation_id, "op-0");
    assert.equal(sent[0].details.units_count, 0);
    assert.ok(typeof sent[0].details.op_age_ms === "number" && sent[0].details.op_age_ms >= 5000);
    assert.equal(statuses.length, 1);
    assert.equal(statuses[0].status, "⚠ 0 facts retained");
    assert.ok(logs.some(l => l.includes("zero-facts")));
  });

  test("completed batch_retain parent with NO unit_ids_count field anywhere (bug pattern): fires zero-facts", async () => {
    // This is the actual 4-day production bug pattern:
    // - LLM failed extraction → 0 facts → orchestrator never wrote unit_ids_count
    // - Operation still marked "completed" → silent failure
    const parent: OperationStatusResponse = {
      operation_id: "parent", status: "completed",
      result_metadata: { is_parent: true, items_count: 1, total_tokens: 31, num_sub_batches: 1 },
      child_operations: [{ operation_id: "c1", status: "completed" }],
    };
    const c1: OperationStatusResponse = {
      operation_id: "c1", status: "completed",
      result_metadata: { items_count: 1, document_ids: ["d1"], sub_batch_index: 1, total_sub_batches: 1, parent_operation_id: "parent" },
    };
    const { fetchImpl } = makeFetchSequence([
      () => jsonResponse(parent),
      () => jsonResponse(c1),
    ]);
    const { hooks, sent } = makeHooks();
    await watchRetainOperation(fetchImpl, "http://x", "key", "bank", "parent", Date.now(), 1, 10, hooks);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].customType, "hindsight-retain-zero-facts");
    assert.equal(sent[0].details.units_count, null, "units_count should be null when no field seen");
  });

  test("completed batch_retain with one child having facts, one with zero: SUM > 0 → silent", async () => {
    const parent: OperationStatusResponse = {
      operation_id: "p", status: "completed",
      result_metadata: { is_parent: true, num_sub_batches: 2 },
      child_operations: [
        { operation_id: "c1", status: "completed" },
        { operation_id: "c2", status: "completed" },
      ],
    };
    const c1: OperationStatusResponse = { operation_id: "c1", status: "completed", result_metadata: { unit_ids_count: 0 } };
    const c2: OperationStatusResponse = { operation_id: "c2", status: "completed", result_metadata: { unit_ids_count: 4 } };
    const { fetchImpl } = makeFetchSequence([
      () => jsonResponse(parent),
      () => jsonResponse(c1),
      () => jsonResponse(c2),
    ]);
    const { hooks, sent } = makeHooks();
    await watchRetainOperation(fetchImpl, "http://x", "key", "bank", "p", Date.now(), 1, 10, hooks);
    assert.equal(sent.length, 0, "any child with facts means overall success");
  });
});

describe("retain-polling: failed status", () => {
  test("status=failed surfaces hindsight-retain-failed-async with error_message", async () => {
    const op: OperationStatusResponse = {
      operation_id: "op-x", status: "failed",
      error_message: "OpenAI HTTP 402: Insufficient credits in your account",
      result_metadata: null,
    };
    const { fetchImpl } = makeFetchSequence([() => jsonResponse(op)]);
    const { hooks, sent, statuses } = makeHooks();
    await watchRetainOperation(fetchImpl, "http://x", "key", "bank", "op-x", Date.now() - 8000, 1, 10, hooks);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].customType, "hindsight-retain-failed-async");
    assert.equal(sent[0].details.bank, "bank");
    assert.equal(sent[0].details.operation_id, "op-x");
    assert.ok(sent[0].details.error_message.includes("Insufficient credits"));
    assert.ok(typeof sent[0].details.op_age_ms === "number" && sent[0].details.op_age_ms >= 8000);
    assert.equal(statuses.length, 1);
    assert.equal(statuses[0].status, "⚠ retain failed");
  });

  test("status=failed with null error_message: still surfaces with placeholder", async () => {
    const op: OperationStatusResponse = { operation_id: "op", status: "failed", error_message: null };
    const { fetchImpl } = makeFetchSequence([() => jsonResponse(op)]);
    const { hooks, sent } = makeHooks();
    await watchRetainOperation(fetchImpl, "http://x", "key", "bank", "op", Date.now(), 1, 10, hooks);
    assert.equal(sent[0].details.error_message, "(no error_message)");
  });
});

describe("retain-polling: timeout", () => {
  test("always pending → logs only, no user-facing message", async () => {
    const pending: OperationStatusResponse = { operation_id: "op", status: "pending" };
    // 3 attempts, all pending
    const { fetchImpl, calls } = makeFetchSequence([
      () => jsonResponse(pending),
      () => jsonResponse(pending),
      () => jsonResponse(pending),
    ]);
    const { hooks, sent, statuses, logs } = makeHooks();
    await watchRetainOperation(fetchImpl, "http://x", "key", "bank", "op", Date.now() - 60000, 1, 3, hooks);
    assert.equal(sent.length, 0, "timeout must not user-message");
    assert.equal(statuses.length, 0, "timeout must not change status bar");
    assert.equal(calls.length, 3, "all 3 poll attempts exhausted");
    assert.ok(logs.some(l => l.includes("timeout")));
  });

  test("fetch errors during polling don't blow up; eventually times out", async () => {
    const { fetchImpl } = makeFetchSequence([
      () => { throw new Error("ECONNREFUSED"); },
      () => jsonResponse({}, false, 500),
      () => { throw new Error("ECONNREFUSED"); },
    ]);
    const { hooks, sent, logs } = makeHooks();
    await watchRetainOperation(fetchImpl, "http://x", "key", "bank", "op", Date.now(), 1, 3, hooks);
    assert.equal(sent.length, 0);
    assert.ok(logs.some(l => l.includes("timeout")));
  });
});

describe("retain-polling: terminal not_found", () => {
  test("status=not_found logs and stays silent (server forgot operation)", async () => {
    const op: OperationStatusResponse = { operation_id: "op", status: "not_found" };
    const { fetchImpl } = makeFetchSequence([() => jsonResponse(op)]);
    const { hooks, sent, statuses, logs } = makeHooks();
    await watchRetainOperation(fetchImpl, "http://x", "key", "bank", "op", Date.now(), 1, 10, hooks);
    assert.equal(sent.length, 0);
    assert.equal(statuses.length, 0);
    assert.ok(logs.some(l => l.includes("not_found")));
  });
});

describe("retain-polling: aggregateUnitsCount helper", () => {
  test("returns null when no operation in tree exposes the field", async () => {
    const op: OperationStatusResponse = { operation_id: "p", status: "completed", result_metadata: { items_count: 1 } };
    const { fetchImpl } = makeFetchSequence([]);
    const r = await aggregateUnitsCount(fetchImpl, "http://x", "k", "b", op);
    assert.equal(r, null);
  });

  test("returns sum across children", async () => {
    const op: OperationStatusResponse = {
      operation_id: "p", status: "completed",
      result_metadata: { unit_ids_count: 1 },
      child_operations: [
        { operation_id: "c1", status: "completed" },
        { operation_id: "c2", status: "completed" },
      ],
    };
    const { fetchImpl } = makeFetchSequence([
      () => jsonResponse({ operation_id: "c1", status: "completed", result_metadata: { unit_ids_count: 5 } }),
      () => jsonResponse({ operation_id: "c2", status: "completed", result_metadata: { unit_ids_count: 4 } }),
    ]);
    const r = await aggregateUnitsCount(fetchImpl, "http://x", "k", "b", op);
    assert.equal(r, 10, "1 (parent) + 5 (c1) + 4 (c2) = 10");
  });

  test("returns 0 when explicit 0 on parent and missing on children", async () => {
    const op: OperationStatusResponse = {
      operation_id: "p", status: "completed",
      result_metadata: { unit_ids_count: 0 },
      child_operations: [{ operation_id: "c1", status: "completed" }],
    };
    const { fetchImpl } = makeFetchSequence([
      () => jsonResponse({ operation_id: "c1", status: "completed", result_metadata: {} }),
    ]);
    const r = await aggregateUnitsCount(fetchImpl, "http://x", "k", "b", op);
    assert.equal(r, 0);
  });
});
