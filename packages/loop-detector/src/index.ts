/**
 * Loop detector extension for pi coding agent.
 *
 * Hooks into tool_call and tool_result events to detect degenerate loops:
 * - generic_repeat: same (tool, args) N times consecutively
 * - poll_no_progress: same tool, same error pattern, no progress (catches edit-loop failures)
 * - ping_pong: alternating between 2 actions without progress
 *
 * Config via env vars:
 *   LOOP_DETECTION_ENABLED=true|false       (default: true)
 *   LOOP_DETECTION_WARNING_THRESHOLD=N       (default: 3)
 *   LOOP_DETECTION_CRITICAL_THRESHOLD=N      (default: 5)
 *   LOOP_DETECTION_WINDOW_SIZE=N             (default: 30)
 *   LOOP_DETECTION_MODE=warn|stop|prune      (default: stop)
 *
 * Or in ~/.pi/agent/settings.json:
 *   { "loopDetection": { "enabled": true, "mode": "stop", ... } }
 */

import type { ExtensionAPI, ToolCallEvent, ToolResultEvent, AgentEndEvent, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { ToolLoopDetector, type LoopDetectorConfig, type LoopDetectorMode } from "./loop-detector.js";

// ── Config ───────────────────────────────────────────────────────────────────

interface LoopDetectorSettings {
  enabled: boolean;
  warningThreshold: number;
  criticalThreshold: number;
  windowSize: number;
  mode: LoopDetectorMode;
}

function loadSettings(): LoopDetectorSettings {
  const env = (key: string, fallback: string) =>
    process.env[`LOOP_DETECTION_${key}`] ?? fallback;

  return {
    enabled: envBool(env("ENABLED", "true")),
    warningThreshold: envInt(env("WARNING_THRESHOLD", "5")),
    criticalThreshold: envInt(env("CRITICAL_THRESHOLD", "10")),
    windowSize: envInt(env("WINDOW_SIZE", "30")),
    mode: envMode(env("MODE", "warn")),
  };
}

function envBool(v: string): boolean {
  return v.toLowerCase() === "true" || v === "1";
}

function envInt(v: string): number {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : 3;
}

function envMode(v: string): LoopDetectorMode {
  if (v === "warn" || v === "stop" || v === "prune") return v;
  return "stop";
}

// ── Extension ────────────────────────────────────────────────────────────────

export default function loopDetectorExtension(pi: ExtensionAPI) {
  const settings = loadSettings();
  if (!settings.enabled) return;

  const validToolNames = new Set<string>();

  const config: LoopDetectorConfig = {
    warningThreshold: settings.warningThreshold,
    criticalThreshold: settings.criticalThreshold,
    windowSize: settings.windowSize,
    mode: settings.mode,
    validToolNames,
  };

  const detector = new ToolLoopDetector(config);
  let engaged = false;
  let currentLoopTool: string | null = null;

  const log = (level: "info" | "warn" | "error", msg: string) => {
    console[level](`[loop-detector] ${msg}`);
  };

  // ── tool_call: collect tool names, block if engaged ─────────────────────

  pi.on("tool_call", async (event: ToolCallEvent, ctx: ExtensionContext) => {
    // Collect tool names dynamically
    validToolNames.add(event.toolName);

    if (!engaged) return;

    log("error", `Blocking "${event.toolName}" — loop breaker engaged`);
    return {
      block: true,
      reason: `Loop detector engaged: repeated "${currentLoopTool}" calls without progress. Try a different approach.`,
    };
  });

  // ── tool_result: record outcome, check for loop ─────────────────────────

  pi.on("tool_result", async (event: ToolResultEvent, ctx: ExtensionContext) => {
    if (engaged) return;

    // Extract reasoning text from the last assistant message in context
    let reasoning: string | null = null;
    try {
      const messages = ctx.sessionManager.getBranch();
      for (let i = messages.length - 1; i >= 0; i--) {
        const entry = messages[i];
        if (entry.type === "message" && entry.message.role === "assistant") {
          const msg = entry.message;
          if (Array.isArray(msg.content)) {
            for (const part of msg.content) {
              if (part.type === "thinking" && typeof (part as any).text === "string") {
                reasoning = (reasoning ? reasoning + "\n" : "") + (part as any).text;
              }
            }
          }
          break;
        }
      }
    } catch {
      // Ignore — reasoning extraction is best-effort
    }

    // Extract result text
    let resultText = "";
    if (Array.isArray(event.content)) {
      resultText = event.content
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("\n");
    }

    const verdict = detector.record({
      toolName: event.toolName,
      args: event.input as Record<string, unknown>,
      result: resultText,
      isError: event.isError,
      reasoning,
    });

    if (verdict.severity === "none") return;

    const { detector: detName, streak, intendedTool } = verdict;

    // ── Warning ──────────────────────────────────────────────────────────

    if (verdict.severity === "warning") {
      const remaining = settings.criticalThreshold - streak;
      const warning =
        `⚠️ Potential tool loop detected: "${event.toolName}" called ${streak}× ` +
        `(${detName}). ${remaining > 0 ? `${remaining} more and this run will stop.` : ""}\n\n` +
        `${intendedTool ? `Your reasoning mentioned "${intendedTool}" — consider using it instead.` : "Try a different approach."}`;

      log("warn", `Warning: ${event.toolName} ×${streak} (${detName})`);

      if (ctx.hasUI) {
        ctx.ui.notify(warning, "warning");
      }

      // Inject steer message to break the pattern
      try {
        pi.sendUserMessage(warning, { deliverAs: "steer" });
      } catch (e) {
        log("warn", `Failed to inject warning: ${e instanceof Error ? e.message : String(e)}`);
      }
      return;
    }

    // ── Critical — engage ────────────────────────────────────────────────

    engaged = true;
    currentLoopTool = event.toolName;

    const reason =
      `🛑 Loop detector engaged: "${event.toolName}" called ${streak}× ` +
      `without progress (${detName}). Mode: ${settings.mode}.`;

    log("error", reason);

    if (ctx.hasUI) {
      ctx.ui.notify(reason, "error");
    }

    if (settings.mode === "warn") {
      // Warn-only: inject steer but don't block
      const steerMsg =
        reason +
        `\n\n${intendedTool ? `Try using "${intendedTool}" instead.` : "Change your approach entirely."}`;
      try {
        pi.sendUserMessage(steerMsg, { deliverAs: "steer" });
      } catch (e) {
        log("error", `Failed to inject steer: ${e instanceof Error ? e.message : String(e)}`);
      }
      // Don't fully engage — keep running
      engaged = false;
      currentLoopTool = null;
      return;
    }

    if (settings.mode === "prune") {
      // Prune mode: inject loop-breaking prompt, give one more chance
      const pruneAppend = detector.buildPrunePromptAppend(event.toolName, streak, intendedTool);
      try {
        pi.sendUserMessage(pruneAppend, { deliverAs: "steer" });
      } catch (e) {
        log("error", `Failed to inject prune prompt: ${e instanceof Error ? e.message : String(e)}`);
      }
      // Don't block — allow one more attempt with the corrective prompt
      return;
    }

    // stop mode: block further tool calls (engaged=true will handle it)
  });

  // ── agent_end: reset for new turn ──────────────────────────────────────

  pi.on("agent_end", async (_event: AgentEndEvent) => {
    detector.reset();
    engaged = false;
    currentLoopTool = null;
  });
}
