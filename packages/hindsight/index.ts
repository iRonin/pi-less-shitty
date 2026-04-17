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

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
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
    const merged: Record<string, string> = {};
    Object.assign(merged, parseToml(join(homedir(), ".hindsight", "config.toml")));

    let dir = cwd;
    while (true) {
      Object.assign(merged, parseToml(join(dir, ".hindsight", "config.toml")));
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }

    return {
      api_url: merged.api_url || "http://localhost:8888",
      api_key: merged.api_key || "",
      bank_id: merged.bank_id || null,
      global_bank: merged.global_bank || null,
      recall_types: merged.recall_types
        ? merged.recall_types.split(",").map(t => t.trim()).filter(Boolean)
        : ["observation"],
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

function extractTags(prompt: string): string[] {
  const reserved = new Set(["nomem", "skip", "global", "me"]);
  return Array.from(prompt.matchAll(/(?<=^|\s)#([a-zA-Z0-9_-]+)/g))
    .map(m => m[1].toLowerCase()).filter(t => !reserved.has(t));
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
      const health = await fetch(`${config.api_url}/health`);
      if (!health.ok) { ctx.ui.setStatus("hindsight", `✗ server HTTP ${health.status}`); return; }
    } catch { ctx.ui.setStatus("hindsight", "✗ unreachable"); return; }

    // Verify bank auth
    const bank = getActiveBank(config);
    if (bank) {
      try {
        const res = await fetch(`${config.api_url}/v1/default/banks/${bank}/profile`, { headers: authHeader(config.api_key) });
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

  pi.registerMessageRenderer("hindsight-recall", (msg, _opt, theme) => {
    const count = (msg.details as any)?.count ?? 0;
    const snippet = (msg.details as any)?.snippet ?? "";
    let t = theme.fg("accent", "🧠 Hindsight");
    t += theme.fg("muted", ` recalled ${count} ${count === 1 ? "memory" : "memories"}`);
    if (snippet) t += "\n" + theme.fg("dim", snippet);
    return new Text(t, 0, 0);
  });

  pi.registerMessageRenderer("hindsight-retain", (msg, _opt, theme) => {
    const banks: string[] = (msg.details as any)?.banks ?? [];
    let t = theme.fg("accent", "💾 Hindsight");
    t += theme.fg("muted", " saved turn to memory");
    if (banks.length) t += theme.fg("dim", ` → ${banks.join(", ")}`);
    return new Text(t, 0, 0);
  });

  pi.registerMessageRenderer("hindsight-retain-failed", (_msg, _opt, theme) => {
    let t = theme.fg("error", "💾 Hindsight");
    t += theme.fg("muted", " retain failed — use ");
    t += theme.fg("accent", "hindsight_retain");
    t += theme.fg("muted", " to save manually");
    return new Text(t, 0, 0);
  });

  // ─── Manual Tools ──────────────────────────────────────────────────

  pi.registerTool({
    name: "hindsight_recall",
    label: "Hindsight Recall",
    description: "Pull relevant context, conventions, or past decisions from project memory.",
    parameters: Type.Object({ query: Type.String({ description: "What to search for" }) }),
    async execute(_id, params) {
      const config = resolveConfig(process.cwd());
      if (!config?.api_url) return { content: [{ type: "text" as const, text: "Hindsight not configured." }], details: {}, isError: true };
      const banks = getRecallBanks(config);
      if (!banks.length) return { content: [{ type: "text" as const, text: "No bank_id configured." }], details: {}, isError: true };
      try {
        const results = await Promise.all(banks.map(async (bank) => {
          const res = await fetch(`${config.api_url}/v1/default/banks/${bank}/memories/recall`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...authHeader(config.api_key) },
            body: JSON.stringify({ query: params.query, budget: "mid", query_timestamp: new Date().toISOString(), types: config.recall_types }),
          });
          if (!res.ok) return [];
          const data = await res.json();
          return (data.results || []).map((r: any) => `[${bank}] ${r.text}`);
        }));
        const flat = results.flat();
        return flat.length
          ? { content: [{ type: "text" as const, text: flat.join("\n\n") }], details: {} }
          : { content: [{ type: "text" as const, text: "No memories found." }], details: {} };
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
    }),
    async execute(_id, params) {
      const config = resolveConfig(process.cwd());
      if (!config?.api_url) return { content: [{ type: "text" as const, text: "Hindsight not configured." }], details: {}, isError: true };
      const scope = (params as any).scope || "project";
      const bank = scope === "global" && config.global_bank ? config.global_bank : getActiveBank(config);
      if (!bank) return { content: [{ type: "text" as const, text: "No bank_id configured." }], details: {}, isError: true };
      try {
        const res = await fetch(`${config.api_url}/v1/default/banks/${bank}/memories`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeader(config.api_key) },
          body: JSON.stringify({
            items: [{ content: params.content, context: "pi: explicit retain", timestamp: new Date().toISOString() }],
            async: false,
          }),
        });
        return res.ok
          ? { content: [{ type: "text" as const, text: `Memory retained → ${bank}.` }], details: { bank, scope } }
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

    let anyOk = false;
    let authErr = false;
    const allResults: string[] = [];

    try {
      await Promise.all(banks.map(async (bank) => {
        const res = await fetch(`${config.api_url}/v1/default/banks/${bank}/memories/recall`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeader(config.api_key) },
          body: JSON.stringify({ query, budget: "mid", query_timestamp: new Date().toISOString(), types: config.recall_types }),
        });
        if (res.status === 401 || res.status === 403) { authErr = true; return; }
        if (!res.ok) return;
        anyOk = true;
        const data = await res.json();
        for (const r of (data.results || [])) allResults.push(`[${bank}] ${r.text}`);
      }));

      if (authErr) {
        recallAttempts = MAX_RECALL_ATTEMPTS;
        hookStats.recall = { firedAt: new Date().toISOString(), result: "failed", detail: "auth error" };
        ctx.ui.setStatus("hindsight", "✗ auth error");
        return;
      }

      if (anyOk) {
        recallDone = true;
        if (allResults.length) {
          hookStats.recall = { firedAt: new Date().toISOString(), result: "ok", detail: `${allResults.length} memories` };
          const snippet = allResults.slice(0, 3).map((r: string) => r.replace(/^\[[^\]]+\] /, "")).join(" · ").slice(0, 200);
          return {
            message: {
              customType: "hindsight-recall",
              content: `<hindsight_memories>\nRelevant memories from past sessions:\n\n${allResults.join("\n\n")}\n</hindsight_memories>`,
              display: true,
              details: { count: allResults.length, snippet },
            },
          };
        }
        hookStats.recall = { firedAt: new Date().toISOString(), result: "ok", detail: "empty" };
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
    if (!prompt) return;
    if (prompt.length < 5 || /^(ok|yes|no|thanks|continue|next|done|sure|stop)$/i.test(prompt.trim())) return;
    if (prompt.trim().startsWith("#nomem") || prompt.trim().startsWith("#skip")) return;

    const bank = getActiveBank(config);
    if (!bank) return;

    const tags = extractTags(prompt);
    const banks = getRetainBanks(config, prompt);

    // Build transcript
    let transcript = `[role: user]\n${prompt}\n[user:end]\n\n[role: assistant]\n`;
    for (const msg of event.messages || []) {
      if (msg.role !== "assistant") continue;
      const content = msg.content;
      if (typeof content === "string") {
        transcript += `${content}\n`;
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "text") transcript += `${block.text}\n`;
          else if (block.type === "tool_use" && !OPERATIONAL_TOOLS.has(block.name))
            transcript += `[Tool: ${block.name}]\n${block.input ? JSON.stringify(block.input) : ""}\n`;
        }
      }
    }
    transcript += `[assistant:end]`;
    transcript = transcript.replace(/<hindsight_memories>[\s\S]*?<\/hindsight_memories>/g, "").trim();
    if (transcript.length < 20) return;
    if (transcript.length > 50000) transcript = transcript.slice(0, 50000) + "\n...[TRUNCATED]";

    const sessionId = ctx.sessionManager?.getSessionId?.() || `unknown-${Date.now()}`;
    log(`retain: banks=${banks.join(",")} len=${transcript.length} tags=${tags.join(",")}`);

    try {
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
                context: `pi: ${prompt.slice(0, 100)}`,
                timestamp: new Date().toISOString(),
                ...(tags.length && { tags }),
              }],
              async: true,
            }),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return b;
        }),
      );

      const ok = results.filter(r => r.status === "fulfilled").map(r => (r as PromiseFulfilledResult<string>).value);
      hookStats.retain = { firedAt: new Date().toISOString(), result: ok.length ? "ok" : "failed", detail: ok.join(", ") };

      if (ok.length) {
        pi.sendMessage({ customType: "hindsight-retain", content: "", display: true, details: { banks: ok } }, { deliverAs: "nextTurn" });
      } else {
        ctx.ui.setStatus("hindsight", "⚠ retain failed");
        pi.sendMessage({ customType: "hindsight-retain-failed", content: "", display: true }, { deliverAs: "nextTurn" });
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
          const health = await fetch(`${config.api_url}/health`);
          lines.push(`Server: ${health.ok ? "✓ online" : `✗ HTTP ${health.status}`}`);
        } catch { lines.push("Server: ✗ unreachable"); }

        lines.push(`URL:    ${config.api_url}`);
        if (!config.api_key) lines.push("  ⚠ no api_key");

        if (bank) {
          try {
            const res = await fetch(`${config.api_url}/v1/default/banks/${bank}/profile`, { headers: authHeader(config.api_key) });
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
            const res = await fetch(`${config.api_url}/v1/default/banks/${bank}/stats`);
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
