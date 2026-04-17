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

/**
 * Permission action types
 */
type PermissionAction = "allow" | "ask" | "deny";

/**
 * Parsed permission rule
 */
interface PermissionRule {
  action: PermissionAction;
  pattern: RegExp;
  rawPattern: string;
  line: number;
}

/**
 * Hooks configuration
 */
interface HooksConfig {
  rules: PermissionRule[];
  filePath: string;
  directory: string;
}

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
 * Find and parse .pi-hooks file in directory tree
 * Searches from cwd up to root, returns config from the deepest file found
 */
function findHooksConfig(cwd: string): HooksConfig | null {
  let dir = cwd;
  let hooksFile: string | null = null;

  // Walk up directory tree to find .pi-hooks
  while (dir !== "/" && dir !== ".") {
    const candidate = path.join(dir, ".pi-hooks");
    if (fs.existsSync(candidate)) {
      hooksFile = candidate;
      break;
    }
    dir = path.dirname(dir);
  }

  if (!hooksFile) {
    return null;
  }

  // Parse the hooks file
  try {
    const content = fs.readFileSync(hooksFile, "utf-8");
    const lines = content.split("\n");
    const rules: PermissionRule[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      const lineNum = i + 1;

      // Skip empty lines and comments
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }

      // Parse "action pattern" format
      const spaceIndex = trimmed.indexOf(" ");
      if (spaceIndex === -1) {
        console.warn(`[pi-hooks] Line ${lineNum}: Missing space separator in ${hooksFile}`);
        continue;
      }

      const action = trimmed.slice(0, spaceIndex) as PermissionAction;
      const pattern = trimmed.slice(spaceIndex + 1).trim();

      if (!["allow", "ask", "deny"].includes(action)) {
        console.warn(
          `[pi-hooks] Line ${lineNum}: Invalid action '${action}' in ${hooksFile}`
        );
        continue;
      }

      if (!pattern) {
        console.warn(`[pi-hooks] Line ${lineNum}: Empty pattern in ${hooksFile}`);
        continue;
      }

      try {
        rules.push({
          action,
          pattern: new RegExp(pattern),
          rawPattern: pattern,
          line: lineNum,
        });
      } catch (error) {
        // Silently skip invalid regex patterns to avoid cluttering output
        // Invalid patterns are logged once during development, not at runtime
      }
    }

    return rules.length > 0
      ? {
          rules,
          filePath: hooksFile,
          directory: path.dirname(hooksFile),
        }
      : null;
  } catch (error) {
    console.error(`[pi-hooks] Error reading ${hooksFile}:`, error);
    return null;
  }
}

/**
 * Check if a command matches any permission rule
 * Returns the action of the first matching rule, or null if no match
 * @internal - exported for testing
 */
export function checkPermission(command: string, rules: PermissionRule[]): PermissionAction | null {
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
 * Commands that require approval (cannot be auto-allowed)
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

      // ─── Check hard blocks FIRST (cannot be overridden by any rule) ───
      for (const block of HARD_BLOCKS) {
        if (block.pattern.test(cmd)) {
          return { block: true, reason: block.reason };
        }
      }

      // ─── Check always-ask rules SECOND (cannot be bypassed by allow rules) ───
      let opaqueCommandBlocked = false;
      for (const askRule of ALWAYS_ASK) {
        if (askRule.pattern.test(cmd)) {
          if (!ctx.hasUI) {
            return {
              block: true,
              reason: `${askRule.reason} (no UI for confirmation).`,
            };
          }

          const ok = await ctx.ui.confirm(
            "⚠️ Opaque Command",
            `${askRule.reason}:\n\n  ${cmd}\n\nAllow?`
          );

          if (!ok) {
            return { block: true, reason: "Blocked by user." };
          }
          opaqueCommandBlocked = true;
          break;
        }
      }

      // ─── Check .pi-hooks rules if config exists ───
      if (config) {
        const permission = checkPermission(cmd, config.rules);

        if (permission === "deny") {
          return {
            block: true,
            reason: `.pi-hooks: Command denied by rule at line ${
              config.rules.find((r) => r.pattern.test(cmd))?.line
            }`,
          };
        }

        if (permission === "ask") {
          if (!ctx.hasUI) {
            return {
              block: true,
              reason: ".pi-hooks: Command requires approval (no UI available).",
            };
          }

          const ok = await ctx.ui.confirm(
            "⚠️ Command Permission Check",
            `This command requires approval:\n\n  ${cmd}\n\nAllow?`
          );

          if (!ok) {
            return { block: true, reason: "Blocked by user (.pi-hooks)." };
          }
        }

        if (permission === "allow") {
          // Command is explicitly allowed in .pi-hooks
          // Skip remaining safety checks (file ops, redirects, dangerous cmds)
          // but hard blocks and opaque checks already ran above
          continue;
        }

        // No matching rule - continue to built-in safety checks
      }

      // ─── Check file operations for path safety ───
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
              if (!ctx.hasUI) {
                return {
                  block: true,
                  reason: `'${fileOp}' targets '${arg}' outside project (no UI).`,
                };
              }

              const ok = await ctx.ui.confirm(
                `⚠️ ${fileOp} outside project`,
                `'${fileOp}' targets '${arg}' (outside project):\n\n  ${cmd}\n\nAllow?`
              );

              if (!ok) return { block: true, reason: "Blocked by user." };
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
                if (!ctx.hasUI) {
                  return {
                    block: true,
                    reason: `'${fileOp}' targets '${arg}' outside project (no UI).`,
                  };
                }

                const ok = await ctx.ui.confirm(
                  `⚠️ ${fileOp} outside project`,
                  `'${fileOp}' targets '${arg}' (outside project):\n\n  ${cmd}\n\nAllow?`
                );

                if (!ok) return { block: true, reason: "Blocked by user." };
                break;
              }
            }
          }
        }
      }

      // ─── Check redirects for path safety ───
      const redirectTarget = extractRedirectTarget(cmd);
      if (redirectTarget) {
        try {
          const expanded = resolveHomePath(redirectTarget);
          const abs = path.isAbsolute(expanded)
            ? expanded
            : path.resolve(ctx.cwd, expanded);

          if (!isPathSafe(abs, projectRoot)) {
            if (!ctx.hasUI) {
              return {
                block: true,
                reason: `Redirect to '${redirectTarget}' outside project (no UI).`,
              };
            }

            const ok = await ctx.ui.confirm(
              "⚠️ Redirect outside project",
              `Redirect to '${redirectTarget}' (outside project):\n\n  ${cmd}\n\nAllow?`
            );

            if (!ok) return { block: true, reason: "Blocked by user." };
          }
        } catch {}
      }

      // ─── Check other dangerous commands (only if not explicitly allowed) ───
      // These checks are skipped if the command was explicitly allowed in .pi-hooks
      // or if it was an opaque command that already required approval
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
            if (!ctx.hasUI) {
              return {
                block: true,
                reason: `'${dangerous.name}' blocked (no UI for confirmation).`,
              };
            }

            const ok = await ctx.ui.confirm(
              `⚠️ ${dangerous.name}`,
              `'${dangerous.name}' detected:\n\n  ${cmd}\n\nAllow?`
            );

            if (!ok) return { block: true, reason: "Blocked by user." };
            break;
          }
        }
      }
    }

    return undefined;
  });

  // Notify on session start
  pi.on("session_start", async (_event, ctx) => {
    const config = findHooksConfig(ctx.cwd);
    if (config) {
      ctx.ui.notify(
        `Pi hooks active: ${config.rules.length} rule(s) from ${path.relative(ctx.cwd, config.filePath)}`,
        "info"
      );
    }
  });
}
