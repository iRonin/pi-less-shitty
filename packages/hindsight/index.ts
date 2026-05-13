/**
 * Hindsight Extension for Pi — Domain-aware agent memory
 *
 * Lifecycle:
 *   session_start       → reset state, verify server + bank auth, set status
 *   input               → capture user prompt for context
 *   before_agent_start  → recall memories from project + global banks
 *   agent_end           → retain turn transcript (delta-only, append mode)
 *   session_compact     → reset recall state (context was rebuilt)
 *
 * Config: parent-traversal of .hindsight/config.toml files (child wins).
 *   bank_id     → active project bank (scope boundary, MUST be explicit)
 *   global_bank → cross-scope shared pool
 *
 * No implicit banks: if no config with bank_id exists in the parent chain,
 * the extension is inactive for that session.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { Type } from "@sinclair/typebox";
import {
  BACKOFF_SCHEDULE_MS,
  DEFAULT_MAX_QUEUE_SIZE,
  enqueue as enqueueQueueEntry,
  listEntries as listQueueEntries,
  markAttempted as markQueueAttempted,
  markAwaitingUser as markQueueAwaitingUser,
  removeEntry as removeQueueEntry,
  countAwaitingUser as countQueueAwaitingUser,
  dueEntries as dueQueueEntries,
  nextBackoffMs,
  getQueueDir,
} from "./queue.ts";
import type { QueueEntry, QueueOptions } from "./queue.ts";
import {
  buildSelfHealEnqueuePayload as _buildSelfHealEnqueuePayload,
  normalizeBool as _normalizeBool,
  writeSelfHealEnabledToml as _writeSelfHealEnabledToml,
} from "./self-heal.ts";
import type {
  SelfHealConfig as _SelfHealConfig,
  RetainContextShape,
  RetainSnapshotShape,
} from "./self-heal.ts";
export const buildSelfHealEnqueuePayload = _buildSelfHealEnqueuePayload;
export const normalizeBool = _normalizeBool;
export const writeSelfHealEnabledToml = _writeSelfHealEnabledToml;
import {
  tokenizeForJaccard,
  jaccardSimilarity,
  shouldRecall,
  normalizeHeuristic,
  TOPIC_SHIFT_TRIGGER_RE,
  DEFAULT_TOPIC_SHIFT_SETTINGS,
} from "./heuristic.ts";
import type {
  TopicShiftHeuristic,
  ShouldRecallInput,
  ShouldRecallDecision,
} from "./heuristic.ts";
export {
  tokenizeForJaccard,
  jaccardSimilarity,
  shouldRecall,
  normalizeHeuristic,
  TOPIC_SHIFT_TRIGGER_RE,
  DEFAULT_TOPIC_SHIFT_SETTINGS,
};
// TopicShiftRecallSettings is re-exported via `export type { ... }` further
// down (after HindsightSettings, which embeds it).
export type {
  TopicShiftHeuristic,
  ShouldRecallInput,
  ShouldRecallDecision,
};

// ─── Debug ───────────────────────────────────────────────────────────────

const DEBUG = process.env.HINDSIGHT_DEBUG === "1";
const LOG_DIR = join(homedir(), ".hindsight");
const LOG_PATH = join(LOG_DIR, "debug.log");

function log(msg: string) {
  if (!DEBUG) return;
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { mkdirSync(LOG_DIR, { recursive: true }); appendFileSync(LOG_PATH, line); } catch {}
}

function readRecentLog(maxLines = 20): string[] {
  try {
    if (!existsSync(LOG_PATH)) return [];
    return readFileSync(LOG_PATH, "utf-8").split("\n").filter(l => l.trim()).slice(-maxLines);
  } catch { return []; }
}

// ─── Config Resolution (Parent Traversal) ────────────────────────────────

interface ResolvedConfig {
  api_url: string;
  api_key: string;
  bank_id: string | null;
  global_bank: string | null;
  recall_types: string[];
  // Pre-compiled at config-load time. Invalid user patterns are skipped with
  // a console.error rather than left as raw strings to be compiled (and to
  // throw) later inside the agent_end handler.
  strip_patterns: RegExp[];
}

/**
 * Tiny TOML reader. Tracks `[section]` headers and emits sectioned keys as
 * `${section}_${key}` so the rest of the code can keep reading from a flat
 * Record<string, string> map. Backwards-compatible: pre-existing root-level
 * keys (`health_gate`, `recall_retry_attempts`, …) still parse as before.
 *
 * Section example:
 *   [self_heal]
 *   enabled = true     → out["self_heal_enabled"] = "true"
 */
function parseToml(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) return {};
  const raw = readFileSync(filePath, "utf-8");
  const out: Record<string, string> = {};
  let section = "";
  for (const rawLine of raw.split("\n")) {
    const line = rawLine.replace(/\s*#.*$/, ""); // strip trailing comments
    const hdr = line.match(/^\s*\[([a-zA-Z0-9_]+)\]\s*$/);
    if (hdr) { section = hdr[1]; continue; }
    const m = line.match(/^\s*([a-zA-Z0-9_]+)\s*=\s*["']?(.*?)["']?\s*$/);
    if (!m) continue;
    const key = section ? `${section}_${m[1]}` : m[1];
    out[key] = m[2];
  }
  return out;
}

function resolveConfig(cwd: string): ResolvedConfig | null {
  try {
    // Collect configs from cwd → root, then reverse to get root → leaf
    // so child configs overwrite parent ones (child wins)
    const configs: Record<string, string>[] = [];

    let dir = cwd;
    while (true) {
      const cfg = parseToml(join(dir, ".hindsight", "config.toml"));
      if (Object.keys(cfg).length) configs.push(cfg);
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }

    configs.reverse();
    // User-wide config is the lowest priority (prepended before reversed list)
    const userCfg = parseToml(join(homedir(), ".hindsight", "config.toml"));
    if (Object.keys(userCfg).length) configs.unshift(userCfg);

    const merged: Record<string, string> = {};
    for (const cfg of configs) Object.assign(merged, cfg);

    return {
      api_url: merged.api_url || "http://localhost:8888",
      api_key: merged.api_key || "",
      bank_id: merged.bank_id || null,
      global_bank: merged.global_bank || null,
      recall_types: merged.recall_types
        ? merged.recall_types.split(",").map(t => t.trim()).filter(Boolean)
        : ["observation"],
      // FIX 3: compile user-supplied strip_patterns at config-load time with
      // explicit per-pattern try/catch. An invalid regex used to throw inside
      // the agent_end handler, where the surrounding try/catch swallowed it
      // silently and dropped the entire retain.
      strip_patterns: merged.strip_patterns
        ? compileStripPatterns(merged.strip_patterns.split(",").map(p => p.trim()).filter(Boolean))
        : [],
    };
  } catch { return null; }
}

function getRecallBanks(config: ResolvedConfig): string[] {
  const banks: string[] = [];
  if (config.bank_id) banks.push(config.bank_id);
  if (config.global_bank) banks.push(config.global_bank);
  return banks;
}

function getRetainBanks(config: ResolvedConfig, prompt: string): string[] {
  const banks = new Set<string>();
  if (config.bank_id) banks.add(config.bank_id);
  if (config.global_bank && (prompt.includes("#global") || prompt.includes("#me"))) {
    banks.add(config.global_bank);
  }
  return Array.from(banks);
}

function getActiveBank(config: ResolvedConfig): string | null {
  return config.bank_id;
}

// ─── Configurable Stripping Patterns ─────────────────────────────────────

const DEFAULT_STRIP_PATTERNS: RegExp[] = [
  // Prevent feedback loop: injected memories from previous recall
  /<hindsight_memories>[\s\S]*?<\/hindsight_memories>/g,
  // Remove reasoning/thinking blocks (not factual content)
  /<(?:antThinking|thinking|reasoning)>[\s\S]*?<\/(?:antThinking|thinking|reasoning)>/g,
  // Remove inline base64 images (massive noise for text memory)
  /data:[^;]+;base64,[A-Za-z0-9+/=]{100,}/g,
];

function compileStripPatterns(patterns: string[]): RegExp[] {
  const compiled: RegExp[] = [];
  for (const p of patterns) {
    try {
      compiled.push(new RegExp(p, "g"));
    } catch (e) {
      console.error(`[hindsight] Invalid strip_pattern regex: ${JSON.stringify(p)} (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  return compiled;
}

function getStripPatterns(config: ResolvedConfig): RegExp[] {
  // strip_patterns are pre-compiled in resolveConfig() — see FIX 3.
  return config.strip_patterns?.length ? config.strip_patterns : DEFAULT_STRIP_PATTERNS;
}

function extractTags(prompt: string): string[] {
  const reserved = new Set(["nomem", "skip", "global", "me"]);
  return Array.from(prompt.matchAll(/(?<=^|\s)#([a-zA-Z0-9_-]+)/g))
    .map(m => m[1].toLowerCase()).filter(t => !reserved.has(t));
}

// ─── Transcript Builder ─────────────────────────────────────────────────

interface AssistantMessage {
  role: string;
  content?: string | Array<{ type: string; name?: string; text?: string; input?: unknown }>;
}

function buildTranscript(prompt: string, messages: AssistantMessage[], stripPatterns: RegExp[]): string {
  let transcript = `[role: user]\n${prompt}\n[user:end]\n\n[role: assistant]\n`;
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    const content = msg.content;
    if (typeof content === "string") {
      transcript += `${content}\n`;
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "text") transcript += `${block.text}\n`;
        // Pi uses block.type === "toolCall" with block.arguments (not Anthropic's "tool_use"/.input).
        // Previously this checked "tool_use" and silently dropped every tool call from the retained transcript.
        else if (block.type === "toolCall" && !OPERATIONAL_TOOLS.has(block.name)) {
          const args = (block as { arguments?: unknown }).arguments ?? (block as { input?: unknown }).input;
          transcript += `[Tool: ${block.name}]\n${args ? JSON.stringify(args) : ""}\n`;
        }
      }
    }
  }
  transcript += `[assistant:end]`;
  for (const pattern of stripPatterns) {
    transcript = transcript.replace(pattern, "");
  }
  return transcript.trim();
}

// ─── Retain Filtering ───────────────────────────────────────────────────

const TRIVIAL_PROMPT_RE = /^(ok|yes|no|thanks|continue|next|done|sure|stop)$/i;

function shouldSkipRetain(prompt: string | null): { skip: boolean; reason?: string } {
  if (!prompt) return { skip: true, reason: "no prompt" };
  if (prompt.length < 5) return { skip: true, reason: "too short" };
  if (TRIVIAL_PROMPT_RE.test(prompt.trim())) return { skip: true, reason: "trivial" };
  if (prompt.trim().startsWith("#nomem") || prompt.trim().startsWith("#skip")) return { skip: true, reason: "opt-out" };
  return { skip: false };
}

// ─── Operation Polling (Silent-Failure Detection — Phase D) ────────────
//
// Hindsight's POST /memories with async:true returns HTTP 200 + an operation_id.
// The server then runs LLM fact extraction in the background. If extraction
// fails (LLM down, budget exhausted, model misconfig) the operation can either:
//   - be marked `failed` with an error_message (reliable), or
//   - be marked `completed` with no units committed (silent failure).
//
// Phase B/C attempted to detect silent failure by reading
// `result_metadata.unit_ids_count`. That field is only written by hindsight's
// streaming checkpoint path (orchestrator.py ~529); MOST completed retains
// bypass that path and ship a `result_metadata` without `unit_ids_count`.
// Treating the missing field as zero-facts produced massive false positives.
//
// Phase D replaces the metadata sniff with a REAL post-retain check:
//   1. Before POST /memories, fetch the target document's current
//      `memory_unit_count` (0 if the document does not yet exist).
//   2. After the operation reaches `completed`, re-fetch the document and
//      compute the unit delta added by this retain.
//   3. Fire `hindsight-retain-zero-units-extracted` ONLY when:
//        (a) the transcript was "substantial" (≥ SUBSTANTIAL_TRANSCRIPT_CHARS), AND
//        (b) the post-retain delta is exactly 0.
//      This is the genuine bug pattern: the LLM was asked to extract from real
//      content and produced nothing.
//   4. Status `failed` with `error_message` continues to fire the existing
//      `hindsight-retain-failed-async` path (always reliable).
//
// All polling runs in the background, never awaited by agent_end.

const POLL_INTERVAL_MS = 5000;
const POLL_MAX_ATTEMPTS = 24; // 5s * 24 = 120s
// Empirical threshold for "this transcript was substantive enough that the LLM
// should have extracted at least one fact". Picked to UNDER-alert rather than
// over-alert: real-world session retains at 14316/19395/25000+ chars produce
// 14/37/74 units respectively, so anything ≥ 2000 chars that yields 0 units
// is a strong signal of extraction failure.
//
// Bumped from 500 → 2000 after switching to gpt-oss-120b on Cerebras. Empirical
// observation: 500–1500-char retains regularly extract 0 facts because the
// content genuinely lacks extractable claims (status checks, short replies,
// single-paragraph notes). Strict extraction models produce many such 0-fact
// completions, and a 500-char floor was generating false "LLM is down"
// warnings. >2000 chars of text with ZERO extractable claim is rare, so the
// new threshold keeps the gate sensitive to real silent failures while
// dropping the noisy false positives.
export const SUBSTANTIAL_TRANSCRIPT_CHARS = 2000;

interface OperationStatusResponse {
  operation_id: string;
  status: "pending" | "completed" | "failed" | "not_found" | string;
  operation_type?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  completed_at?: string | null;
  error_message?: string | null;
  result_metadata?: Record<string, unknown> | null;
  child_operations?: Array<{ operation_id: string; status: string; error_message?: string | null }> | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchOperation(
  apiUrl: string,
  apiKey: string,
  bank: string,
  operationId: string,
): Promise<OperationStatusResponse | null> {
  try {
    const res = await fetch(
      `${apiUrl}/v1/default/banks/${bank}/operations/${operationId}`,
      { headers: authHeader(apiKey), signal: AbortSignal.timeout(5000) },
    );
    if (!res.ok) return null;
    return (await res.json()) as OperationStatusResponse;
  } catch {
    return null;
  }
}

/**
 * Fetch the current `memory_unit_count` for a document, or `null` if the
 * document does not exist yet (404) or the request failed.
 *
 * Used to snapshot pre/post unit counts around a retain, so we can detect the
 * genuine "substantial input → 0 facts extracted" failure mode without
 * relying on hindsight's inconsistent `result_metadata.unit_ids_count` field.
 */
async function fetchDocumentUnitsCount(
  apiUrl: string,
  apiKey: string,
  bank: string,
  documentId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<number | null> {
  try {
    const res = await fetchImpl(
      `${apiUrl}/v1/default/banks/${bank}/documents/${documentId}`,
      { headers: authHeader(apiKey), signal: AbortSignal.timeout(5000) } as any,
    );
    if (res.status === 404) return null;
    if (!res.ok) return null;
    const data = (await res.json()) as { memory_unit_count?: number };
    return typeof data.memory_unit_count === "number" ? data.memory_unit_count : null;
  } catch {
    return null;
  }
}

/**
 * Fetch the byte/char length of an existing document's `original_text`, or
 * `null` if the document does not exist yet (404) or the request failed.
 *
 * Used by `resolveSessionDocumentId` to decide whether to keep appending to
 * `session-<id>` or roll over to `session-<id>-<part>`. The server may
 * advertise the length directly via a `text_length` field; otherwise we fall
 * back to measuring `original_text.length` so this still works against older
 * hindsight builds.
 *
 * Note: in the fallback branch we download the full document body, which can
 * be ~500K chars for bloated sessions. That's an acceptable one-off per
 * retain because (a) it only fires when the live doc is already near the
 * rollover threshold, and (b) once we've rolled over, subsequent retains
 * probe the smaller part doc first and short-circuit on its lower length.
 */
async function fetchDocumentTextLength(
  apiUrl: string,
  apiKey: string,
  bank: string,
  documentId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<number | null> {
  try {
    const res = await fetchImpl(
      `${apiUrl}/v1/default/banks/${bank}/documents/${documentId}`,
      { headers: authHeader(apiKey), signal: AbortSignal.timeout(5000) } as any,
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

/**
 * Document rollover — cap individual session documents at ~80K chars so the
 * extraction LLM (gpt-oss-120b on Cerebras, 131K-token / ≈525K-char context)
 * never sees a doc large enough to overflow its window during retain.
 *
 * Observed in the wild before the cap: documents grew to 500K+ chars and
 * silently dropped to 0 extracted units (legal-ramod 544K / 0 units,
 * legal-mosquito 528K, project-Pi-Agent 443K). 80K is the conservative
 * default; tune via `HINDSIGHT_DOC_ROLLOVER_CHARS` env var.
 */
export const DEFAULT_DOC_ROLLOVER_CHARS = 80_000;
export function getDocRolloverThreshold(): number {
  const v = parseInt(process.env.HINDSIGHT_DOC_ROLLOVER_CHARS || "", 10);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_DOC_ROLLOVER_CHARS;
}

/**
 * Sanity cap on the number of parts we'll probe for a single session.
 * Each part holds up to threshold chars (80K default); 50 parts → 4 MB of
 * raw transcript per session, which is multiple full work-days of pi usage.
 * Beyond this we stop probing and append to the last part rather than
 * spinning forever.
 */
export const MAX_DOC_ROLLOVER_PARTS = 50;

/**
 * Resolve the right document_id for THIS retain against `bank`.
 *
 * Walks `session-<id>`, `session-<id>-2`, `…`, `session-<id>-N` and returns
 * the first part that either (a) does not exist yet (use it fresh) or
 * (b) is below `threshold` chars (append). If all `MAX_DOC_ROLLOVER_PARTS`
 * are full, returns the last part as a last-resort append target rather
 * than throwing — a still-functioning retain beats a hard failure.
 *
 * Network cost: at most one GET per probed part; we early-exit on the
 * first hit, so in steady state this is one round-trip.
 */
export async function resolveSessionDocumentId(
  apiUrl: string,
  apiKey: string,
  bank: string,
  sessionId: string,
  threshold: number,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const baseId = `session-${sessionId}`;
  for (let part = 1; part <= MAX_DOC_ROLLOVER_PARTS; part++) {
    const id = part === 1 ? baseId : `${baseId}-${part}`;
    const length = await fetchDocumentTextLength(apiUrl, apiKey, bank, id, fetchImpl);
    if (length === null) return id;       // 404 — part doesn't exist yet, use it
    if (length < threshold) return id;    // existing doc has room — append
    // otherwise continue probing the next part
  }
  return `${baseId}-${MAX_DOC_ROLLOVER_PARTS}`;
}

/**
 * Extract document_ids from a completed retain operation's `result_metadata`.
 * The value is consistently written by hindsight at completion (verified
 * against vectorize-io/hindsight:latest), unlike `unit_ids_count`.
 */
function extractDocumentIds(op: OperationStatusResponse): string[] {
  const ids = op.result_metadata?.document_ids;
  if (Array.isArray(ids)) return ids.filter((x): x is string => typeof x === "string");
  return [];
}

/**
 * Poll one operation until terminal status or POLL_MAX_ATTEMPTS attempts.
 * Returns the final OperationStatusResponse on terminal status, or null on timeout.
 */
async function pollOperationUntilTerminal(
  apiUrl: string,
  apiKey: string,
  bank: string,
  operationId: string,
): Promise<OperationStatusResponse | null> {
  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    await sleep(POLL_INTERVAL_MS);
    const op = await fetchOperation(apiUrl, apiKey, bank, operationId);
    if (!op) continue;
    if (op.status === "completed" || op.status === "failed" || op.status === "not_found") {
      return op;
    }
  }
  return null;
}

/**
 * Per-bank pre-retain snapshot. `documentId` is the session-level document we
 * are appending to; `preUnitsCount` is `memory_unit_count` BEFORE the retain.
 * `transcriptLen` is the length of the content we POSTed; it gates whether a
 * zero-delta result is treated as a likely extraction failure.
 */
export interface RetainSnapshot {
  documentId: string;
  preUnitsCount: number; // 0 if document didn't exist yet
  transcriptLen: number;
}

/**
 * Self-heal G1 — closure-stable payload carried into watchRetainOperation so
 * the zero-units gate can persist the full retain to disk and the drain can
 * re-POST without rebuilding from the (already-disposed) agent_end closure.
 *
 * Without this, the watcher only sees `transcriptLen` (a number); the actual
 * transcript text is unreachable by the time Phase D fires (see design doc
 * §1.2). Threading retainCtx is the load-bearing API change for G1.
 *
 * Type aliased to RetainContextShape from ./self-heal.ts so the gate
 * function (pure, pi-tui-free) and the watcher (in this file) share one
 * shape definition.
 */
export type RetainContext = RetainContextShape;

/**
 * Background task: poll a single retain operation and surface failures.
 * `t0` is `Date.now()` at the moment the retain POST returned HTTP 200.
 *
 * Surfaces two genuine error modes:
 *   1. status=failed                          → hindsight-retain-failed-async
 *   2. completed + substantial + delta == 0   → hindsight-retain-zero-units-extracted
 * Everything else stays silent (logs only).
 */
async function watchRetainOperation(
  pi: ExtensionAPI,
  ctx: any,
  config: ResolvedConfig,
  bank: string,
  operationId: string,
  t0: number,
  snapshot: RetainSnapshot,
  retainCtx?: RetainContext,
): Promise<void> {
  try {
    const op = await pollOperationUntilTerminal(config.api_url, config.api_key, bank, operationId);
    const op_age_ms = Date.now() - t0;

    if (!op) {
      // 120s elapsed and still pending — debug log only, no user notification.
      log(`retain-poll: timeout op=${operationId} bank=${bank} age_ms=${op_age_ms} status=pending`);
      return;
    }

    if (op.status === "failed") {
      const errMsg = op.error_message || "(no error_message)";
      log(`retain-poll: failed op=${operationId} bank=${bank} age_ms=${op_age_ms} error=${errMsg}`);
      try { ctx.ui.setStatus?.("hindsight", "⚠ retain failed"); } catch {}
      pi.sendMessage(
        {
          customType: "hindsight-retain-failed-async",
          content: "",
          display: true,
          details: { bank, operation_id: operationId, op_age_ms, error_message: errMsg },
        },
        { deliverAs: "nextTurn" },
      );
      return;
    }

    if (op.status === "not_found") {
      log(`retain-poll: not_found op=${operationId} bank=${bank} age_ms=${op_age_ms}`);
      return;
    }

    // status === "completed" — verify units were actually extracted by
    // delta-comparing the document's memory_unit_count to the pre-snapshot.
    // Prefer the document_id from the op's result_metadata, but fall back to
    // the snapshot's documentId so we cover the case where hindsight omitted
    // the field for one-shot retains.
    const opDocIds = extractDocumentIds(op);
    const docId = opDocIds.includes(snapshot.documentId)
      ? snapshot.documentId
      : (opDocIds[0] || snapshot.documentId);
    const postUnits = await fetchDocumentUnitsCount(config.api_url, config.api_key, bank, docId);

    if (postUnits === null) {
      // Document GET failed (network, 404 on a doc the op said it touched).
      // We can't compute delta — stay silent rather than risk false positives.
      log(`retain-poll: no-post-units op=${operationId} bank=${bank} age_ms=${op_age_ms} doc=${docId}`);
      return;
    }

    const delta = postUnits - snapshot.preUnitsCount;
    const substantial = snapshot.transcriptLen >= SUBSTANTIAL_TRANSCRIPT_CHARS;

    if (delta <= 0 && substantial) {
      // Two sub-paths inside the same gate:
      //   legit-empty: status=completed AND error_message is null — the LLM
      //               responded normally but extracted 0 claims. Informational,
      //               not actionable; common with strict extraction models.
      //   real-down:  error_message is non-null — the operation surfaced an
      //               error even though it ended up in `completed` state
      //               (rare but the only structural signal we have for an
      //               unhealthy LLM at the zero-units detection point).
      const legitEmpty = !op.error_message;
      log(`retain-poll: zero-units op=${operationId} bank=${bank} age_ms=${op_age_ms} doc=${docId} pre=${snapshot.preUnitsCount} post=${postUnits} transcript_len=${snapshot.transcriptLen} legit_empty=${legitEmpty}`);
      try { ctx.ui.setStatus?.("hindsight", legitEmpty ? "ℹ 0 facts extracted" : "⚠ 0 units extracted"); } catch {}
      try {
        const settings = loadSettings();
        // Suppress markUnhealthy on legit-empty: a normal LLM response with
        // 0 facts must NOT block subsequent turns under healthGate=block.
        if (!legitEmpty && settings.healthGate !== "off") markUnhealthy("zero units extracted");
        // Self-heal G1 — opt-in enqueue. Still runs on legit-empty: the queue's
        // drain re-POSTs later, and if the next attempt produces facts the
        // entry self-clears; if not, the awaiting-user alert eventually fires.
        const payload = buildSelfHealEnqueuePayload(bank, snapshot, settings.selfHeal.enabled, retainCtx);
        if (payload) {
          try {
            const entry = enqueueQueueEntry(payload, {
              maxQueueSize: settings.selfHeal.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE,
            });
            log(`self-heal: enqueued id=${entry.id} bank=${bank} doc=${snapshot.documentId} pre=${snapshot.preUnitsCount}`);
          } catch (e) { log(`self-heal: enqueue failed ${e}`); }
        }
      } catch (e) { log(`retain-poll: loadSettings failed ${e}`); }
      pi.sendMessage(
        {
          customType: "hindsight-retain-zero-units-extracted",
          content: "",
          display: true,
          details: {
            bank,
            operation_id: operationId,
            op_age_ms,
            document_id: docId,
            pre_units_count: snapshot.preUnitsCount,
            post_units_count: postUnits,
            transcript_len: snapshot.transcriptLen,
            error_message: op.error_message ?? null,
            legit_empty: legitEmpty,
          },
        },
        { deliverAs: "nextTurn" },
      );
      return;
    }

    if (delta <= 0 && !substantial) {
      // Legitimate zero-extraction — input was too trivial. Silent.
      log(`retain-poll: legit-zero op=${operationId} bank=${bank} age_ms=${op_age_ms} doc=${docId} pre=${snapshot.preUnitsCount} post=${postUnits} transcript_len=${snapshot.transcriptLen}`);
      return;
    }

    log(`retain-poll: ok op=${operationId} bank=${bank} age_ms=${op_age_ms} doc=${docId} pre=${snapshot.preUnitsCount} post=${postUnits} delta=${delta}`);
    // Change 1b: real success (postUnits > preUnits) heals unhealthy state.
    // Covers the async-completion path where the POST returned 200 but units
    // only appeared after the watcher polled — the synchronous markHealthy()
    // in agent_end already fires on POST, but if a prior turn poisoned the
    // flag between the POST and this watcher resolving, we re-clear it here.
    markHealthy();
  } catch (e) {
    log(`retain-poll: watcher error op=${operationId} bank=${bank} ${e}`);
  }
}

/**
 * Build the per-bank pre-retain snapshot of `memory_unit_count` for a given
 * document. Runs all GETs in parallel; banks that 404 or fail map to 0
 * (which is exactly the legitimate pre-count for a brand-new document).
 *
 * Extracted as a helper so the agent_end handler stays linear and so the
 * snapshot logic is unit-testable without driving the full extension lifecycle.
 */
async function buildPreRetainSnapshot(
  apiUrl: string,
  apiKey: string,
  banks: string[],
  documentId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const results = await Promise.allSettled(
    banks.map(async (b) => {
      const n = await fetchDocumentUnitsCount(apiUrl, apiKey, b, documentId, fetchImpl);
      return { bank: b, count: n ?? 0 };
    }),
  );
  for (const r of results) {
    if (r.status === "fulfilled") out.set(r.value.bank, r.value.count);
  }
  // Ensure every requested bank has an entry even if Promise.allSettled
  // gave us a rejection (defensive — Promise.allSettled rejection should
  // not happen since our mapper already swallows errors via fetchDocumentUnitsCount).
  for (const b of banks) {
    if (!out.has(b)) out.set(b, 0);
  }
  return out;
}

// Export internals for unit testing without recreating them in test files.
export const __internal = {
  fetchDocumentUnitsCount,
  fetchDocumentTextLength,
  extractDocumentIds,
  watchRetainOperation,
  buildPreRetainSnapshot,
  drainQueue,
  loadAwaitingUserAlertState,
  saveAwaitingUserAlertState,
};

// ─── Self-heal G1: drain + alert state ────────────────────────────────────
//
// Drain is event-driven (session_start + post-successful-retain). No
// setInterval — the user mandated this. Per-entry concurrency is bounded at
// 3 so a deep queue does not block session_start past its existing budget.
//
// Awaiting-user alert state persists in ~/.hindsight/self_heal_alert_state.json
// so the alert fires ONCE per count-change across pi restarts.

const SELF_HEAL_ALERT_STATE_PATH = join(homedir(), ".hindsight", "self_heal_alert_state.json");
const DRAIN_CONCURRENCY = 3;

export interface AwaitingUserAlertState {
  lastAlertedCount: number;
  alertedAt?: string; // ISO
}

export function loadAwaitingUserAlertState(): AwaitingUserAlertState {
  try {
    if (existsSync(SELF_HEAL_ALERT_STATE_PATH)) {
      const raw = readFileSync(SELF_HEAL_ALERT_STATE_PATH, "utf-8");
      const obj = JSON.parse(raw);
      if (obj && typeof obj.lastAlertedCount === "number") return obj as AwaitingUserAlertState;
    }
  } catch { /* fall through to default */ }
  return { lastAlertedCount: 0 };
}

export function saveAwaitingUserAlertState(s: AwaitingUserAlertState): void {
  try {
    mkdirSync(dirname(SELF_HEAL_ALERT_STATE_PATH), { recursive: true });
    const tmp = `${SELF_HEAL_ALERT_STATE_PATH}.tmp`;
    writeFileSync(tmp, JSON.stringify(s, null, 2));
    renameSync(tmp, SELF_HEAL_ALERT_STATE_PATH);
  } catch (e) { log(`self-heal: alert state write failed ${e}`); }
}

/**
 * Self-heal G1 drain. Pure-ish: takes API + bank coords, queue dir override,
 * and a `pi` + `ctx` for the alert sendMessage. Returns metrics for tests.
 *
 * Per entry (in concurrency-bounded parallel):
 *   1. fetchDocumentUnitsCount(documentId) > preUnitsCount
 *      → success path: another retain already grew the doc (or this one
 *        eventually did). Delete entry, count as recovered.
 *   2. Else: re-POST /memories with the original transcript/tags/context.
 *      → markAttempted(false, error). nextBackoffMs(attempts) drives next wait.
 *      When nextBackoffMs returns null → markAwaitingUser(id).
 *
 * After the loop, compares countAwaitingUser to the persisted alert state.
 * If it CHANGED, fire `hindsight-self-heal-awaiting` exactly once.
 */
interface DrainResult {
  drained: number;          // # entries inspected
  recovered: number;        // # deleted because doc grew
  reposted: number;         // # entries POSTed (success or fail)
  failed: number;           // # POST failures
  newAwaiting: number;      // # newly transitioned to awaiting-user this drain
  totalAwaiting: number;    // # awaiting-user after drain
  alertFired: boolean;
}

async function drainQueue(
  apiUrl: string,
  apiKey: string,
  opts: {
    pi?: ExtensionAPI;
    ctx?: any;
    settings?: HindsightSettings;
    fetchImpl?: typeof fetch;
    now?: () => number;
    queueOptions?: QueueOptions;
  } = {},
): Promise<DrainResult> {
  const result: DrainResult = {
    drained: 0, recovered: 0, reposted: 0, failed: 0,
    newAwaiting: 0, totalAwaiting: 0, alertFired: false,
  };
  // Gate check — read settings FRESH every call so flipping off mid-session
  // stops auto-drain immediately.
  const settings = opts.settings ?? loadSettings();
  if (!settings.selfHeal.enabled) return result;

  const fetchImpl = opts.fetchImpl ?? fetch;
  const schedule = settings.selfHeal.backoffSchedule ?? BACKOFF_SCHEDULE_MS;
  const queueOpts: QueueOptions = { ...(opts.queueOptions ?? {}), now: opts.now, schedule };

  const due = dueQueueEntries(queueOpts);
  result.drained = due.length;
  if (!due.length) {
    // Still need to check awaiting-user count for alert state changes — e.g.
    // a previous session left entries parked; this session's start should
    // surface the alert if it hasn't been shown yet.
    result.totalAwaiting = countQueueAwaitingUser(queueOpts);
    maybeFireAwaitingUserAlert(result, opts.pi, opts.ctx);
    return result;
  }
  log(`self-heal: drain start due=${due.length} concurrency=${DRAIN_CONCURRENCY}`);

  // Bounded concurrency via a simple worker pool.
  let idx = 0;
  const workers: Promise<void>[] = [];
  const drainOne = async (entry: QueueEntry): Promise<void> => {
    // Re-check settings INSIDE the worker so a mid-drain toggle off stops
    // outstanding workers from doing further network work.
    const live = loadSettings();
    if (!live.selfHeal.enabled) return;

    // Step 1: dedup-by-document-growth. If the document grew vs the
    // pre-failure snapshot, a successful retain already happened (either
    // this entry's original op completed late, or a follow-up turn). Delete
    // without re-POSTing to avoid double-chunking.
    let postUnits: number | null = null;
    try {
      postUnits = await fetchDocumentUnitsCount(apiUrl, apiKey, entry.bank, entry.documentId, fetchImpl);
    } catch { /* treat as null → fall through to re-POST */ }
    if (postUnits !== null && postUnits > entry.preUnitsCount) {
      log(`self-heal: drain id=${entry.id} bank=${entry.bank} recovered (doc grew ${entry.preUnitsCount}→${postUnits})`);
      markQueueAttempted(entry.id, true, undefined, queueOpts);
      result.recovered += 1;
      return;
    }

    // Step 2: re-POST.
    let ok = false; let err: string | undefined;
    try {
      const res = await fetchImpl(`${apiUrl}/v1/default/banks/${entry.bank}/memories`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader(apiKey) },
        body: JSON.stringify({
          items: [{
            content: entry.transcript,
            document_id: entry.documentId,
            update_mode: "append",
            context: entry.context,
            timestamp: new Date().toISOString(),
            ...(entry.tags?.length ? { tags: entry.tags } : {}),
          }],
          async: true,
        }),
        signal: AbortSignal.timeout(8000),
      } as any);
      ok = res.ok;
      if (!ok) err = `HTTP ${res.status}`;
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    }
    result.reposted += 1;
    if (ok) {
      // POST accepted. Treat the entry as still pending the next growth
      // check (POST 200 just means async work was queued server-side). Mark
      // as attempted-with-no-growth-yet so the next drain pass will either
      // see the growth (→ recover) or repost.
      markQueueAttempted(entry.id, false, "reposted, awaiting outcome", queueOpts);
    } else {
      result.failed += 1;
      markQueueAttempted(entry.id, false, err ?? "unknown", queueOpts);
    }

    // Budget exhaustion check: if nextBackoffMs(new attempts) returned null,
    // the markAttempted parked nextRetryAt at MAX_SAFE_INTEGER. Promote to
    // explicit awaiting-user terminal state so the alert layer can fire.
    const nextWait = nextBackoffMs(entry.attempts + 1, schedule);
    if (nextWait === null) {
      markQueueAwaitingUser(entry.id, queueOpts);
      result.newAwaiting += 1;
      log(`self-heal: drain id=${entry.id} bank=${entry.bank} → awaiting-user (attempts=${entry.attempts + 1})`);
    }
  };

  // Spin up DRAIN_CONCURRENCY workers, each pulling from `due` until empty.
  for (let w = 0; w < Math.min(DRAIN_CONCURRENCY, due.length); w++) {
    workers.push((async () => {
      while (true) {
        const my = idx++;
        if (my >= due.length) return;
        try { await drainOne(due[my]); } catch (e) { log(`self-heal: worker error ${e}`); }
      }
    })());
  }
  await Promise.all(workers);

  result.totalAwaiting = countQueueAwaitingUser(queueOpts);
  maybeFireAwaitingUserAlert(result, opts.pi, opts.ctx);
  log(`self-heal: drain end drained=${result.drained} recovered=${result.recovered} reposted=${result.reposted} failed=${result.failed} newAwaiting=${result.newAwaiting} totalAwaiting=${result.totalAwaiting}`);
  return result;
}

/**
 * Awaiting-user alert: fire ONCE per count-change. Persists last-alerted
 * count to disk so subsequent pi sessions don't re-spam.
 */
function maybeFireAwaitingUserAlert(result: DrainResult, pi?: ExtensionAPI, ctx?: any): void {
  const state = loadAwaitingUserAlertState();
  const current = result.totalAwaiting;
  if (current === state.lastAlertedCount) return;
  // Count changed (either up or down). Update state + fire only when count > 0.
  saveAwaitingUserAlertState({ lastAlertedCount: current, alertedAt: new Date().toISOString() });
  if (current === 0) {
    // Awaiting count dropped to zero (user dismissed / drained manually).
    // Don't spam a recovery alert here — just reset state silently.
    log(`self-heal: awaiting count cleared (was ${state.lastAlertedCount})`);
    try { ctx?.ui?.setStatus?.("hindsight", undefined); } catch {}
    return;
  }
  result.alertFired = true;
  // Compute oldest awaiting-user age (for the user message).
  const all = listQueueEntries();
  const oldest = all.filter(e => e.awaitingUser).sort((a, b) => a.createdAt - b.createdAt)[0];
  const oldestAge = oldest ? Math.max(0, Date.now() - oldest.createdAt) : 0;
  try { ctx?.ui?.setStatus?.("hindsight", `⚠ Hindsight: ${current} awaiting manual retry`); } catch {}
  try {
    pi?.sendMessage?.(
      {
        customType: "hindsight-self-heal-awaiting",
        content: "",
        display: true,
        details: { count: current, oldestAgeMs: oldestAge },
      },
      { deliverAs: "nextTurn" },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("stale after session replacement or reload")) throw err;
  }
  log(`self-heal: alert fired count=${current} oldestAgeMs=${oldestAge}`);
}

// ─── Helpers ─────────────────────────────────────────────────────────────

const OPERATIONAL_TOOLS = new Set([
  "bash", "nu", "process", "read", "write", "edit",
  "grep", "ast_grep_search", "ast_grep_replace", "lsp_navigation",
]);

interface HookStats {
  firedAt?: string;
  result?: "ok" | "failed" | "skipped";
  detail?: string;
}

const hookStats: Record<string, HookStats> = { sessionStart: {}, recall: {}, retain: {} };

// ─── Phase C: Settings + Health Gate ─────────────────────────────────────
//
// User-tunable robustness knobs. Sources (in priority order, last wins):
//   1. ~/.pi/agent/hindsight.json   (preferred — pi-wide)
//   2. .hindsight/config.toml       (already loaded via resolveConfig; legacy
//                                    flat keys: health_gate, recall_retry_*)
//
// Defaults are backwards-compatible with pre-Phase C behavior:
//   - healthGate="warn" (current behavior — status only)
//   - retries=3, backoffMs=1000
//   - recallTimeoutMs=5000 (bumped from 2000 — root cause of ⚠ retrying)
//
// Health gate semantics:
//   off   → never blocks, never warns. Status bar still reflects errors.
//   warn  → status bar only (DEFAULT — current behavior).
//   block → mark hindsight UNHEALTHY on:
//             (a) zero-units extracted retain (substantial input → 0 facts)
//             (b) all-auth-failed recall
//             (c) recall exhausted retries without success
//           …then on next before_agent_start, call ctx.abort() and inject
//           a sentinel message instructing the user to fix or override.
//           Cleared by: /hindsight reset, or a subsequent successful recall.

export type HealthGate = "off" | "warn" | "block";

// TopicShiftRecallSettings / TopicShiftHeuristic / normalizeHeuristic /
// DEFAULT_TOPIC_SHIFT_SETTINGS / TOPIC_SHIFT_TRIGGER_RE / shouldRecall /
// jaccardSimilarity / tokenizeForJaccard are imported from ./heuristic.ts
// in the Phase F section further down and re-exported there.
import type { TopicShiftRecallSettings as _TSR } from "./heuristic.ts";
type TopicShiftRecallSettings = _TSR;

/**
 * Self-heal G1 — opt-in persistent retry queue for Phase D zero-units failures.
 * Default: OFF. Toggling on enables enqueue/drain/alert paths.
 */
export type SelfHealConfig = _SelfHealConfig;

export interface HindsightSettings {
  healthGate: HealthGate;
  recallRetry: { attempts: number; backoffMs: number };
  recallTimeoutMs: number;
  topicShiftRecall: TopicShiftRecallSettings;
  selfHeal: SelfHealConfig;
}
export type { TopicShiftRecallSettings };

export const DEFAULT_SETTINGS: HindsightSettings = {
  healthGate: "warn",
  recallRetry: { attempts: 3, backoffMs: 1000 },
  recallTimeoutMs: 5000,
  topicShiftRecall: {
    // Backwards-compatible-by-thresholds: enabled on, but conservative knobs.
    // Same-topic multi-turn conversations stay above the 0.2 jaccard floor,
    // and the 60s cooldown prevents over-firing even on a sudden shift.
    enabled: true,
    heuristic: "hybrid",
    cooldownSeconds: 60,
    everyNTurns: 8,
    jaccardThreshold: 0.2,
  },
  selfHeal: {
    // OFF BY DEFAULT — G1 ships as beta opt-in. Must not change existing
    // behavior for users who don't explicitly turn it on.
    enabled: false,
  },
};

const SETTINGS_PATH = join(homedir(), ".pi", "agent", "hindsight.json");

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

export function normalizeHealthGate(v: unknown): HealthGate {
  return v === "off" || v === "block" || v === "warn" ? v : DEFAULT_SETTINGS.healthGate;
}

// normalizeHeuristic is imported from ./heuristic.ts further down.
function clampFloat(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/**
 * Merge raw JSON / TOML overrides into a defaulted HindsightSettings shape.
 * Exported for direct unit testing.
 */
export function buildSettings(
  jsonOverride: Partial<HindsightSettings> | null,
  tomlOverride: Record<string, string> | null,
): HindsightSettings {
  const base: HindsightSettings = {
    healthGate: DEFAULT_SETTINGS.healthGate,
    recallRetry: { ...DEFAULT_SETTINGS.recallRetry },
    recallTimeoutMs: DEFAULT_SETTINGS.recallTimeoutMs,
    topicShiftRecall: { ...DEFAULT_SETTINGS.topicShiftRecall },
    selfHeal: { ...DEFAULT_SETTINGS.selfHeal },
  };
  if (jsonOverride) {
    if (jsonOverride.healthGate !== undefined) base.healthGate = normalizeHealthGate(jsonOverride.healthGate);
    if (jsonOverride.recallRetry) {
      base.recallRetry.attempts = clampInt(jsonOverride.recallRetry.attempts, 1, 10, base.recallRetry.attempts);
      base.recallRetry.backoffMs = clampInt(jsonOverride.recallRetry.backoffMs, 0, 60_000, base.recallRetry.backoffMs);
    }
    if (jsonOverride.recallTimeoutMs !== undefined) {
      base.recallTimeoutMs = clampInt(jsonOverride.recallTimeoutMs, 500, 60_000, base.recallTimeoutMs);
    }
    if (jsonOverride.topicShiftRecall) {
      const ts = jsonOverride.topicShiftRecall;
      if (typeof ts.enabled === "boolean") base.topicShiftRecall.enabled = ts.enabled;
      if (ts.heuristic !== undefined) base.topicShiftRecall.heuristic = normalizeHeuristic(ts.heuristic);
      if (ts.cooldownSeconds !== undefined) base.topicShiftRecall.cooldownSeconds = clampInt(ts.cooldownSeconds, 0, 24 * 3600, base.topicShiftRecall.cooldownSeconds);
      if (ts.everyNTurns !== undefined) base.topicShiftRecall.everyNTurns = clampInt(ts.everyNTurns, 1, 1000, base.topicShiftRecall.everyNTurns);
      if (ts.jaccardThreshold !== undefined) base.topicShiftRecall.jaccardThreshold = clampFloat(ts.jaccardThreshold, 0, 1, base.topicShiftRecall.jaccardThreshold);
    }
    if (jsonOverride.selfHeal) {
      if (typeof jsonOverride.selfHeal.enabled === "boolean") base.selfHeal.enabled = jsonOverride.selfHeal.enabled;
      if (Array.isArray(jsonOverride.selfHeal.backoffSchedule)) base.selfHeal.backoffSchedule = [...jsonOverride.selfHeal.backoffSchedule];
      if (typeof jsonOverride.selfHeal.maxQueueSize === "number") base.selfHeal.maxQueueSize = clampInt(jsonOverride.selfHeal.maxQueueSize, 1, 10_000, DEFAULT_MAX_QUEUE_SIZE);
    }
  }
  if (tomlOverride) {
    if (tomlOverride.health_gate !== undefined) base.healthGate = normalizeHealthGate(tomlOverride.health_gate);
    if (tomlOverride.recall_retry_attempts !== undefined) {
      base.recallRetry.attempts = clampInt(tomlOverride.recall_retry_attempts, 1, 10, base.recallRetry.attempts);
    }
    if (tomlOverride.recall_retry_backoff_ms !== undefined) {
      base.recallRetry.backoffMs = clampInt(tomlOverride.recall_retry_backoff_ms, 0, 60_000, base.recallRetry.backoffMs);
    }
    if (tomlOverride.recall_timeout_ms !== undefined) {
      base.recallTimeoutMs = clampInt(tomlOverride.recall_timeout_ms, 500, 60_000, base.recallTimeoutMs);
    }
    // [self_heal] section — the parseToml emits sectioned keys as `<section>_<key>`.
    if (tomlOverride.self_heal_enabled !== undefined) {
      base.selfHeal.enabled = normalizeBool(tomlOverride.self_heal_enabled, base.selfHeal.enabled);
    }
    if (tomlOverride.self_heal_max_queue_size !== undefined) {
      base.selfHeal.maxQueueSize = clampInt(tomlOverride.self_heal_max_queue_size, 1, 10_000, DEFAULT_MAX_QUEUE_SIZE);
    }
  }
  return base;
}

// `normalizeBool` and `writeSelfHealEnabledToml` are imported from
// ./self-heal.ts at the top of this file and re-exported there.
// Keeping them in a pi-tui-free module lets the integration tests exercise
// the SAME functions the extension runs without dragging the peer-dep.

function loadSettings(): HindsightSettings {
  let json: Partial<HindsightSettings> | null = null;
  try {
    if (existsSync(SETTINGS_PATH)) {
      json = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8")) as Partial<HindsightSettings>;
    }
  } catch (e) {
    log(`settings: failed to parse ${SETTINGS_PATH}: ${e}`);
  }
  // TOML keys come from resolveConfig() via the same flat parser.
  // We re-parse the merged TOML chain here so settings can override per-project.
  let toml: Record<string, string> | null = null;
  try {
    const configs: Record<string, string>[] = [];
    let dir = process.cwd();
    while (true) {
      const cfg = parseToml(join(dir, ".hindsight", "config.toml"));
      if (Object.keys(cfg).length) configs.push(cfg);
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    configs.reverse();
    const userCfg = parseToml(join(homedir(), ".hindsight", "config.toml"));
    if (Object.keys(userCfg).length) configs.unshift(userCfg);
    const merged: Record<string, string> = {};
    for (const cfg of configs) Object.assign(merged, cfg);
    if (Object.keys(merged).length) toml = merged;
  } catch { /* fall through to defaults */ }
  return buildSettings(json, toml);
}

// Module-level health state. Reset on session_start, mutated by retain watcher
// and recall handler. Process-wide (intentionally — one bad hindsight session
// poisons all in-flight pi sessions for the same pgdata).
interface HealthState {
  healthy: boolean;
  reason?: string;
  markedAt?: string;
}
const healthState: HealthState = { healthy: true };

export function markUnhealthy(reason: string): void {
  if (healthState.healthy) {
    healthState.healthy = false;
    healthState.reason = reason;
    healthState.markedAt = new Date().toISOString();
    log(`health: marked UNHEALTHY (${reason})`);
  }
}

export function markHealthy(): void {
  if (!healthState.healthy) {
    log(`health: clearing UNHEALTHY (was: ${healthState.reason})`);
  }
  healthState.healthy = true;
  healthState.reason = undefined;
  healthState.markedAt = undefined;
}

export function getHealthState(): Readonly<HealthState> {
  return healthState;
}

// Module-level rate-limit timestamp for the passive health re-probe (Change 2).
// Reset on session_start so a fresh pi process re-probes immediately if it
// inherits an unhealthy mark via a stale config-derived assumption (it can't
// today — healthState is module-scoped — but keeping reset symmetric with
// resetRecallState() is cheap and future-proof).
let lastHealthProbeAt = 0;
export function __resetLastHealthProbeAtForTests(): void { lastHealthProbeAt = 0; }
export function __getLastHealthProbeAtForTests(): number { return lastHealthProbeAt; }

/**
 * Passive, non-blocking, rate-limited health re-probe (Change 2 of the
 * auto-recover fix). Fires from the `input` hook ONLY while unhealthy and
 * no more often than once every `HEALTH_PROBE_RATE_LIMIT_MS`. On a 200 from
 * `/health`, clears the unhealthy flag and resets recall state so the next
 * recall can fire fresh. NOT gated by healthGate — its purpose is to be the
 * recovery path under healthGate=block, where recall itself is blocked.
 *
 * Intentionally swallows all errors: this is an opportunistic probe, not a
 * health check the caller cares about. Returns the action it took for tests.
 */
export const HEALTH_PROBE_RATE_LIMIT_MS = 10_000;
export const HEALTH_PROBE_TIMEOUT_MS = 1500;

export async function healthProbe(
  apiUrl: string,
  onCleared: () => void,
  now: () => number = Date.now,
  fetchImpl: typeof fetch = fetch,
): Promise<"skipped-healthy" | "skipped-ratelimit" | "cleared" | "still-unhealthy"> {
  if (healthState.healthy) return "skipped-healthy";
  const t = now();
  if (t - lastHealthProbeAt < HEALTH_PROBE_RATE_LIMIT_MS) return "skipped-ratelimit";
  lastHealthProbeAt = t;
  try {
    const res = await fetchImpl(`${apiUrl}/health`, { signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS) });
    if (res.ok) {
      log(`health-probe: hindsight reachable — clearing unhealthy state (was: ${healthState.reason})`);
      markHealthy();
      onCleared();
      return "cleared";
    }
    log(`health-probe: HTTP ${res.status} — staying unhealthy`);
    return "still-unhealthy";
  } catch (e) {
    log(`health-probe: error ${e} — staying unhealthy`);
    return "still-unhealthy";
  }
}

/**
 * Per-call recall with retry + circuit-breaker for a single bank.
 * Exported for direct unit testing.
 *
 * Returns:
 *   { outcome: "ok", data }      — HTTP 200, body parsed
 *   { outcome: "empty-ok" }       — HTTP 200 but server unreachable from JSON
 *   { outcome: "auth-failed" }    — HTTP 401/403, NOT retried
 *   { outcome: "error" }          — exhausted retries, last error type recorded
 *
 * Retries on: timeout, network error (TypeError/AbortError), HTTP 5xx.
 * Does not retry on: 4xx other than 408/429.
 */
export type RecallBankOutcome =
  | { outcome: "ok"; data: { results?: Array<{ text: string }> } }
  | { outcome: "auth-failed"; status: number }
  | { outcome: "error"; attempts: number; lastErrorKind: string };

export interface RecallRetryOpts {
  attempts: number;
  backoffMs: number;
  timeoutMs: number;
}

function classifyError(e: unknown): string {
  if (e instanceof Error) {
    if (e.name === "TimeoutError" || e.name === "AbortError") return "timeout";
    if (/ECONNREFUSED|ECONNRESET|EAI_AGAIN|ENOTFOUND|fetch failed/.test(e.message)) return "network";
    return e.name || "error";
  }
  return "unknown";
}

export async function recallBankWithRetry(
  apiUrl: string,
  apiKey: string,
  bank: string,
  body: unknown,
  opts: RecallRetryOpts,
  fetchImpl: typeof fetch = fetch,
  sleepImpl: (ms: number) => Promise<void> = sleep,
): Promise<RecallBankOutcome> {
  let lastErrorKind = "none";
  for (let attempt = 1; attempt <= Math.max(1, opts.attempts); attempt++) {
    try {
      const res = await fetchImpl(`${apiUrl}/v1/default/banks/${bank}/memories/recall`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader(apiKey) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
      if (res.status === 401 || res.status === 403) {
        return { outcome: "auth-failed", status: res.status };
      }
      if (res.ok) {
        let data: any = { results: [] };
        try { data = await res.json(); } catch { /* tolerate empty body */ }
        return { outcome: "ok", data };
      }
      // 5xx / 408 / 429 → retry; other 4xx → give up.
      const retryable = res.status >= 500 || res.status === 408 || res.status === 429;
      lastErrorKind = `http-${res.status}`;
      if (!retryable) {
        return { outcome: "error", attempts: attempt, lastErrorKind };
      }
    } catch (e) {
      lastErrorKind = classifyError(e);
    }
    if (attempt < opts.attempts) {
      // exponential backoff with cap
      const wait = Math.min(opts.backoffMs * Math.pow(2, attempt - 1), 30_000);
      await sleepImpl(wait);
    }
  }
  return { outcome: "error", attempts: opts.attempts, lastErrorKind };
}

// ─── Phase F: Topic-Shift Heuristic ─────────────────────────────────────
// Pure decision policy + types live in ./heuristic.ts (re-exported at top of
// file so existing imports of these symbols from "pi-ironin-hindsight" keep
// working). See heuristic.ts for the decision rules and rationale.

// ─── Extension ───────────────────────────────────────────────────────────

const MAX_RECALL_ATTEMPTS = 3;
const authHeader = (key: string) => ({ "Authorization": `Bearer ${key || ""}` });

export default function hindsightExtension(pi: ExtensionAPI) {
  // Phase F state machine. `recallEverFired` replaces the strict
  // once-per-session `recallDone` gate from Phase E; we now also track when
  // and on what prompt the last successful recall happened so the topic-shift
  // heuristic (shouldRecall) can decide whether to re-fire on later turns.
  let recallEverFired = false;
  let recallAttempts = 0;        // attempts within the current decision window
  let lastRecallPrompt = "";     // the prompt that triggered the last successful recall
  let lastRecallAt = 0;          // Date.now() of last successful recall, 0 = never
  let turnsSinceLastRecall = 0;  // user turns observed since last successful recall
  let currentPrompt = "";

  function resetRecallState(): void {
    recallEverFired = false;
    recallAttempts = 0;
    lastRecallPrompt = "";
    lastRecallAt = 0;
    turnsSinceLastRecall = 0;
  }

  pi.on("input", async (event) => {
    currentPrompt = event.input ?? event.text ?? currentPrompt;
    // Passive auto-recovery (Change 2): if a prior turn marked unhealthy,
    // try a cheap GET /health every HEALTH_PROBE_RATE_LIMIT_MS. Fire-and-forget
    // so it never blocks user input. Not gated by healthGate — this is the
    // recovery path under healthGate=block where recall itself is suppressed.
    if (!healthState.healthy) {
      const cfg = resolveConfig(process.cwd());
      if (cfg?.api_url) {
        void healthProbe(cfg.api_url, resetRecallState).catch(() => {});
      }
    }
  });

  // ─── Session lifecycle ─────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    // Change 3: session_start clears unhealthy AND recall state — makes a
    // fresh session equivalent to /hindsight reset. If the underlying problem
    // is real (hindsight still down), the next recall/retain will re-mark
    // unhealthy within one turn; we are not hiding genuine failures, only
    // clearing stale module-state from a transient blip that already passed.
    markHealthy();
    lastHealthProbeAt = 0;
    resetRecallState();
    hookStats.sessionStart = { firedAt: new Date().toISOString(), result: "ok" };
    hookStats.recall = {};
    hookStats.retain = {};

    const config = resolveConfig(process.cwd());
    if (!config) {
      ctx.ui.setStatus("hindsight", undefined);
      return;
    }

    // Verify server
    try {
      const health = await fetch(`${config.api_url}/health`, { signal: AbortSignal.timeout(2000) });
      if (!health.ok) { ctx.ui.setStatus("hindsight", `✗ server HTTP ${health.status}`); return; }
    } catch { ctx.ui.setStatus("hindsight", "✗ unreachable"); return; }

    // Verify bank auth
    const bank = getActiveBank(config);
    if (bank) {
      try {
        const res = await fetch(`${config.api_url}/v1/default/banks/${bank}/profile`, { headers: authHeader(config.api_key), signal: AbortSignal.timeout(2000) });
        if (res.status === 401 || res.status === 403) { ctx.ui.setStatus("hindsight", "✗ auth error"); return; }
        ctx.ui.setStatus("hindsight", `🧠 ${bank}`);
      } catch { ctx.ui.setStatus("hindsight", "✗ bank unreachable"); }
    } else {
      log("session_start: no bank_id — extension inactive");
    }

    // ─── Self-heal G1: drain queue (opt-in) ───────────────────────────────
    // Fire-and-forget after the server + bank probes succeed. Default OFF;
    // never runs unless settings.selfHeal.enabled is true. Failures are
    // logged but never propagate.
    try {
      const settings = loadSettings();
      if (settings.selfHeal.enabled) {
        void drainQueue(config.api_url, config.api_key, { pi, ctx, settings })
          .catch(e => log(`self-heal: session_start drain error ${e}`));
      }
    } catch (e) { log(`self-heal: session_start gate error ${e}`); }
  });

  pi.on("session_compact", async () => {
    resetRecallState();
    log("session_compact: recall state reset");
  });

  // ─── Message Renderers ─────────────────────────────────────────────

  pi.registerMessageRenderer("hindsight-recall", (msg, opt, theme) => {
    const count = (msg.details as any)?.count ?? 0;
    const snippet = (msg.details as any)?.snippet ?? "";
    const memories: string[] = (msg.details as any)?.memories ?? [];
    let t = theme.fg("accent", "🧠 Hindsight");
    t += theme.fg("muted", ` recalled ${count} ${count === 1 ? "memory" : "memories"}`);
    if (!opt?.expanded) t += theme.fg("muted", "  ‣ ctrl+o");
    if (snippet) t += "\n" + theme.fg("dim", snippet);
    // Expanded: show full memory list (no truncation)
    if (opt?.expanded && memories.length) {
      t += "\n";
      for (const mem of memories) {
        t += "\n" + theme.fg("dim", "  " + mem.split("\n").join("\n  "));
      }
    }
    return new Text(t, 0, 0);
  });

  pi.registerMessageRenderer("hindsight-retain", (msg, opt, theme) => {
    const banks: string[] = (msg.details as any)?.banks ?? [];
    const transcript = (msg.details as any)?.transcript ?? "";
    let t = theme.fg("accent", "💾 Hindsight");
    t += theme.fg("muted", " saved turn to memory");
    if (banks.length) t += theme.fg("dim", ` → ${banks.join(", ")}`);
    if (!opt?.expanded) t += theme.fg("muted", "  ‣ ctrl+o");
    // Expanded: show the full transcript that was saved (no truncation)
    if (opt?.expanded && transcript) {
      t += "\n" + theme.fg("dim", "  " + transcript.split("\n").join("\n  "));
    }
    return new Text(t, 0, 0);
  });

  pi.registerMessageRenderer("hindsight-retain-failed", (_msg, _opt, theme) => {
    let t = theme.fg("error", "💾 Hindsight");
    t += theme.fg("muted", " retain failed — use ");
    t += theme.fg("accent", "hindsight_retain");
    t += theme.fg("muted", " to save manually");
    return new Text(t, 0, 0);
  });

  pi.registerMessageRenderer("hindsight-retain-zero-units-extracted", (msg, _opt, theme) => {
    const d = (msg.details as any) ?? {};
    // legit_empty true  → LLM responded normally with 0 facts. Informational.
    // legit_empty false → operation surfaced error_message → likely LLM-down.
    const legitEmpty = d.legit_empty === true;
    // theme.fg color choice: pi-tui's ThemeColor enum has no "info" entry, so
    // we use "accent" — the canonical neutral highlight color used elsewhere
    // in this renderer (e.g. /hindsight retry callouts) — to visually distinguish
    // legit-empty (informational) from real-down (warning).
    let t = legitEmpty
      ? theme.fg("accent", "ℹ Hindsight") + theme.fg("muted", ": 0 facts extracted")
      : theme.fg("warning", "⚠ Hindsight") + theme.fg("muted", " retain completed but added 0 units");
    if (d.bank) t += theme.fg("dim", ` → ${d.bank}`);
    if (typeof d.op_age_ms === "number") t += theme.fg("dim", ` (${Math.round(d.op_age_ms / 1000)}s)`);
    if (typeof d.transcript_len === "number") t += theme.fg("dim", ` [${d.transcript_len} chars in]`);
    if (legitEmpty) {
      t += "\n" + theme.fg("dim", "  LLM responded normally — content may simply lack extractable claims.");
      t += "\n" + theme.fg("dim", "  No action needed unless this persists across substantive retains.");
    } else {
      t += "\n" + theme.fg("dim", "  Substantial input + LLM error → extraction LLM may be unhealthy.");
      t += "\n" + theme.fg("dim", "  Check `docker logs hindsight --tail 50` and `~/Work/llm-mode.sh status`.");
      if (d.error_message) t += "\n" + theme.fg("dim", `  ${String(d.error_message).slice(0, 300)}`);
    }
    return new Text(t, 0, 0);
  });

  pi.registerMessageRenderer("hindsight-blocked", (msg, _opt, theme) => {
    const d = (msg.details as any) ?? {};
    let t = theme.fg("error", "✗ Hindsight blocked");
    if (d.reason) t += theme.fg("muted", ` — ${d.reason}`);
    t += "\n" + theme.fg("dim", "  Turn aborted (healthGate=block). Run /hindsight reset after fixing upstream,");
    t += "\n" + theme.fg("dim", "  or set hindsight.healthGate=\"warn\" in ~/.pi/agent/hindsight.json.");
    return new Text(t, 0, 0);
  });

  pi.registerMessageRenderer("hindsight-self-heal-awaiting", (msg, _opt, theme) => {
    const d = (msg.details as any) ?? {};
    const n = typeof d.count === "number" ? d.count : 0;
    const ageMs = typeof d.oldestAgeMs === "number" ? d.oldestAgeMs : 0;
    const ageMin = Math.round(ageMs / 60_000);
    let t = theme.fg("warning", "⚠ Hindsight self-heal");
    t += theme.fg("muted", ` — ${n} ${n === 1 ? "entry" : "entries"} awaiting manual retry`);
    if (ageMin > 0) t += theme.fg("dim", ` (oldest ≈ ${ageMin} min)`);
    t += "\n" + theme.fg("dim", "  Auto-retry budget exhausted (4 attempts ≈ 7.5 min). Run");
    t += theme.fg("accent", " /hindsight retry");
    t += theme.fg("dim", " to drain manually, or");
    t += theme.fg("accent", " /hindsight queue");
    t += theme.fg("dim", " to inspect.");
    return new Text(t, 0, 0);
  });

  pi.registerMessageRenderer("hindsight-retain-failed-async", (msg, _opt, theme) => {
    const d = (msg.details as any) ?? {};
    let t = theme.fg("error", "✗ Hindsight");
    t += theme.fg("muted", " retain operation failed");
    if (d.bank) t += theme.fg("dim", ` → ${d.bank}`);
    if (typeof d.op_age_ms === "number") t += theme.fg("dim", ` (${Math.round(d.op_age_ms / 1000)}s)`);
    if (d.error_message) t += "\n" + theme.fg("dim", `  ${String(d.error_message).slice(0, 300)}`);
    return new Text(t, 0, 0);
  });

  // ─── Manual Tools ──────────────────────────────────────────────────

  pi.registerTool({
    name: "hindsight_recall",
    label: "Hindsight Recall",
    description:
      "Query the persistent memory bank for past decisions, conventions, bug fixes, or domain knowledge that may not be in the current context. " +
      "Auto-recall fires on the first user turn and re-fires on detected topic shifts (jaccard < threshold, N-turn fallback, or trigger phrases), bounded by a cooldown. Call this tool explicitly when you need targeted context mid-turn or after a tool result reveals an unknown. " +
      "USE THIS TOOL when: (1) the user references past decisions/conventions/work you don't recall, (2) the auto-injected memories are insufficient for the current sub-task, (3) you would otherwise say 'I don't know' or guess about project-specific facts. " +
      "Cheap (<2s, ~few hundred tokens) — prefer over guessing. Do NOT spam: skip when the auto-injection already answers the question.",
    parameters: Type.Object({
      query: Type.String({ description: "Natural-language search query. Be specific — e.g. 'smart-compaction fallback policy' beats 'compaction'." }),
      bank: Type.Optional(Type.String({ description: "Specific bank to query (e.g. 'project-alpha', 'project-Pi-Agent'). Defaults to project + global banks." })),
      banks: Type.Optional(Type.Array(Type.String(), { description: "Multiple banks to query simultaneously." })),
    }),
    async execute(_id, params) {
      const config = resolveConfig(process.cwd());
      if (!config?.api_url) return { content: [{ type: "text" as const, text: "Hindsight not configured." }], details: {}, isError: true };
      const p = params as any;
      const banks = p.bank ? [p.bank] : p.banks?.length ? p.banks : getRecallBanks(config);
      if (!banks.length) return { content: [{ type: "text" as const, text: "No banks configured." }], details: {}, isError: true };
      try {
        const results = await Promise.all(banks.map(async (bank) => {
          const res = await fetch(`${config.api_url}/v1/default/banks/${bank}/memories/recall`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...authHeader(config.api_key) },
            body: JSON.stringify({ query: p.query, budget: "mid", query_timestamp: new Date().toISOString(), types: config.recall_types }),
            signal: AbortSignal.timeout(2000),
          });
          if (!res.ok) return [];
          const data = await res.json();
          return (data.results || []).map((r: any) => `[${bank}] ${r.text}`);
        }));
        const flat = results.flat();
        return flat.length
          ? { content: [{ type: "text" as const, text: flat.join("\n\n") }], details: { banks: banks.join(", "), count: flat.length } }
          : { content: [{ type: "text" as const, text: "No memories found." }], details: { banks: banks.join(", ") } };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${e}` }], details: {}, isError: true };
      }
    },
  });

  pi.registerTool({
    name: "hindsight_retain",
    label: "Hindsight Retain",
    description: "Save an important insight to memory. Auto-retain handles routine turns. Use this tool for knowledge worth preserving beyond the current session.",
    parameters: Type.Object({
      content: Type.String({ description: "The insight to save — include full context" }),
      scope: Type.Optional(Type.Union([Type.Literal("project"), Type.Literal("global")], {
        description: "Use 'project' for project-specific knowledge (decisions, bugs, patterns). Use 'global' for cross-project knowledge: coding conventions, tool preferences, environment setup, architecture patterns, or lessons learned that apply to other projects. When in doubt, use 'project'.",
      })),
      bank: Type.Optional(Type.String({ description: "Explicit bank name to write to (e.g. 'project-beta', 'project-gamma'). Overrides scope." })),
    }),
    async execute(_id, params) {
      const config = resolveConfig(process.cwd());
      if (!config?.api_url) return { content: [{ type: "text" as const, text: "Hindsight not configured." }], details: {}, isError: true };
      const p = params as any;
      const bank = p.bank || (p.scope === "global" && config.global_bank ? config.global_bank : getActiveBank(config));
      if (!bank) return { content: [{ type: "text" as const, text: "No bank_id configured." }], details: {}, isError: true };
      try {
        // Use async:true server-side — kilocode-backed fact extraction takes 5–30s,
        // which exceeds any reasonable client-side AbortSignal.timeout. Sub-Phase-D
        // polling will catch silent failures asynchronously. Client returns as soon
        // as hindsight has accepted the work (typically <200ms).
        const res = await fetch(`${config.api_url}/v1/default/banks/${bank}/memories`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeader(config.api_key) },
          body: JSON.stringify({
            items: [{ content: params.content, context: "pi: explicit retain", timestamp: new Date().toISOString() }],
            async: true,
          }),
          signal: AbortSignal.timeout(5000),
        });
        return res.ok
          ? { content: [{ type: "text" as const, text: `Memory queued → ${bank} (async; Phase D watcher will surface any silent failure).` }], details: { bank, scope: p.bank ? "explicit" : (p.scope || "project") } }
          : { content: [{ type: "text" as const, text: `Failed to retain to ${bank}.` }], details: {}, isError: true };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${e}` }], details: {}, isError: true };
      }
    },
  });

  pi.registerTool({
    name: "hindsight_reflect",
    label: "Hindsight Reflect",
    description: "Synthesize insights from memory to answer complex questions.",
    parameters: Type.Object({ query: Type.String() }),
    async execute(_id, params) {
      const config = resolveConfig(process.cwd());
      if (!config?.api_url) return { content: [{ type: "text" as const, text: "Hindsight not configured." }], details: {}, isError: true };
      const bank = getActiveBank(config);
      if (!bank) return { content: [{ type: "text" as const, text: "No bank_id configured." }], details: {}, isError: true };
      try {
        const res = await fetch(`${config.api_url}/v1/default/banks/${bank}/memories/reflect`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeader(config.api_key) },
          body: JSON.stringify({ query: params.query }),
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) {
          const data = await res.json();
          return { content: [{ type: "text" as const, text: data.synthesis || JSON.stringify(data) }], details: {} };
        }
        return { content: [{ type: "text" as const, text: "Reflection failed." }], details: {}, isError: true };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${e}` }], details: {}, isError: true };
      }
    },
  });

  pi.registerTool({
    name: "hindsight_promote",
    label: "Hindsight Promote Memories",
    description: "Copy memories between banks. Use to analyze what knowledge from one project applies to another — recall from the source bank, copy matching memories to the target bank. Use case: 'analyze what memories from project-alpha could be applicable to project-beta and add them there'.",
    parameters: Type.Object({
      query: Type.String({ description: "What to search for in the source bank (e.g. 'drafting conventions', 'procedural rules', 'code style')" }),
      from: Type.Optional(Type.String({ description: "Source bank ID. Defaults to the active project bank." })),
      to: Type.Optional(Type.String({ description: "Target bank ID. Defaults to the global bank." })),
    }),
    async execute(_id, params) {
      const config = resolveConfig(process.cwd());
      if (!config?.api_url) return { content: [{ type: "text" as const, text: "Hindsight not configured." }], details: {}, isError: true };
      const p = params as any;
      const fromBank = p.from || getActiveBank(config);
      const toBank = p.to || config.global_bank;
      if (!fromBank) return { content: [{ type: "text" as const, text: "No source bank (no bank_id configured, and no 'from' specified)." }], details: {}, isError: true };
      if (!toBank) return { content: [{ type: "text" as const, text: "No target bank (no global_bank configured, and no 'to' specified)." }], details: {}, isError: true };
      try {
        // Recall from source bank
        const res = await fetch(`${config.api_url}/v1/default/banks/${fromBank}/memories/recall`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeader(config.api_key) },
          body: JSON.stringify({ query: p.query, budget: "mid", query_timestamp: new Date().toISOString(), types: config.recall_types }),
          signal: AbortSignal.timeout(2000),
        });
        if (!res.ok) return { content: [{ type: "text" as const, text: `Recall from ${fromBank} failed (HTTP ${res.status}).` }], details: {}, isError: true };
        const data = await res.json();
        const memories = data.results || [];
        if (!memories.length) return { content: [{ type: "text" as const, text: `No memories in ${fromBank} matching \"${p.query}\".` }], details: {} };

        // Copy each memory to target bank
        const promoted: string[] = [];
        for (const mem of memories) {
          const copyRes = await fetch(`${config.api_url}/v1/default/banks/${toBank}/memories`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...authHeader(config.api_key) },
            body: JSON.stringify({
              items: [{ content: mem.text, context: `pi: promoted from ${fromBank}`, timestamp: new Date().toISOString(), tags: [...(mem.tags || []), "promoted"] }],
              async: false,
            }),
            signal: AbortSignal.timeout(5000),
          });
          if (copyRes.ok) promoted.push(mem.text.slice(0, 100));
        }

        if (promoted.length) {
          return {
            content: [{ type: "text" as const, text: `Promoted ${promoted.length} memories from ${fromBank} → ${toBank}:\n\n${promoted.map((m: string) => `• ${m}...`).join("\n")}` }],
            details: { count: promoted.length, from: fromBank, to: toBank },
          };
        }
        return { content: [{ type: "text" as const, text: `Found ${memories.length} memories but failed to copy to ${toBank}.` }], details: {}, isError: true };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${e}` }], details: {}, isError: true };
      }
    },
  });

  // ─── Auto-Recall (before_agent_start) ──────────────────────────────

  // Phase C changes vs Phase B:
  //   1. Each per-bank fetch uses recallBankWithRetry() — N retries with
  //      exponential backoff for transient errors (timeout/5xx/network).
  //      4xx auth errors are NOT retried.
  //   2. Default timeout is settings.recallTimeoutMs (5000ms, was 2000ms).
  //      2000ms was too tight for cold-start recall (embed + similarity +
  //      optional LLM rerank) — the root cause of the ⚠ retrying status.
  //   3. The status bar only displays ⚠ retrying after the LAST retry has
  //      failed, never between retries inside one before_agent_start call.
  //   4. healthGate=block: if unhealthy AT ENTRY (from prior zero-units
  //      extracted or auth failure), abort the turn before recall.
  //   5. A successful recall flips healthState back to healthy — self-heals
  //      if the upstream LLM gateway recovers between turns.
  pi.on("before_agent_start", async (event, ctx) => {
    // Every user turn increments the counter; the heuristic decides whether
    // this turn earns a fresh recall. Counter is reset on successful recall.
    turnsSinceLastRecall++;

    const config = resolveConfig(process.cwd());
    if (!config?.api_url) return;

    const banks = getRecallBanks(config);
    if (!banks.length) return;

    const settings = loadSettings();

    // ─── Phase F: topic-shift decision ────────────────────
    // Use event.prompt (provided by pi for this exact turn) as the freshest
    // signal; fall back to the session-tracked currentPrompt otherwise.
    const heuristicPrompt = (event as any)?.prompt || currentPrompt || "";
    const decision = shouldRecall({
      currentPrompt: heuristicPrompt,
      lastRecallPrompt,
      lastRecallAt,
      turnsSinceLastRecall,
      now: Date.now(),
      settings: settings.topicShiftRecall,
    });
    if (!decision.fire) {
      log(`recall: skip (${decision.reason}${decision.detail ? ` ${decision.detail}` : ""})`);
      return;
    }
    log(`recall: fire (${decision.reason}${decision.detail ? ` ${decision.detail}` : ""}, turn ${turnsSinceLastRecall})`);
    // Each "fire" decision opens a fresh retry window.
    recallAttempts = 0;

    // ─── Health Gate (block mode) ────────────────────
    // Check BEFORE incrementing recallAttempts or making any network call so
    // that re-runs after `/hindsight reset` start with a clean slate.
    if (!healthState.healthy && settings.healthGate === "block") {
      log(`health-gate: BLOCKING turn (reason=${healthState.reason})`);
      ctx.ui.setStatus?.("hindsight", `✗ blocked: ${healthState.reason || "unhealthy"}`);
      hookStats.recall = {
        firedAt: new Date().toISOString(),
        result: "failed",
        detail: `blocked: ${healthState.reason || "unhealthy"}`,
      };
      try { ctx.abort?.(); } catch (e) { log(`health-gate: ctx.abort threw ${e}`); }
      return {
        message: {
          customType: "hindsight-blocked",
          content:
            `Hindsight is UNHEALTHY (${healthState.reason || "unknown reason"}) and ` +
            `hindsight.healthGate is "block". The turn was aborted to avoid running ` +
            `without recall context. Fix the underlying hindsight issue (check ` +
            `\`~/Work/llm-mode.sh status\` and \`docker logs hindsight --tail 50\`), ` +
            `then run \`/hindsight reset\` to clear the unhealthy flag and retry. ` +
            `Alternatively, set \`hindsight.healthGate="warn"\` (or "off") in ` +
            `~/.pi/agent/hindsight.json to proceed without recall.`,
          display: true,
          details: { reason: healthState.reason, markedAt: healthState.markedAt },
        },
      };
    }

    recallAttempts++;
    const query = heuristicPrompt || getLastUserMessage(ctx, currentPrompt) || "Provide context for current project";
    log(`recall: attempt ${recallAttempts}/${MAX_RECALL_ATTEMPTS}, banks=${banks.join(",")}, retries=${settings.recallRetry.attempts}, timeout=${settings.recallTimeoutMs}ms`);

    type BankOutcome = "ok" | "auth-failed" | "error";
    const bankOutcomes = new Map<string, BankOutcome>();
    const allResults: string[] = [];
    const recallBody = {
      query,
      budget: "mid",
      query_timestamp: new Date().toISOString(),
      types: config.recall_types,
    };

    try {
      await Promise.all(banks.map(async (bank) => {
        const r = await recallBankWithRetry(
          config.api_url,
          config.api_key,
          bank,
          recallBody,
          {
            attempts: settings.recallRetry.attempts,
            backoffMs: settings.recallRetry.backoffMs,
            timeoutMs: settings.recallTimeoutMs,
          },
        );
        if (r.outcome === "auth-failed") {
          bankOutcomes.set(bank, "auth-failed");
          log(`recall: bank=${bank} auth error (HTTP ${r.status})`);
        } else if (r.outcome === "ok") {
          bankOutcomes.set(bank, "ok");
          for (const m of (r.data.results || [])) allResults.push(`[${bank}] ${m.text}`);
        } else {
          bankOutcomes.set(bank, "error");
          log(`recall: bank=${bank} exhausted ${r.attempts} retries (last=${r.lastErrorKind})`);
        }
      }));

      const okBanks = banks.filter(b => bankOutcomes.get(b) === "ok");
      const authFailedBanks = banks.filter(b => bankOutcomes.get(b) === "auth-failed");
      const anyOk = okBanks.length > 0;
      const allAuthFailed = authFailedBanks.length === banks.length;

      if (allAuthFailed) {
        // Every bank rejected our credentials — credential is wrong, no point
        // retrying. Park lastRecallAt at "infinity" via a huge cooldown sentinel
        // so subsequent turns don't keep hammering: only /hindsight reset
        // clears this state (auth doesn't fix itself between prompts).
        lastRecallAt = Date.now() + 24 * 3600 * 1000; // 24h in the future
        hookStats.recall = { firedAt: new Date().toISOString(), result: "failed", detail: "auth error" };
        ctx.ui.setStatus("hindsight", "✗ auth error");
        if (settings.healthGate !== "off") markUnhealthy("auth error on all banks");
        return;
      }

      if (anyOk) {
        // Phase F bookkeeping: a successful recall closes the cooldown window
        // and resets the turn counter. Re-firing on the very next turn now
        // requires either a real topic shift or expiry of the cooldown.
        const isRefire = recallEverFired;
        recallEverFired = true;
        lastRecallPrompt = heuristicPrompt;
        lastRecallAt = Date.now();
        turnsSinceLastRecall = 0;
        // Successful recall → self-heal. Clears unhealthy flag from a prior
        // zero-units-extracted retain or transient recall failure, so the user doesn't
        // need to /hindsight reset once the upstream LLM gateway recovers.
        markHealthy();
        if (allResults.length) {
          const detail = authFailedBanks.length
            ? `${allResults.length} memories (auth failed: ${authFailedBanks.join(",")})`
            : `${allResults.length} memories`;
          hookStats.recall = { firedAt: new Date().toISOString(), result: "ok", detail: isRefire ? `${detail} [refire: ${decision.reason}]` : detail };
          // On a topic-shift re-fire, surface a brief status flash so the
          // user can see the new injection. First-turn recall keeps the
          // session_start `🧠 bank` status untouched.
          if (isRefire) {
            const bank = getActiveBank(config);
            ctx.ui.setStatus?.("hindsight", `🧠 +${allResults.length}${bank ? ` (${bank})` : ""}`);
          }
          const snippet = allResults.slice(0, 3).map((r: string) => r.replace(/^\[[^\]]+\] /, "")).join(" · ").slice(0, 200);
          return {
            message: {
              customType: "hindsight-recall",
              content: `<hindsight_memories>\nRelevant memories from past sessions:\n\n${allResults.join("\n\n")}\n</hindsight_memories>`,
              display: true,
              details: { count: allResults.length, snippet, memories: allResults, refire: isRefire, reason: decision.reason },
            },
          };
        }
        hookStats.recall = {
          firedAt: new Date().toISOString(),
          result: "ok",
          detail: authFailedBanks.length ? `empty (auth failed: ${authFailedBanks.join(",")})` : "empty",
        };
      } else {
        // All banks failed (network/timeout/5xx). recallBankWithRetry already
        // exhausted its internal retry budget; one fire = one terminal failure.
        // Park lastRecallAt = now so the cooldown gate prevents thrashing on
        // every subsequent turn. Recovery: next turn after `cooldownSeconds`
        // re-evaluates shouldRecall — jaccard against the empty
        // lastRecallPrompt returns 0, so it will fire again if/when needed.
        lastRecallAt = Date.now();
        hookStats.recall = { firedAt: new Date().toISOString(), result: "failed", detail: "unreachable" };
        ctx.ui.setStatus("hindsight", "✗ unreachable");
        if (settings.healthGate !== "off") markUnhealthy("recall exhausted retries");
      }
    } catch (e) {
      lastRecallAt = Date.now();
      ctx.ui.setStatus("hindsight", "✗ unreachable");
      log(`recall: error ${e}`);
      if (settings.healthGate !== "off") markUnhealthy("recall threw");
    }
  });

  // ─── Auto-Retain (agent_end) ───────────────────────────────────────

  pi.on("agent_end", async (event, ctx) => {
    const config = resolveConfig(process.cwd());
    if (!config?.api_url) return;

    const prompt = getLastUserMessage(ctx, currentPrompt);
    const skipCheck = shouldSkipRetain(prompt);
    if (skipCheck.skip) { log(`agent_end: skip (${skipCheck.reason})`); return; }

    const bank = getActiveBank(config);
    if (!bank) return;

    const tags = extractTags(prompt);
    const banks = getRetainBanks(config, prompt);
    const stripPatterns = getStripPatterns(config);

    // Build transcript
    const rawTranscript = buildTranscript(prompt, event.messages || [], stripPatterns);
    if (rawTranscript.length < 20) return;
    let transcript = rawTranscript.length > 50000 ? rawTranscript.slice(0, 50000) + "\n...[TRUNCATED]" : rawTranscript;

    const sessionId = ctx.sessionManager?.getSessionId?.() || `unknown-${Date.now()}`;
    // Include local date/time in context so the extraction LLM generates timezone-correct memory dates
    const now = new Date();
    const localDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const localTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    log(`retain: banks=${banks.join(",")} len=${transcript.length} tags=${tags.join(",")}`);

    try {
      // ─── Phase D: pre-retain snapshot ─────────────────────────────────
      // Snapshot per-bank memory_unit_count for this document BEFORE the
      // POST so the watcher can compute a real delta after the operation
      // completes. Without this, the watcher fires with preUnitsCount=0
      // for every bank and zero-units detection silently misclassifies
      // append-mode retains (which already had units) as failures.
      // ─── Document rollover: pick per-bank document_id ─────────────────
      // Each bank gets its own rollover state because their docs grow at
      // different rates (project bank vs global bank vs legal bank etc.).
      // The resolver probes session-<id>, session-<id>-2, … and returns
      // the first part below the threshold (or 404, meaning fresh). On
      // resolver error we fall back to the legacy `session-<id>` so a
      // hindsight-server hiccup never blocks the retain.
      const baseDocumentId = `session-${sessionId}`;
      const transcriptLen = transcript.length;
      const rolloverThreshold = getDocRolloverThreshold();
      const docIdByBank = new Map<string, string>();
      await Promise.all(banks.map(async (b) => {
        try {
          const id = await resolveSessionDocumentId(
            config.api_url, config.api_key, b, sessionId, rolloverThreshold,
          );
          docIdByBank.set(b, id);
        } catch {
          docIdByBank.set(b, baseDocumentId);
        }
      }));

      // Pre-retain snapshot must use the resolved (per-bank) doc id so the
      // watcher's post-retain delta compares apples to apples. Inlined here
      // because buildPreRetainSnapshot() assumes a single document_id
      // across banks, which no longer holds after rollover.
      const preCounts = new Map<string, number>();
      await Promise.all(banks.map(async (b) => {
        const docId = docIdByBank.get(b) || baseDocumentId;
        const n = await fetchDocumentUnitsCount(config.api_url, config.api_key, b, docId);
        preCounts.set(b, n ?? 0);
      }));

      // ─── Self-heal G1: closure-stable RetainContext ───────────────────
      // Capture transcript + tags + context BEFORE Promise.allSettled so it
      // is reachable from the fire-and-forget watcher. Without this, the
      // watcher's scope only has `snapshot.transcriptLen` (a number) and
      // any zero-units retry would have nothing to re-POST.
      const retainCtxStable: RetainContext = {
        transcript,
        tags,
        context: `pi | ${localDate} ${localTime} ${tz}`,
        sessionId,
        timestamp: new Date().toISOString(),
      };

      const t0 = Date.now();
      const results = await Promise.allSettled(
        banks.map(async (b) => {
          const docId = docIdByBank.get(b) || baseDocumentId;
          const res = await fetch(`${config.api_url}/v1/default/banks/${b}/memories`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...authHeader(config.api_key) },
            body: JSON.stringify({
              items: [{
                content: transcript,
                document_id: docId,
                update_mode: "append",
                context: `pi | ${localDate} ${localTime} ${tz}`,
                timestamp: new Date().toISOString(),
                ...(tags.length && { tags }),
              }],
              async: true,
            }),
            signal: AbortSignal.timeout(5000),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          // Capture operation_id from RetainResponse so we can poll for silent failures.
          let operationId: string | null = null;
          try {
            const data = await res.json() as { operation_id?: string | null; operation_ids?: string[] | null };
            operationId = data.operation_id || (Array.isArray(data.operation_ids) ? data.operation_ids[0] : null) || null;
          } catch { /* response body not JSON — proceed without polling */ }
          return { bank: b, operationId };
        }),
      );

      const fulfilled = results
        .filter((r): r is PromiseFulfilledResult<{ bank: string; operationId: string | null }> => r.status === "fulfilled")
        .map(r => r.value);
      const ok = fulfilled.map(v => v.bank);
      hookStats.retain = { firedAt: new Date().toISOString(), result: ok.length ? "ok" : "failed", detail: ok.join(", ") };

      // Change 1a: clear unhealthy on any successful retain POST. Symmetric
      // with the post-recall markHealthy() above. Without this, a transient
      // unreachable mark only clears on the next successful recall, which may
      // not fire for hundreds of turns in a long session. Note this fires on
      // the synchronous 200 — the async watcher below confirms units actually
      // appeared; the watcher fires its own markHealthy() on real delta.
      if (ok.length > 0) markHealthy();

      // ─── Phase D: background polling for silent failures ─────────────
      // Dispatched BEFORE pi.sendMessage so a stale-ctx throw from sendMessage
      // (notably in `pi -p` single-shot mode, where the runtime invalidates
      // ctx by the time the queued agent_end handler runs) cannot abort the
      // dispatch. `void watchRetainOperation(...)` is fire-and-forget — each
      // watcher gets the per-bank pre-retain snapshot so it can compute a
      // real delta after the operation completes.
      for (const { bank: b, operationId } of fulfilled) {
        if (!operationId) {
          log(`retain: bank=${b} no operation_id in response — skipping watcher`);
          continue;
        }
        const snapshot: RetainSnapshot = {
          documentId: docIdByBank.get(b) || baseDocumentId,
          preUnitsCount: preCounts.get(b) ?? 0,
          transcriptLen,
        };
        void watchRetainOperation(pi, ctx, config, b, operationId, t0, snapshot, retainCtxStable);
      }

      // ─── Self-heal G1: opportunistic drain on successful retain ─────────
      // If selfHeal is on AND at least one bank succeeded this turn, fire a
      // best-effort drain of the queue. Reads settings FRESH so a /hindsight
      // self-heal off mid-session takes immediate effect. Fire-and-forget;
      // failures inside drainQueue are logged but never propagate.
      if (ok.length) {
        const liveSettings = loadSettings();
        if (liveSettings.selfHeal.enabled) {
          void drainQueue(config.api_url, config.api_key, { pi, ctx, settings: liveSettings })
            .catch(e => log(`self-heal: agent_end drain error ${e}`));
        }
      }

      // pi.sendMessage can throw "stale after session replacement or reload"
      // when the runtime invalidates ctx after disposeRuntime() (same race as
      // commit 971552b for session-title). Swallow exactly that error; rethrow
      // anything else so real bugs surface. Wrapped per-call so a throw from
      // the success path does not skip the failure path or vice versa.
      if (ok.length) {
        const transcriptPreview = transcript.length > 1000 ? transcript.slice(0, 1000) + "…" : transcript;
        try {
          pi.sendMessage({ customType: "hindsight-retain", content: "", display: true, details: { banks: ok, transcript: transcriptPreview } }, { deliverAs: "nextTurn" });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!msg.includes("stale after session replacement or reload")) throw err;
        }
      } else {
        try { ctx.ui.setStatus("hindsight", "⚠ retain failed"); } catch {}
        try {
          pi.sendMessage({ customType: "hindsight-retain-failed", content: "", display: true }, { deliverAs: "nextTurn" });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!msg.includes("stale after session replacement or reload")) throw err;
        }
      }
    } catch (e) {
      log(`retain: error ${e}`);
    }
  });

  // ─── Commands ──────────────────────────────────────────────────────

  pi.registerCommand("hindsight", {
    description: "Hindsight memory status. Usage: /hindsight [status|stats|health|reset|refresh|retry|queue|self-heal on|off]",
    handler: async (args: any, ctx) => {
      const config = resolveConfig(process.cwd());
      if (!config) { ctx.ui.notify("Hindsight not configured — no .hindsight/config.toml in path.", "warning"); return; }

      const sub = typeof args === "string" ? args.trim() : "";

      // ─── Self-heal G1 subcommands ─────────────────────────────────────
      if (sub === "retry") {
        const settings = loadSettings();
        if (!settings.selfHeal.enabled) {
          ctx.ui.notify("Self-heal is OFF. Run `/hindsight self-heal on` first.", "warning");
          return;
        }
        const r = await drainQueue(config.api_url, config.api_key, { pi, ctx, settings });
        ctx.ui.notify(
          `Self-heal drain:\n` +
          `  drained: ${r.drained}\n` +
          `  recovered: ${r.recovered}\n` +
          `  reposted: ${r.reposted} (${r.failed} failed)\n` +
          `  newly awaiting-user: ${r.newAwaiting}\n` +
          `  total awaiting-user: ${r.totalAwaiting}`,
          "info",
        );
        return;
      }

      if (sub === "queue") {
        const all = listQueueEntries();
        if (!all.length) { ctx.ui.notify("Hindsight queue is empty.", "info"); return; }
        const lines = [`Hindsight queue (${all.length} entries):`];
        const now = Date.now();
        for (const e of all) {
          const ageMin = Math.round((now - e.createdAt) / 60_000);
          const due = e.awaitingUser
            ? "awaiting-user"
            : (e.nextRetryAt <= now ? "due" : `in ${Math.max(0, Math.round((e.nextRetryAt - now) / 1000))}s`);
          lines.push(`  ${e.id.slice(0, 8)} bank=${e.bank} doc=${e.documentId.slice(0, 24)} attempts=${e.attempts}/${BACKOFF_SCHEDULE_MS.length} age=${ageMin}m next=${due}${e.lastError ? ` err="${e.lastError.slice(0, 60)}"` : ""}`);
        }
        lines.push("");
        lines.push(`Queue dir: ${getQueueDir()}`);
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      if (sub === "self-heal" || sub === "selfheal" || sub.startsWith("self-heal ") || sub.startsWith("selfheal ")) {
        const parts = sub.split(/\s+/);
        const action = (parts[1] || "").toLowerCase();
        const cfgPath = join(homedir(), ".hindsight", "config.toml");
        if (action === "on" || action === "off") {
          const enabled = action === "on";
          try {
            writeSelfHealEnabledToml(cfgPath, enabled);
            // Reset alert state on toggle so the next drain reports cleanly.
            saveAwaitingUserAlertState({ lastAlertedCount: 0 });
            ctx.ui.notify(
              `Self-heal ${enabled ? "ENABLED" : "DISABLED"} (persisted to ${cfgPath}).\n` +
              (enabled ? "  - Zero-units retains will be enqueued for retry.\n  - Bounded backoff: 30s, 60s, 2min, 4min → alert.\n  - Drain runs on session_start and after successful retains." : "  - Auto-retry stopped immediately. Existing queue entries are not deleted."),
              "info",
            );
          } catch (e) {
            ctx.ui.notify(`Failed to write ${cfgPath}: ${e}`, "error");
          }
          return;
        }
        // Status display
        const s = loadSettings();
        const all = listQueueEntries();
        const awaiting = all.filter(e => e.awaitingUser).length;
        ctx.ui.notify(
          `Self-heal status:\n` +
          `  enabled: ${s.selfHeal.enabled}\n` +
          `  queue:   ${all.length} entries (${awaiting} awaiting-user)\n` +
          `  backoff: [${(s.selfHeal.backoffSchedule ?? BACKOFF_SCHEDULE_MS).join(", ")}] ms\n` +
          `  max:     ${s.selfHeal.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE}\n` +
          `\nToggle: /hindsight self-heal on | off`,
          "info",
        );
        return;
      }

      if (sub === "reset") {
        const wasHealthy = healthState.healthy;
        const prevReason = healthState.reason;
        markHealthy();
        resetRecallState();
        ctx.ui.setStatus?.("hindsight", `🧠 ${getActiveBank(config) || ""}`.trim() || undefined);
        ctx.ui.notify(
          wasHealthy
            ? "Hindsight already healthy. Recall state reset — next turn will fire fresh recall."
            : `Hindsight unhealthy flag cleared (was: ${prevReason}). Recall state reset.`,
          "info",
        );
        return;
      }

      if (sub === "refresh") {
        // Like /hindsight reset for the recall side: forces the next user
        // turn to fire a fresh recall regardless of topic-shift heuristic.
        // Mirrors the Phase F design note "/clear explicitly resets the
        // recallDone flag" — pi has no global /clear, but this matches.
        resetRecallState();
        ctx.ui.setStatus?.("hindsight", `🧠 ${getActiveBank(config) || ""}`.trim() || undefined);
        ctx.ui.notify("Hindsight recall state cleared — next turn will fire a fresh recall.", "info");
        return;
      }

      if (sub === "health") {
        const s = loadSettings();
        const ts = s.topicShiftRecall;
        const lines = [
          `Health: ${healthState.healthy ? "✓ healthy" : `✗ unhealthy (${healthState.reason})`}`,
          healthState.markedAt ? `Marked: ${healthState.markedAt}` : "",
          "",
          `Settings (~/.pi/agent/hindsight.json):`,
          `  healthGate:        ${s.healthGate}`,
          `  recallRetry:       attempts=${s.recallRetry.attempts}, backoffMs=${s.recallRetry.backoffMs}`,
          `  recallTimeoutMs:   ${s.recallTimeoutMs}`,
          `  topicShiftRecall:  enabled=${ts.enabled}, heuristic=${ts.heuristic}, cooldown=${ts.cooldownSeconds}s, everyN=${ts.everyNTurns}, jaccard<${ts.jaccardThreshold}`,
          "",
          `Recall state: everFired=${recallEverFired}, lastAt=${lastRecallAt ? new Date(lastRecallAt).toISOString() : "never"}, turnsSince=${turnsSinceLastRecall}`,
          "",
          `Reset with: /hindsight reset    Force re-recall: /hindsight refresh`,
        ].filter(Boolean);
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      if (sub === "status") {
        const lines: string[] = [];
        const bank = getActiveBank(config);
        lines.push(`Bank:   ${bank || "(none)"}`);
        if (config.global_bank) lines.push(`Global: ${config.global_bank}`);
        lines.push("");

        try {
          const health = await fetch(`${config.api_url}/health`, { signal: AbortSignal.timeout(2000) });
          lines.push(`Server: ${health.ok ? "✓ online" : `✗ HTTP ${health.status}`}`);
        } catch { lines.push("Server: ✗ unreachable"); }

        lines.push(`URL:    ${config.api_url}`);
        if (!config.api_key) lines.push("  ⚠ no api_key");

        if (bank) {
          try {
            const res = await fetch(`${config.api_url}/v1/default/banks/${bank}/profile`, { headers: authHeader(config.api_key), signal: AbortSignal.timeout(2000) });
            lines.push(`Bank auth: ${res.status === 401 || res.status === 403 ? "✗ invalid" : "✓ ok"}`);
          } catch { lines.push("Bank auth: ✗ unreachable"); }
        }

        lines.push("");
        lines.push(`Health: ${healthState.healthy ? "✓ healthy" : `✗ unhealthy (${healthState.reason})`}`);
        const settings = loadSettings();
        lines.push(`Gate:   ${settings.healthGate}`);
        if (settings.healthGate === "block" && !healthState.healthy) {
          lines.push("  • next prompt will be aborted — run /hindsight reset after fixing upstream");
        }
        lines.push("");
        lines.push("Hooks:");
        const icon = (r?: string) => r === "ok" ? "✓" : r === "failed" ? "✗" : "…";
        const fmt = (s: HookStats) => s.firedAt ? `${icon(s.result)} ${s.result}${s.detail ? ` (${s.detail})` : ""}` : "not fired";
        lines.push(`  session_start: ${fmt(hookStats.sessionStart)}`);
        lines.push(`  recall:        ${fmt(hookStats.recall)}`);
        lines.push(`  retain:        ${fmt(hookStats.retain)}`);

        if (DEBUG) {
          const logLines = readRecentLog(10);
          if (logLines.length) {
            lines.push("");
            lines.push(`Debug log (last ${logLines.length}):`);
            logLines.forEach(l => lines.push(`  ${l}`));
          }
        }

        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      if (sub === "stats") {
        const banks = getRecallBanks(config);
        if (!banks.length) { ctx.ui.notify("No banks configured.", "info"); return; }
        const results = await Promise.all(banks.map(async (bank) => {
          try {
            const res = await fetch(`${config.api_url}/v1/default/banks/${bank}/stats`, { signal: AbortSignal.timeout(2000) });
            if (!res.ok) return `${bank}: unavailable`;
            const data = await res.json();
            const entries = Object.entries(data).map(([k, v]) => `  ${k}: ${v}`).join("\n");
            return `${bank}:\n${entries}`;
          } catch { return `${bank}: error`; }
        }));
        ctx.ui.notify(results.join("\n\n"), "info");
        return;
      }

      ctx.ui.notify(`Bank: ${getActiveBank(config) || "none"}\nGlobal: ${config.global_bank || "none"}\nRecall: ${getRecallBanks(config).join(", ")}\nHealth: ${healthState.healthy ? "✓" : `✗ ${healthState.reason}`}\n/hindsight status | stats | health | reset | refresh`, "info");
    },
  });
}

/**
 * Extract the most recent user-message text from the session.
 *
 * pi messages may have either a plain string content or a content-block
 * array (text/image/tool_use/tool_result). The previous implementation
 * fell back to `JSON.stringify(content)` on arrays — which polluted retain
 * transcripts with the raw block JSON (incl. base64 images, tool-use IDs,
 * etc.) and was the root cause of multi-hundred-K documents in the
 * hindsight store that subsequently overflowed the extraction LLM context.
 *
 * Behavior:
 *   - string content → returned as-is
 *   - block array → concatenation of `type === "text"` blocks (newline-joined)
 *     with everything else (images, tool_use, tool_result) silently dropped
 *   - unknown/empty shape → "" (NOT JSON.stringify — empty is strictly better)
 *   - no user message found → `fallback`
 */
export function getLastUserMessage(ctx: any, fallback: string): string {
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
          // Empty text join (e.g. all-image content) → fall through to "".
          // "" is preferable to the legacy JSON dump because retain-time
          // callers treat empty as "no extractable user text" and skip
          // pollution-prone branches, whereas a JSON dump would survive
          // into the document store.
          return "";
        }
        // Unknown content shape (null, number, object) — same rationale.
        return "";
      }
    }
  } catch {}
  return fallback;
}
