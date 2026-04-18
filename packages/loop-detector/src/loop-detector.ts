/**
 * Tool loop detection with three strategies:
 *
 * 1. **generic_repeat** — same (tool, args) N consecutive times.
 *    Catches: model emits identical tool call over and over.
 *
 * 2. **poll_no_progress** — same tool, same error pattern, N consecutive times.
 *    Catches: "Could not find exact text" edit loops, grep-not-found loops, etc.
 *    The args may differ but the failure result is structurally identical.
 *
 * 3. **ping_pong** — alternating between exactly 2 (tool, args) states.
 *    Catches: model bouncing between read→edit→fail→read→edit→fail.
 *
 * Each record() returns a verdict: none | warning | critical.
 */

import { createHash } from "node:crypto";

// ── Types ────────────────────────────────────────────────────────────────────

export type LoopDetectorMode = "warn" | "stop" | "prune";

export type LoopVerdict =
  | { severity: "none"; detector: null; streak: number }
  | { severity: "warning"; detector: DetectorName; streak: number; intendedTool: string | null }
  | { severity: "critical"; detector: DetectorName; streak: number; intendedTool: string | null };

export type DetectorName = "generic_repeat" | "poll_no_progress" | "ping_pong";

export interface ToolCallRecord {
  toolName: string;
  args: Record<string, unknown>;
  result: string;
  isError: boolean;
  reasoning: string | null;
}

export interface LoopDetectorConfig {
  /** Minimum consecutive repeats for a warning */
  warningThreshold: number;
  /** Minimum consecutive repeats for critical / stop */
  criticalThreshold: number;
  /** How many past entries to keep in history */
  windowSize: number;
  /** What to do on critical: "warn" (warn only), "stop" (inject steer + block), "prune" (collapse context) */
  mode: LoopDetectorMode;
  /** Known tool names — used for extracting intended tool from reasoning text */
  validToolNames: Set<string>;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function canonicalKey(toolName: string, args: Record<string, unknown>): string {
  let normalized: string;
  try {
    normalized = JSON.stringify(args, Object.keys(args).sort());
  } catch {
    normalized = "<unserializable>";
  }
  return `${toolName}:${normalized}`;
}

function errorSignature(result: string): string {
  // Extract a compact signature from the error result.
  // For edit tool failures: "Could not find the exact text in /path/to/file.md..."
  // We hash the first line to group similar errors together.
  const firstLine = result.split("\n")[0]?.trim() || "";
  if (firstLine.length === 0) return "empty_result";
  return shortHash(firstLine);
}

function shortHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

/**
 * Extract a target signature from tool args — the primary entity being operated on.
 * For edit/read/write/grep: the `path` field.
 * For bash: the `command` field.
 * Used by poll_no_progress to ensure the model is stuck on the SAME target,
 * not just using the same tool across different files.
 */
function extractTargetSignature(args: Record<string, unknown>): string {
  // Check common path-like fields in priority order
  const targetKeys = ["path", "file", "filePath", "filepath", "filename", "directory"];
  for (const key of targetKeys) {
    if (typeof args[key] === "string" && (args[key] as string).length > 0) {
      return shortHash(args[key] as string);
    }
  }
  // For bash tools, use the command as target
  if (typeof args.command === "string" && (args.command as string).length > 0) {
    // Hash first 100 chars of command to keep signature stable
    return shortHash((args.command as string).slice(0, 100));
  }
  return "no_target";
}

interface HistoryEntry {
  toolName: string;
  callKey: string;
  errorSig: string;
  targetSig: string; // e.g. file path — breaks poll_no_progress when target changes
  isError: boolean;
}

// ── Detector ─────────────────────────────────────────────────────────────────

export class ToolLoopDetector {
  private config: LoopDetectorConfig;
  private history: HistoryEntry[] = [];
  private warned: Set<string> = new Set();

  constructor(config: LoopDetectorConfig) {
    this.config = config;
  }

  reset(): void {
    this.history = [];
    this.warned.clear();
  }

  /** Update config (e.g. from settings reload) */
  updateConfig(partial: Partial<LoopDetectorConfig>): void {
    this.config = { ...this.config, ...partial };
  }

  record(call: ToolCallRecord): LoopVerdict {
    const callKey = canonicalKey(call.toolName, call.args);
    const errorSig = call.isError ? errorSignature(call.result) : "";
    const targetSig = call.isError ? extractTargetSignature(call.args) : "";

    const entry: HistoryEntry = {
      toolName: call.toolName,
      callKey,
      errorSig,
      targetSig,
      isError: call.isError,
    };

    this.history.push(entry);
    if (this.history.length > this.config.windowSize) {
      this.history.shift();
    }

    const intended = this.extractIntendedTool(call.reasoning, call.toolName);

    // Check 1: generic_repeat — exact same (tool, args) repeated
    const genericVerdict = this.checkGenericRepeat(callKey);
    if (genericVerdict.severity !== "none") {
      return { ...genericVerdict, detector: "generic_repeat", intendedTool: intended };
    }

    // Check 2: poll_no_progress — same tool, same error pattern, same target
    const pollVerdict = this.checkPollNoProgress(call.toolName, errorSig, targetSig);
    if (pollVerdict.severity !== "none") {
      return { ...pollVerdict, detector: "poll_no_progress", intendedTool: intended };
    }

    // Check 3: ping_pong — A-B-A-B-A-B alternation
    const pingVerdict = this.checkPingPong();
    if (pingVerdict.severity !== "none") {
      return { ...pingVerdict, detector: "ping_pong", intendedTool: intended };
    }

    // All clear — return highest streak for observability
    const maxStreak = Math.max(genericVerdict.streak, pollVerdict.streak, pingVerdict.streak);
    return { severity: "none", detector: null, streak: maxStreak };
  }

  // ── Detection strategies ─────────────────────────────────────────────────

  private checkGenericRepeat(callKey: string): Omit<LoopVerdict, "detector" | "intendedTool"> {
    let streak = 0;
    for (let i = this.history.length - 1; i >= 0; i--) {
      if (this.history[i].callKey === callKey) streak++;
      else break;
    }
    return this.severity(streak);
  }

  private checkPollNoProgress(
    toolName: string,
    errorSig: string,
    targetSig: string,
  ): Omit<LoopVerdict, "detector" | "intendedTool"> {
    // Count consecutive calls to same tool that are errors with the same error signature
    // AND the same target (e.g. same file path). If the target changes, it's not a loop —
    // the model is trying different files/approaches.
    if (!errorSig || !targetSig) return this.severity(0);
    let streak = 0;
    for (let i = this.history.length - 1; i >= 0; i--) {
      const e = this.history[i];
      if (e.toolName === toolName && e.isError && e.errorSig === errorSig && e.targetSig === targetSig) streak++;
      else break;
    }
    return this.severity(streak);
  }

  private checkPingPong(): Omit<LoopVerdict, "detector" | "intendedTool"> {
    // Detect A-B-A-B-A-B alternation in the last 6 entries.
    if (this.history.length < 6) return this.severity(0);
    const tail = this.history.slice(-6);
    const keys = tail.map((e) => e.callKey);
    const a = keys[4];
    const b = keys[5];
    if (a === b) return this.severity(0);
    const expected = [a, b, a, b, a, b];
    if (keys.every((k, i) => k === expected[i])) {
      return this.severity(3); // 3 pairs
    }
    return this.severity(0);
  }

  // ── Severity ──────────────────────────────────────────────────────────────

  private severity(streak: number): Omit<LoopVerdict, "detector" | "intendedTool"> {
    if (streak >= this.config.criticalThreshold) {
      return { severity: "critical", streak };
    }
    if (streak >= this.config.warningThreshold) {
      return { severity: "warning", streak };
    }
    return { severity: "none", streak };
  }

  // ── Intended tool extraction ─────────────────────────────────────────────

  private extractIntendedTool(reasoning: string | null, actualTool: string): string | null {
    if (!reasoning || this.config.validToolNames.size === 0) return null;
    const lower = reasoning.toLowerCase();
    for (const name of this.config.validToolNames) {
      if (name === actualTool) continue;
      if (lower.includes(name.toLowerCase())) return name;
    }
    return null;
  }

  // ── Pruning support ──────────────────────────────────────────────────────

  /**
   * When mode is "prune", return a system prompt append that tells the model
   * about the loop. This is lighter than full message pruning (which requires
   * modifying the message array) but still breaks the anchoring pattern.
   */
  buildPrunePromptAppend(toolName: string, streak: number, intendedTool: string | null): string {
    let msg =
      `⚠️ LOOP DETECTED: You called \`${toolName}\` ${streak} times in a row ` +
      `without making progress. Repeating the same action won't help.\n\n`;

    if (intendedTool) {
      msg +=
        `Your reasoning mentioned \`${intendedTool}\` as the tool you wanted, ` +
        `but you kept emitting \`${toolName}\` instead. This is a known ` +
        `token-anchoring issue — the repeated appearances of \`${toolName}\` ` +
        `in context biased your generation. Try calling \`${intendedTool}\` now.\n\n`;
    } else {
      msg +=
        `Try a different approach. If you intended to call a different tool, ` +
        `state its name explicitly before making the call.\n\n`;
    }

    return msg;
  }
}
