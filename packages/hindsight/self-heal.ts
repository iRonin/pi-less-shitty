/**
 * Self-Heal G1 \u2014 pure module for the gate + TOML writer + bool parser.
 *
 * Split out of index.ts so tests can import these without pulling in the
 * pi-tui / pi-coding-agent peer deps (mirrors the heuristic.ts pattern).
 *
 * No imports from "@earendil-works/*" \u2014 verify this stays true on every
 * change. If you need to depend on something there, push it back into
 * index.ts instead and re-export.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import type { QueueEntry } from "./queue.ts";

// ─── Types (re-exported through index.ts) ────────────────────────────────

export interface SelfHealConfig {
  enabled: boolean;
  backoffSchedule?: number[];
  maxQueueSize?: number;
}

export interface RetainSnapshotShape {
  documentId: string;
  preUnitsCount: number;
  transcriptLen: number;
}

export interface RetainContextShape {
  transcript: string;
  tags: string[];
  context: string;
  sessionId: string;
  timestamp: string;
}

/**
 * Pure decision: should this zero-units failure be enqueued for self-heal?
 *
 * Encoded invariants (Rule 9 \u2014 a test that pinned only the shape would
 * silently accept a default-on regression; this function refuses ALL of:
 *   - settings missing self-heal config (treated as off)
 *   - selfHealEnabled === false (default \u2014 opt-in)
 *   - missing retainCtx (the watcher would be enqueuing a dead entry)
 *   - tiny transcript (matches the 20-char floor in agent_end)
 * \u2026 producing null in every case).
 */
export function buildSelfHealEnqueuePayload(
  bank: string,
  snapshot: RetainSnapshotShape,
  selfHealEnabled: boolean,
  retainCtx: RetainContextShape | undefined,
): Omit<QueueEntry, "v" | "id" | "attempts" | "nextRetryAt" | "createdAt" | "awaitingUser"> | null {
  if (!selfHealEnabled) return null;
  if (!retainCtx) return null;
  if (!retainCtx.transcript || retainCtx.transcript.length < 20) return null;
  return {
    bank,
    transcript: retainCtx.transcript,
    tags: retainCtx.tags ?? [],
    context: retainCtx.context,
    preUnitsCount: snapshot.preUnitsCount,
    documentId: snapshot.documentId,
    sessionId: retainCtx.sessionId,
    lastError: "zero-units-extracted",
  };
}

/** Accepts "true"/"false"/"1"/"0"/"yes"/"no"/"on"/"off" (case-insensitive). */
export function normalizeBool(v: unknown, fallback: boolean): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "true" || s === "1" || s === "yes" || s === "on") return true;
    if (s === "false" || s === "0" || s === "no" || s === "off") return false;
  }
  return fallback;
}

/**
 * Minimal, format-preserving rewriter for the `[self_heal] enabled` flag in
 * ~/.hindsight/config.toml. Preserves all other content (comments,
 * whitespace, other sections) by line-editing in place.
 *
 *   - File missing → created with just the [self_heal] section.
 *   - Section exists → `enabled` line replaced (or inserted right after the
 *     header if absent).
 *   - Section missing → appended at EOF.
 *
 * Atomic via tmp + rename.
 */
export function writeSelfHealEnabledToml(path: string, enabled: boolean): void {
  const value = enabled ? "true" : "false";
  let raw = "";
  try { if (existsSync(path)) raw = readFileSync(path, "utf-8"); } catch { /* fall through */ }

  const lines = raw.length ? raw.split("\n") : [];

  let secIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*\[self_heal\]\s*$/.test(lines[i])) { secIdx = i; break; }
  }

  if (secIdx === -1) {
    if (raw.length && !raw.endsWith("\n")) lines.push("");
    lines.push("[self_heal]");
    lines.push(`enabled = ${value}`);
  } else {
    let enabledIdx = -1;
    const insertAt = secIdx + 1;
    for (let i = secIdx + 1; i < lines.length; i++) {
      if (/^\s*\[[a-zA-Z0-9_]+\]\s*$/.test(lines[i])) break;
      if (/^\s*enabled\s*=/.test(lines[i])) { enabledIdx = i; break; }
    }
    if (enabledIdx >= 0) {
      lines[enabledIdx] = `enabled = ${value}`;
    } else {
      lines.splice(insertAt, 0, `enabled = ${value}`);
    }
  }

  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, lines.join("\n") + (lines[lines.length - 1] === "" ? "" : "\n"));
  renameSync(tmp, path);
}
