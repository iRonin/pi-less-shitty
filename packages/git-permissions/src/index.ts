/**
 * Git Permissions Extension
 *
 * Provides directory-based permission control for git operations.
 * Uses .git-permissions files to allow/deny/ask for git commands.
 *
 * This is a specialized extension focused solely on git command permissions,
 * separate from the general safety-hooks extension.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import {
  checkPermission,
  findGitPermissions,
  splitChainedCommands,
  unwrapCommand,
} from "./policy.js";

export {
  checkPermission,
  findGitPermissions,
  splitChainedCommands,
  tokenize,
  unwrapCommand,
} from "./policy.js";

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("bash", event)) {
      return undefined;
    }

    const command = event.input.command;
    if (!command) {
      return undefined;
    }

    // Cheap pre-filter: if the raw command does not mention `git` anywhere
    // (including inside wrapper payloads), skip. This avoids paying tokenization
    // cost for unrelated commands while still letting wrapped git commands
    // reach the per-subcommand logic below.
    if (!/\bgit\b/.test(command)) {
      return undefined;
    }

    const rules = findGitPermissions(ctx.cwd);

    // If no .git-permissions file exists, allow all git commands.
    if (!rules) {
      return undefined;
    }

    const subcommands = splitChainedCommands(command);

    for (const subcmd of subcommands) {
      const cmd = subcmd.trim();
      if (!cmd) continue;

      // Unwrap wrappers (bash -c, sh -c, eval, xargs, env). One level only.
      const unwrapped = unwrapCommand(cmd);
      if (unwrapped.failed) {
        return {
          block: true,
          reason:
            ".git-permissions: wrapper command (bash -c / sh -c / eval / xargs / env) with unparsable payload — denied (fail-closed).",
        };
      }

      const effective = unwrapped.command.trim();
      if (!effective || !/^\s*git\s/.test(effective)) {
        // Not a git command after unwrapping — let it through.
        continue;
      }

      const permission = checkPermission(effective, rules);

      // No matching rule — default deny for git
      if (permission === null) {
        return {
          block: true,
          reason:
            ".git-permissions: git command not explicitly allowed in this directory.",
        };
      }

      if (permission === "deny") {
        return {
          block: true,
          reason: `.git-permissions: git command denied by rule.`,
        };
      }

      if (permission === "ask") {
        if (!ctx.hasUI) {
          return {
            block: true,
            reason:
              ".git-permissions: git command requires approval (no UI available).",
          };
        }

        const ok = await ctx.ui.confirm(
          "⚠️ Git Permission Check",
          `This git command requires approval:\n\n  ${effective}\n\nAllow?`
        );

        if (!ok) {
          return { block: true, reason: "Blocked by user (.git-permissions)." };
        }
      }

      // allow — continue to next subcommand
    }

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
