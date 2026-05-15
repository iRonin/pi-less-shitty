/**
 * JSON-based .pi-hooks.json config store.
 *
 * Format:
 * {
 *   "version": 1,
 *   "rules": [
 *     { "action": "allow", "command": "exact command string" },
 *     { "action": "deny", "pattern": "^\\s*rm\\s+-rf\\s+/" }
 *   ]
 * }
 *
 * - "command" = exact literal match (escaped to regex internally)
 * - "pattern" = user-provided regex for broader matching
 *
 * Handles complex commands with newlines, quotes, pipes safely.
 * Auto-migrates old text-based .pi-hooks format.
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ============================================================================
// Types
// ============================================================================

export type HookAction = "allow" | "ask" | "deny";

export interface HookRule {
  action: HookAction;
  /** Exact command string for literal match. */
  command?: string;
  /** Regex pattern for flexible matching. */
  pattern?: string;
  /** Human-readable description (optional). */
  note?: string;
}

export interface HooksConfig {
  version: 1;
  rules: HookRule[];
}

export interface LoadedRule {
  action: HookAction;
  pattern: RegExp;
  rawPattern: string;
}

export interface LoadedConfig {
  rules: LoadedRule[];
  filePath: string;
}

// ============================================================================
// File paths
// ============================================================================

/** Returns the .pi-hooks.json path for a directory. */
export function hooksFilePath(dir: string): string {
  return path.join(dir, ".pi-hooks.json");
}

// ============================================================================
// Loading
// ============================================================================

/**
 * Load hooks config from a directory.
 * Tries .pi-hooks.json first, falls back to old .pi-hooks text format
 * and auto-migrates it.
 */
export function loadHooksConfig(dir: string): LoadedConfig | null {
  const jsonPath = hooksFilePath(dir);
  const oldPath = path.join(dir, ".pi-hooks");

  // Try JSON format first
  if (fs.existsSync(jsonPath)) {
    try {
      const raw = fs.readFileSync(jsonPath, "utf-8");
      const config: HooksConfig = JSON.parse(raw);
      const rules: LoadedRule[] = [];

      for (const rule of config.rules ?? []) {
        const regex = ruleToRegex(rule);
        if (regex) rules.push(regex);
      }

      return { rules, filePath: jsonPath };
    } catch (err) {
      console.warn(`[pi-hooks] Error reading ${jsonPath}:`, err);
    }
  }

  // Fall back to old text format and migrate
  if (fs.existsSync(oldPath)) {
    const migrated = migrateOldFormat(oldPath);
    if (migrated) {
      return { rules: migrated, filePath: jsonPath };
    }
  }

  return null;
}

/**
 * Convert a HookRule to a LoadedRule.
 * "command" gets escaped to literal regex; "pattern" used as-is.
 */
function ruleToRegex(rule: HookRule): LoadedRule | null {
  let regex: RegExp | null = null;
  let rawPattern = "";

  if (rule.pattern) {
    rawPattern = rule.pattern;
    try {
      regex = new RegExp(rule.pattern);
    } catch {
      return null;
    }
  } else if (rule.command) {
    rawPattern = "^" + escapeRegex(rule.command) + "$";
    regex = new RegExp(rawPattern);
  }

  if (!regex) return null;

  return {
    action: rule.action,
    pattern: regex,
    rawPattern,
  };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ============================================================================
// Migration from old text format
// ============================================================================

function migrateOldFormat(oldPath: string): LoadedRule[] | null {
  try {
    const content = fs.readFileSync(oldPath, "utf-8");
    const lines = content.split("\n");
    const rules: HookRule[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      const spaceIdx = trimmed.indexOf(" ");
      if (spaceIdx === -1) continue;

      const action = trimmed.slice(0, spaceIdx) as HookAction;
      const pattern = trimmed.slice(spaceIdx + 1).trim();

      if (!["allow", "ask", "deny"].includes(action) || !pattern) continue;

      rules.push({ action, pattern });
    }

    if (rules.length === 0) return null;

    // Write new JSON format
    const jsonPath = hooksFilePath(path.dirname(oldPath));
    const config: HooksConfig = { version: 1, rules };
    fs.writeFileSync(jsonPath, JSON.stringify(config, null, 2) + "\n", "utf-8");

    // Remove old file
    try {
      fs.unlinkSync(oldPath);
    } catch {
      // best effort
    }

    console.log(`[pi-hooks] Migrated ${oldPath} → ${jsonPath}`);

    // Return loaded rules
    const loaded: LoadedRule[] = [];
    for (const rule of rules) {
      const r = ruleToRegex(rule);
      if (r) loaded.push(r);
    }
    return loaded;
  } catch {
    return null;
  }
}

// ============================================================================
// Writing
// ============================================================================

/**
 * Add a rule to the hooks config file.
 *
 * Creates the file if it doesn't exist. Deduplicates: won't add a rule
 * that already exists. Writes atomically: serialise to `${path}.tmp`,
 * fsync, then rename. If the existing config file is malformed, this
 * function THROWS rather than overwriting it — silently clobbering a
 * user's configured rules is unacceptable.
 */
export function addRule(
  dir: string,
  action: HookAction,
  commandOrPattern: string,
  opts: { kind?: "command" | "pattern"; note?: string } = {},
): boolean {
  const kind = opts.kind ?? "command";

  // Validate pattern rules at write time so we never persist a regex that
  // would later throw on load. A bad pattern silently dropped at load time
  // would be a fail-open: user thinks they have a rule, hooks ignore it.
  if (kind === "pattern") {
    try {
      // eslint-disable-next-line no-new
      new RegExp(commandOrPattern);
    } catch (err) {
      throw new Error(`[pi-hooks] invalid regex pattern: ${(err as Error).message}`);
    }
  }

  const jsonPath = hooksFilePath(dir);

  // Ensure directory exists
  if (!fs.existsSync(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      throw new Error(`[pi-hooks] cannot create ${dir}: ${(err as Error).message}`);
    }
  }

  // Load existing config. If parsing fails we refuse to clobber.
  let config: HooksConfig = { version: 1, rules: [] };
  if (fs.existsSync(jsonPath)) {
    const raw = fs.readFileSync(jsonPath, "utf-8");
    try {
      config = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `[pi-hooks] refusing to clobber malformed ${jsonPath}: ${(err as Error).message}`,
      );
    }
    if (!config || typeof config !== "object" || !Array.isArray(config.rules)) {
      throw new Error(`[pi-hooks] refusing to clobber malformed ${jsonPath}: missing rules array`);
    }
  }

  // Deduplicate: skip if identical rule already exists (same kind + value).
  for (const existing of config.rules) {
    if (existing.action !== action) continue;
    if (kind === "pattern" && existing.pattern === commandOrPattern) return false;
    if (kind === "command" && existing.command === commandOrPattern) return false;
  }

  const newRule: HookRule = kind === "pattern"
    ? { action, pattern: commandOrPattern }
    : { action, command: commandOrPattern };
  if (opts.note) newRule.note = opts.note;
  config.rules.push(newRule);
  const data = JSON.stringify(config, null, 2) + "\n";

  // Atomic write: write to ${path}.tmp, fsync, rename.
  const tmpPath = jsonPath + ".tmp";
  let fd: number | null = null;
  try {
    fd = fs.openSync(tmpPath, "w", 0o600);
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
  try {
    fs.renameSync(tmpPath, jsonPath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }
  return true;
}
