/**
 * Flexible Hooks Permission System
 *
 * Provides directory-based permission control for any bash commands.
 * Uses .pi-hooks files to define allow/ask/deny rules with regex patterns.
 * Supports cascading permissions, command chaining, and path-based rules.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  clearSessionAllowlist,
  isSessionAllowed,
  addToSessionAllowlist,
  askPermission,
  buildBlockReason,
  agentDoneSound,
  isAlreadyPrompting,
} from "./permission-ui.js";
import {
  loadHooksConfig,
  addRule,
  type HookAction,
  type LoadedRule,
} from "./config-store.js";

/**
 * Permission action types — re-exported for checkPermission
 */
type PermissionAction = HookAction;

/**
 * Command context for permission checks
 */
interface CommandContext {
  command: string;
  cwd: string;
  projectRoot: string;
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Resolve home directory paths (~, $HOME)
 * @internal - exported for testing
 */
export function resolveHomePath(p: string): string {
  const home = os.homedir();
  p = p.replace(/^~\//, home + "/");
  p = p.replace(/^~$/, home);
  p = p.replace(/\$HOME/g, home);
  p = p.replace(/\$\{HOME\}/g, home);
  return p;
}

/**
 * Get real path with fallback
 * @internal - exported for testing
 */
export function safeRealpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Find project root by searching for .git
 * Only uses .git to avoid accidental project root detection from misplaced .pi-hooks files
 * @internal - exported for testing
 */
export function findProjectRoot(start: string): string {
  let dir = start;
  while (dir !== "/" && dir !== ".") {
    if (fs.existsSync(path.join(dir, ".git"))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return start;
}

/**
 * Check if a file path is safe (within project or allowed directories)
 * @internal - exported for testing
 */
export function isPathSafe(filePath: string, projectRoot: string): boolean {
  const resolved = safeRealpath(resolveHomePath(filePath));
  const project = safeRealpath(projectRoot);
  const downloads = safeRealpath(path.join(os.homedir(), "Downloads"));
  const tmpDirs = ["/tmp", "/private/tmp"];

  // /tmp is always safe
  if (tmpDirs.some((tmp) => resolved.startsWith(tmp + "/") || resolved === tmp)) {
    return true;
  }

  // ~/Downloads is safe
  if (resolved.startsWith(downloads + "/") || resolved === downloads) {
    return true;
  }

  // Inside project
  if ((resolved + "/").startsWith(project + "/")) {
    return true;
  }

  // Inside a git repo whose root matches our project
  const pathRoot = findProjectRoot(
    fs.statSync(resolved).isDirectory() ? resolved : path.dirname(resolved)
  );
  if (pathRoot === project) {
    return true;
  }

  return false;
}

// ============================================================================
// Configuration Loading
// ============================================================================

/**
 * Find hooks config — searches from cwd upward (text .pi-hooks auto-migrated).
 */
function findHooksConfig(cwd: string): { rules: LoadedRule[]; filePath: string } | null {
  let dir = cwd;
  while (dir !== "/" && dir !== ".") {
    const config = loadHooksConfig(dir);
    if (config) return config;
    dir = path.dirname(dir);
  }
  return null;
}

/**
 * Add a permanent rule to the hooks config in CWD.
 */
function addPermanentRule(cwd: string, command: string): void {
  if (!addRule(cwd, "allow", command)) {
    // CWD not writable — try creating in a parent that exists
    try { fs.mkdirSync(cwd, { recursive: true }); } catch { return; }
    addRule(cwd, "allow", command);
  }
}

/**
 * Check if a command matches any permission rule
 */
export function checkPermission(command: string, rules: LoadedRule[]): PermissionAction | null {
  for (const rule of rules) {
    if (rule.pattern.test(command)) {
      return rule.action;
    }
  }
  return null;
}

// ============================================================================
// Command Parsing
// ============================================================================

/**
 * Split chained commands (;, &&, ||, |) while respecting quotes
 * @internal - exported for testing
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
 * Basic shell argument splitter
 */
function shellSplit(cmd: string): string[] {
  const args: string[] = [];
  let current = "";
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escape = false;

  for (const char of cmd) {
    if (escape) {
      current += char;
      escape = false;
      continue;
    }
    if (char === "\\" && !inSingleQuote) {
      escape = true;
      continue;
    }
    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }
    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }
    if ((char === " " || char === "\t") && !inSingleQuote && !inDoubleQuote) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) args.push(current);
  return args;
}

/**
 * Extract redirect target from command
 */
function extractRedirectTarget(cmd: string): string | null {
  const match =
    cmd.match(/>>?\s*"([^"]+)"/) ||
    cmd.match(/>>?\s*([/~$][^\s);&|]*)/);
  if (!match) return null;
  let target = match[1];
  target = target.replace(/[);&|]+$/, "");

  // Skip safe redirects
  if (
    target === "/dev/null" ||
    target === "/dev/stdout" ||
    target === "/dev/stderr" ||
    target.startsWith("/tmp/") ||
    target.startsWith("/private/tmp/")
  ) {
    return null;
  }
  return target;
}

// ============================================================================
// Built-in Safety Rules
// ============================================================================

/**
 * Hard-blocked commands (cannot be overridden by .pi-hooks)
 */
const HARD_BLOCKS = [
  { pattern: /\bsudo\s/, reason: "HARD BLOCK: 'sudo' is never allowed via agent." },
  {
    pattern: /\b(dd|mkfs\S*|diskutil)\s/,
    reason: "HARD BLOCK: Disk operations are never allowed via agent.",
  },
  {
    pattern: />\s*\/dev\/(sd|hd|disk|nvme|mmcblk)/,
    reason: "HARD BLOCK: Writing to device files is never allowed via agent.",
  },
  {
    pattern: /\b(DROP\s+TABLE|TRUNCATE\s+TABLE|DROP\s+DATABASE)\b/i,
    reason: "HARD BLOCK: Destructive SQL operations are never allowed via agent.",
  },
  {
    pattern: /\bkill\s+(-9\s+)?-1(\s|$)/,
    reason: "HARD BLOCK: 'kill -1' kills all user processes.",
  },
];

/**
 * Commands that require approval (unless explicitly allowed in .pi-hooks)
 */
const ALWAYS_ASK = [
  {
    pattern: /(^|\s|\/)(bash|sh)\s+-(l?c|cl)\s/,
    reason: "Opaque shell command detected",
  },
  {
    pattern: /(^|\s)eval\s/,
    reason: "Opaque eval command detected",
  },
  {
    pattern: /\|\s*(bash|sh)\s*$/,
    reason: "Pipe to shell detected",
  },
];

// ============================================================================
// Extension Entry Point
// ============================================================================

export default function (pi: ExtensionAPI) {
  // Track all bash commands via tool_call event
  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("bash", event)) {
      return undefined;
    }

    const command = event.input.command;
    if (!command) {
      return undefined;
    }

    const projectRoot = findProjectRoot(ctx.cwd);

    // Find hooks config for current directory
    const config = findHooksConfig(ctx.cwd);

    // Split chained commands and check each one
    const subcommands = splitChainedCommands(command);

    for (const subcmd of subcommands) {
      const cmd = subcmd.trim();
      if (!cmd) continue;

      // ─── 1. Hard blocks (cannot be overridden by anything) ───
      for (const block of HARD_BLOCKS) {
        if (block.pattern.test(cmd)) {
          return { block: true, reason: block.reason };
        }
      }

      // ─── 2. Session allowlist (approved this session) ───
      if (isSessionAllowed(cmd)) {
        continue;
      }

      // ─── 2b. Already being prompted by another handler ───
      if (isAlreadyPrompting(cmd)) {
        continue; // let the other handler decide
      }

      // ─── 3. .pi-hooks rules — allow/deny/ask ───
      // NOTE: checked BEFORE ALWAYS_ASK so .pi-hooks "allow" bypasses opaque check
      if (config) {
        const permission = checkPermission(cmd, config.rules);

        if (permission === "allow") {
          // Explicitly allowed — skip all remaining checks
          continue;
        }

        if (permission === "deny") {
          return {
            block: true,
            reason: `.pi-hooks: Command denied by rule at line ${
              config.rules.find((r) => r.pattern.test(cmd))?.line
            }`,
          };
        }

        if (permission === "ask") {
          const result = await askPermission(cmd, ".pi-hooks: rule requires approval", {
            select: (title, options) => ctx.ui.select(title, options),
            input: (title, placeholder) => ctx.ui.input(title, placeholder),
            confirm: (title, msg) => ctx.ui.confirm(title, msg),
            hasUI: ctx.hasUI,
          });
          if (!result) return { block: true, reason: "Permission dialog dismissed." };
          if (result.choice === "allow") continue;
          if (result.choice === "deny" || result.choice === "deny-steer") {
            return { block: true, reason: buildBlockReason(cmd, result) };
          }
          if (result.choice === "allow-session") {
            addToSessionAllowlist(cmd);
            continue;
          }
          if (result.choice === "allow-permanent" && result.permanentPattern) {
            addToSessionAllowlist(result.permanentPattern);
            addPermanentRule(ctx.cwd, result.permanentPattern);
            continue;
          }
        }
      }

      // ─── 4. ALWAYS_ASK — opaque commands (only if no .pi-hooks allow matched) ───
      for (const askRule of ALWAYS_ASK) {
        if (askRule.pattern.test(cmd)) {
          const result = await askPermission(cmd, askRule.reason, {
            select: (title, options) => ctx.ui.select(title, options),
            input: (title, placeholder) => ctx.ui.input(title, placeholder),
            confirm: (title, msg) => ctx.ui.confirm(title, msg),
            hasUI: ctx.hasUI,
          });
          if (!result) return { block: true, reason: "Permission dialog dismissed." };
          if (result.choice === "allow") continue;
          if (result.choice === "deny" || result.choice === "deny-steer") {
            return { block: true, reason: buildBlockReason(cmd, result) };
          }
          if (result.choice === "allow-session") {
            addToSessionAllowlist(cmd);
            continue;
          }
          if (result.choice === "allow-permanent" && result.permanentPattern) {
            addToSessionAllowlist(result.permanentPattern);
            addPermanentRule(ctx.cwd, result.permanentPattern);
            continue;
          }
          break;
        }
      }

      // ─── 5. File operations — path safety with permission dialog ───
      const fileOpMatch = cmd.match(/(^|\s)(rm|rmdir|unlink|mv|cp|ln)\s/);
      if (fileOpMatch) {
        const fileOp = fileOpMatch[2];
        const args = shellSplit(cmd);

        for (const arg of args.slice(1)) {
          if (arg.startsWith("-")) continue;

          try {
            const expanded = resolveHomePath(arg);
            const resolved = path.isAbsolute(expanded)
              ? safeRealpath(expanded)
              : safeRealpath(path.join(ctx.cwd, expanded));

            if (!isPathSafe(resolved, projectRoot)) {
              const result = await askPermission(cmd, `'${fileOp}' targets '${arg}' outside project`, {
                select: (title, options) => ctx.ui.select(title, options),
                input: (title, placeholder) => ctx.ui.input(title, placeholder),
                confirm: (title, msg) => ctx.ui.confirm(title, msg),
                hasUI: ctx.hasUI,
              });
              if (!result) return { block: true, reason: "Permission dialog dismissed." };
              if (result.choice === "allow") continue;
              if (result.choice === "deny" || result.choice === "deny-steer") {
                return { block: true, reason: buildBlockReason(cmd, result) };
              }
              if (result.choice === "allow-session") {
                addToSessionAllowlist(cmd);
              } else if (result.choice === "allow-permanent" && result.permanentPattern) {
                addToSessionAllowlist(result.permanentPattern);
                addPermanentRule(ctx.cwd, result.permanentPattern);
              }
              break;
            }
          } catch {
            // Path doesn't exist yet - only worry about rm
            if (fileOp === "rm") {
              const expanded = resolveHomePath(arg);
              const abs = path.isAbsolute(expanded)
                ? expanded
                : path.resolve(ctx.cwd, expanded);
              const projResolved = safeRealpath(projectRoot);

              if (!(abs + "/").startsWith(projResolved + "/")) {
                const result = await askPermission(cmd, `'${fileOp}' targets '${arg}' outside project`, {
                  select: (title, options) => ctx.ui.select(title, options),
                  input: (title, placeholder) => ctx.ui.input(title, placeholder),
                  confirm: (title, msg) => ctx.ui.confirm(title, msg),
                  hasUI: ctx.hasUI,
                });
                if (!result) return { block: true, reason: "Permission dialog dismissed." };
                if (result.choice === "allow") continue;
                if (result.choice === "deny" || result.choice === "deny-steer") {
                  return { block: true, reason: buildBlockReason(cmd, result) };
                }
                if (result.choice === "allow-session") {
                  addToSessionAllowlist(cmd);
                } else if (result.choice === "allow-permanent" && result.permanentPattern) {
                  addToSessionAllowlist(result.permanentPattern);
                  addPermanentRule(ctx.cwd, result.permanentPattern);
                }
                break;
              }
            }
          }
        }
      }

      // ─── 6. Redirects — path safety with permission dialog ───
      const redirectTarget = extractRedirectTarget(cmd);
      if (redirectTarget) {
        try {
          const expanded = resolveHomePath(redirectTarget);
          const abs = path.isAbsolute(expanded)
            ? expanded
            : path.resolve(ctx.cwd, expanded);

          if (!isPathSafe(abs, projectRoot)) {
            const result = await askPermission(cmd, `Redirect to '${redirectTarget}' outside project`, {
              select: (title, options) => ctx.ui.select(title, options),
              input: (title, placeholder) => ctx.ui.input(title, placeholder),
              confirm: (title, msg) => ctx.ui.confirm(title, msg),
              hasUI: ctx.hasUI,
            });
            if (!result) return { block: true, reason: "Permission dialog dismissed." };
            if (result.choice === "allow") continue;
            if (result.choice === "deny" || result.choice === "deny-steer") {
              return { block: true, reason: buildBlockReason(cmd, result) };
            }
            if (result.choice === "allow-session") {
              addToSessionAllowlist(cmd);
            } else if (result.choice === "allow-permanent" && result.permanentPattern) {
              addToSessionAllowlist(result.permanentPattern);
              addPermanentRule(ctx.cwd, result.permanentPattern);
            }
          }
        } catch {}
      }

      // ─── 7. Dangerous commands (only if not explicitly allowed) ───
      if (!config || checkPermission(cmd, config.rules) !== "allow") {
        const dangerousCmds = [
          {
            pattern: /\b(kill|pkill)\s+(-9|-KILL|-SIGKILL)\s/,
            name: "Force kill",
          },
          {
            pattern: /\bkillall\s/,
            name: "killall",
          },
          {
            pattern: /\bchmod\s+777\b/,
            name: "chmod 777",
          },
          {
            pattern: /\bchown\s/,
            name: "chown",
          },
          {
            pattern: /\b(pip3?|brew)\s+uninstall\b/,
            name: "Package uninstall",
          },
          {
            pattern: /\b(truncate|shred)\s/,
            name: "File destruction",
          },
        ];

        for (const dangerous of dangerousCmds) {
          if (dangerous.pattern.test(cmd)) {
            const result = await askPermission(cmd, `'${dangerous.name}' detected`, {
              select: (title, options) => ctx.ui.select(title, options),
              input: (title, placeholder) => ctx.ui.input(title, placeholder),
              confirm: (title, msg) => ctx.ui.confirm(title, msg),
              hasUI: ctx.hasUI,
            });
            if (!result) return { block: true, reason: "Permission dialog dismissed." };
            if (result.choice === "allow") continue;
            if (result.choice === "deny" || result.choice === "deny-steer") {
              return { block: true, reason: buildBlockReason(cmd, result) };
            }
            if (result.choice === "allow-session") {
              addToSessionAllowlist(cmd);
            } else if (result.choice === "allow-permanent" && result.permanentPattern) {
              addToSessionAllowlist(result.permanentPattern);
              addPermanentRule(ctx.cwd, result.permanentPattern);
            }
            break;
          }
        }
      }
    }

    return undefined;
  });

  // Reset session allowlist + notify on session start
  pi.on("session_start", async (_event, ctx) => {
    clearSessionAllowlist();
    const config = findHooksConfig(ctx.cwd);
    if (config) {
      ctx.ui.notify(
        `Pi hooks active: ${config.rules.length} rule(s) from ${path.relative(ctx.cwd, config.filePath)}`,
        "info"
      );
    }
  });

  // Play soft ding when agent finishes a turn
  pi.on("agent_end", async (_event, _ctx) => {
    agentDoneSound();
  });
}
