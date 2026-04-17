/**
 * Git Permissions Extension
 *
 * Provides directory-based permission control for git operations.
 * Uses .git-permissions files to allow/deny/ask for git commands.
 *
 * This is a specialized extension focused solely on git command permissions,
 * separate from the general safety-hooks extension.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

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
}

/**
 * Find and parse .git-permissions file in directory tree
 * Searches from cwd up to root, returns rules from the deepest file found
 */
function findGitPermissions(cwd: string): PermissionRule[] | null {
  let dir = cwd;
  let permissionsFile: string | null = null;

  // Walk up directory tree to find .git-permissions
  while (dir !== "/" && dir !== ".") {
    const candidate = path.join(dir, ".git-permissions");
    if (fs.existsSync(candidate)) {
      permissionsFile = candidate;
      break;
    }
    dir = path.dirname(dir);
  }

  if (!permissionsFile) {
    return null;
  }

  // Parse the permissions file
  try {
    const content = fs.readFileSync(permissionsFile, "utf-8");
    const lines = content.split("\n");
    const rules: PermissionRule[] = [];

    for (const line of lines) {
      const trimmed = line.trim();

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
        console.warn(`[git-permissions] Invalid action '${action}' in ${permissionsFile}`);
        continue;
      }

      if (!pattern) {
        console.warn(`[git-permissions] Empty pattern in ${permissionsFile}`);
        continue;
      }

      try {
        rules.push({
          action,
          pattern: new RegExp(pattern),
          rawPattern: pattern,
        });
      } catch (error) {
        console.warn(
          `[git-permissions] Invalid regex '${pattern}' in ${permissionsFile}:`,
          error
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
 * Check if a command matches any permission rule
 * Returns the action of the first matching rule, or null if no match
 */
function checkPermission(command: string, rules: PermissionRule[]): PermissionAction | null {
  for (const rule of rules) {
    if (rule.pattern.test(command)) {
      return rule.action;
    }
  }
  return null;
}

/**
 * Split chained commands (;, &&, ||, |) while respecting quotes
 */
function splitChainedCommands(command: string): string[] {
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

export default function (pi: ExtensionAPI) {
  // Track git commands via tool_call event
  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("bash", event)) {
      return undefined;
    }

    const command = event.input.command;
    if (!command) {
      return undefined;
    }

    // Only process git commands
    if (!/^\s*git\s/.test(command)) {
      return undefined;
    }

    // Find permissions rules for current directory
    const rules = findGitPermissions(ctx.cwd);

    // If no .git-permissions file exists, allow all git commands
    if (!rules) {
      return undefined;
    }

    // Split chained commands and check each one
    const subcommands = splitChainedCommands(command);

    for (const subcmd of subcommands) {
      const cmd = subcmd.trim();
      if (!cmd || !/^\s*git\s/.test(cmd)) {
        continue;
      }

      const permission = checkPermission(cmd, rules);

      // No matching rule - default deny for git
      if (permission === null) {
        return {
          block: true,
          reason:
            ".git-permissions: git command not explicitly allowed in this directory.",
        };
      }

      // Permission is deny - block immediately
      if (permission === "deny") {
        return {
          block: true,
          reason: `.git-permissions: git command denied by rule.`,
        };
      }

      // Permission is ask - require user confirmation
      if (permission === "ask") {
        if (!ctx.hasUI) {
          return {
            block: true,
            reason: ".git-permissions: git command requires approval (no UI available).",
          };
        }

        const ok = await ctx.ui.confirm(
          "⚠️ Git Permission Check",
          `This git command requires approval:\n\n  ${cmd}\n\nAllow?`
        );

        if (!ok) {
          return { block: true, reason: "Blocked by user (.git-permissions)." };
        }
      }

      // Permission is allow - continue to next subcommand
    }

    // All subcommands passed checks
    return undefined;
  });

  // Notify on session start
  pi.on("session_start", async (_event, ctx) => {
    const rules = findGitPermissions(ctx.cwd);
    if (rules) {
      ctx.ui.notify(
        `Git permissions active: ${rules.length} rule(s) loaded`,
        "info"
      );
    }
  });
}
