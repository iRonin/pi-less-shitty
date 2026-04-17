#!/usr/bin/env node --experimental-strip-types
/**
 * Hindsight Bootstrap — migrate existing conversations into memory banks.
 *
 * Scans Pi session history, extracts user/assistant turns, and retains them
 * to the appropriate Hindsight banks — only if an explicit .hindsight/config
 * with bank_id exists somewhere in the parent chain of the session's CWD.
 *
 * Sessions without config are silently skipped — no implicit banks.
 * Newer sessions are processed first (they carry more weight).
 *
 * Usage:
 *   node --experimental-strip-types bootstrap.ts              # dry run
 *   node --experimental-strip-types bootstrap.ts --commit     # actually retain
 *   node --experimental-strip-types bootstrap.ts --limit 20   # process N sessions
 *   node --experimental-strip-types bootstrap.ts --verbose    # show skipped details
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { homedir } from "node:os";

// ─── Args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const dryRun = !args.includes("--commit");
const limit = parseInt(args.find(a => a.startsWith("--limit="))?.split("=")[1] || "0");
const verbose = args.includes("--verbose") || args.includes("-v");

// ─── Config Resolution (Parent Traversal) ─────────────────────────────────

interface ResolvedResult {
  bank_id: string;
  global_bank: string | null;
  api_url: string;
  api_key: string;
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

/**
 * Walk up from CWD looking for .hindsight/config with an explicit bank_id.
 * Returns null if no config with bank_id is found — no implicit banks.
 * Merges all configs along the way (child wins).
 */
function resolveActiveBank(cwd: string): ResolvedResult | null {
  const homeCfg = join(homedir(), ".hindsight", "config.toml");
  const allCfgs: Record<string, string>[] = [parseToml(homeCfg)];

  let dir = cwd;
  while (true) {
    const cfg = join(dir, ".hindsight", "config.toml");
    if (existsSync(cfg)) allCfgs.push(parseToml(cfg));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Merge (last wins)
  const merged: Record<string, string> = {};
  for (const c of allCfgs) Object.assign(merged, c);

  // bank_id MUST be explicit
  if (!merged.bank_id) return null;

  return {
    bank_id: merged.bank_id,
    global_bank: merged.global_bank || null,
    api_url: merged.api_url || "http://localhost:8888",
    api_key: merged.api_key || "",
  };
}

// ─── Session Parsing ───────────────────────────────────────────────────────

interface Turn {
  user: string;
  assistant: string;
}

interface Session {
  id: string;
  cwd: string;
  timestamp: string;
  turns: Turn[];
  model?: string;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("\n");
  }
  return "";
}

function parsePiSession(filePath: string): Session | null {
  try {
    const lines = readFileSync(filePath, "utf-8").trim().split("\n");
    if (lines.length < 3) return null;

    const header = JSON.parse(lines[0]);
    const cwd = header.cwd || "";
    const sessionId = header.id || basename(filePath, ".jsonl");
    const timestamp = header.timestamp || "";

    // Find model
    let model: string | undefined;
    for (const line of lines) {
      const entry = JSON.parse(line);
      if (entry.type === "model_change") {
        model = entry.modelId || `${entry.provider}/${entry.model}` || undefined;
        break;
      }
    }

    // Collect user/assistant messages
    const messages: { role: string; content: string }[] = [];
    for (const line of lines) {
      const entry = JSON.parse(line);
      if (entry.type === "message" && entry.message) {
        const { role, content } = entry.message;
        if (role === "user" || role === "assistant") {
          const text = extractText(content);
          if (text.trim()) messages.push({ role, content: text });
        }
      }
    }

    // Pair user→assistant
    const turns: Turn[] = [];
    let current: Turn | null = null;
    for (const msg of messages) {
      if (msg.role === "user") {
        if (current) turns.push(current);
        current = { user: msg.content, assistant: "" };
      } else if (msg.role === "assistant" && current) {
        if (current.assistant) current.assistant += "\n\n";
        current.assistant += msg.content;
      }
    }
    if (current && (current.user || current.assistant)) turns.push(current);

    if (turns.length === 0) return null;
    return { id: sessionId, cwd, timestamp, turns, model };
  } catch {
    return null;
  }
}

// ─── Discovery ─────────────────────────────────────────────────────────────

function discoverPiSessions(): string[] {
  const root = join(homedir(), ".pi", "agent", "sessions");
  if (!existsSync(root)) return [];
  const files: string[] = [];
  function walk(dir: string) {
    try {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (entry.endsWith(".jsonl")) files.push(full);
      }
    } catch {}
  }
  walk(root);
  return files;
}

// ─── Transcript Builder ────────────────────────────────────────────────────

function buildTranscript(session: Session): string {
  const lines: string[] = [];
  lines.push(`# Session: ${session.id}`);
  if (session.model) lines.push(`# Model: ${session.model}`);
  lines.push(`# CWD: ${session.cwd}`);
  lines.push(`# Date: ${session.timestamp}`);
  lines.push(`# Turns: ${session.turns.length}`);
  lines.push("");

  for (let i = 0; i < session.turns.length; i++) {
    const turn = session.turns[i];
    if (!turn.user.trim()) continue;
    lines.push(`## Turn ${i + 1}`);
    lines.push(`### User`);
    lines.push(turn.user);
    if (turn.assistant?.trim()) {
      lines.push("");
      lines.push(`### Assistant`);
      const text = turn.assistant.length > 8000
        ? turn.assistant.slice(0, 8000) + "\n\n[...truncated]"
        : turn.assistant;
      lines.push(text);
    }
    lines.push("");
  }
  return lines.join("\n");
}

// ─── Recency Formatting ────────────────────────────────────────────────────

function ageStr(timestamp: string): string {
  if (!timestamp) return "?";
  const ms = Date.now() - new Date(timestamp).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

// ─── Retain ────────────────────────────────────────────────────────────────

async function retainToHindsight(
  result: ResolvedResult,
  content: string,
  sessionId: string,
): Promise<boolean> {
  const url = `${result.api_url}/v1/default/banks/${result.bank_id}/memories`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${result.api_key}`,
      },
      body: JSON.stringify({
        items: [{
          content,
          document_id: `bootstrap-pi-${sessionId}`,
          context: "bootstrap import: pi session",
          timestamp: new Date().toISOString(),
        }],
        async: true,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.warn(`    ⚠ HTTP ${res.status}: ${body.slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (e) {
    console.warn(`    ✗ Error: ${e}`);
    return false;
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log(`═══ Hindsight Bootstrap ═══`);
  console.log(`Mode: ${dryRun ? "DRY RUN" : "COMMIT"}`);
  if (limit) console.log(`Limit: ${limit} sessions`);
  console.log("");

  // Discover
  const piFiles = discoverPiSessions();
  console.log(`Discovered: ${piFiles.length} Pi sessions`);
  console.log("");

  // Parse
  const sessions: Session[] = [];
  for (const f of piFiles) {
    const s = parsePiSession(f);
    if (s) sessions.push(s);
  }

  // Filter: meaningful turns only
  const TRIVIAL = /^(ok|yes|no|thanks|continue|next|done|sure|stop|\/compact|\/tree|\/model)$/i;
  const meaningful = sessions.filter(s =>
    s.turns.some(t => t.user.length > 10 && !TRIVIAL.test(t.user.trim()))
  );

  // Sort by recency (newest first)
  meaningful.sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || ""));

  // Limit
  const toProcess = limit > 0 ? meaningful.slice(0, limit) : meaningful;

  // Resolve banks — skip sessions without config
  const noConfig: { id: string; cwd: string; age: string }[] = [];
  const resolvable: { session: Session; bank: ResolvedResult }[] = [];
  for (const s of toProcess) {
    const bank = resolveActiveBank(s.cwd || process.cwd());
    if (!bank) {
      noConfig.push({ id: s.id, cwd: s.cwd, age: ageStr(s.timestamp) });
    } else {
      resolvable.push({ session: s, bank });
    }
  }

  // Group by bank
  const bankGroups = new Map<string, Session[]>();
  for (const r of resolvable) {
    if (!bankGroups.has(r.bank.bank_id)) bankGroups.set(r.bank.bank_id, []);
    bankGroups.get(r.bank.bank_id)!.push(r.session);
  }

  // Summary
  const oldest = toProcess.length > 0 ? ageStr(toProcess[toProcess.length - 1].timestamp) : "—";
  const newest = toProcess.length > 0 ? ageStr(toProcess[0].timestamp) : "—";
  console.log(`Parsed:         ${sessions.length}`);
  console.log(`Meaningful:     ${meaningful.length}`);
  console.log(`To process:     ${toProcess.length} (${newest} → ${oldest})`);
  console.log(`Resolvable:     ${resolvable.length}`);
  console.log(`No config:      ${noConfig.length}`);
  console.log("");

  if (noConfig.length > 0 && verbose) {
    console.log(`Sessions without .hindsight/config (skipped):`);
    for (const n of noConfig.slice(0, 20)) {
      console.log(`  [${n.age}] ${n.id}  cwd=${n.cwd}`);
    }
    if (noConfig.length > 20) console.log(`  ...and ${noConfig.length - 20} more`);
    console.log("");
  }

  // Bank distribution
  if (bankGroups.size > 0) {
    console.log(`Bank distribution:`);
    for (const [bank, sess] of bankGroups) {
      const turns = sess.reduce((sum, s) => sum + s.turns.length, 0);
      const oldestS = ageStr(sess[sess.length - 1].timestamp);
      const newestS = ageStr(sess[0].timestamp);
      console.log(`  ${bank}: ${sess.length} sessions, ${turns} turns (${newestS} → ${oldestS})`);
    }
    console.log("");
  }

  if (dryRun) {
    console.log(`─── Dry Run Samples ───`);
    for (const [bank, sess] of bankGroups) {
      console.log(`\n  Bank: ${bank}`);
      for (const s of sess.slice(0, 2)) {
        const transcript = buildTranscript(s);
        const preview = transcript.slice(0, 250);
        console.log(`  [${ageStr(s.timestamp)}] ${s.model || "?"} · ${s.turns.length} turns`);
        console.log(`  CWD: ${s.cwd}`);
        console.log(`  Preview:`);
        for (const line of preview.split("\n")) console.log(`    ${line}`);
        console.log(`  [...${transcript.length - 250} chars]`);
        console.log("");
      }
    }
    console.log(`═══ Dry Run Complete ═══`);
    console.log(`Run with --commit to actually retain`);
    return;
  }

  // ─── Commit ────────────────────────────────────────────────────────
  let retained = 0, failed = 0;

  for (const [bank, sess] of bankGroups) {
    const result = resolveActiveBank(sess[0].cwd)!;
    console.log(`\n  Retaining to ${bank} (${sess.length} sessions):`);

    for (const s of sess) {
      const transcript = buildTranscript(s);
      const ok = await retainToHindsight(result, transcript, s.id);
      if (ok) {
        retained++;
        console.log(`    ✓ [${ageStr(s.timestamp)}] ${s.id} (${s.turns.length} turns, ${(transcript.length / 1024).toFixed(1)}KB)`);
      } else {
        failed++;
        console.log(`    ✗ ${s.id}`);
      }
    }
  }

  console.log(`\n═══ Bootstrap Complete ═══`);
  console.log(`Retained: ${retained}`);
  console.log(`Failed:   ${failed}`);
}

main().catch(console.error);
