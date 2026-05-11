/**
 * Permission UI — Session allowlist and attention sounds.
 *
 * Dialog code removed in V2 — the agent now receives structured
 * analysis instead of user dialogs. Use the notify_user tool
 * (registered in index.ts) when user confirmation is needed.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";

// ============================================================================
// Sound / terminal bell for attention
// ============================================================================

/**
 * Play attention sound for urgent notifications.
 * Sosumi + bell.
 */
export function attentionSound(): void {
  process.stdout.write("\x07");
  try {
    const child = spawn(
      "/usr/bin/afplay",
      ["/System/Library/Sounds/Sosumi.aiff"],
      { detached: true, stdio: "ignore" }
    );
    child.unref();
  } catch {}
}

/**
 * Play a soft ding when the agent finishes a turn.
 * Ping.aiff + bell.
 */
export function agentDoneSound(): void {
  process.stdout.write("\x07");
  try {
    const child = spawn(
      "/usr/bin/afplay",
      ["/System/Library/Sounds/Ping.aiff"],
      { detached: true, stdio: "ignore" }
    );
    child.unref();
  } catch {}
}

// ============================================================================
// Session-scoped allowlist with TTL
//
// Stored as literal full command strings keyed to an expiry timestamp.
// Matching uses exact equality — NOT regex. Approving "git status" must
// NOT match "git statusXXX" or "Xgit status", and approving a string with
// regex metachars (`.`, `()`, `*`) must be treated literally.
//
// TTL is intentionally short (60s) so that a stale Approve cannot keep
// shadowing a hard-block forever. The intent is: the user just clicked
// Approve on this exact command, so the immediately-following bash call
// gets a one-shot bypass — not a session-wide license.
// ============================================================================

export const SESSION_ALLOWLIST_TTL_MS = 60_000;

// Indirected via a getter so tests can stub Date.now() if needed.
let nowFn: () => number = () => Date.now();
export function _setNowForTests(fn: () => number): void {
  nowFn = fn;
}
export function _resetNowForTests(): void {
  nowFn = () => Date.now();
}

const sessionAllowlist = new Map<string, number>();

function pruneExpired(): void {
  const now = nowFn();
  for (const [cmd, expiresAt] of sessionAllowlist) {
    if (expiresAt <= now) sessionAllowlist.delete(cmd);
  }
}

export function clearSessionAllowlist(): void {
  sessionAllowlist.clear();
}

/**
 * Strict equality against stored literal command strings. Prunes expired
 * entries lazily on every lookup so a stale Approve can never resurface.
 */
export function isSessionAllowed(command: string): boolean {
  const expiresAt = sessionAllowlist.get(command);
  if (expiresAt === undefined) return false;
  if (expiresAt <= nowFn()) {
    sessionAllowlist.delete(command);
    return false;
  }
  return true;
}

/**
 * Adds a literal full command string with a 60s expiry. No regex, no
 * fragmentation. Multiple Approves for the same command refresh the TTL.
 */
export function addToSessionAllowlist(command: string): void {
  pruneExpired();
  sessionAllowlist.set(command, nowFn() + SESSION_ALLOWLIST_TTL_MS);
}

/** Test-only inspector. Returns currently-live entries (post-prune). */
export function _sessionAllowlistSnapshot(): string[] {
  pruneExpired();
  return [...sessionAllowlist.keys()];
}
