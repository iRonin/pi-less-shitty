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
// Session-scoped allowlist
//
// Stored as literal full command strings. Matching uses exact equality —
// NOT regex. Approving "git status" must NOT match "git statusXXX" or
// "Xgit status", and approving a string with regex metachars (`.`, `()`, `*`)
// must be treated literally.
// ============================================================================

const sessionAllowlist = new Set<string>();

export function clearSessionAllowlist(): void {
  sessionAllowlist.clear();
}

/** Strict equality against stored literal command strings. */
export function isSessionAllowed(command: string): boolean {
  return sessionAllowlist.has(command);
}

/** Adds a literal full command string. No regex, no fragmentation. */
export function addToSessionAllowlist(command: string): void {
  sessionAllowlist.add(command);
}

/** Test-only inspector. */
export function _sessionAllowlistSnapshot(): string[] {
  return [...sessionAllowlist];
}
