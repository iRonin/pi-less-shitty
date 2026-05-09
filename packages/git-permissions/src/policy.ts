/**
 * Pure policy helpers for git-permissions. No runtime peer dependency on
 * the pi extension API — kept separate so this module can be unit-tested
 * in isolation.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type PermissionAction = "allow" | "ask" | "deny";

export interface PermissionRule {
  action: PermissionAction;
  pattern: RegExp;
  rawPattern: string;
}

/**
 * Check if `child` is the same as or nested under `parent`.
 * Both arguments must be absolute, normalized paths.
 */
export function isWithinDir(child: string, parent: string): boolean {
  if (child === parent) return true;
  const rel = path.relative(parent, child);
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Find and parse .git-permissions file in directory tree.
 *
 * Walks from cwd upward but never crosses $HOME — files outside the user's
 * home directory cannot affect policy. Refuses to read non-regular files
 * (symlinks, devices) to defeat symlink races.
 */
export function findGitPermissions(
  cwd: string,
  homeDir: string = os.homedir()
): PermissionRule[] | null {
  let dir = path.resolve(cwd);
  const home = path.resolve(homeDir);

  // If cwd is not inside (or equal to) the user's home dir, do not walk at all.
  if (!isWithinDir(dir, home)) {
    return null;
  }

  let permissionsFile: string | null = null;

  while (true) {
    const candidate = path.join(dir, ".git-permissions");
    try {
      const stat = fs.lstatSync(candidate);
      if (stat.isFile()) {
        // lstat.isFile() returns true only for regular files, not symlinks.
        permissionsFile = candidate;
        break;
      } else if (stat.isSymbolicLink()) {
        console.error(
          `[git-permissions] refusing to use symlink: ${candidate}`
        );
      }
    } catch {
      // ENOENT or other access error — keep walking.
    }

    if (dir === home) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  if (!permissionsFile) {
    return null;
  }

  // Parse the permissions file
  try {
    const content = fs.readFileSync(permissionsFile, "utf-8");
    const lines = content.split("\n");
    const rules: PermissionRule[] = [];

    for (let i = 0; i < lines.length; i++) {
      const lineNum = i + 1;
      const trimmed = lines[i].trim();

      // Skip empty lines and comments
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }

      // Parse "action pattern" format
      const spaceIndex = trimmed.indexOf(" ");
      if (spaceIndex === -1) {
        continue;
      }

      const action = trimmed.slice(0, spaceIndex) as PermissionAction;
      const pattern = trimmed.slice(spaceIndex + 1);

      if (!["allow", "ask", "deny"].includes(action)) {
        console.error(
          `[git-permissions] invalid action in ${permissionsFile}:${lineNum}: '${action}'`
        );
        continue;
      }

      if (!pattern) {
        console.error(
          `[git-permissions] empty pattern in ${permissionsFile}:${lineNum}`
        );
        continue;
      }

      try {
        rules.push({
          action,
          pattern: new RegExp(pattern),
          rawPattern: pattern,
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(
          `[git-permissions] invalid pattern in ${permissionsFile}:${lineNum}: ${msg}`
        );
      }
    }

    return rules.length > 0 ? rules : null;
  } catch (error) {
    console.error(`[git-permissions] Error reading ${permissionsFile}:`, error);
    return null;
  }
}

/**
 * Check if a command matches any permission rule.
 * Returns the action of the first matching rule, or null if no match.
 */
export function checkPermission(
  command: string,
  rules: PermissionRule[]
): PermissionAction | null {
  for (const rule of rules) {
    if (rule.pattern.test(command)) {
      return rule.action;
    }
  }
  return null;
}

/**
 * Split chained commands (;, &&, ||, |) while respecting quotes.
 */
export function splitChainedCommands(command: string): string[] {
  const result: string[] = [];
  let current: string[] = [];
  let i = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;

  while (i < command.length) {
    const char = command[i];

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      current.push(char);
    } else if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      current.push(char);
    } else if (!inSingleQuote && !inDoubleQuote) {
      if (command.slice(i, i + 2) === "&&") {
        result.push(current.join(""));
        current = [];
        i += 2;
        continue;
      } else if (command.slice(i, i + 2) === "||") {
        result.push(current.join(""));
        current = [];
        i += 2;
        continue;
      } else if (char === ";") {
        result.push(current.join(""));
        current = [];
      } else if (char === "|") {
        result.push(current.join(""));
        current = [];
      } else {
        current.push(char);
      }
    } else {
      current.push(char);
    }
    i++;
  }

  if (current.length > 0) {
    result.push(current.join(""));
  }

  return result.map((s) => s.trim()).filter(Boolean);
}

/**
 * Tokenize a shell command string respecting single/double quotes and
 * backslash escapes inside double quotes. Returns null on unbalanced quotes.
 *
 * NOTE: This is a permissive shell-like tokenizer used for policy evaluation
 * only. It does not perform variable/command/glob expansion.
 */
export function tokenize(s: string): string[] | null {
  const tokens: string[] = [];
  let cur = "";
  let i = 0;
  let inSingle = false;
  let inDouble = false;
  let hasContent = false;

  while (i < s.length) {
    const c = s[i];
    if (inSingle) {
      if (c === "'") {
        inSingle = false;
      } else {
        cur += c;
      }
    } else if (inDouble) {
      if (c === '"') {
        inDouble = false;
      } else if (c === "\\" && i + 1 < s.length) {
        cur += s[i + 1];
        i++;
      } else {
        cur += c;
      }
    } else if (c === "'") {
      inSingle = true;
      hasContent = true;
    } else if (c === '"') {
      inDouble = true;
      hasContent = true;
    } else if (c === "\\" && i + 1 < s.length) {
      cur += s[i + 1];
      i++;
      hasContent = true;
    } else if (/\s/.test(c)) {
      if (hasContent) {
        tokens.push(cur);
        cur = "";
        hasContent = false;
      }
    } else {
      cur += c;
      hasContent = true;
    }
    i++;
  }

  if (inSingle || inDouble) return null;
  if (hasContent) tokens.push(cur);
  return tokens;
}

const WRAPPER_HEADS = new Set(["bash", "sh", "zsh", "eval", "xargs", "env"]);
const XARGS_FLAGS_WITH_ARG = new Set([
  "-I",
  "-n",
  "-P",
  "-E",
  "-d",
  "-L",
  "-s",
  "--max-args",
  "--max-procs",
  "--replace",
]);

/**
 * Detect wrapper commands (bash -c, sh -c, eval, xargs, env) and unwrap one
 * level to expose the real underlying command for policy evaluation.
 *
 * Returns:
 *  - { command }                 — for non-wrappers (cmd unchanged) and for
 *                                  successfully unwrapped wrappers.
 *  - { command, failed: true }   — wrapper detected but payload could not be
 *                                  parsed (caller should fail-closed / deny).
 *
 * Only one level of recursion is performed; nested wrappers like
 * `bash -c "bash -c '...'"` are intentionally NOT recursed further.
 */
export function unwrapCommand(cmd: string): {
  command: string;
  failed?: boolean;
} {
  const trimmed = cmd.trim();
  if (!trimmed) return { command: trimmed };

  // Cheap head probe so we can detect "wrapper-shaped" commands even if
  // tokenization later fails (unbalanced quotes inside payload).
  const headMatch = trimmed.match(/^([A-Za-z_][\w-]*)/);
  const head = headMatch?.[1];
  const isWrapperShape = !!head && WRAPPER_HEADS.has(head);

  const tokens = tokenize(trimmed);
  if (tokens === null) {
    // Tokenization failed. If it looks like a wrapper, fail closed.
    if (isWrapperShape) {
      return { command: trimmed, failed: true };
    }
    return { command: trimmed };
  }

  if (tokens.length === 0) return { command: trimmed };
  const headTok = tokens[0];

  // env [KEY=VAL]... cmd args...
  if (headTok === "env") {
    let i = 1;
    while (i < tokens.length) {
      const t = tokens[i];
      if (t === "--") {
        i++;
        break;
      }
      if (/^-/.test(t)) {
        if (t === "-u" || t === "--unset") {
          i += 2;
        } else {
          i++;
        }
        continue;
      }
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
        i++;
        continue;
      }
      break;
    }
    if (i >= tokens.length) return { command: "" };
    return { command: tokens.slice(i).join(" ") };
  }

  // xargs [-flags...] cmd args...
  if (headTok === "xargs") {
    let i = 1;
    while (i < tokens.length && tokens[i].startsWith("-")) {
      const flag = tokens[i];
      if (flag.includes("=")) {
        i++;
        continue;
      }
      const shortWithVal = /^-[InPEdLs].+$/.test(flag);
      if (shortWithVal) {
        i++;
        continue;
      }
      if (XARGS_FLAGS_WITH_ARG.has(flag)) {
        i += 2;
      } else {
        i++;
      }
    }
    if (i >= tokens.length) return { command: "" };
    return { command: tokens.slice(i).join(" ") };
  }

  // bash/sh/zsh -c <str>
  if (headTok === "bash" || headTok === "sh" || headTok === "zsh") {
    for (let i = 1; i < tokens.length; i++) {
      const t = tokens[i];
      if (t === "-c" || t === "--command") {
        if (i + 1 < tokens.length) {
          return { command: tokens[i + 1] };
        }
        return { command: trimmed, failed: true };
      }
    }
    // No -c flag — shell invocation without inline command.
    return { command: "" };
  }

  // eval <str> [<str>...]  — bash concatenates args with spaces and evaluates.
  if (headTok === "eval") {
    if (tokens.length < 2) {
      return { command: trimmed, failed: true };
    }
    return { command: tokens.slice(1).join(" ") };
  }

  return { command: trimmed };
}
