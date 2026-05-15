/**
 * LLM-driven security evaluator for Tier-3 commands.
 *
 * Tier 3 = commands that are *contextually* destructive but cheap and
 * common in dev workflows. Today: `kill / pkill / killall <pid|name>`. The
 * judge sees the command + project context + cascaded HOOKS-POLICY.md and
 * returns one of three verdicts:
 *
 *   - "allow"   → command runs; no dialog
 *   - "confirm" → bash precheck blocks and instructs the agent to call
 *                 notify_user; the user sees the dialog as today
 *   - "block"   → bash precheck blocks with a hard reason
 *
 * Failure semantics — **all fail-closed**:
 *   - judge disabled                       → "confirm"
 *   - rate-limit exceeded                  → "confirm"
 *   - network error / timeout              → "confirm"
 *   - non-OK HTTP                          → "confirm"
 *   - unparsable response                  → "confirm"
 *   - response missing/invalid verdict     → "confirm"
 *
 * "Fail-closed" here means **never auto-allow** \u2014 the worst case the judge can
 * produce is the current behaviour (block + ask the user). It cannot make
 * a destructive command *less* safe than today.
 *
 * The endpoint is OpenAI-compatible (LMStudio's `/v1/chat/completions`,
 * Cerebras, etc.). We use JSON-schema response_format for deterministic
 * parsing where supported and fall back to JSON-mode then to free-text
 * extraction.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { JudgeConfig } from "./judge-config.js";

// ============================================================================
// Types
// ============================================================================

export type Verdict = "allow" | "confirm" | "block";

export interface JudgeRequest {
  /** Full command string the precheck is about to dispatch. */
  command: string;
  /** Process cwd for the bash call. */
  cwd: string;
  /** Concatenated HOOKS-POLICY.md cascade (may be empty). */
  policyText: string;
  /** Last N bash commands the agent has run this session. Most-recent last. */
  recentCommands?: string[];
  /** Last user prompt (truncated). */
  lastUserPrompt?: string;
  /** Reason this command was routed to the judge (e.g. "kill <pid>"). */
  routingReason: string;
}

export interface JudgeResult {
  verdict: Verdict;
  reason: string;
  /** Wall-clock ms spent in the call (incl. fallback if used). */
  latencyMs: number;
  /** Which endpoint produced the verdict, or "none" if fail-closed. */
  source: "primary" | "fallback" | "none";
  /** Non-fatal warnings: rate-limit, parse fallback, timeout, etc. */
  warnings: string[];
}

// ============================================================================
// Rate limiter (sliding 60s window)
// ============================================================================

class RateLimiter {
  private timestamps: number[] = [];
  constructor(private maxPerMinute: number, private nowFn: () => number = Date.now) {}

  tryAcquire(): boolean {
    const now = this.nowFn();
    const cutoff = now - 60_000;
    // Drop expired entries.
    while (this.timestamps.length && this.timestamps[0] < cutoff) this.timestamps.shift();
    if (this.timestamps.length >= this.maxPerMinute) return false;
    this.timestamps.push(now);
    return true;
  }

  reset(): void {
    this.timestamps = [];
  }
}

let _limiter: RateLimiter | null = null;
let _limiterMax = 0;

function getLimiter(config: JudgeConfig): RateLimiter {
  if (!_limiter || _limiterMax !== config.maxCallsPerMinute) {
    _limiter = new RateLimiter(config.maxCallsPerMinute);
    _limiterMax = config.maxCallsPerMinute;
  }
  return _limiter;
}

/** Test-only reset. */
export function _resetLimiter(): void {
  _limiter = null;
  _limiterMax = 0;
}

// ============================================================================
// Prompt construction
// ============================================================================

const SYSTEM_PROMPT = `You are a strict security evaluator for an autonomous coding agent's bash commands.

Return ONE of three verdicts as JSON:
  { "verdict": "allow",   "reason": "<one-line explanation>" }
  { "verdict": "confirm", "reason": "<one-line explanation>" }
  { "verdict": "block",   "reason": "<one-line explanation>" }

Definitions:
  - "allow"   : the command is clearly routine in the given project context. Run it without bothering the user.
  - "confirm" : ambiguous; ask the user via a dialog.
  - "block"   : clearly dangerous and not justified by context.

Hard rules (these have already been filtered upstream; if you ever see one, return "block"):
  sudo, dd, mkfs, diskutil, writes to /dev/sd*, SQL DROP/TRUNCATE, kill -1, pipe-to-shell.

Default posture is "confirm". Return "allow" ONLY when:
  - the command's target is plainly something the agent or user just touched in the session, AND
  - the project policy (if any) does not forbid it, AND
  - the worst-case outcome is recoverable (e.g. respawning a server) within minutes.

Output STRICT JSON only \u2014 no prose, no markdown fences.`;

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["allow", "confirm", "block"] },
    reason: { type: "string", maxLength: 240 },
  },
  required: ["verdict", "reason"],
  additionalProperties: false,
} as const;

function buildUserPrompt(req: JudgeRequest): string {
  const lines: string[] = [];
  lines.push(`Command to evaluate:`);
  lines.push("```");
  lines.push(req.command);
  lines.push("```");
  lines.push("");
  lines.push(`Routing reason: ${req.routingReason}`);
  lines.push(`cwd: ${req.cwd}`);
  if (req.lastUserPrompt) {
    lines.push("");
    lines.push(`Last user prompt (truncated):`);
    lines.push(req.lastUserPrompt.slice(0, 1000));
  }
  if (req.recentCommands && req.recentCommands.length) {
    lines.push("");
    lines.push(`Recent agent bash commands (most recent last):`);
    for (const c of req.recentCommands.slice(-10)) lines.push(`  - ${c}`);
  }
  if (req.policyText && req.policyText.trim()) {
    lines.push("");
    lines.push(`Project HOOKS-POLICY.md cascade (advisory context, not enforcement):`);
    lines.push(req.policyText);
  }
  lines.push("");
  lines.push(`Verdict?`);
  return lines.join("\n");
}

// ============================================================================
// Single-endpoint call
// ============================================================================

interface EndpointCall {
  endpoint: string;
  model: string;
  apiKey: string | null;
}

interface CallOutcome {
  ok: true;
  verdict: Verdict;
  reason: string;
  warnings: string[];
}

interface CallFailure {
  ok: false;
  error: string;
  warnings: string[];
}

async function callEndpoint(
  call: EndpointCall,
  req: JudgeRequest,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<CallOutcome | CallFailure> {
  const warnings: string[] = [];
  const url = call.endpoint.replace(/\/+$/, "") + "/chat/completions";
  const body = {
    model: call.model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildUserPrompt(req) },
    ],
    temperature: 0,
    max_tokens: 200,
    response_format: {
      type: "json_schema",
      json_schema: { name: "verdict", strict: true, schema: RESPONSE_SCHEMA },
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(call.apiKey ? { Authorization: `Bearer ${call.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    return { ok: false, error: `fetch failed: ${(err as Error).message}`, warnings };
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    let detail = "";
    try { detail = (await res.text()).slice(0, 240); } catch { /* ignore */ }
    return { ok: false, error: `HTTP ${res.status}: ${detail}`, warnings };
  }

  let payload: any;
  try {
    payload = await res.json();
  } catch (err) {
    return { ok: false, error: `non-JSON body: ${(err as Error).message}`, warnings };
  }

  const content: unknown = payload?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    return { ok: false, error: `empty response content`, warnings };
  }

  // Parse strict JSON first; on failure try to extract a JSON object from
  // the text (some servers ignore response_format and emit prose+JSON).
  let parsed: any;
  try {
    parsed = JSON.parse(content);
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) return { ok: false, error: `unparseable verdict content: ${content.slice(0, 240)}`, warnings };
    try {
      parsed = JSON.parse(match[0]);
      warnings.push("judge: response_format ignored by server, fell back to regex extraction");
    } catch (err) {
      return { ok: false, error: `extracted JSON invalid: ${(err as Error).message}`, warnings };
    }
  }

  const verdict = parsed?.verdict;
  if (verdict !== "allow" && verdict !== "confirm" && verdict !== "block") {
    return { ok: false, error: `invalid verdict value: ${JSON.stringify(verdict)}`, warnings };
  }
  const reason = typeof parsed?.reason === "string" ? parsed.reason.slice(0, 240) : "";
  return { ok: true, verdict, reason, warnings };
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Ask the judge for a verdict. Always resolves (never throws). On any
 * failure the result is a fail-closed `confirm` so the user sees the
 * existing dialog.
 *
 * `fetchImpl` is exposed for tests.
 */
export async function judgeCommand(
  req: JudgeRequest,
  config: JudgeConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<JudgeResult> {
  const t0 = Date.now();

  if (!config.enabled) {
    return { verdict: "confirm", reason: "judge disabled", latencyMs: 0, source: "none", warnings: [] };
  }

  // Rate-limit first \u2014 fail-closed if exhausted.
  if (!getLimiter(config).tryAcquire()) {
    return {
      verdict: "confirm",
      reason: "judge rate-limited (fail-closed)",
      latencyMs: Date.now() - t0,
      source: "none",
      warnings: [`judge: > ${config.maxCallsPerMinute} calls/min, falling back to confirm`],
    };
  }

  const primary: EndpointCall = { endpoint: config.endpoint, model: config.model, apiKey: config.apiKey };
  const primaryOutcome = await callEndpoint(primary, req, config.timeoutMs, fetchImpl);

  if (primaryOutcome.ok) {
    const result: JudgeResult = {
      verdict: primaryOutcome.verdict,
      reason: primaryOutcome.reason,
      latencyMs: Date.now() - t0,
      source: "primary",
      warnings: primaryOutcome.warnings,
    };
    appendAuditLog(config.logPath, req, result);
    return result;
  }

  // Primary failed. Try fallback if configured.
  if (config.fallback) {
    const fallbackOutcome = await callEndpoint(
      {
        endpoint: config.fallback.endpoint,
        model: config.fallback.model,
        apiKey: config.fallback.apiKey,
      },
      req,
      config.timeoutMs,
      fetchImpl,
    );
    if (fallbackOutcome.ok) {
      const result: JudgeResult = {
        verdict: fallbackOutcome.verdict,
        reason: fallbackOutcome.reason,
        latencyMs: Date.now() - t0,
        source: "fallback",
        warnings: [`judge: primary failed (${primaryOutcome.error}); fallback succeeded`, ...fallbackOutcome.warnings],
      };
      appendAuditLog(config.logPath, req, result);
      return result;
    }
    const result: JudgeResult = {
      verdict: "confirm",
      reason: "judge primary+fallback failed (fail-closed)",
      latencyMs: Date.now() - t0,
      source: "none",
      warnings: [`judge primary error: ${primaryOutcome.error}`, `judge fallback error: ${fallbackOutcome.error}`],
    };
    appendAuditLog(config.logPath, req, result);
    return result;
  }

  // No fallback. Fail-closed.
  const result: JudgeResult = {
    verdict: "confirm",
    reason: "judge failed (fail-closed)",
    latencyMs: Date.now() - t0,
    source: "none",
    warnings: [`judge error: ${primaryOutcome.error}`],
  };
  appendAuditLog(config.logPath, req, result);
  return result;
}

// ============================================================================
// Audit log
// ============================================================================

function appendAuditLog(logPath: string, req: JudgeRequest, result: JudgeResult): void {
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      cwd: req.cwd,
      command: req.command,
      routingReason: req.routingReason,
      verdict: result.verdict,
      reason: result.reason,
      source: result.source,
      latencyMs: result.latencyMs,
      warnings: result.warnings,
    });
    fs.appendFileSync(logPath, entry + "\n", "utf-8");
  } catch {
    // Audit log is best-effort. Don't let it break the precheck.
  }
}
