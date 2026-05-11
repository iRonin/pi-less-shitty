/**
 * Phase A — JSONL capture of every assistant message for offline replay.
 *
 * Toggled by `LOOP_DEBUG_CAPTURE=true` (or `loopDetection.debugCapture=true`
 * in settings.json). When on, every assistant message that pi finalizes is
 * appended as a single JSON line to:
 *
 *     ~/.pi/agent/loop-debug/<session_id>.jsonl
 *
 * Each line:
 *   { ts, role, text, thinking, toolCalls, completionTokens, model? }
 *
 * - Auto-rotates at 50 MB per session file (`<session_id>.<N>.jsonl`).
 * - Auto-deletes session files (and rotations) older than 30 days on startup.
 *
 * Pure local capture — nothing leaves disk.
 */

import { existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const CAPTURE_DIR = join(homedir(), ".pi", "agent", "loop-debug");
const ROTATE_BYTES = 50 * 1024 * 1024;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export interface CapturedAssistantTurn {
  ts: number;
  role: "assistant";
  /** Concatenated text content blocks (the final reply text). */
  text: string;
  /** Concatenated thinking content blocks. */
  thinking: string;
  /** Compact tool-call dump: name + serialized args. */
  toolCalls: Array<{ name: string; args: unknown }>;
  /** Completion token count if pi attached usage to this message. */
  completionTokens: number | null;
  /** Provider/model string if available. */
  model?: string;
}

/** Walk an assistant message and pull out (text, thinking, toolCalls). */
export function extractTurn(message: unknown): CapturedAssistantTurn | null {
  if (!message || typeof message !== "object") return null;
  const m = message as Record<string, unknown>;
  if (m.role !== "assistant") return null;

  const content = Array.isArray(m.content) ? (m.content as Array<Record<string, unknown>>) : [];

  let text = "";
  let thinking = "";
  const toolCalls: Array<{ name: string; args: unknown }> = [];

  for (const part of content) {
    const t = part?.type;
    if (t === "text" && typeof part.text === "string") {
      text += (text ? "\n" : "") + (part.text as string);
    } else if (t === "thinking" && typeof part.text === "string") {
      thinking += (thinking ? "\n" : "") + (part.text as string);
    } else if (t === "toolCall") {
      toolCalls.push({
        name: typeof part.name === "string" ? (part.name as string) : "<unknown>",
        args: part.input ?? part.arguments ?? null,
      });
    }
  }

  const usage = m.usage as Record<string, unknown> | undefined;
  const completionTokens =
    usage && typeof usage.output === "number"
      ? (usage.output as number)
      : usage && typeof usage.completionTokens === "number"
        ? (usage.completionTokens as number)
        : null;

  const model = typeof m.model === "string" ? (m.model as string) : undefined;

  return {
    ts: Date.now(),
    role: "assistant",
    text,
    thinking,
    toolCalls,
    completionTokens,
    model,
  };
}

/** Ensure capture dir exists and prune files older than MAX_AGE_MS. */
export function ensureCaptureDir(): void {
  try {
    if (!existsSync(CAPTURE_DIR)) {
      mkdirSync(CAPTURE_DIR, { recursive: true });
    }
  } catch (e) {
    console.error(`[loop-detector] capture: cannot create ${CAPTURE_DIR}: ${(e as Error).message}`);
  }
}

/** Delete session files older than 30 days. Called once at extension startup. */
export function gcOldCaptures(now = Date.now()): void {
  try {
    if (!existsSync(CAPTURE_DIR)) return;
    const cutoff = now - MAX_AGE_MS;
    for (const entry of readdirSync(CAPTURE_DIR)) {
      if (!entry.endsWith(".jsonl")) continue;
      const path = join(CAPTURE_DIR, entry);
      try {
        const st = statSync(path);
        if (st.mtimeMs < cutoff) {
          unlinkSync(path);
        }
      } catch {
        /* skip */
      }
    }
  } catch {
    /* swallow */
  }
}

function targetPath(sessionId: string): string {
  return join(CAPTURE_DIR, `${sessionId}.jsonl`);
}

function rotateIfNeeded(sessionId: string): void {
  const path = targetPath(sessionId);
  if (!existsSync(path)) return;
  try {
    const st = statSync(path);
    if (st.size < ROTATE_BYTES) return;
  } catch {
    return;
  }
  // Find next rotation index
  for (let i = 1; i < 10_000; i++) {
    const rot = join(CAPTURE_DIR, `${sessionId}.${i}.jsonl`);
    if (!existsSync(rot)) {
      try {
        renameSync(path, rot);
      } catch (e) {
        console.error(`[loop-detector] capture: rotation failed: ${(e as Error).message}`);
      }
      return;
    }
  }
}

/** Append one captured turn to the session's JSONL file. */
export function appendCapture(sessionId: string, turn: CapturedAssistantTurn): void {
  if (!sessionId) return;
  try {
    ensureCaptureDir();
    rotateIfNeeded(sessionId);
    appendFileSync(targetPath(sessionId), JSON.stringify(turn) + "\n", "utf-8");
  } catch (e) {
    // Capture is best-effort — never crash the host process over a write fail.
    console.error(`[loop-detector] capture: append failed: ${(e as Error).message}`);
  }
}
