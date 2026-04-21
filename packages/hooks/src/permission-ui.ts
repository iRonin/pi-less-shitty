/**
 * Interactive permission UI for the hooks system.
 *
 * Replaces binary ctx.ui.confirm() with a 4-choice dialog:
 *   1. Deny                    — block with minimal message
 *   2. Deny & Steer            — block + suggest alternative
 *   3. Allow for Session       — allow for remainder of this session
 *   4. Allow Permanently       — write allow rule to .pi-hooks
 *
 * Also provides session-scoped allowlist (in-memory, cleared on session_start).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";

// ============================================================================
// Sound / terminal bell for attention
// ============================================================================

/**
 * Play attention sound for hooks permission prompt.
 * Urgent: Sosumi + bell + badge.
 */
export function attentionSound(): void {
  // Terminal bell — triggers iTerm2's tab notification dot (blue dot on inactive tabs)
  process.stdout.write("\x07");

  // iTerm2 badge — shows ⚠️ in the tab bar even when focused
  process.stdout.write("\x1b]1337;SetBadgeFormat=⚠️\x07");

  // Urgent alert sound
  try {
    const child = spawn(
      "/usr/bin/afplay",
      ["/System/Library/Sounds/Sosumi.aiff"],
      { detached: true, stdio: "ignore" }
    );
    child.unref();
  } catch {
    // afplay not available — bell was already sent
  }
}

/**
 * Play a soft ding when the agent finishes a turn.
 * Gentle: bell only + Ping.aiff.
 */
export function agentDoneSound(): void {
  // Terminal bell — blue dot on inactive tab
  process.stdout.write("\x07");

  // Soft chime
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
// Auto pattern generation for "Allow Permanently" / "Allow for Session"
// ============================================================================

/**
 * Generalize a concrete command into a reusable regex pattern.
 * Keeps the full command structure, only generalizes truly variable parts:
 *   - File paths → [^ ]+
 *   - Quoted strings → generalized quote pairs
 *   - UUIDs / long hashes → [0-9a-f]+
 * Everything else is kept literally.
 */
export function generateAllowPattern(command: string): string {
  const p = command.trim();
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // Tokenize: quoted strings stay intact, everything else splits on whitespace
  const tokenRegex = /"[^"]*"|'[^']*'|\S+/g;
  const tokens: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = tokenRegex.exec(p)) !== null) {
    tokens.push(m[0]);
  }

  if (tokens.length === 0) return "^" + esc(p) + "$";

  const parts: string[] = [];
  for (const token of tokens) {
    // Quoted strings → generalized
    if ((token.startsWith('"') && token.endsWith('"')) ||
        (token.startsWith("'") && token.endsWith("'"))) {
      const q = token[0];
      parts.push(q + '[^"' + (q === "'" ? "'" : '') + "]+" + q);
    }
    // Path-like (contains / and not a flag)
    else if (token.includes("/") && !token.startsWith("-")) {
      parts.push("[^\\s]+");
    }
    // UUID
    else if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)) {
      parts.push("[0-9a-f-]+");
    }
    // Long hex hash (8+ chars)
    else if (/^[0-9a-f]{8,}$/i.test(token)) {
      parts.push("[0-9a-f]+");
    }
    // Everything else → literal (escaped)
    else {
      parts.push(esc(token));
    }
  }

  return "^\\s*" + parts.join("\\s+") + "$";
}

// ============================================================================
// Session-scoped allowlist
// ============================================================================

/** Patterns allowed for the current session only. */
const sessionAllowlist = new Set<string>();

export function clearSessionAllowlist(): void {
  sessionAllowlist.clear();
}

export function isSessionAllowed(command: string): boolean {
  for (const pat of sessionAllowlist) {
    try {
      if (new RegExp(pat).test(command)) return true;
    } catch { /* skip invalid regex */ }
  }
  return false;
}

export function addToSessionAllowlist(pattern: string): void {
  sessionAllowlist.add(pattern);
}

// ============================================================================
// Permission dialog
// ============================================================================

export type PermissionChoice =
  | "allow"
  | "allow-session"
  | "allow-permanent"
  | "deny"
  | "deny-steer";

export interface PermissionResult {
  choice: PermissionChoice;
  /** For "deny-steer": the steer message the user typed. */
  steerMessage?: string;
  /** For "allow-permanent": the regex pattern to write. */
  permanentPattern?: string;
}

/**
 * Prevents concurrent prompts for the same command when multiple
 * extensions both have tool_call handlers (index.ts + safety-hooks.ts).
 */
const promptingFor = new Set<string>();

export function isAlreadyPrompting(command: string): boolean {
  return promptingFor.has(command);
}

export function markPrompting(command: string): void {
  promptingFor.add(command);
}

export function unmarkPrompting(command: string): void {
  promptingFor.delete(command);
}

/**
 * Show a 4-choice permission dialog.
 * Returns null if the dialog was dismissed.
 */
export async function askPermission(
  command: string,
  reason: string,
  ui: {
    select(title: string, options: string[]): Promise<string | undefined>;
    input(title: string, placeholder?: string): Promise<string | undefined>;
    confirm(title: string, message: string): Promise<boolean>;
    hasUI: boolean;
  },
): Promise<PermissionResult | null> {
  if (!ui.hasUI) {
    return { choice: "deny" }; // no UI → safe default: deny
  }

  // Play attention sound — user needs to interact
  attentionSound();

  // Prevent double prompts when multiple handlers fire for the same command
  if (isAlreadyPrompting(command)) {
    return { choice: "allow" }; // other handler is already handling it
  }
  markPrompting(command);

  try {
    const choice = await ui.select("⚠️ Command Permission", [
      "Allow",
      "Allow for Session",
      "Allow Permanently",
      "Deny",
      "Deny & Steer",
    ]);

    if (!choice) return null; // dismissed

    switch (choice) {
      case "Allow":
        return { choice: "allow" };

      case "Allow for Session": {
        const pattern = generateAllowPattern(command);
        addToSessionAllowlist(pattern);
        return { choice: "allow-session" };
      }

      case "Allow Permanently":
        // Store exact command as literal — config-store handles escaping
        return { choice: "allow-permanent", permanentPattern: command };

      case "Deny":
        return { choice: "deny" };

      case "Deny & Steer": {
        const steerMessage = await ui.input(
          "Steer message",
          `Instead of '${truncate(command, 60)}...', suggest: `,
        );
        return { choice: "deny-steer", steerMessage };
      }

      default:
        return null;
    }
  } finally {
    // Clear iTerm2 badge after user responds
    process.stdout.write("\x1b]1337;ClearBadgeFormat\x07");
    unmarkPrompting(command);
  }
}

/**
 * Build the block reason string from a permission result.
 * For "deny-steer", the steer message IS the reason (visible to LLM as tool result).
 */
export function buildBlockReason(
  command: string,
  result: PermissionResult,
): string {
  switch (result.choice) {
    case "deny":
      return `BLOCKED by user: ${command}`;
    case "deny-steer":
      return result.steerMessage
        ? `BLOCKED: ${result.steerMessage}`
        : `BLOCKED by user: ${command}`;
    case "allow-session":
    case "allow-permanent":
      throw new Error("buildBlockReason called on allow result");
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}
