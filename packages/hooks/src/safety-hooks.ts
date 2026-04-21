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
import {
  clearSessionAllowlist,
  isSessionAllowed,
  addToSessionAllowlist,
  askPermission,
  buildBlockReason,
  isAlreadyPrompting,
} from "./permission-ui.js";
import { addRule } from "./config-store.js";

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

      // ── Skip if already approved or being prompted by another handler ──
      if (isSessionAllowed(cmd) || isAlreadyPrompting(cmd)) {
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
        const result = await askPermission(cmd, ".ai-permissions: rule requires approval", {
          select: (title, options) => ctx.ui.select(title, options),
          input: (title, placeholder) => ctx.ui.input(title, placeholder),
          confirm: (title, msg) => ctx.ui.confirm(title, msg),
          hasUI: ctx.hasUI,
        });
        if (!result) return { block: true, reason: "Permission dialog dismissed." };
        if (result.choice === "deny" || result.choice === "deny-steer") {
          return { block: true, reason: buildBlockReason(cmd, result) };
        }
        if (result.choice === "allow") continue;
          if (result.choice === "allow-session") {
          addToSessionAllowlist(cmd);
          continue;
        }
        if (result.choice === "allow-permanent" && result.permanentPattern) {
          addToSessionAllowlist(result.permanentPattern);
              addRule(ctx.cwd, "allow", result.permanentPattern);
          continue;
        }
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
        const result = await askPermission(cmd, "Opaque shell: 'bash -c' / 'sh -c' detected", {
          select: (title, options) => ctx.ui.select(title, options),
          input: (title, placeholder) => ctx.ui.input(title, placeholder),
          confirm: (title, msg) => ctx.ui.confirm(title, msg),
          hasUI: ctx.hasUI,
        });
        if (!result) return { block: true, reason: "Permission dialog dismissed." };
        if (result.choice === "deny" || result.choice === "deny-steer") {
          return { block: true, reason: buildBlockReason(cmd, result) };
        }
        if (result.choice === "allow") continue;
          if (result.choice === "allow-session") {
          addToSessionAllowlist(cmd);
          continue;
        }
        if (result.choice === "allow-permanent" && result.permanentPattern) {
          addToSessionAllowlist(result.permanentPattern);
              addRule(ctx.cwd, "allow", result.permanentPattern);
          continue;
        }
      }

      // eval
      if (/(^|\s)eval\s/.test(cmd)) {
        const result = await askPermission(cmd, "Opaque 'eval' detected", {
          select: (title, options) => ctx.ui.select(title, options),
          input: (title, placeholder) => ctx.ui.input(title, placeholder),
          confirm: (title, msg) => ctx.ui.confirm(title, msg),
          hasUI: ctx.hasUI,
        });
        if (!result) return { block: true, reason: "Permission dialog dismissed." };
        if (result.choice === "deny" || result.choice === "deny-steer") {
          return { block: true, reason: buildBlockReason(cmd, result) };
        }
        if (result.choice === "allow") continue;
          if (result.choice === "allow-session") {
          addToSessionAllowlist(cmd);
          continue;
        }
        if (result.choice === "allow-permanent" && result.permanentPattern) {
          addToSessionAllowlist(result.permanentPattern);
              addRule(ctx.cwd, "allow", result.permanentPattern);
          continue;
        }
      }

      // pipe to bare sh/bash
      if (/\|\s*(bash|sh)\s*$/.test(cmd)) {
        const result = await askPermission(cmd, "Pipe to shell detected", {
          select: (title, options) => ctx.ui.select(title, options),
          input: (title, placeholder) => ctx.ui.input(title, placeholder),
          confirm: (title, msg) => ctx.ui.confirm(title, msg),
          hasUI: ctx.hasUI,
        });
        if (!result) return { block: true, reason: "Permission dialog dismissed." };
        if (result.choice === "deny" || result.choice === "deny-steer") {
          return { block: true, reason: buildBlockReason(cmd, result) };
        }
        if (result.choice === "allow") continue;
          if (result.choice === "allow-session") {
          addToSessionAllowlist(cmd);
          continue;
        }
        if (result.choice === "allow-permanent" && result.permanentPattern) {
          addToSessionAllowlist(result.permanentPattern);
              addRule(ctx.cwd, "allow", result.permanentPattern);
          continue;
        }
      }

      // xargs with destructive commands
      const xargsMatch = cmd.match(
        /xargs\s.*\b(rm|mv|cp|chmod|chown|tee|ln)\b/
      );
      if (xargsMatch) {
        const result = await askPermission(cmd, `xargs with '${xargsMatch[1]}' detected`, {
          select: (title, options) => ctx.ui.select(title, options),
          input: (title, placeholder) => ctx.ui.input(title, placeholder),
          confirm: (title, msg) => ctx.ui.confirm(title, msg),
          hasUI: ctx.hasUI,
        });
        if (!result) return { block: true, reason: "Permission dialog dismissed." };
        if (result.choice === "deny" || result.choice === "deny-steer") {
          return { block: true, reason: buildBlockReason(cmd, result) };
        }
        if (result.choice === "allow") continue;
          if (result.choice === "allow-session") {
          addToSessionAllowlist(cmd);
          continue;
        }
        if (result.choice === "allow-permanent" && result.permanentPattern) {
          addToSessionAllowlist(result.permanentPattern);
              addRule(ctx.cwd, "allow", result.permanentPattern);
          continue;
        }
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
                const result = await askPermission(cmd, `find -delete/-exec targets '${a}' outside project`, {
                  select: (title, options) => ctx.ui.select(title, options),
                  input: (title, placeholder) => ctx.ui.input(title, placeholder),
                  confirm: (title, msg) => ctx.ui.confirm(title, msg),
                  hasUI: ctx.hasUI,
                });
                if (!result) return { block: true, reason: "Permission dialog dismissed." };
                if (result.choice === "deny" || result.choice === "deny-steer") {
                  return { block: true, reason: buildBlockReason(cmd, result) };
                }
                if (result.choice === "allow") continue;
          if (result.choice === "allow-session") {
                  addToSessionAllowlist(cmd);
                } else if (result.choice === "allow-permanent" && result.permanentPattern) {
                  addToSessionAllowlist(result.permanentPattern);
              addRule(ctx.cwd, "allow", result.permanentPattern);
                }
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
        const result = await askPermission(cmd, `git ${gitMatch[1]} detected`, {
          select: (title, options) => ctx.ui.select(title, options),
          input: (title, placeholder) => ctx.ui.input(title, placeholder),
          confirm: (title, msg) => ctx.ui.confirm(title, msg),
          hasUI: ctx.hasUI,
        });
        if (!result) return { block: true, reason: "Permission dialog dismissed." };
        if (result.choice === "deny" || result.choice === "deny-steer") {
          return { block: true, reason: buildBlockReason(cmd, result) };
        }
        if (result.choice === "allow") continue;
          if (result.choice === "allow-session") { addToSessionAllowlist(cmd); continue; }
        if (result.choice === "allow-permanent" && result.permanentPattern) {
          addToSessionAllowlist(result.permanentPattern);
          addRule(ctx.cwd, "allow", result.permanentPattern);
          continue;
        }
      }

      // Force kill
      if (/(kill|pkill)\s+(-9|-KILL|-SIGKILL)\s/.test(cmd)) {
        const result = await askPermission(cmd, "Force kill (-9) detected", {
          select: (title, options) => ctx.ui.select(title, options),
          input: (title, placeholder) => ctx.ui.input(title, placeholder),
          confirm: (title, msg) => ctx.ui.confirm(title, msg),
          hasUI: ctx.hasUI,
        });
        if (!result) return { block: true, reason: "Permission dialog dismissed." };
        if (result.choice === "deny" || result.choice === "deny-steer") {
          return { block: true, reason: buildBlockReason(cmd, result) };
        }
        if (result.choice === "allow") continue;
          if (result.choice === "allow-session") { addToSessionAllowlist(cmd); continue; }
        if (result.choice === "allow-permanent" && result.permanentPattern) {
          addToSessionAllowlist(result.permanentPattern);
          addRule(ctx.cwd, "allow", result.permanentPattern);
          continue;
        }
      }

      // killall
      if (/(^|\s)killall\s/.test(cmd)) {
        const result = await askPermission(cmd, "killall detected (broad)", {
          select: (title, options) => ctx.ui.select(title, options),
          input: (title, placeholder) => ctx.ui.input(title, placeholder),
          confirm: (title, msg) => ctx.ui.confirm(title, msg),
          hasUI: ctx.hasUI,
        });
        if (!result) return { block: true, reason: "Permission dialog dismissed." };
        if (result.choice === "deny" || result.choice === "deny-steer") {
          return { block: true, reason: buildBlockReason(cmd, result) };
        }
        if (result.choice === "allow") continue;
          if (result.choice === "allow-session") { addToSessionAllowlist(cmd); continue; }
        if (result.choice === "allow-permanent" && result.permanentPattern) {
          addToSessionAllowlist(result.permanentPattern);
          addRule(ctx.cwd, "allow", result.permanentPattern);
          continue;
        }
      }

      // chmod 777
      if (/chmod\s+777/.test(cmd)) {
        const result = await askPermission(cmd, "chmod 777 detected", {
          select: (title, options) => ctx.ui.select(title, options),
          input: (title, placeholder) => ctx.ui.input(title, placeholder),
          confirm: (title, msg) => ctx.ui.confirm(title, msg),
          hasUI: ctx.hasUI,
        });
        if (!result) return { block: true, reason: "Permission dialog dismissed." };
        if (result.choice === "deny" || result.choice === "deny-steer") {
          return { block: true, reason: buildBlockReason(cmd, result) };
        }
        if (result.choice === "allow") continue;
          if (result.choice === "allow-session") { addToSessionAllowlist(cmd); continue; }
        if (result.choice === "allow-permanent" && result.permanentPattern) {
          addToSessionAllowlist(result.permanentPattern);
          addRule(ctx.cwd, "allow", result.permanentPattern);
          continue;
        }
      }

      // chown
      if (/(^|\s)chown\s/.test(cmd)) {
        const result = await askPermission(cmd, "chown detected", {
          select: (title, options) => ctx.ui.select(title, options),
          input: (title, placeholder) => ctx.ui.input(title, placeholder),
          confirm: (title, msg) => ctx.ui.confirm(title, msg),
          hasUI: ctx.hasUI,
        });
        if (!result) return { block: true, reason: "Permission dialog dismissed." };
        if (result.choice === "deny" || result.choice === "deny-steer") {
          return { block: true, reason: buildBlockReason(cmd, result) };
        }
        if (result.choice === "allow") continue;
          if (result.choice === "allow-session") { addToSessionAllowlist(cmd); continue; }
        if (result.choice === "allow-permanent" && result.permanentPattern) {
          addToSessionAllowlist(result.permanentPattern);
          addRule(ctx.cwd, "allow", result.permanentPattern);
          continue;
        }
      }

      // Package uninstall
      const uninstallMatch = cmd.match(/(pip3?|brew)\s+uninstall/);
      if (uninstallMatch) {
        const result = await askPermission(cmd, `${uninstallMatch[1]} uninstall detected`, {
          select: (title, options) => ctx.ui.select(title, options),
          input: (title, placeholder) => ctx.ui.input(title, placeholder),
          confirm: (title, msg) => ctx.ui.confirm(title, msg),
          hasUI: ctx.hasUI,
        });
        if (!result) return { block: true, reason: "Permission dialog dismissed." };
        if (result.choice === "deny" || result.choice === "deny-steer") {
          return { block: true, reason: buildBlockReason(cmd, result) };
        }
        if (result.choice === "allow") continue;
          if (result.choice === "allow-session") { addToSessionAllowlist(cmd); continue; }
        if (result.choice === "allow-permanent" && result.permanentPattern) {
          addToSessionAllowlist(result.permanentPattern);
          addRule(ctx.cwd, "allow", result.permanentPattern);
          continue;
        }
      }

      // truncate, shred
      const truncMatch = cmd.match(/(^|\s)(truncate|shred)\s/);
      if (truncMatch) {
        const result = await askPermission(cmd, `${truncMatch[2]} detected`, {
          select: (title, options) => ctx.ui.select(title, options),
          input: (title, placeholder) => ctx.ui.input(title, placeholder),
          confirm: (title, msg) => ctx.ui.confirm(title, msg),
          hasUI: ctx.hasUI,
        });
        if (!result) return { block: true, reason: "Permission dialog dismissed." };
        if (result.choice === "deny" || result.choice === "deny-steer") {
          return { block: true, reason: buildBlockReason(cmd, result) };
        }
        if (result.choice === "allow") continue;
          if (result.choice === "allow-session") { addToSessionAllowlist(cmd); continue; }
        if (result.choice === "allow-permanent" && result.permanentPattern) {
          addToSessionAllowlist(result.permanentPattern);
          addRule(ctx.cwd, "allow", result.permanentPattern);
          continue;
        }
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
              const result = await askPermission(cmd, `'${fileOp}' targets '${arg}' outside project`, {
                select: (t, o) => ctx.ui.select(t, o),
                input: (t, p) => ctx.ui.input(t, p),
                confirm: (t, m) => ctx.ui.confirm(t, m),
                hasUI: ctx.hasUI,
              });
              if (!result) return { block: true, reason: "Permission dialog dismissed." };
              if (result.choice === "deny" || result.choice === "deny-steer") {
                return { block: true, reason: buildBlockReason(cmd, result) };
              }
              if (result.choice === "allow") continue;
          if (result.choice === "allow-session") { addToSessionAllowlist(cmd); break; }
              if (result.choice === "allow-permanent" && result.permanentPattern) {
                addToSessionAllowlist(result.permanentPattern);
          addRule(ctx.cwd, "allow", result.permanentPattern);
                break;
              }
              break;
            }
          } catch {
            if (fileOp === "rm") {
              const expanded = arg
                .replace(/^~\//, os.homedir() + "/")
                .replace(/\$HOME/g, os.homedir());
              const abs = path.isAbsolute(expanded)
                ? expanded
                : path.resolve(currentDir, expanded);
              const projResolved = safeRealpath(projectDir);
              if (!(abs + "/").startsWith(projResolved + "/")) {
                const result = await askPermission(cmd, `'${fileOp}' targets '${arg}' outside project`, {
                  select: (t, o) => ctx.ui.select(t, o),
                  input: (t, p) => ctx.ui.input(t, p),
                  confirm: (t, m) => ctx.ui.confirm(t, m),
                  hasUI: ctx.hasUI,
                });
                if (!result) return { block: true, reason: "Permission dialog dismissed." };
                if (result.choice === "deny" || result.choice === "deny-steer") {
                  return { block: true, reason: buildBlockReason(cmd, result) };
                }
                if (result.choice === "allow") continue;
          if (result.choice === "allow-session") { addToSessionAllowlist(cmd); break; }
                if (result.choice === "allow-permanent" && result.permanentPattern) {
                  addToSessionAllowlist(result.permanentPattern);
          addRule(ctx.cwd, "allow", result.permanentPattern);
                  break;
                }
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
            const result = await askPermission(cmd, `Redirect to '${redirectTarget}' outside project`, {
              select: (t, o) => ctx.ui.select(t, o),
              input: (t, p) => ctx.ui.input(t, p),
              confirm: (t, m) => ctx.ui.confirm(t, m),
              hasUI: ctx.hasUI,
            });
            if (!result) return { block: true, reason: "Permission dialog dismissed." };
            if (result.choice === "deny" || result.choice === "deny-steer") {
              return { block: true, reason: buildBlockReason(cmd, result) };
            }
            if (result.choice === "allow") continue;
          if (result.choice === "allow-session") { addToSessionAllowlist(cmd); }
            if (result.choice === "allow-permanent" && result.permanentPattern) {
              addToSessionAllowlist(result.permanentPattern);
          addRule(ctx.cwd, "allow", result.permanentPattern);
            }
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
    clearSessionAllowlist();
    ctx.ui.notify(
      "Safety hooks active: bash-safety, pdf-guard, pdfenv-guard, trailing-spaces",
      "info"
    );
  });
}
