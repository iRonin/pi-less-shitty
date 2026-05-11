/**
 * Phase D smoke — exercises the new units-delta detection against the live
 * test container on :18787.
 *
 * Scenario A: short transcript + working LLM → no alert (silent)
 * Scenario B: substantial transcript + BROKEN LLM → fires zero-units-extracted
 *
 * Usage:
 *   node test/smoke-phase-d.mjs            # scenario A (working LLM)
 *   SMOKE_BROKEN_LLM=1 node test/smoke-phase-d.mjs   # scenario B
 *
 * Prereqs:
 *   - hindsight-test container running on :18787 (scripts/hindsight-test-up.sh)
 *   - For scenario B, the container must have been launched with
 *     HINDSIGHT_API_LLM_BASE_URL=http://localhost:9 (smoke-fail mode)
 */
const API = "http://localhost:18787";
const BANK = process.env.SMOKE_BROKEN_LLM ? "test-bank-broken" : "test-bank";

const SHORT = "[role: user]\nhi there\n[user:end]\n\n[role: assistant]\nhello!\n[assistant:end]";
const SUBSTANTIAL = `[role: user]\n` +
  `Refactor the retain-polling module. The Phase B work surfaced "zero facts extracted" ` +
  `false-positives because it relied on a metadata field (unit_ids_count) that's only ` +
  `written by hindsight's streaming checkpoint path. Most retains bypass that path so ` +
  `the field is missing on success too. Replace the heuristic with a real post-retain ` +
  `units delta: snapshot memory_unit_count before POST, re-fetch after the operation ` +
  `completes, compare. Only alert when input was substantial (≥500 chars) AND delta == 0. ` +
  `Below that threshold, treat zero-extraction as legitimate (trivial input). Make sure ` +
  `the threshold is empirical — undershoot toward silence rather than over-alerting. ` +
  `\n[user:end]\n\n[role: assistant]\n` +
  `Acknowledged. Implementation plan: (1) add fetchDocumentUnitsCount helper that GETs ` +
  `/banks/{b}/documents/{d} and returns memory_unit_count or null. (2) Define SUBSTANTIAL_TRANSCRIPT_CHARS ` +
  `= 500. (3) In agent_end, before POST, snapshot pre-counts per bank in parallel. ` +
  `(4) Pass snapshot {documentId, preUnitsCount, transcriptLen} into watcher. ` +
  `(5) Watcher: poll until terminal. On completed, fetch op's document_ids from ` +
  `result_metadata, GET each doc, compute delta. If delta<=0 AND substantial, fire ` +
  `hindsight-retain-zero-units-extracted with full evidence. Otherwise stay silent. ` +
  `(6) Tests: rewrite retain-polling.test.ts; keep failed-status branch unchanged.\n[assistant:end]`;

console.log(`[smoke-d] mode=${process.env.SMOKE_BROKEN_LLM ? "BROKEN_LLM (scenario B)" : "WORKING_LLM (scenario A)"} bank=${BANK}`);
console.log(`[smoke-d] short transcript len=${SHORT.length} chars`);
console.log(`[smoke-d] substantial transcript len=${SUBSTANTIAL.length} chars`);

// ─── Inline the Phase D logic (kept in sync with index.ts) ──────────────────

async function fetchDocumentUnitsCount(bank, docId) {
  const r = await fetch(`${API}/v1/default/banks/${bank}/documents/${docId}`);
  if (r.status === 404) return null;
  if (!r.ok) return null;
  const j = await r.json();
  return typeof j.memory_unit_count === "number" ? j.memory_unit_count : null;
}

async function postRetain(bank, content, docId) {
  const r = await fetch(`${API}/v1/default/banks/${bank}/memories`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      items: [{ content, document_id: docId, update_mode: "append", timestamp: new Date().toISOString() }],
      async: true,
    }),
  });
  if (!r.ok) throw new Error(`POST /memories HTTP ${r.status}: ${await r.text()}`);
  const j = await r.json();
  return j.operation_id || (Array.isArray(j.operation_ids) ? j.operation_ids[0] : null);
}

async function pollOp(bank, opId, maxSec = 90) {
  for (let i = 0; i < maxSec / 2; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const r = await fetch(`${API}/v1/default/banks/${bank}/operations/${opId}`);
    if (!r.ok) continue;
    const j = await r.json();
    if (j.status === "completed" || j.status === "failed" || j.status === "not_found") return j;
  }
  return null;
}

const SUBSTANTIAL_TRANSCRIPT_CHARS = 500;

async function runScenario(label, content) {
  const docId = `session-smoke-${label}-${Date.now()}`;
  console.log(`\n[smoke-d] === scenario ${label} ===`);
  console.log(`[smoke-d] doc_id=${docId} transcript_len=${content.length}`);

  const pre = await fetchDocumentUnitsCount(BANK, docId);
  console.log(`[smoke-d] pre_units_count = ${pre} (null = doc does not exist yet)`);

  const t0 = Date.now();
  const opId = await postRetain(BANK, content, docId);
  console.log(`[smoke-d] operation_id = ${opId}`);

  const op = await pollOp(BANK, opId);
  const age = Date.now() - t0;
  if (!op) { console.log(`[smoke-d] TIMEOUT after ${age}ms`); return; }

  console.log(`[smoke-d] terminal status=${op.status} age=${age}ms`);
  console.log(`[smoke-d] result_metadata = ${JSON.stringify(op.result_metadata)}`);
  if (op.error_message) console.log(`[smoke-d] error_message = ${op.error_message}`);

  if (op.status === "failed") {
    console.log(`[smoke-d] DECISION: would fire hindsight-retain-failed-async`);
    return;
  }
  if (op.status !== "completed") {
    console.log(`[smoke-d] DECISION: non-terminal — silent`);
    return;
  }

  const post = await fetchDocumentUnitsCount(BANK, docId);
  console.log(`[smoke-d] post_units_count = ${post}`);
  const preN = pre ?? 0;
  if (post === null) {
    console.log(`[smoke-d] DECISION: doc fetch returned null — silent (avoid FP)`);
    return;
  }
  const delta = post - preN;
  const substantial = content.length >= SUBSTANTIAL_TRANSCRIPT_CHARS;
  console.log(`[smoke-d] delta = ${delta}, substantial = ${substantial}`);

  if (delta <= 0 && substantial) {
    console.log(`[smoke-d] DECISION: would fire hindsight-retain-zero-units-extracted`);
    console.log(`[smoke-d]   { bank: ${BANK}, document_id: ${docId}, pre: ${preN}, post: ${post}, transcript_len: ${content.length} }`);
  } else if (delta <= 0 && !substantial) {
    console.log(`[smoke-d] DECISION: legit-zero (transcript below threshold) — SILENT`);
  } else {
    console.log(`[smoke-d] DECISION: happy path (delta=${delta}) — SILENT`);
  }
}

(async () => {
  await runScenario("short", SHORT);
  await runScenario("substantial", SUBSTANTIAL);
})();
