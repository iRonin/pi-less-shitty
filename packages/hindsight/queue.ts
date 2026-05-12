/**
 * Hindsight Self-Heal G1 — Persistent retry queue (opt-in).
 *
 * Pure module: only `node:fs`, `node:os`, `node:path`, `node:crypto`.
 * No pi-tui / pi-coding-agent imports — directly testable per the Phase F
 * `heuristic.ts` pattern.
 *
 * On-disk layout:
 *   ~/.hindsight/queue/<uuid>.json      — one entry per failed retain
 *   ~/.hindsight/queue/<uuid>.json.tmp  — atomic-write scratch (never read)
 *
 * BACKOFF — explicitly bounded per user mandate, NOT exponential 12h:
 *   [30s, 60s, 2min, 4min] → after attempt 4, mark awaiting-user and stop
 *   auto-retry. Total auto-retry wall ≈ 7.5 min, then a single high-visibility
 *   alert (status bar + chat message). The user can drain manually via
 *   `/hindsight retry`.
 *
 * Failure-mode contract:
 *   - `enqueue()`: refuses to silently exceed `maxQueueSize`; drops the
 *     oldest entries by `createdAt`. This is deterministic.
 *   - Atomic writes via `tmp + rename`. `listEntries()` ignores files that
 *     do not end in `.json` (i.e. half-written `.tmp` are skipped) — a
 *     crash mid-write leaves only the .tmp orphan, never a corrupt entry.
 *   - `markAttempted(ok=true)` deletes; `markAttempted(ok=false)` increments
 *     attempts + recomputes `nextRetryAt`; `markAwaitingUser` sets a terminal
 *     state that callers check explicitly.
 */

import {
  mkdirSync, existsSync, readFileSync, writeFileSync,
  readdirSync, unlinkSync, renameSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

// User-mandated bounded backoff. CANNOT be exponential 12h.
// Total ≈ 7.5 min across 4 attempts, then alert + stop auto-retry.
export const BACKOFF_SCHEDULE_MS: readonly number[] = [
  30_000,    // 30s
  60_000,    // 60s
  120_000,   // 2 min
  240_000,   // 4 min
];

export const DEFAULT_MAX_QUEUE_SIZE = 100;
export const QUEUE_SCHEMA_VERSION = 1;

export interface QueueEntry {
  v: number;             // schema version
  id: string;            // uuid
  bank: string;          // target hindsight bank
  transcript: string;    // full POST body content (≤ 50000 chars per index.ts truncation)
  tags: string[];        // extractTags() output
  context: string;       // "pi | YYYY-MM-DD HH:MM TZ" string
  preUnitsCount: number; // document memory_unit_count BEFORE the failed retain (dedup anchor)
  documentId: string;    // session-<sessionId> — same doc the failed retain used
  sessionId: string;     // for diagnostic correlation
  createdAt: number;     // unix ms
  attempts: number;      // count of drain attempts (POST or growth-check counts as 1)
  nextRetryAt: number;   // unix ms; entry is eligible for drain when nextRetryAt <= now
  awaitingUser: boolean; // terminal state — auto-retry budget exhausted
  lastError?: string;
}

export interface QueueOptions {
  /** Override the queue directory. Default: ~/.hindsight/queue */
  dir?: string;
  /** Cap on simultaneously-queued entries. Drops oldest on overflow. */
  maxQueueSize?: number;
  /** Clock injection for tests. */
  now?: () => number;
  /** Backoff schedule override (tests). */
  schedule?: readonly number[];
}

export function getQueueDir(opts: QueueOptions = {}): string {
  return opts.dir ?? join(homedir(), ".hindsight", "queue");
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function entryPath(dir: string, id: string): string {
  return join(dir, `${id}.json`);
}

function readEntryFile(path: string): QueueEntry | null {
  try {
    const raw = readFileSync(path, "utf-8");
    const obj = JSON.parse(raw);
    if (!obj || typeof obj.id !== "string" || typeof obj.bank !== "string") return null;
    // Normalize fields that may be missing in older on-disk entries.
    if (typeof obj.v !== "number") obj.v = QUEUE_SCHEMA_VERSION;
    if (!Array.isArray(obj.tags)) obj.tags = [];
    if (typeof obj.attempts !== "number") obj.attempts = 0;
    if (typeof obj.nextRetryAt !== "number") obj.nextRetryAt = obj.createdAt ?? 0;
    if (typeof obj.awaitingUser !== "boolean") obj.awaitingUser = false;
    return obj as QueueEntry;
  } catch {
    return null;
  }
}

function writeAtomic(path: string, content: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

/** Read every well-formed entry, sorted by createdAt asc (FIFO order). */
export function listEntries(opts: QueueOptions = {}): QueueEntry[] {
  const dir = getQueueDir(opts);
  if (!existsSync(dir)) return [];
  const out: QueueEntry[] = [];
  for (const name of readdirSync(dir)) {
    // Atomic-write contract: only files that end exactly in `.json` are
    // visible. `.json.tmp` scratch files MUST be ignored — they may contain
    // half-written content.
    if (!name.endsWith(".json")) continue;
    const e = readEntryFile(join(dir, name));
    if (e) out.push(e);
  }
  out.sort((a, b) => a.createdAt - b.createdAt);
  return out;
}

/**
 * Enqueue a failed retain. Writes atomically via tmp + rename so a crash
 * mid-write never leaves a corrupt .json visible to listEntries.
 *
 * Returns the persisted entry (with assigned id / createdAt / nextRetryAt).
 */
export function enqueue(
  partial: Omit<QueueEntry, "v" | "id" | "attempts" | "nextRetryAt" | "createdAt" | "awaitingUser">,
  opts: QueueOptions = {},
): QueueEntry {
  const dir = getQueueDir(opts);
  ensureDir(dir);

  // Enforce cap BEFORE writing the new one. FIFO by createdAt.
  const max = opts.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE;
  if (max > 0) {
    const current = listEntries(opts);
    // Drop oldest until there's room for the new entry.
    while (current.length >= max) {
      const oldest = current.shift()!;
      try { unlinkSync(entryPath(dir, oldest.id)); } catch { /* fall through */ }
    }
  }

  const now = opts.now ? opts.now() : Date.now();
  const id = randomUUID();
  const entry: QueueEntry = {
    v: QUEUE_SCHEMA_VERSION,
    id,
    bank: partial.bank,
    transcript: partial.transcript,
    tags: partial.tags ?? [],
    context: partial.context,
    preUnitsCount: partial.preUnitsCount,
    documentId: partial.documentId,
    sessionId: partial.sessionId,
    createdAt: now,
    attempts: 0,
    // Wait schedule[0] (= 30s) before the FIRST drain attempt — gives the
    // upstream (kilocode burst-rate, container OOM, etc.) a chance to
    // recover before burning attempt #1. After this initial delay, each
    // failed drain bumps the wait per BACKOFF_SCHEDULE_MS.
    nextRetryAt: now + (BACKOFF_SCHEDULE_MS[0] ?? 0),
    awaitingUser: false,
    lastError: partial.lastError,
  };
  writeAtomic(entryPath(dir, id), JSON.stringify(entry, null, 2));
  return entry;
}

/**
 * Returns the wait time for the *next* drain attempt given the current
 * `attempts` counter, or `null` when the auto-retry budget is exhausted.
 *
 * Contract:
 *   nextBackoffMs(0)               = schedule[0]              (initial wait before drain #1)
 *   nextBackoffMs(1)               = schedule[1]              (wait after drain #1 failed)
 *   ...
 *   nextBackoffMs(schedule.length) = null                     (budget exhausted → alert)
 *
 * Result for BACKOFF_SCHEDULE_MS = [30s, 60s, 2min, 4min]: 4 drain attempts,
 * total wall ≈ 7.5 min, then null.
 */
export function nextBackoffMs(
  attempts: number,
  schedule: readonly number[] = BACKOFF_SCHEDULE_MS,
): number | null {
  if (attempts < 0) return schedule[0] ?? null;
  if (attempts >= schedule.length) return null;
  return schedule[attempts];
}

/**
 * Mark a queue entry as attempted.
 *   - `ok = true`: delete the file (recovered).
 *   - `ok = false`: bump attempts, compute nextRetryAt from BACKOFF_SCHEDULE,
 *     persist. When `nextBackoffMs()` returns null, the entry stays at its
 *     current `nextRetryAt` (effectively dormant) — the caller is expected
 *     to follow up with `markAwaitingUser(id)`.
 */
export function markAttempted(
  id: string,
  ok: boolean,
  error?: string,
  opts: QueueOptions = {},
): QueueEntry | null {
  const dir = getQueueDir(opts);
  const path = entryPath(dir, id);
  if (!existsSync(path)) return null;
  if (ok) {
    try { unlinkSync(path); } catch { /* nothing left to do */ }
    return null;
  }
  const entry = readEntryFile(path);
  if (!entry) return null;
  entry.attempts += 1;
  if (error !== undefined) entry.lastError = error;
  const now = opts.now ? opts.now() : Date.now();
  const wait = nextBackoffMs(entry.attempts, opts.schedule ?? BACKOFF_SCHEDULE_MS);
  if (wait === null) {
    // Budget exhausted — keep entry in place; caller decides whether to
    // promote to awaiting-user. nextRetryAt is parked far in the future so
    // a stale drain pass cannot accidentally re-fire.
    entry.nextRetryAt = Number.MAX_SAFE_INTEGER;
  } else {
    entry.nextRetryAt = now + wait;
  }
  writeAtomic(path, JSON.stringify(entry, null, 2));
  return entry;
}

/**
 * Explicit terminal state: auto-retry budget exhausted, awaiting manual
 * user action. Auto-drains never re-attempt an awaiting-user entry.
 */
export function markAwaitingUser(id: string, opts: QueueOptions = {}): QueueEntry | null {
  const dir = getQueueDir(opts);
  const path = entryPath(dir, id);
  if (!existsSync(path)) return null;
  const entry = readEntryFile(path);
  if (!entry) return null;
  entry.awaitingUser = true;
  entry.nextRetryAt = Number.MAX_SAFE_INTEGER;
  writeAtomic(path, JSON.stringify(entry, null, 2));
  return entry;
}

/** Hard remove (manual dismissal). */
export function removeEntry(id: string, opts: QueueOptions = {}): boolean {
  const dir = getQueueDir(opts);
  const path = entryPath(dir, id);
  if (!existsSync(path)) return false;
  try { unlinkSync(path); return true; } catch { return false; }
}

/** Count of entries in awaiting-user terminal state. */
export function countAwaitingUser(opts: QueueOptions = {}): number {
  return listEntries(opts).filter(e => e.awaitingUser).length;
}

/** Entries currently eligible for drain (nextRetryAt <= now, not awaiting-user). */
export function dueEntries(opts: QueueOptions = {}): QueueEntry[] {
  const now = opts.now ? opts.now() : Date.now();
  return listEntries(opts).filter(e => !e.awaitingUser && e.nextRetryAt <= now);
}
