/**
 * Hindsight Extension for Pi — Domain-aware agent memory
 *
 * Lifecycle:
 *   session_start       → reset state, verify server + bank auth, set status
 *   input               → capture user prompt for context
 *   before_agent_start  → recall memories from project + global banks
 *   agent_end           → retain turn transcript (delta-only, append mode)
 *   session_compact     → reset recall state (context was rebuilt)
 *
 * Config: parent-traversal of .hindsight/config.toml files (child wins).
 *   bank_id     → active project bank (scope boundary, MUST be explicit)
 *   global_bank → cross-scope shared pool
 *
 * No implicit banks: if no config with bank_id exists in the parent chain,
 * the extension is inactive for that session.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { existsSync, readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { Type } from "@sinclair/typebox";

// ─── Debug ───────────────────────────────────────────────────────────────

const DEBUG = process.env.HINDSIGHT_DEBUG === "1";
const LOG_DIR = join(homedir(), ".hindsight");
const LOG_PATH = join(LOG_DIR, "debug.log");

function log(msg: string) {
  if (!DEBUG) return;
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { mkdirSync(LOG_DIR, { recursive: true }); appendFileSync(LOG_PATH, line); } catch {}
}

function readRecentLog(maxLines = 20): string[] {
  try {
    if (!existsSync(LOG_PATH)) return [];
    return readFileSync(LOG_PATH, "utf-8").split("\n").filter(l => l.trim()).slice(-maxLines);
  } catch { return []; }
}

// ─── Config Resolution (Parent Traversal) ────────────────────────────────

interface ResolvedConfig {
  api_url: string;
  api_key: string;
  bank_id: string | null;
  global_bank: string | null;
  recall_types: string[];
  // Pre-compiled at config-load time. Invalid user patterns are skipped with
  // a console.error rather than left as raw strings to be compiled (and to
  // throw) later inside the agent_end handler.
  strip_patterns: RegExp[];
}

function parseToml(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) return {};
  const raw = readFileSync(filePath, "utf-8");
  const out: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([a-zA-Z0-9_]+)\s*=\s*["']?(.*?)["']?\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function resolveConfig(cwd: string): ResolvedConfig | null {
  try {
    // Collect configs from cwd → root, then reverse to get root → leaf
    // so child configs overwrite parent ones (child wins)
    const configs: Record<string, string>[] = [];

    let dir = cwd;
    while (true) {
      const cfg = parseToml(join(dir, ".hindsight", "config.toml"));
      if (Object.keys(cfg).length) configs.push(cfg);
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }

    configs.reverse();
    // User-wide config is the lowest priority (prepended before reversed list)
    const userCfg = parseToml(join(homedir(), ".hindsight", "config.toml"));
    if (Object.keys(userCfg).length) configs.unshift(userCfg);

    const merged: Record<string, string> = {};
    for (const cfg of configs) Object.assign(merged, cfg);

    return {
      api_url: merged.api_url || "http://localhost:8888",
      api_key: merged.api_key || "",
      bank_id: merged.bank_id || null,
      global_bank: merged.global_bank || null,
      recall_types: merged.recall_types
        ? merged.recall_types.split(",").map(t => t.trim()).filter(Boolean)
        : ["observation"],
      // FIX 3: compile user-supplied strip_patterns at config-load time with
      // explicit per-pattern try/catch. An invalid regex used to throw inside
      // the agent_end handler, where the surrounding try/catch swallowed it
      // silently and dropped the entire retain.
      strip_patterns: merged.strip_patterns
        ? compileStripPatterns(merged.strip_patterns.split(",").map(p => p.trim()).filter(Boolean))
        : [],
    };
  } catch { return null; }
}

function getRecallBanks(config: ResolvedConfig): string[] {
  const banks: string[] = [];
  if (config.bank_id) banks.push(config.bank_id);
  if (config.global_bank) banks.push(config.global_bank);
  return banks;
}

function getRetainBanks(config: ResolvedConfig, prompt: string): string[] {
  const banks = new Set<string>();
  if (config.bank_id) banks.add(config.bank_id);
  if (config.global_bank && (prompt.includes("#global") || prompt.includes("#me"))) {
    banks.add(config.global_bank);
  }
  return Array.from(banks);
}

function getActiveBank(config: ResolvedConfig): string | null {
  return config.bank_id;
}

// ─── Configurable Stripping Patterns ─────────────────────────────────────

const DEFAULT_STRIP_PATTERNS: RegExp[] = [
  // Prevent feedback loop: injected memories from previous recall
  /<hindsight_memories>[\s\S]*?<\/hindsight_memories>/g,
  // Remove reasoning/thinking blocks (not factual content)
  /<(?:antThinking|thinking|reasoning)>[\s\S]*?<\/(?:antThinking|thinking|reasoning)>/g,
  // Remove inline base64 images (massive noise for text memory)
  /data:[^;]+;base64,[A-Za-z0-9+/=]{100,}/g,
];

function compileStripPatterns(patterns: string[]): RegExp[] {
  const compiled: RegExp[] = [];
  for (const p of patterns) {
    try {
      compiled.push(new RegExp(p, "g"));
    } catch (e) {
      console.error(`[hindsight] Invalid strip_pattern regex: ${JSON.stringify(p)} (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  return compiled;
}

function getStripPatterns(config: ResolvedConfig): RegExp[] {
  // strip_patterns are pre-compiled in resolveConfig() — see FIX 3.
  return config.strip_patterns?.length ? config.strip_patterns : DEFAULT_STRIP_PATTERNS;
}

function extractTags(prompt: string): string[] {
  const reserved = new Set(["nomem", "skip", "global", "me"]);
  return Array.from(prompt.matchAll(/(?<=^|\s)#([a-zA-Z0-9_-]+)/g))
    .map(m => m[1].toLowerCase()).filter(t => !reserved.has(t));
}

// ─── Transcript Builder ─────────────────────────────────────────────────

interface AssistantMessage {
  role: string;
  content?: string | Array<{ type: string; name?: string; text?: string; input?: unknown }>;
}

function buildTranscript(prompt: string, messages: AssistantMessage[], stripPatterns: RegExp[]): string {
  let transcript = `[role: user]\n${prompt}\n[user:end]\n\n[role: assistant]\n`;
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    const content = msg.content;
    if (typeof content === "string") {
      transcript += `${content}\n`;
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "text") transcript += `${block.text}\n`;
        // Pi uses block.type === "toolCall" with block.arguments (not Anthropic's "tool_use"/.input).
        // Previously this checked "tool_use" and silently dropped every tool call from the retained transcript.
        else if (block.type === "toolCall" && !OPERATIONAL_TOOLS.has(block.name)) {
          const args = (block as { arguments?: unknown }).arguments ?? (block as { input?: unknown }).input;
          transcript += `[Tool: ${block.name}]\n${args ? JSON.stringify(args) : ""}\n`;
        }
      }
    }
  }
  transcript += `[assistant:end]`;
  for (const pattern of stripPatterns) {
    transcript = transcript.replace(pattern, "");
  }
  return transcript.trim();
}

// ─── Retain Filtering ───────────────────────────────────────────────────

const TRIVIAL_PROMPT_RE = /^(ok|yes|no|thanks|continue|next|done|sure|stop)$/i;

function shouldSkipRetain(prompt: string | null): { skip: boolean; reason?: string } {
  if (!prompt) return { skip: true, reason: "no prompt" };
  if (prompt.length < 5) return { skip: true, reason: "too short" };
  if (TRIVIAL_PROMPT_RE.test(prompt.trim())) return { skip: true, reason: "trivial" };
  if (prompt.trim().startsWith("#nomem") || prompt.trim().startsWith("#skip")) return { skip: true, reason: "opt-out" };
  return { skip: false };
}

// ─── Operation Polling (Silent-Failure Detection — Phase B) ────────────
//
// Hindsight's POST /memories with async:true returns HTTP 200 + an operation_id.
// The server then runs LLM fact extraction in the background. If extraction
// fails (LLM down, budget exhausted, model misconfig) the operation can either:
//   - be marked `failed` with an error_message, or
//   - be marked `completed` with zero facts extracted (silent failure — the
//     4-day bug we are fixing).
//
// Detection rule (verified empirically against vectorize-io/hindsight:latest):
//   `result_metadata.unit_ids_count` is only written by the streaming retain
//   path when at least one fact is committed (orchestrator.py line ~1128:
//   `if operation_id and all_unit_ids`). For a parent batch_retain operation,
//   the parent's own result_metadata never carries this field — we aggregate
//   across child_operations instead.
//
//   completed + (∑ child unit_ids_count) === 0  →  zero-facts alert
//   completed + no child has any unit_ids_count → zero-facts alert (matches
//     the actual production bug pattern: 0-fact retains have the field absent)
//   completed + ∑ unit_ids_count >= 1           →  silent happy path
//   failed                                       →  failed alert with error_message
//   timeout                                      →  debug log only
//
// All polling runs in the background, never awaited by agent_end.

const POLL_INTERVAL_MS = 5000;
const POLL_MAX_ATTEMPTS = 24; // 5s * 24 = 120s

interface OperationStatusResponse {
  operation_id: string;
  status: "pending" | "completed" | "failed" | "not_found" | string;
  operation_type?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  completed_at?: string | null;
  error_message?: string | null;
  result_metadata?: Record<string, unknown> | null;
  child_operations?: Array<{ operation_id: string; status: string; error_message?: string | null }> | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchOperation(
  apiUrl: string,
  apiKey: string,
  bank: string,
  operationId: string,
): Promise<OperationStatusResponse | null> {
  try {
    const res = await fetch(
      `${apiUrl}/v1/default/banks/${bank}/operations/${operationId}`,
      { headers: authHeader(apiKey), signal: AbortSignal.timeout(5000) },
    );
    if (!res.ok) return null;
    return (await res.json()) as OperationStatusResponse;
  } catch {
    return null;
  }
}

/**
 * Aggregate `unit_ids_count` across an operation and (if present) its children.
 * Returns:
 *   - number  ≥ 0   when at least one operation in the tree exposed the field
 *   - null          when no operation in the tree exposed the field
 *                   (treated as zero-facts in production: matches the bug pattern)
 */
async function aggregateUnitsCount(
  apiUrl: string,
  apiKey: string,
  bank: string,
  op: OperationStatusResponse,
): Promise<number | null> {
  let total = 0;
  let anyFieldSeen = false;

  const direct = op.result_metadata?.unit_ids_count;
  if (typeof direct === "number") { total += direct; anyFieldSeen = true; }

  if (Array.isArray(op.child_operations) && op.child_operations.length > 0) {
    // Children are returned WITHOUT result_metadata — fetch each one.
    for (const child of op.child_operations) {
      const childOp = await fetchOperation(apiUrl, apiKey, bank, child.operation_id);
      const c = childOp?.result_metadata?.unit_ids_count;
      if (typeof c === "number") { total += c; anyFieldSeen = true; }
    }
  }

  return anyFieldSeen ? total : null;
}

/**
 * Poll one operation until terminal status or POLL_MAX_ATTEMPTS attempts.
 * Returns the final OperationStatusResponse on terminal status, or null on timeout.
 */
async function pollOperationUntilTerminal(
  apiUrl: string,
  apiKey: string,
  bank: string,
  operationId: string,
): Promise<OperationStatusResponse | null> {
  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    await sleep(POLL_INTERVAL_MS);
    const op = await fetchOperation(apiUrl, apiKey, bank, operationId);
    if (!op) continue;
    if (op.status === "completed" || op.status === "failed" || op.status === "not_found") {
      return op;
    }
  }
  return null;
}

/**
 * Background task: poll a single retain operation and surface failures.
 * `t0` is `Date.now()` at the moment the retain POST returned HTTP 200.
 */
async function watchRetainOperation(
  pi: ExtensionAPI,
  ctx: any,
  config: ResolvedConfig,
  bank: string,
  operationId: string,
  t0: number,
): Promise<void> {
  try {
    const op = await pollOperationUntilTerminal(config.api_url, config.api_key, bank, operationId);
    const op_age_ms = Date.now() - t0;

    if (!op) {
      // 120s elapsed and still pending — debug log only, no user notification.
      log(`retain-poll: timeout op=${operationId} bank=${bank} age_ms=${op_age_ms} status=pending`);
      return;
    }

    if (op.status === "failed") {
      const errMsg = op.error_message || "(no error_message)";
      log(`retain-poll: failed op=${operationId} bank=${bank} age_ms=${op_age_ms} error=${errMsg}`);
      try { ctx.ui.setStatus?.("hindsight", "⚠ retain failed"); } catch {}
      pi.sendMessage(
        {
          customType: "hindsight-retain-failed-async",
          content: "",
          display: true,
          details: { bank, operation_id: operationId, op_age_ms, error_message: errMsg },
        },
        { deliverAs: "nextTurn" },
      );
      return;
    }

    if (op.status === "not_found") {
      log(`retain-poll: not_found op=${operationId} bank=${bank} age_ms=${op_age_ms}`);
      return;
    }

    // status === "completed" — check whether any facts were retained.
    const units = await aggregateUnitsCount(config.api_url, config.api_key, bank, op);
    if (units === null || units === 0) {
      log(`retain-poll: zero-facts op=${operationId} bank=${bank} age_ms=${op_age_ms} units=${units}`);
      try { ctx.ui.setStatus?.("hindsight", "⚠ 0 facts retained"); } catch {}
      pi.sendMessage(
        {
          customType: "hindsight-retain-zero-facts",
          content: "",
          display: true,
          details: { bank, operation_id: operationId, op_age_ms, units_count: units },
        },
        { deliverAs: "nextTurn" },
      );
      return;
    }

    // Happy path — silent.
    log(`retain-poll: ok op=${operationId} bank=${bank} age_ms=${op_age_ms} units=${units}`);
  } catch (e) {
    log(`retain-poll: watcher error op=${operationId} bank=${bank} ${e}`);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

const OPERATIONAL_TOOLS = new Set([
  "bash", "nu", "process", "read", "write", "edit",
  "grep", "ast_grep_search", "ast_grep_replace", "lsp_navigation",
]);

interface HookStats {
  firedAt?: string;
  result?: "ok" | "failed" | "skipped";
  detail?: string;
}

const hookStats: Record<string, HookStats> = { sessionStart: {}, recall: {}, retain: {} };

// ─── Extension ───────────────────────────────────────────────────────────

const MAX_RECALL_ATTEMPTS = 3;
const authHeader = (key: string) => ({ "Authorization": `Bearer ${key || ""}` });

export default function hindsightExtension(pi: ExtensionAPI) {
  let recallDone = false;
  let recallAttempts = 0;
  let currentPrompt = "";

  pi.on("input", async (event) => {
    currentPrompt = event.input ?? event.text ?? currentPrompt;
  });

  // ─── Session lifecycle ─────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    recallDone = false;
    recallAttempts = 0;
    hookStats.sessionStart = { firedAt: new Date().toISOString(), result: "ok" };
    hookStats.recall = {};
    hookStats.retain = {};

    const config = resolveConfig(process.cwd());
    if (!config) {
      ctx.ui.setStatus("hindsight", undefined);
      return;
    }

    // Verify server
    try {
      const health = await fetch(`${config.api_url}/health`, { signal: AbortSignal.timeout(2000) });
      if (!health.ok) { ctx.ui.setStatus("hindsight", `✗ server HTTP ${health.status}`); return; }
    } catch { ctx.ui.setStatus("hindsight", "✗ unreachable"); return; }

    // Verify bank auth
    const bank = getActiveBank(config);
    if (bank) {
      try {
        const res = await fetch(`${config.api_url}/v1/default/banks/${bank}/profile`, { headers: authHeader(config.api_key), signal: AbortSignal.timeout(2000) });
        if (res.status === 401 || res.status === 403) { ctx.ui.setStatus("hindsight", "✗ auth error"); return; }
        ctx.ui.setStatus("hindsight", `🧠 ${bank}`);
      } catch { ctx.ui.setStatus("hindsight", "✗ bank unreachable"); }
    } else {
      log("session_start: no bank_id — extension inactive");
    }
  });

  pi.on("session_compact", async () => {
    recallDone = false;
    recallAttempts = 0;
    log("session_compact: recall state reset");
  });

  // ─── Message Renderers ─────────────────────────────────────────────

  pi.registerMessageRenderer("hindsight-recall", (msg, opt, theme) => {
    const count = (msg.details as any)?.count ?? 0;
    const snippet = (msg.details as any)?.snippet ?? "";
    const memories: string[] = (msg.details as any)?.memories ?? [];
    let t = theme.fg("accent", "🧠 Hindsight");
    t += theme.fg("muted", ` recalled ${count} ${count === 1 ? "memory" : "memories"}`);
    if (!opt?.expanded) t += theme.fg("muted", "  ‣ ctrl+o");
    if (snippet) t += "\n" + theme.fg("dim", snippet);
    // Expanded: show full memory list (no truncation)
    if (opt?.expanded && memories.length) {
      t += "\n";
      for (const mem of memories) {
        t += "\n" + theme.fg("dim", "  " + mem.split("\n").join("\n  "));
      }
    }
    return new Text(t, 0, 0);
  });

  pi.registerMessageRenderer("hindsight-retain", (msg, opt, theme) => {
    const banks: string[] = (msg.details as any)?.banks ?? [];
    const transcript = (msg.details as any)?.transcript ?? "";
    let t = theme.fg("accent", "💾 Hindsight");
    t += theme.fg("muted", " saved turn to memory");
    if (banks.length) t += theme.fg("dim", ` → ${banks.join(", ")}`);
    if (!opt?.expanded) t += theme.fg("muted", "  ‣ ctrl+o");
    // Expanded: show the full transcript that was saved (no truncation)
    if (opt?.expanded && transcript) {
      t += "\n" + theme.fg("dim", "  " + transcript.split("\n").join("\n  "));
    }
    return new Text(t, 0, 0);
  });

  pi.registerMessageRenderer("hindsight-retain-failed", (_msg, _opt, theme) => {
    let t = theme.fg("error", "💾 Hindsight");
    t += theme.fg("muted", " retain failed — use ");
    t += theme.fg("accent", "hindsight_retain");
    t += theme.fg("muted", " to save manually");
    return new Text(t, 0, 0);
  });

  pi.registerMessageRenderer("hindsight-retain-zero-facts", (msg, _opt, theme) => {
    const d = (msg.details as any) ?? {};
    let t = theme.fg("warning", "⚠ Hindsight");
    t += theme.fg("muted", " retain completed but 0 facts extracted");
    if (d.bank) t += theme.fg("dim", ` → ${d.bank}`);
    if (typeof d.op_age_ms === "number") t += theme.fg("dim", ` (${Math.round(d.op_age_ms / 1000)}s)`);
    t += "\n" + theme.fg("dim", "  LLM extraction likely failed silently — check ~/Work/llm-mode.sh status");
    return new Text(t, 0, 0);
  });

  pi.registerMessageRenderer("hindsight-retain-failed-async", (msg, _opt, theme) => {
    const d = (msg.details as any) ?? {};
    let t = theme.fg("error", "✗ Hindsight");
    t += theme.fg("muted", " retain operation failed");
    if (d.bank) t += theme.fg("dim", ` → ${d.bank}`);
    if (typeof d.op_age_ms === "number") t += theme.fg("dim", ` (${Math.round(d.op_age_ms / 1000)}s)`);
    if (d.error_message) t += "\n" + theme.fg("dim", `  ${String(d.error_message).slice(0, 300)}`);
    return new Text(t, 0, 0);
  });

  // ─── Manual Tools ──────────────────────────────────────────────────

  pi.registerTool({
    name: "hindsight_recall",
    label: "Hindsight Recall",
    description: "Pull relevant context, conventions, or past decisions from project memory.",
    parameters: Type.Object({
      query: Type.String({ description: "What to search for" }),
      bank: Type.Optional(Type.String({ description: "Specific bank to query (e.g. 'project-alpha', 'project-Pi-Agent'). Defaults to project + global banks." })),
      banks: Type.Optional(Type.Array(Type.String(), { description: "Multiple banks to query simultaneously." })),
    }),
    async execute(_id, params) {
      const config = resolveConfig(process.cwd());
      if (!config?.api_url) return { content: [{ type: "text" as const, text: "Hindsight not configured." }], details: {}, isError: true };
      const p = params as any;
      const banks = p.bank ? [p.bank] : p.banks?.length ? p.banks : getRecallBanks(config);
      if (!banks.length) return { content: [{ type: "text" as const, text: "No banks configured." }], details: {}, isError: true };
      try {
        const results = await Promise.all(banks.map(async (bank) => {
          const res = await fetch(`${config.api_url}/v1/default/banks/${bank}/memories/recall`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...authHeader(config.api_key) },
            body: JSON.stringify({ query: p.query, budget: "mid", query_timestamp: new Date().toISOString(), types: config.recall_types }),
            signal: AbortSignal.timeout(2000),
          });
          if (!res.ok) return [];
          const data = await res.json();
          return (data.results || []).map((r: any) => `[${bank}] ${r.text}`);
        }));
        const flat = results.flat();
        return flat.length
          ? { content: [{ type: "text" as const, text: flat.join("\n\n") }], details: { banks: banks.join(", "), count: flat.length } }
          : { content: [{ type: "text" as const, text: "No memories found." }], details: { banks: banks.join(", ") } };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${e}` }], details: {}, isError: true };
      }
    },
  });

  pi.registerTool({
    name: "hindsight_retain",
    label: "Hindsight Retain",
    description: "Save an important insight to memory. Auto-retain handles routine turns. Use this tool for knowledge worth preserving beyond the current session.",
    parameters: Type.Object({
      content: Type.String({ description: "The insight to save — include full context" }),
      scope: Type.Optional(Type.Union([Type.Literal("project"), Type.Literal("global")], {
        description: "Use 'project' for project-specific knowledge (decisions, bugs, patterns). Use 'global' for cross-project knowledge: coding conventions, tool preferences, environment setup, architecture patterns, or lessons learned that apply to other projects. When in doubt, use 'project'.",
      })),
      bank: Type.Optional(Type.String({ description: "Explicit bank name to write to (e.g. 'project-beta', 'project-gamma'). Overrides scope." })),
    }),
    async execute(_id, params) {
      const config = resolveConfig(process.cwd());
      if (!config?.api_url) return { content: [{ type: "text" as const, text: "Hindsight not configured." }], details: {}, isError: true };
      const p = params as any;
      const bank = p.bank || (p.scope === "global" && config.global_bank ? config.global_bank : getActiveBank(config));
      if (!bank) return { content: [{ type: "text" as const, text: "No bank_id configured." }], details: {}, isError: true };
      try {
        const res = await fetch(`${config.api_url}/v1/default/banks/${bank}/memories`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeader(config.api_key) },
          body: JSON.stringify({
            items: [{ content: params.content, context: "pi: explicit retain", timestamp: new Date().toISOString() }],
            async: false,
          }),
          signal: AbortSignal.timeout(5000),
        });
        return res.ok
          ? { content: [{ type: "text" as const, text: `Memory retained → ${bank}.` }], details: { bank, scope: p.bank ? "explicit" : (p.scope || "project") } }
          : { content: [{ type: "text" as const, text: `Failed to retain to ${bank}.` }], details: {}, isError: true };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${e}` }], details: {}, isError: true };
      }
    },
  });

  pi.registerTool({
    name: "hindsight_reflect",
    label: "Hindsight Reflect",
    description: "Synthesize insights from memory to answer complex questions.",
    parameters: Type.Object({ query: Type.String() }),
    async execute(_id, params) {
      const config = resolveConfig(process.cwd());
      if (!config?.api_url) return { content: [{ type: "text" as const, text: "Hindsight not configured." }], details: {}, isError: true };
      const bank = getActiveBank(config);
      if (!bank) return { content: [{ type: "text" as const, text: "No bank_id configured." }], details: {}, isError: true };
      try {
        const res = await fetch(`${config.api_url}/v1/default/banks/${bank}/memories/reflect`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeader(config.api_key) },
          body: JSON.stringify({ query: params.query }),
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) {
          const data = await res.json();
          return { content: [{ type: "text" as const, text: data.synthesis || JSON.stringify(data) }], details: {} };
        }
        return { content: [{ type: "text" as const, text: "Reflection failed." }], details: {}, isError: true };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${e}` }], details: {}, isError: true };
      }
    },
  });

  pi.registerTool({
    name: "hindsight_promote",
    label: "Hindsight Promote Memories",
    description: "Copy memories between banks. Use to analyze what knowledge from one project applies to another — recall from the source bank, copy matching memories to the target bank. Use case: 'analyze what memories from project-alpha could be applicable to project-beta and add them there'.",
    parameters: Type.Object({
      query: Type.String({ description: "What to search for in the source bank (e.g. 'drafting conventions', 'procedural rules', 'code style')" }),
      from: Type.Optional(Type.String({ description: "Source bank ID. Defaults to the active project bank." })),
      to: Type.Optional(Type.String({ description: "Target bank ID. Defaults to the global bank." })),
    }),
    async execute(_id, params) {
      const config = resolveConfig(process.cwd());
      if (!config?.api_url) return { content: [{ type: "text" as const, text: "Hindsight not configured." }], details: {}, isError: true };
      const p = params as any;
      const fromBank = p.from || getActiveBank(config);
      const toBank = p.to || config.global_bank;
      if (!fromBank) return { content: [{ type: "text" as const, text: "No source bank (no bank_id configured, and no 'from' specified)." }], details: {}, isError: true };
      if (!toBank) return { content: [{ type: "text" as const, text: "No target bank (no global_bank configured, and no 'to' specified)." }], details: {}, isError: true };
      try {
        // Recall from source bank
        const res = await fetch(`${config.api_url}/v1/default/banks/${fromBank}/memories/recall`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeader(config.api_key) },
          body: JSON.stringify({ query: p.query, budget: "mid", query_timestamp: new Date().toISOString(), types: config.recall_types }),
          signal: AbortSignal.timeout(2000),
        });
        if (!res.ok) return { content: [{ type: "text" as const, text: `Recall from ${fromBank} failed (HTTP ${res.status}).` }], details: {}, isError: true };
        const data = await res.json();
        const memories = data.results || [];
        if (!memories.length) return { content: [{ type: "text" as const, text: `No memories in ${fromBank} matching \"${p.query}\".` }], details: {} };

        // Copy each memory to target bank
        const promoted: string[] = [];
        for (const mem of memories) {
          const copyRes = await fetch(`${config.api_url}/v1/default/banks/${toBank}/memories`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...authHeader(config.api_key) },
            body: JSON.stringify({
              items: [{ content: mem.text, context: `pi: promoted from ${fromBank}`, timestamp: new Date().toISOString(), tags: [...(mem.tags || []), "promoted"] }],
              async: false,
            }),
            signal: AbortSignal.timeout(5000),
          });
          if (copyRes.ok) promoted.push(mem.text.slice(0, 100));
        }

        if (promoted.length) {
          return {
            content: [{ type: "text" as const, text: `Promoted ${promoted.length} memories from ${fromBank} → ${toBank}:\n\n${promoted.map((m: string) => `• ${m}...`).join("\n")}` }],
            details: { count: promoted.length, from: fromBank, to: toBank },
          };
        }
        return { content: [{ type: "text" as const, text: `Found ${memories.length} memories but failed to copy to ${toBank}.` }], details: {}, isError: true };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${e}` }], details: {}, isError: true };
      }
    },
  });

  // ─── Auto-Recall (before_agent_start) ──────────────────────────────

  pi.on("before_agent_start", async (_event, ctx) => {
    if (recallDone || recallAttempts >= MAX_RECALL_ATTEMPTS) return;
    recallAttempts++;

    const config = resolveConfig(process.cwd());
    if (!config?.api_url) { recallAttempts = MAX_RECALL_ATTEMPTS; return; }

    const banks = getRecallBanks(config);
    if (!banks.length) { recallAttempts = MAX_RECALL_ATTEMPTS; return; }

    const query = getLastUserMessage(ctx, currentPrompt) || "Provide context for current project";
    log(`recall: attempt ${recallAttempts}/${MAX_RECALL_ATTEMPTS}, banks=${banks.join(",")}`);

    // FIX 2: per-bank state — auth failure on one bank must not poison the
    // others. Aggregate any successful results, only mark a specific bank as
    // auth-failed, and bail out only when *all* banks failed auth (in which
    // case there's nothing to retry).
    type BankOutcome = "ok" | "auth-failed" | "error";
    const bankOutcomes = new Map<string, BankOutcome>();
    const allResults: string[] = [];

    try {
      await Promise.all(banks.map(async (bank) => {
        try {
          const res = await fetch(`${config.api_url}/v1/default/banks/${bank}/memories/recall`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...authHeader(config.api_key) },
            body: JSON.stringify({ query, budget: "mid", query_timestamp: new Date().toISOString(), types: config.recall_types }),
            signal: AbortSignal.timeout(2000),
          });
          if (res.status === 401 || res.status === 403) {
            bankOutcomes.set(bank, "auth-failed");
            log(`recall: bank=${bank} auth error (HTTP ${res.status}) — other banks unaffected`);
            return;
          }
          if (!res.ok) {
            bankOutcomes.set(bank, "error");
            return;
          }
          bankOutcomes.set(bank, "ok");
          const data = await res.json();
          for (const r of (data.results || [])) allResults.push(`[${bank}] ${r.text}`);
        } catch (e) {
          bankOutcomes.set(bank, "error");
          log(`recall: bank=${bank} fetch error ${e}`);
        }
      }));

      const okBanks = banks.filter(b => bankOutcomes.get(b) === "ok");
      const authFailedBanks = banks.filter(b => bankOutcomes.get(b) === "auth-failed");
      const anyOk = okBanks.length > 0;
      const allAuthFailed = authFailedBanks.length === banks.length;

      if (allAuthFailed) {
        // Every bank rejected our credentials — no point retrying this session.
        recallAttempts = MAX_RECALL_ATTEMPTS;
        hookStats.recall = { firedAt: new Date().toISOString(), result: "failed", detail: "auth error" };
        ctx.ui.setStatus("hindsight", "✗ auth error");
        return;
      }

      if (anyOk) {
        recallDone = true;
        if (allResults.length) {
          const detail = authFailedBanks.length
            ? `${allResults.length} memories (auth failed: ${authFailedBanks.join(",")})`
            : `${allResults.length} memories`;
          hookStats.recall = { firedAt: new Date().toISOString(), result: "ok", detail };
          const snippet = allResults.slice(0, 3).map((r: string) => r.replace(/^\[[^\]]+\] /, "")).join(" · ").slice(0, 200);
          return {
            message: {
              customType: "hindsight-recall",
              content: `<hindsight_memories>\nRelevant memories from past sessions:\n\n${allResults.join("\n\n")}\n</hindsight_memories>`,
              display: true,
              details: { count: allResults.length, snippet, memories: allResults },
            },
          };
        }
        hookStats.recall = {
          firedAt: new Date().toISOString(),
          result: "ok",
          detail: authFailedBanks.length ? `empty (auth failed: ${authFailedBanks.join(",")})` : "empty",
        };
      } else {
        const isLast = recallAttempts >= MAX_RECALL_ATTEMPTS;
        hookStats.recall = { firedAt: new Date().toISOString(), result: "failed", detail: isLast ? "unreachable" : "retrying" };
        ctx.ui.setStatus("hindsight", isLast ? "✗ unreachable" : "⚠ retrying");
      }
    } catch (e) {
      const isLast = recallAttempts >= MAX_RECALL_ATTEMPTS;
      ctx.ui.setStatus("hindsight", isLast ? "✗ unreachable" : "⚠ retrying");
      log(`recall: error ${e}`);
    }
  });

  // ─── Auto-Retain (agent_end) ───────────────────────────────────────

  pi.on("agent_end", async (event, ctx) => {
    const config = resolveConfig(process.cwd());
    if (!config?.api_url) return;

    const prompt = getLastUserMessage(ctx, currentPrompt);
    const skipCheck = shouldSkipRetain(prompt);
    if (skipCheck.skip) { log(`agent_end: skip (${skipCheck.reason})`); return; }

    const bank = getActiveBank(config);
    if (!bank) return;

    const tags = extractTags(prompt);
    const banks = getRetainBanks(config, prompt);
    const stripPatterns = getStripPatterns(config);

    // Build transcript
    const rawTranscript = buildTranscript(prompt, event.messages || [], stripPatterns);
    if (rawTranscript.length < 20) return;
    let transcript = rawTranscript.length > 50000 ? rawTranscript.slice(0, 50000) + "\n...[TRUNCATED]" : rawTranscript;

    const sessionId = ctx.sessionManager?.getSessionId?.() || `unknown-${Date.now()}`;
    // Include local date/time in context so the extraction LLM generates timezone-correct memory dates
    const now = new Date();
    const localDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const localTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    log(`retain: banks=${banks.join(",")} len=${transcript.length} tags=${tags.join(",")}`);

    try {
      const t0 = Date.now();
      const results = await Promise.allSettled(
        banks.map(async (b) => {
          const res = await fetch(`${config.api_url}/v1/default/banks/${b}/memories`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...authHeader(config.api_key) },
            body: JSON.stringify({
              items: [{
                content: transcript,
                document_id: `session-${sessionId}`,
                update_mode: "append",
                context: `pi | ${localDate} ${localTime} ${tz}`,
                timestamp: new Date().toISOString(),
                ...(tags.length && { tags }),
              }],
              async: true,
            }),
            signal: AbortSignal.timeout(5000),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          // Capture operation_id from RetainResponse so we can poll for silent failures.
          let operationId: string | null = null;
          try {
            const data = await res.json() as { operation_id?: string | null; operation_ids?: string[] | null };
            operationId = data.operation_id || (Array.isArray(data.operation_ids) ? data.operation_ids[0] : null) || null;
          } catch { /* response body not JSON — proceed without polling */ }
          return { bank: b, operationId };
        }),
      );

      const fulfilled = results
        .filter((r): r is PromiseFulfilledResult<{ bank: string; operationId: string | null }> => r.status === "fulfilled")
        .map(r => r.value);
      const ok = fulfilled.map(v => v.bank);
      hookStats.retain = { firedAt: new Date().toISOString(), result: ok.length ? "ok" : "failed", detail: ok.join(", ") };

      if (ok.length) {
        const transcriptPreview = transcript.length > 1000 ? transcript.slice(0, 1000) + "…" : transcript;
        pi.sendMessage({ customType: "hindsight-retain", content: "", display: true, details: { banks: ok, transcript: transcriptPreview } }, { deliverAs: "nextTurn" });
      } else {
        ctx.ui.setStatus("hindsight", "⚠ retain failed");
        pi.sendMessage({ customType: "hindsight-retain-failed", content: "", display: true }, { deliverAs: "nextTurn" });
      }

      // ─── Phase B: background polling for silent failures ─────────────
      // No await — these promises run after agent_end returns.
      for (const { bank: b, operationId } of fulfilled) {
        if (!operationId) {
          log(`retain: bank=${b} no operation_id in response — skipping watcher`);
          continue;
        }
        void watchRetainOperation(pi, ctx, config, b, operationId, t0);
      }
    } catch (e) {
      log(`retain: error ${e}`);
    }
  });

  // ─── Commands ──────────────────────────────────────────────────────

  pi.registerCommand("hindsight", {
    description: "Hindsight memory status. Usage: /hindsight [status|stats]",
    handler: async (args: any, ctx) => {
      const config = resolveConfig(process.cwd());
      if (!config) { ctx.ui.notify("Hindsight not configured — no .hindsight/config.toml in path.", "warning"); return; }

      const sub = typeof args === "string" ? args.trim() : "";

      if (sub === "status") {
        const lines: string[] = [];
        const bank = getActiveBank(config);
        lines.push(`Bank:   ${bank || "(none)"}`);
        if (config.global_bank) lines.push(`Global: ${config.global_bank}`);
        lines.push("");

        try {
          const health = await fetch(`${config.api_url}/health`, { signal: AbortSignal.timeout(2000) });
          lines.push(`Server: ${health.ok ? "✓ online" : `✗ HTTP ${health.status}`}`);
        } catch { lines.push("Server: ✗ unreachable"); }

        lines.push(`URL:    ${config.api_url}`);
        if (!config.api_key) lines.push("  ⚠ no api_key");

        if (bank) {
          try {
            const res = await fetch(`${config.api_url}/v1/default/banks/${bank}/profile`, { headers: authHeader(config.api_key), signal: AbortSignal.timeout(2000) });
            lines.push(`Bank auth: ${res.status === 401 || res.status === 403 ? "✗ invalid" : "✓ ok"}`);
          } catch { lines.push("Bank auth: ✗ unreachable"); }
        }

        lines.push("");
        lines.push("Hooks:");
        const icon = (r?: string) => r === "ok" ? "✓" : r === "failed" ? "✗" : "…";
        const fmt = (s: HookStats) => s.firedAt ? `${icon(s.result)} ${s.result}${s.detail ? ` (${s.detail})` : ""}` : "not fired";
        lines.push(`  session_start: ${fmt(hookStats.sessionStart)}`);
        lines.push(`  recall:        ${fmt(hookStats.recall)}`);
        lines.push(`  retain:        ${fmt(hookStats.retain)}`);

        if (DEBUG) {
          const logLines = readRecentLog(10);
          if (logLines.length) {
            lines.push("");
            lines.push(`Debug log (last ${logLines.length}):`);
            logLines.forEach(l => lines.push(`  ${l}`));
          }
        }

        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      if (sub === "stats") {
        const banks = getRecallBanks(config);
        if (!banks.length) { ctx.ui.notify("No banks configured.", "info"); return; }
        const results = await Promise.all(banks.map(async (bank) => {
          try {
            const res = await fetch(`${config.api_url}/v1/default/banks/${bank}/stats`, { signal: AbortSignal.timeout(2000) });
            if (!res.ok) return `${bank}: unavailable`;
            const data = await res.json();
            const entries = Object.entries(data).map(([k, v]) => `  ${k}: ${v}`).join("\n");
            return `${bank}:\n${entries}`;
          } catch { return `${bank}: error`; }
        }));
        ctx.ui.notify(results.join("\n\n"), "info");
        return;
      }

      ctx.ui.notify(`Bank: ${getActiveBank(config) || "none"}\nGlobal: ${config.global_bank || "none"}\nRecall: ${getRecallBanks(config).join(", ")}\n/hindsight status | stats`, "info");
    },
  });
}

function getLastUserMessage(ctx: any, fallback: string): string {
  try {
    const entries = ctx.sessionManager?.getEntries() || [];
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.type === "message" && e.message?.role === "user") {
        return typeof e.message.content === "string" ? e.message.content : JSON.stringify(e.message.content);
      }
    }
  } catch {}
  return fallback;
}
