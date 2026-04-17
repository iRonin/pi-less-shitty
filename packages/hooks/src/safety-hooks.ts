/**
 * Safety Hooks Extension — ported from Claude Code hooks
 *
 * Integrates all four Claude hooks into pi:
 *   1. bash-safety   — PreToolUse Bash: block/ask for destructive commands
 *   2. pdf-guard     — PreToolUse Read: block large PDF reads
 *   3. pdfenv-guard  — PreToolUse Bash: force PDF scripts to use /tmp/pdfenv venv
 *   4. trailing-spaces-guard — PostToolUse Edit: warn on lost markdown double-spaces
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { execSync } from "node:child_process";

export default function (pi: ExtensionAPI) {
  // ─────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────

  function getProjectDir(cwd: string): string {
    // Try git root first
    try {
      const root = execSync("git rev-parse --show-toplevel", {
        cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      if (root) return root;
    } catch {}

    // Walk up looking for .ai-permissions or .git
    let dir = cwd;
    while (dir !== "/" && dir !== ".") {
      if (
        fs.existsSync(path.join(dir, ".ai-permissions")) ||
        fs.existsSync(path.join(dir, ".git"))
      ) {
        return dir;
      }
      dir = path.dirname(dir);
    }
    return cwd;
  }

  function resolvePath(p: string, base: string): string {
    // Expand ~ and $HOME
    p = p.replace(/^~\//, os.homedir() + "/");
    p = p.replace(/^~$/, os.homedir());
    p = p.replace(/\$HOME/g, os.homedir());
    p = p.replace(/\$\{HOME\}/g, os.homedir());

    // Strip surrounding quotes
    p = p.replace(/^["']|["']$/g, "");

    // Make absolute
    if (!path.isAbsolute(p)) {
      p = path.join(base, p);
    }

    return safeRealpath(p);
  }

  function safeRealpath(p: string): string {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  }

  function findProjectRoot(start: string): string {
    let dir = start;
    while (dir !== "/") {
      if (
        fs.existsSync(path.join(dir, ".git")) ||
        fs.existsSync(path.join(dir, ".ai-permissions"))
      ) {
        return dir;
      }
      dir = path.dirname(dir);
    }
    return start;
  }

  function isPathSafe(filePath: string, projectDir: string): boolean {
    const resolved = safeRealpath(filePath);
    const project = safeRealpath(projectDir);
    const downloads = safeRealpath(path.join(os.homedir(), "Downloads"));

    // /tmp is always safe
    if (
      resolved.startsWith("/tmp/") ||
      resolved.startsWith("/private/tmp/") ||
      resolved === "/tmp" ||
      resolved === "/private/tmp"
    ) {
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
      fs.statSync(resolved).isDirectory()
        ? resolved
        : path.dirname(resolved)
    );
    if (pathRoot === project) {
      return true;
    }

    return false;
  }

  // ─── .ai-permissions cascading check ───
  function checkAiPermissions(
    cmd: string,
    projectDir: string
  ): "allow" | "ask" | "deny" | "default-deny" | null {
    const permFiles: string[] = [];
    let dir = projectDir;
    while (dir !== "/" && dir !== ".") {
      const f = path.join(dir, ".ai-permissions");
      if (fs.existsSync(f)) permFiles.push(f);
      dir = path.dirname(dir);
    }
    if (permFiles.length === 0) return null;

    for (const permFile of permFiles) {
      const lines = fs.readFileSync(permFile, "utf-8").split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const spaceIdx = trimmed.indexOf(" ");
        if (spaceIdx === -1) continue;
        const action = trimmed.slice(0, spaceIdx);
        const pattern = trimmed.slice(spaceIdx + 1);
        if (!pattern) continue;
        try {
          if (new RegExp(pattern).test(cmd)) {
            if (action === "allow") return "allow";
            if (action === "ask") return "ask";
            if (action === "deny") return "deny";
          }
        } catch {}
      }
      // File exists, no rule matched — most-specific file default-deny
      return "default-deny";
    }
    return null;
  }

  // ─── Split chained commands (;, &&, ||, |) respecting quotes ───
  function splitChainedCommands(command: string): string[] {
    const result: string[] = [];
    let current: string[] = [];
    let i = 0;
    let inSq = false;
    let inDq = false;

    while (i < command.length) {
      const c = command[i];
      if (c === "'" && !inDq) {
        inSq = !inSq;
        current.push(c);
      } else if (c === '"' && !inSq) {
        inDq = !inDq;
        current.push(c);
      } else if (!inSq && !inDq) {
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
        } else if (c === ";") {
          result.push(current.join(""));
          current = [];
        } else if (c === "|") {
          result.push(current.join(""));
          current = [];
        } else {
          current.push(c);
        }
      } else {
        current.push(c);
      }
      i++;
    }
    if (current.length > 0) result.push(current.join(""));
    return result.map((s) => s.trim()).filter(Boolean);
  }

  // ─── Parse args from command (basic shlex-like split) ───
  function shellSplit(cmd: string): string[] {
    const args: string[] = [];
    let current = "";
    let inSq = false;
    let inDq = false;
    let escape = false;

    for (const c of cmd) {
      if (escape) {
        current += c;
        escape = false;
        continue;
      }
      if (c === "\\" && !inSq) {
        escape = true;
        continue;
      }
      if (c === "'" && !inDq) {
        inSq = !inSq;
        continue;
      }
      if (c === '"' && !inSq) {
        inDq = !inDq;
        continue;
      }
      if ((c === " " || c === "\t") && !inSq && !inDq) {
        if (current) {
          args.push(current);
          current = "";
        }
        continue;
      }
      current += c;
    }
    if (current) args.push(current);
    return args;
  }

  // ─── Extract redirect target from command ───
  function extractRedirectTarget(cmd: string): string | null {
    // Match >> or > followed by a path
    const m =
      cmd.match(/>>?\s*"([^"]+)"/) ||
      cmd.match(/>>?\s*([/~$][^\s);&|]*)/);
    if (!m) return null;
    let target = m[1];
    // Strip trailing shell syntax
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

  // ─────────────────────────────────────────────────────────────
  // 1. BASH SAFETY — tool_call on "bash"
  // ─────────────────────────────────────────────────────────────

  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("bash", event)) return undefined;

    const command = event.input.command;
    if (!command) return undefined;

    const projectDir = getProjectDir(ctx.cwd);
    let currentDir = projectDir;

    const subcmds = splitChainedCommands(command);

    for (const subcmd of subcmds) {
      const cmd = subcmd.trim();
      if (!cmd) continue;

      // ── Track cd ──
      if (/^cd\s/.test(cmd)) {
        const target = cmd.replace(/^cd\s+/, "").replace(/^["']|["']$/g, "");
        try {
          currentDir = resolvePath(target, currentDir);
        } catch {}
        continue;
      }

      // ══════════════════════════════════════════
      // HARD DENY — always blocked, no override
      // ══════════════════════════════════════════

      // sudo
      if (/\bsudo\s/.test(cmd)) {
        return { block: true, reason: "HARD BLOCK: 'sudo' is never allowed via agent." };
      }

      // dd, mkfs, diskutil
      const diskOp = cmd.match(/(^|\s)(dd|mkfs\S*|diskutil)\s/);
      if (diskOp) {
        return {
          block: true,
          reason: `HARD BLOCK: '${diskOp[2]}' is never allowed via agent.`,
        };
      }

      // Write to device files
      if (/>\s*\/dev\/(sd|hd|disk|nvme|mmcblk)/.test(cmd)) {
        return {
          block: true,
          reason: "HARD BLOCK: writing to device file is never allowed via agent.",
        };
      }

      // SQL destructive
      const sqlOp = cmd.match(/\b(DROP\s+TABLE|TRUNCATE\s+TABLE|DROP\s+DATABASE)\b/i);
      if (sqlOp) {
        return {
          block: true,
          reason: `HARD BLOCK: '${sqlOp[1]}' is never allowed via agent.`,
        };
      }

      // kill -1 (all processes)
      if (/\bkill\s+(-9\s+)?-1(\s|$)/.test(cmd)) {
        return {
          block: true,
          reason: "HARD BLOCK: 'kill -1' kills all user processes.",
        };
      }

      // ══════════════════════════════════════════
      // .ai-permissions check
      // ══════════════════════════════════════════
      const aiPerm = checkAiPermissions(cmd, projectDir);
      if (aiPerm === "deny") {
        return {
          block: true,
          reason: ".ai-permissions: command denied in this directory.",
        };
      }
      if (aiPerm === "ask") {
        if (!ctx.hasUI) {
          return {
            block: true,
            reason: ".ai-permissions: command requires approval (no UI).",
          };
        }
        const ok = await ctx.ui.confirm(
          "⚠️ .ai-permissions",
          `Command requires approval:\n\n  ${cmd}\n\nAllow?`
        );
        if (!ok)
          return { block: true, reason: "Blocked by user (.ai-permissions)." };
      }
      if (aiPerm === "default-deny" && /^\s*git\s/.test(cmd)) {
        return {
          block: true,
          reason:
            ".ai-permissions: git command not explicitly allowed in this directory.",
        };
      }
      if (aiPerm === "allow") continue;

      // ══════════════════════════════════════════
      // OPAQUE COMMANDS — can't inspect inner payload
      // ══════════════════════════════════════════

      // bash -c, sh -c
      if (/(^|\s|\/)(bash|sh)\s+-(l?c|cl)\s/.test(cmd)) {
        if (!ctx.hasUI) {
          return {
            block: true,
            reason: "Opaque shell blocked (no UI for confirmation).",
          };
        }
        const ok = await ctx.ui.confirm(
          "⚠️ Opaque shell",
          `'bash -c' / 'sh -c' detected — cannot inspect inner command:\n\n  ${cmd}\n\nAllow?`
        );
        if (!ok) return { block: true, reason: "Blocked by user." };
      }

      // eval
      if (/(^|\s)eval\s/.test(cmd)) {
        if (!ctx.hasUI) {
          return {
            block: true,
            reason: "Opaque 'eval' blocked (no UI for confirmation).",
          };
        }
        const ok = await ctx.ui.confirm(
          "⚠️ Opaque eval",
          `'eval' detected — cannot inspect inner command:\n\n  ${cmd}\n\nAllow?`
        );
        if (!ok) return { block: true, reason: "Blocked by user." };
      }

      // pipe to bare sh/bash
      if (/\|\s*(bash|sh)\s*$/.test(cmd)) {
        if (!ctx.hasUI) {
          return {
            block: true,
            reason: "Opaque pipe-to-shell blocked (no UI).",
          };
        }
        const ok = await ctx.ui.confirm(
          "⚠️ Opaque pipe",
          `Piping to shell detected:\n\n  ${cmd}\n\nAllow?`
        );
        if (!ok) return { block: true, reason: "Blocked by user." };
      }

      // xargs with destructive commands
      const xargsMatch = cmd.match(
        /xargs\s.*\b(rm|mv|cp|chmod|chown|tee|ln)\b/
      );
      if (xargsMatch) {
        if (!ctx.hasUI) {
          return {
            block: true,
            reason: `xargs with '${xargsMatch[1]}' blocked (no UI).`,
          };
        }
        const ok = await ctx.ui.confirm(
          "⚠️ xargs + destructive",
          `'xargs' with '${xargsMatch[1]}' detected:\n\n  ${cmd}\n\nAllow?`
        );
        if (!ok) return { block: true, reason: "Blocked by user." };
      }

      // find with -delete or -exec rm/mv
      if (/\bfind\b.*-(delete|exec\s+(rm|mv|cp)\b)/.test(cmd)) {
        // Check if find targets paths outside project
        const args = shellSplit(cmd);
        const findIdx = args.indexOf("find");
        if (findIdx >= 0) {
          for (let j = findIdx + 1; j < args.length; j++) {
            const a = args[j];
            if (a.startsWith("-") || a.startsWith("(") || a === "!" || a === "not")
              break;
            try {
              if (!isPathSafe(resolvePath(a, currentDir), projectDir)) {
                if (!ctx.hasUI) {
                  return {
                    block: true,
                    reason: `find -delete/-exec targets '${a}' outside project (no UI).`,
                  };
                }
                const ok = await ctx.ui.confirm(
                  "⚠️ find outside project",
                  `'find -delete/-exec' targets '${a}' (outside project):\n\n  ${cmd}\n\nAllow?`
                );
                if (!ok) return { block: true, reason: "Blocked by user." };
              }
            } catch {}
          }
        }
      }

      // ══════════════════════════════════════════
      // ASK: destructive but approvable
      // ══════════════════════════════════════════

      // git operations
      const gitMatch = cmd.match(
        /git\s+(push|reset\s+--hard|clean\s+-[fd]|checkout|branch\s+-[dD]|stash\s+drop|rebase)/
      );
      if (gitMatch) {
        if (!ctx.hasUI) {
          return {
            block: true,
            reason: `'git ${gitMatch[1]}' blocked (no UI for confirmation).`,
          };
        }
        const ok = await ctx.ui.confirm(
          "⚠️ Git operation",
          `'git ${gitMatch[1]}' detected:\n\n  ${cmd}\n\nAllow?`
        );
        if (!ok) return { block: true, reason: "Blocked by user." };
      }

      // Force kill
      if (/(kill|pkill)\s+(-9|-KILL|-SIGKILL)\s/.test(cmd)) {
        if (!ctx.hasUI) {
          return { block: true, reason: "Force kill blocked (no UI)." };
        }
        const ok = await ctx.ui.confirm(
          "⚠️ Force kill",
          `Force kill (-9) detected:\n\n  ${cmd}\n\nAllow?`
        );
        if (!ok) return { block: true, reason: "Blocked by user." };
      }

      // killall
      if (/(^|\s)killall\s/.test(cmd)) {
        if (!ctx.hasUI) {
          return { block: true, reason: "'killall' blocked (no UI)." };
        }
        const ok = await ctx.ui.confirm(
          "⚠️ killall",
          `'killall' detected (broad):\n\n  ${cmd}\n\nAllow?`
        );
        if (!ok) return { block: true, reason: "Blocked by user." };
      }

      // chmod 777
      if (/chmod\s+777/.test(cmd)) {
        if (!ctx.hasUI) {
          return { block: true, reason: "'chmod 777' blocked (no UI)." };
        }
        const ok = await ctx.ui.confirm(
          "⚠️ chmod 777",
          `'chmod 777' detected:\n\n  ${cmd}\n\nAllow?`
        );
        if (!ok) return { block: true, reason: "Blocked by user." };
      }

      // chown
      if (/(^|\s)chown\s/.test(cmd)) {
        if (!ctx.hasUI) {
          return { block: true, reason: "'chown' blocked (no UI)." };
        }
        const ok = await ctx.ui.confirm(
          "⚠️ chown",
          `'chown' detected:\n\n  ${cmd}\n\nAllow?`
        );
        if (!ok) return { block: true, reason: "Blocked by user." };
      }

      // Package uninstall
      const uninstallMatch = cmd.match(/(pip3?|brew)\s+uninstall/);
      if (uninstallMatch) {
        if (!ctx.hasUI) {
          return {
            block: true,
            reason: `'${uninstallMatch[1]} uninstall' blocked (no UI).`,
          };
        }
        const ok = await ctx.ui.confirm(
          "⚠️ Package uninstall",
          `'${uninstallMatch[1]} uninstall' detected:\n\n  ${cmd}\n\nAllow?`
        );
        if (!ok) return { block: true, reason: "Blocked by user." };
      }

      // truncate, shred
      const truncMatch = cmd.match(/(^|\s)(truncate|shred)\s/);
      if (truncMatch) {
        if (!ctx.hasUI) {
          return {
            block: true,
            reason: `'${truncMatch[2]}' blocked (no UI).`,
          };
        }
        const ok = await ctx.ui.confirm(
          `⚠️ ${truncMatch[2]}`,
          `'${truncMatch[2]}' detected:\n\n  ${cmd}\n\nAllow?`
        );
        if (!ok) return { block: true, reason: "Blocked by user." };
      }

      // ── File operations: rm, mv, cp, ln — only ASK if outside project ──
      let fileOp: string | null = null;
      if (/(^|\s)(rm|rmdir|unlink)\s/.test(cmd)) fileOp = "rm";
      else if (/(^|\s)mv\s/.test(cmd)) fileOp = "mv";
      else if (/(^|\s)cp\s/.test(cmd)) fileOp = "cp";
      else if (/(^|\s)ln\s/.test(cmd)) fileOp = "ln";

      if (fileOp) {
        const args = shellSplit(cmd);
        for (const arg of args.slice(1)) {
          if (arg.startsWith("-")) continue;
          try {
            const expanded = arg
              .replace(/^~\//, os.homedir() + "/")
              .replace(/^~$/, os.homedir())
              .replace(/\$HOME/g, os.homedir());
            const resolved = path.isAbsolute(expanded)
              ? safeRealpath(expanded)
              : safeRealpath(path.join(currentDir, expanded));
            if (!isPathSafe(resolved, projectDir)) {
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
              break; // Only ask once per subcmd
            }
          } catch {
            // Path doesn't exist yet — only worry about rm
            if (fileOp === "rm") {
              // Can't resolve nonexistent path; check textually
              const expanded = arg
                .replace(/^~\//, os.homedir() + "/")
                .replace(/\$HOME/g, os.homedir());
              const abs = path.isAbsolute(expanded)
                ? expanded
                : path.resolve(currentDir, expanded);
              const projResolved = safeRealpath(projectDir);
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

      // ── Redirect outside project ──
      const redirectTarget = extractRedirectTarget(cmd);
      if (redirectTarget) {
        try {
          const expanded = redirectTarget
            .replace(/^~\//, os.homedir() + "/")
            .replace(/\$HOME/g, os.homedir());
          const abs = path.isAbsolute(expanded)
            ? expanded
            : path.resolve(currentDir, expanded);
          if (!isPathSafe(abs, projectDir)) {
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

      // ══════════════════════════════════════════
      // PDFENV GUARD (integrated — was pdfenv-guard.sh)
      // ══════════════════════════════════════════
      const PDF_SCRIPTS =
        /reformat-letter\.py|first-pages\.py|fix-double-ocr\.py|pdf2md\.py|auto-highlight\.py|manual-highlight\.py|collate-exhibits\.py|highlight-preview\.py|toc-pages\.py|verify-citations\.py/;

      if (PDF_SCRIPTS.test(cmd)) {
        if (/\/tmp\/pdfenv\/bin\/python3/.test(cmd)) {
          // Already using the venv — ok
        } else if (/(^|\s|;|&&|\|\|)(python3?)\s/.test(cmd)) {
          const scriptMatch = cmd.match(PDF_SCRIPTS);
          return {
            block: true,
            reason: `PDF script '${scriptMatch?.[0]}' must use /tmp/pdfenv/bin/python3 (not system python3). PyMuPDF and other dependencies are only installed in the venv. Rewrite command to use: /tmp/pdfenv/bin/python3 TOOLS/PDF/${scriptMatch?.[0]}`,
          };
        }
      }
    }

    return undefined;
  });

  // ─────────────────────────────────────────────────────────────
  // 2. PDF GUARD — tool_call on "read"
  // ─────────────────────────────────────────────────────────────

  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("read", event)) return undefined;

    const filePath = event.input.path;
    if (!filePath) return undefined;

    // Only care about PDFs
    if (!/\.pdf$/i.test(filePath)) return undefined;

    // If offset/limit is set, this is a targeted read — allow
    if (event.input.offset || event.input.limit) return undefined;

    // Check file exists
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return undefined; // file doesn't exist, let the tool handle the error
    }

    const fileSize = stat.size;

    // Get page count via pdfinfo if available
    let pageCount: number | null = null;
    try {
      const info = execSync(`pdfinfo "${filePath}" 2>/dev/null`, {
        encoding: "utf-8",
      });
      const m = info.match(/^Pages:\s+(\d+)/m);
      if (m) pageCount = parseInt(m[1], 10);
    } catch {}

    // Thresholds
    const WARN_SIZE = 2_000_000; // 2MB
    const BLOCK_SIZE = 10_000_000; // 10MB
    const WARN_PAGES = 10;
    const BLOCK_PAGES = 30;

    const humanSize =
      fileSize > 1_000_000
        ? `${Math.floor(fileSize / 1_000_000)}MB`
        : fileSize > 1_000
          ? `${Math.floor(fileSize / 1_000)}KB`
          : `${fileSize}B`;

    // Check for .md version
    const mdVersion = filePath.replace(/\.pdf$/i, ".md");
    const mdHint = fs.existsSync(mdVersion)
      ? ` An .md version exists at ${path.basename(mdVersion)} — prefer reading that instead.`
      : "";

    const delegateMsg =
      "Do NOT read this PDF in the main context. Instead: (1) Use pdfgrep or MCP pdf_search_text to find specific content, (2) Use Read with offset/limit parameters for targeted extraction, or (3) Spawn a background agent to read and summarise the PDF, preserving the main context window.";

    let reason: string | null = null;

    if (pageCount !== null && pageCount > BLOCK_PAGES) {
      reason = `BLOCKED: PDF has ${pageCount} pages (${humanSize}). ${delegateMsg}${mdHint}`;
    } else if (fileSize > BLOCK_SIZE) {
      reason = `BLOCKED: PDF is ${humanSize}. ${delegateMsg}${mdHint}`;
    } else if (pageCount !== null && pageCount > WARN_PAGES) {
      reason = `BLOCKED: PDF has ${pageCount} pages (${humanSize}). ${delegateMsg}${mdHint}`;
    } else if (fileSize > WARN_SIZE) {
      reason = `BLOCKED: PDF is ${humanSize}. ${delegateMsg}${mdHint}`;
    }

    if (reason) {
      return { block: true, reason };
    }

    return undefined;
  });

  // ─────────────────────────────────────────────────────────────
  // 3. TRAILING SPACES GUARD — tool_result on "edit"
  // ─────────────────────────────────────────────────────────────

  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "edit") return undefined;

    const filePath = (event.input as any)?.path;
    if (!filePath || !/\.md$/i.test(filePath)) return undefined;

    const oldText: string = (event.input as any)?.oldText ?? "";
    const newText: string = (event.input as any)?.newText ?? "";

    if (!oldText || !newText) return undefined;

    // Count lines ending with two or more trailing spaces
    const countTrailing = (s: string) =>
      s.split("\n").filter((line) => /  $/.test(line)).length;

    const oldCount = countTrailing(oldText);
    const newCount = countTrailing(newText);

    if (oldCount > newCount) {
      const lost = oldCount - newCount;

      // Prepend a warning to the tool result content
      const warningText = `⚠️ WARNING: Edit removed ${lost} trailing double-space(s) from markdown. These are intentional line breaks. Re-read the edited section and restore any lost '  ' (two spaces) at line endings where the original had them.`;

      const existingContent = event.content ?? [];
      return {
        content: [
          { type: "text" as const, text: warningText },
          ...existingContent,
        ],
      };
    }

    return undefined;
  });

  // ─────────────────────────────────────────────────────────────
  // Session start notification
  // ─────────────────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify(
      "Safety hooks active: bash-safety, pdf-guard, pdfenv-guard, trailing-spaces",
      "info"
    );
  });
}
