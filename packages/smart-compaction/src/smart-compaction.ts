/**
 * Smart Compaction Extension for Pi Agent
 *
 * Transparently intercepts pi's built-in /compact and auto-compaction
 * (session_before_compact fires for both) to replace blanket LLM
 * summarization with heuristic turn scoring.
 *
 * Scoring (0–10) with user's Hermes settings:
 *   keep_threshold: 6  → score ≥6 = HIGH (kept verbatim in summary + LLM-summarized)
 *   drop_threshold: 5  → score <5 = LOW (included in structured summary, summarizeLow=true)
 *   score 5           → MEDIUM (structured summary)
 *
 * summarize_high: true  → HIGH turns get LLM summary for iterative safety
 * summarize_low: true   → LOW turns folded into structured summary
 *
 * Retry loops (same tool+file within 3 turns) are collapsed.
 *
 * Key pi compaction details respected:
 *   - messagesToSummarize are DISCARDED after compaction; summary is ALL the
 *     agent has from that context on reload
 *   - previousSummary is merged/updated (iterative compaction)
 *   - isSplitTurn: when a single huge turn is split, turnPrefixMessages are
 *     the prefix that gets summarized separately
 *   - fileOps accumulate across compactions from previous CompactionEntry.details
 *   - Summary format mirrors pi's structured format (Goal, Progress, etc.)
 *
 * CLI usage:
 *   pi --smart-compress [SESSION-ID|NAME]   — dry-run analysis on a session
 *
 * In-session commands:
 *   /smart-compress              — quick status
 *   /smart-compress stat         — aggregate statistics
 *   /smart-compress tune [N]     — score histogram + threshold tuning for Nth compaction
 *   /smart-compress review [N] [CLASS] — tabular review of scored messages
 *   /smart-compress dry          — dry-run on current session (no compaction)
 *   /smart-compress hist [N]     — last N compaction events
 *
 * Installation: symlink or copy to ~/.pi/agent/extensions/smart-compaction/
 * Environment: PI_SMART_COMPACT_KEEP=6  PI_SMART_COMPACT_DROP=5
 */

import type {
  ExtensionAPI,
  SessionBeforeCompactEvent,
} from "@mariozechner/pi-coding-agent";
import { convertToLlm, serializeConversation, SessionManager } from "@mariozechner/pi-coding-agent";
import { complete } from "@mariozechner/pi-ai";
import { mkdir, writeFile, readdir, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { scoreAllMessages, scoreAllMessagesSync, classify } from "./scorer.js";
import { detectRetryLoops, type RetryLoop } from "./pattern-detector.js";

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

interface SmartCompactionSettings {
  keepThreshold: number;
  dropThreshold: number;
  retryWindow: number;
  summarizeHigh: boolean;
  summarizeLow: boolean;
  skipUnderMessages: number;
  scoringProvider: string;  // e.g. "openrouter", "google", "anthropic"
  scoringModel: string;      // e.g. "google/gemini-2.5-flash-lite"
}

const DEFAULT_SETTINGS: SmartCompactionSettings = {
  keepThreshold: 6,
  dropThreshold: 5,
  retryWindow: 3,
  summarizeHigh: true,
  summarizeLow: true,
  skipUnderMessages: 6,
  scoringProvider: "openrouter",
  scoringModel: "google/gemini-2.5-flash-lite",
};

function readSettingsJson(): Partial<SmartCompactionSettings> {
  try {
    const settingsPath = join(homedir(), ".pi", "agent", "settings.json");
    const raw = JSON.parse(readFileSync(settingsPath, "utf-8"));
    const sc = raw.smartCompaction as Record<string, unknown> | undefined;
    if (!sc) return {};
    const out: Partial<SmartCompactionSettings> = {};
    if (typeof sc.keepThreshold === "number") out.keepThreshold = sc.keepThreshold as number;
    if (typeof sc.dropThreshold === "number") out.dropThreshold = sc.dropThreshold as number;
    if (typeof sc.retryWindow === "number") out.retryWindow = sc.retryWindow as number;
    if (typeof sc.summarizeHigh === "boolean") out.summarizeHigh = sc.summarizeHigh as boolean;
    if (typeof sc.summarizeLow === "boolean") out.summarizeLow = sc.summarizeLow as boolean;
    if (typeof sc.skipUnderMessages === "number") out.skipUnderMessages = sc.skipUnderMessages as number;
    if (typeof sc.scoringProvider === "string") out.scoringProvider = sc.scoringProvider as string;
    if (typeof sc.scoringModel === "string") out.scoringModel = sc.scoringModel as string;
    return out;
  } catch {
    return {};
  }
}

function loadSettings(): SmartCompactionSettings {
  // Layer 1: hardcoded defaults
  const s = { ...DEFAULT_SETTINGS };
  // Layer 2: ~/.pi/agent/settings.json → smartCompaction
  const file = readSettingsJson();
  Object.assign(s, file);
  // Layer 3: env vars override everything
  const envKeep = process.env.PI_SMART_COMPACT_KEEP;
  const envDrop = process.env.PI_SMART_COMPACT_DROP;
  if (envKeep) s.keepThreshold = clamp(parseInt(envKeep, 10), 4, 10);
  if (envDrop) s.dropThreshold = clamp(parseInt(envDrop, 10), 0, s.keepThreshold - 1);
  if (s.dropThreshold >= s.keepThreshold) s.dropThreshold = s.keepThreshold - 1;
  const envProvider = process.env.PI_SMART_COMPACT_SCORING_PROVIDER;
  const envModel = process.env.PI_SMART_COMPACT_SCORING_MODEL;
  if (envProvider) s.scoringProvider = envProvider;
  if (envModel) s.scoringModel = envModel;
  return s;
}

function clamp(v: number, lo: number, hi: number): number {
  return isNaN(v) ? lo : Math.max(lo, Math.min(hi, v));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c: any) => c?.type === "text" && typeof c.text === "string")
    .map((c: any) => c.text)
    .join("\n");
}

function extractToolCalls(content: unknown): Array<{ name: string; arguments: unknown }> {
  if (!Array.isArray(content)) return [];
  return content
    .filter((c: any) => c?.type === "toolCall")
    .map((c: any) => ({ name: c.name ?? "", arguments: c.arguments ?? {} }));
}

function estimateMsgTokens(msg: { role: string; content: unknown }): number {
  const text = extractText(msg.content);
  let tokens = Math.ceil(text.length / 4) + 10;
  for (const tc of extractToolCalls(msg.content)) {
    tokens += (typeof tc.arguments === "string" ? tc.arguments.length : JSON.stringify(tc.arguments).length) / 4;
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Structured summary builder — mirrors pi's format
// ---------------------------------------------------------------------------

function buildStructuredSummary(
  scoredFlat: Array<{ role: string; content: unknown; score: number; classification: string }>,
  loops: RetryLoop[],
  highSummary: string | null,
  previousSummary: string | undefined,
  readFiles: string[],
  modifiedFiles: string[],
  settings: SmartCompactionSettings,
): string {
  const parts: string[] = [];

  if (previousSummary) {
    parts.push("## Previous Context Checkpoint\n");
    parts.push(previousSummary);
    parts.push("\n---\n\n## Updates from Recent Turns\n");
  }

  // Goal (extract from user HIGH turns)
  const userDirectives: string[] = [];
  for (const m of scoredFlat) {
    if (m.role === "user" && m.classification === "HIGH") {
      const text = extractText(m.content).trim();
      if (text.length > 5) userDirectives.push(text.substring(0, 500));
    }
  }
  if (userDirectives.length > 0) {
    parts.push("## Goal\n" + userDirectives.map((d) => `- ${d}`).join("\n") + "\n");
  }

  // Key Decisions
  const decisions: string[] = [];
  for (const m of scoredFlat) {
    if (m.role === "assistant" && m.classification === "HIGH") {
      const text = extractText(m.content).trim();
      if (text.length > 10) decisions.push(text.substring(0, 500));
    }
  }
  if (decisions.length > 0) {
    parts.push("## Key Decisions\n" + decisions.map((d) => `- ${d}`).join("\n") + "\n");
  }

  // Retry loops
  if (loops.length > 0) {
    parts.push("## Collapsed Retry Loops\n");
    for (const loop of loops) {
      parts.push(`- ${loop.description}`);
      if (loop.lastResult) {
        parts.push(`  Final: ${loop.lastResult.substring(0, 150)}`);
      }
    }
    parts.push("");
  }

  // LLM summary of HIGH turns
  if (highSummary) {
    parts.push("## Context Summary (High-Value Turns)\n");
    parts.push(highSummary);
    parts.push("\n*The full HIGH turn messages are also preserved verbatim. " +
      "This summary survives if this section is compacted again later.*\n");
  }

  // Deterministic summary of MEDIUM (+ LOW)
  const relevant = scoredFlat.filter(
    (m) => m.classification === "MEDIUM" || (settings.summarizeLow && m.classification === "LOW"),
  );
  if (relevant.length > 0) {
    const toolLines: string[] = [];
    const toolCallsByType: Record<string, { label: string; count: number }> = {};
    const allPaths: string[] = [];
    const excerpts: string[] = [];
    const FILE_PATH_RE = /[/\\][\w.\-/]+(?:\.\w+)?/g;

    for (const msg of relevant) {
      for (const tc of extractToolCalls(msg.content)) {
        if (!toolCallsByType[tc.name]) toolCallsByType[tc.name] = { label: tc.name, count: 0 };
        toolCallsByType[tc.name].count++;
        const args = typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(tc.arguments);
        const pathMatch = args.match(/"path"\s*:\s*"([^"]+)"/);
        const cmdMatch = args.match(/"command"\s*:\s*"([^"]+)"/);
        if (pathMatch) {
          toolCallsByType[tc.name].label = `${tc.name}(${pathMatch[1]})`;
          allPaths.push(pathMatch[1]);
        } else if (cmdMatch) {
          toolCallsByType[tc.name].label = `${tc.name}("${cmdMatch[1].substring(0, 80)}")`;
        }
      }
      const text = extractText(msg.content);
      const paths = text.match(FILE_PATH_RE) ?? [];
      allPaths.push(...paths.filter((p: string) => p.length > 5 && !p.startsWith("/dev/")));
      const trimmed = text.trim();
      if (trimmed.length > 10 && !/^(ok|got it|sure|will do|on it|let me|oops)/i.test(trimmed)) {
        excerpts.push(trimmed.substring(0, 300));
      }
    }

    for (const [, info] of Object.entries(toolCallsByType)) {
      toolLines.push(`- ${info.label} (${info.count}×)`);
    }
    if (toolLines.length > 0) {
      parts.push("## Tool Activity\n" + toolLines.join("\n") + "\n");
    }

    const uniquePaths = [...new Set(allPaths)].slice(0, 20);
    if (uniquePaths.length > 0) {
      parts.push("## Files Referenced\n" + uniquePaths.map((p) => `- ${p}`).join("\n") + "\n");
    }

    if (excerpts.length > 0) {
      parts.push("## Key Content\n" + excerpts.slice(0, 8).map((t) => `> ${t}`).join("\n\n") + "\n");
    }

    parts.push(`*${relevant.length} turns condensed above*\n`);
  }

  // LOW omitted marker
  const lowCount = scoredFlat.filter((m) => m.classification === "LOW").length;
  if (lowCount > 0 && !settings.summarizeLow) {
    parts.push(`> ${lowCount} low-value turns omitted (acknowledgments, retries with no substantive content)\n`);
  }

  // File operations
  if (readFiles.length > 0) {
    parts.push("<read-files>\n" + readFiles.join("\n") + "\n</read-files>\n");
  }
  if (modifiedFiles.length > 0) {
    parts.push("<modified-files>\n" + modifiedFiles.join("\n") + "\n</modified-files>\n");
  }

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// LLM summary for HIGH turns
// ---------------------------------------------------------------------------

async function generateHighSummary(
  highAgentMessages: any[],
  signal: AbortSignal,
  modelRegistry: any,
  previousSummary?: string,
  customInstructions?: string,
): Promise<string | null> {
  if (highAgentMessages.length === 0) return null;

  const llmMessages = convertToLlm(highAgentMessages);
  const conversationText = serializeConversation(llmMessages);

  const model = modelRegistry.find("google", "gemini-2.5-flash")
    ?? modelRegistry.find("openai", "gpt-4o-mini")
    ?? modelRegistry.find("anthropic", "claude-sonnet-4-20250514");

  if (!model) return null;
  const auth = await modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) return null;

  const prevCtx = previousSummary
    ? `\n\n<previous-summary>\n${previousSummary}\n</previous-summary>\n\nIntegrate with and update the previous summary. Preserve existing goals/decisions/progress.`
    : "";
  const focusCtx = customInstructions ? `\n\nAdditional focus: ${customInstructions}` : "";

  try {
    const response = await complete(
      model,
      { messages: [{
        role: "user" as const,
        content: [{
          type: "text" as const,
          text: `You are a context summarization assistant. Create a structured checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish?]

## Progress
### Done
- [x] [Completed items]

### In Progress
- [ ] [Current work]

### Blocked
- [Blockers, if any]

## Key Decisions
- **[Decision]**: [Rationale]

## Next Steps
1. [What should happen next]

## Critical Context
- [Data needed to continue]

Be concise. Preserve exact file paths, function names, and error messages.

<conversation>
${conversationText}
</conversation>${prevCtx}${focusCtx}`,
        }],
        timestamp: Date.now(),
      }] },
      { apiKey: auth.apiKey, headers: auth.headers, maxTokens: 4096, signal },
    );
    const text = response.content
      .filter((c: any): c is { type: "text"; text: string } => c.type === "text")
      .map((c: any) => c.text)
      .join("\n")
      .trim();
    return text || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main compaction handler
// ---------------------------------------------------------------------------

interface CompactionStats {
  totalTurns: number;
  highKept: number;
  mediumSummarized: number;
  lowDropped: number;
  retryLoopsCollapsed: number;
  tokensSavedEstimate: number;
  actualKeepThreshold: number;
  actualDropThreshold: number;
  llmUsed: boolean;         // LLM used for HIGH summary
  scoringMethod: string;    // "llm" or "heuristic"
}

async function handleSmartCompaction(
  event: SessionBeforeCompactEvent,
  ctx: any,
  settings: SmartCompactionSettings,
): Promise<{ compaction: { summary: string; firstKeptEntryId: string; tokensBefore: number; details: CompactionStats } } | void> {
  const { preparation, signal, customInstructions } = event;
  const {
    messagesToSummarize,
    turnPrefixMessages,
    tokensBefore,
    firstKeptEntryId,
    previousSummary,
    fileOps,
    isSplitTurn,
  } = preparation;

  const allMsgs = [...messagesToSummarize, ...turnPrefixMessages];
  if (allMsgs.length === 0) return;

  const flatMsgs = allMsgs.map((m: any) => ({
    role: m.role ?? "unknown",
    content: m.content ?? "",
  }));

  if (flatMsgs.length < settings.skipUnderMessages) return;

  ctx.ui.setWorkingMessage("Smart compaction: scoring turns…");
  const scored = await scoreAllMessages(
    flatMsgs,
    settings.keepThreshold,
    settings.dropThreshold,
    settings.retryWindow,
    {
      modelRegistry: ctx.modelRegistry,
      signal,
      providerId: settings.scoringProvider,
      modelId: settings.scoringModel,
    },
  );
  const scoringMethod = scored[0]?.method ?? "heuristic";

  const highCount = scored.filter((s) => s.classification === "HIGH").length;
  const mediumCount = scored.filter((s) => s.classification === "MEDIUM").length;
  const lowCount = scored.filter((s) => s.classification === "LOW").length;

  if (mediumCount === 0 && lowCount === 0 && !settings.summarizeHigh) return;

  const loops = detectRetryLoops(flatMsgs, settings.retryWindow);

  let highSummary: string | null = null;
  if (settings.summarizeHigh && highCount > 0) {
    ctx.ui.setWorkingMessage("Smart compaction: summarizing high-value turns…");
    const highAgentMsgs = allMsgs.filter((_: any, i: number) => scored[i].classification === "HIGH");
    highSummary = await generateHighSummary(highAgentMsgs, signal, ctx.modelRegistry, previousSummary, customInstructions);
  }

  const readFiles = [...(fileOps?.read ?? [])];
  const modifiedFiles = [...(fileOps?.written ?? []), ...(fileOps?.edited ?? [])];

  const scoredFlat = flatMsgs.map((m, i) => ({
    ...m,
    score: scored[i].score,
    classification: scored[i].classification,
  }));

  let summary = buildStructuredSummary(
    scoredFlat, loops, highSummary, previousSummary, readFiles, modifiedFiles, settings,
  );

  if (isSplitTurn && turnPrefixMessages.length > 0) {
    summary += "\n\n> **Split turn note:** Earlier parts of this turn were summarized above. " +
      "The recent work (suffix) is kept verbatim.\n";
  }

  const highTokens = scored.filter((s) => s.classification === "HIGH")
    .reduce((sum, s, idx) => sum + estimateMsgTokens(flatMsgs[idx]), 0);
  const summaryTokens = Math.ceil(summary.length / 4);
  const outputTokens = highTokens + summaryTokens;
  const tokensSaved = Math.max(0, tokensBefore - outputTokens);

  ctx.ui.setWorkingMessage(undefined);

  const stats: CompactionStats = {
    totalTurns: flatMsgs.length,
    highKept: highCount,
    mediumSummarized: mediumCount,
    lowDropped: settings.summarizeLow ? 0 : lowCount,
    retryLoopsCollapsed: loops.length,
    tokensSavedEstimate: tokensSaved,
    actualKeepThreshold: settings.keepThreshold,
    actualDropThreshold: settings.dropThreshold,
    llmUsed: !!highSummary || scoringMethod === "llm",
    scoringMethod,
  };

  const scoringTag = scoringMethod === "llm"
    ? ` [${settings.scoringProvider}:${settings.scoringModel}]`
    : " [heuristic]";
  ctx.ui.notify(
    `Smart compaction: ${flatMsgs.length} turns → ${highCount} HIGH + ${mediumCount} MEDIUM + ${lowCount} LOW | ~${(tokensSaved / 1000).toFixed(1)}K saved${scoringTag}`,
    "info",
  );

  // Store snapshot for analysis
  const snapshot = buildCompactionSnapshot({
    timestamp: new Date().toISOString(),
    sessionFile: ctx.sessionManager.getSessionFile() ?? "",
    settings,
    preCompaction: {
      messageCount: flatMsgs.length,
      tokensBefore,
      isSplitTurn: !!isSplitTurn,
      turnPrefixCount: turnPrefixMessages.length,
    },
    messages: flatMsgs.map((m, i) => ({
      role: m.role,
      content: truncateContent(m.content, 3000),
      contentLength: extractText(m.content).length,
      score: scored[i].score,
      classification: scored[i].classification,
      tokenEstimate: estimateMsgTokens(m),
      toolCalls: extractToolCalls(m.content).map((tc) => tc.name),
    })),
    postCompaction: { summary, summaryTokens, outputTokens, tokensSaved },
    stats,
    retryLoops: loops.map((l) => ({ description: l.description, lastResult: l.lastResult })),
    scoringMethod,
  });
  await storeCompactionSnapshot(snapshot);

  return {
    compaction: { summary, firstKeptEntryId, tokensBefore, details: stats },
  };
}

// ---------------------------------------------------------------------------
// Data collection
// ---------------------------------------------------------------------------

interface CompactionSnapshot {
  version: 1;
  timestamp: string;
  sessionFile: string;
  settings: { keepThreshold: number; dropThreshold: number; summarizeHigh: boolean; summarizeLow: boolean; scoringProvider: string; scoringModel: string };
  preCompaction: { messageCount: number; tokensBefore: number; isSplitTurn: boolean; turnPrefixCount: number };
  messages: Array<{
    role: string; content: string; contentLength: number; score: number;
    classification: string; tokenEstimate: number; toolCalls: string[];
  }>;
  postCompaction: { summary: string; summaryTokens: number; outputTokens: number; tokensSaved: number };
  stats: CompactionStats;
  retryLoops: Array<{ description: string; lastResult: string }>;
  scoringMethod: string;  // "llm" or "heuristic" — how turns were scored
}

function truncateContent(content: unknown, maxLen: number): string {
  const text = extractText(content);
  return text.length > maxLen ? text.substring(0, maxLen) + "…" : text;
}

function buildCompactionSnapshot(data: {
  timestamp: string; sessionFile: string; settings: SmartCompactionSettings;
  preCompaction: CompactionSnapshot["preCompaction"];
  messages: CompactionSnapshot["messages"];
  postCompaction: CompactionSnapshot["postCompaction"];
  stats: CompactionStats; retryLoops: CompactionSnapshot["retryLoops"];
  scoringMethod: string;
}): CompactionSnapshot {
  return {
    version: 1, timestamp: data.timestamp, sessionFile: data.sessionFile,
    settings: {
      keepThreshold: data.settings.keepThreshold, dropThreshold: data.settings.dropThreshold,
      summarizeHigh: data.settings.summarizeHigh, summarizeLow: data.settings.summarizeLow,
      scoringProvider: data.settings.scoringProvider, scoringModel: data.settings.scoringModel,
    },
    preCompaction: data.preCompaction, messages: data.messages,
    postCompaction: data.postCompaction, stats: data.stats, retryLoops: data.retryLoops,
    scoringMethod: data.scoringMethod,
  };
}

async function storeCompactionSnapshot(snapshot: CompactionSnapshot): Promise<void> {
  try {
    const dir = join(homedir(), ".pi", "agent", "smart-compaction-data");
    await mkdir(dir, { recursive: true });
    const ts = snapshot.timestamp.replace(/[:.]/g, "-").replace("T", "_");
    const sessionName = basename(snapshot.sessionFile).replace(/\.jsonl$/, "").substring(0, 32);
    await writeFile(join(dir, `${ts}_${sessionName}.json`), JSON.stringify(snapshot, null, 2));
  } catch { /* silent — must not break compaction */ }
}

async function loadAllSnapshots(): Promise<CompactionSnapshot[]> {
  const dir = join(homedir(), ".pi", "agent", "smart-compaction-data");
  try {
    const files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort().reverse();
    const snapshots: CompactionSnapshot[] = [];
    for (const f of files) {
      try {
        const data = JSON.parse(await readFile(join(dir, f), "utf-8"));
        if (data.version === 1) snapshots.push(data);
      } catch { /* skip corrupted */ }
    }
    return snapshots;
  } catch { return []; }
}

// ---------------------------------------------------------------------------
// Analysis helpers
// ---------------------------------------------------------------------------

function buildScoreHistogram(messages: CompactionSnapshot["messages"], keep: number, drop: number): Map<number, { count: number; cls: string }> {
  const hist = new Map<number, { count: number; cls: string }>();
  for (let i = 0; i <= 10; i++) hist.set(i, { count: 0, cls: i >= keep ? "HIGH" : i >= drop ? "MEDIUM" : "LOW" });
  for (const m of messages) {
    const entry = hist.get(m.score);
    if (entry) entry.count++;
  }
  return hist;
}

function formatBar(count: number, maxCount: number, width: number): string {
  if (maxCount === 0) return "";
  const filled = Math.round((count / maxCount) * width);
  return "█".repeat(filled) + "░".repeat(Math.max(0, width - filled));
}

// ---------------------------------------------------------------------------
// Smart compaction analysis (works on any message set — for dry-run and CLI)
// ---------------------------------------------------------------------------

interface AnalysisResult {
  messages: Array<{ role: string; content: string; contentLength: number; score: number; classification: string; tokenEstimate: number; toolCalls: string[] }>;
  stats: CompactionStats;
  retryLoops: RetryLoop[];
  summary: string;
  summaryTokens: number;
  outputTokens: number;
  tokensBefore: number;
  tokensSaved: number;
}

function analyzeMessages(
  flatMsgs: Array<{ role: string; content: unknown }>,
  settings: SmartCompactionSettings,
  previousSummary?: string,
): AnalysisResult {
  const scored = scoreAllMessagesSync(flatMsgs, settings.keepThreshold, settings.dropThreshold, settings.retryWindow);

  const highCount = scored.filter((s) => s.classification === "HIGH").length;
  const mediumCount = scored.filter((s) => s.classification === "MEDIUM").length;
  const lowCount = scored.filter((s) => s.classification === "LOW").length;

  const loops = detectRetryLoops(flatMsgs, settings.retryWindow);

  const scoredFlat = flatMsgs.map((m, i) => ({
    role: m.role, content: m.content,
    score: scored[i].score, classification: scored[i].classification,
  }));

  const summary = buildStructuredSummary(
    scoredFlat, loops, null, previousSummary, [], [], settings,
  );

  const highTokens = scored.filter((s) => s.classification === "HIGH")
    .reduce((sum, s, idx) => sum + estimateMsgTokens(flatMsgs[idx]), 0);
  const summaryTokens = Math.ceil(summary.length / 4);
  const tokensBefore = flatMsgs.reduce((s, m) => s + estimateMsgTokens(m), 0);
  const outputTokens = highTokens + summaryTokens;
  const tokensSaved = Math.max(0, tokensBefore - outputTokens);

  return {
    messages: flatMsgs.map((m, i) => ({
      role: m.role,
      content: truncateContent(m.content, 3000),
      contentLength: extractText(m.content).length,
      score: scored[i].score,
      classification: scored[i].classification,
      tokenEstimate: estimateMsgTokens(m),
      toolCalls: extractToolCalls(m.content).map((tc) => tc.name),
    })),
    stats: {
      totalTurns: flatMsgs.length,
      highKept: highCount,
      mediumSummarized: mediumCount,
      lowDropped: settings.summarizeLow ? 0 : lowCount,
      retryLoopsCollapsed: loops.length,
      tokensSavedEstimate: tokensSaved,
      actualKeepThreshold: settings.keepThreshold,
      actualDropThreshold: settings.dropThreshold,
      llmUsed: false,
    },
    retryLoops: loops,
    summary,
    summaryTokens,
    outputTokens,
    tokensBefore,
    tokensSaved,
  };
}

// ---------------------------------------------------------------------------
// CLI: find session by ID/name and run analysis
// ---------------------------------------------------------------------------

async function findSession(query: string): Promise<{ path: string; name: string } | null> {
  try {
    const sessions = await SessionManager.listAll();
    const q = query.toLowerCase();

    // Exact ID match
    let match = sessions.find((s) => s.id.toLowerCase() === q);
    if (match) return { path: match.file, name: match.name || match.id };

    // Partial ID match
    match = sessions.find((s) => s.id.toLowerCase().includes(q));
    if (match) return { path: match.file, name: match.name || match.id };

    // Name match
    match = sessions.find((s) => (s.name || "").toLowerCase().includes(q));
    if (match) return { path: match.file, name: match.name || match.id };

    // File path match
    match = sessions.find((s) => s.file.toLowerCase().includes(q));
    if (match) return { path: match.file, name: match.name || match.id };

    return null;
  } catch {
    return null;
  }
}

function formatAnalysisOutput(result: AnalysisResult, sessionName: string, settings: SmartCompactionSettings): string {
  const hist = buildScoreHistogram(result.messages, settings.keepThreshold, settings.dropThreshold);
  const maxCount = Math.max(...Array.from(hist.values()).map((v) => v.count));

  const lines = [
    `╔══════════════════════════════════════════════════════════╗`,
    `║          Smart Compaction Analysis                     ║`,
    `╚════════════════════════════════════════════════════════╝`,
    ``,
    `Session: ${sessionName}`,
    `Settings: keep≥${settings.keepThreshold} drop<${settings.dropThreshold} | scorer=${settings.scoringProvider}:${settings.scoringModel} | summarizeHigh=${settings.summarizeHigh} summarizeLow=${settings.summarizeLow}`,
    ``,
    `── Overview ──`,
    `Messages analyzed: ${result.stats.totalTurns}`,
    `Tokens before:     ~${(result.tokensBefore / 1000).toFixed(1)}K`,
    `Tokens after:      ~${(result.outputTokens / 1000).toFixed(1)}K`,
    `Tokens saved:      ~${(result.tokensSaved / 1000).toFixed(1)}K (${result.tokensBefore > 0 ? ((result.tokensSaved / result.tokensBefore) * 100).toFixed(0) : 0}%)`,
    `Retry loops:       ${result.retryLoops.length}`,
    ``,
    `── Classification ──`,
    `  HIGH (verbatim):  ${result.stats.highKept} (${result.stats.totalTurns > 0 ? ((result.stats.highKept / result.stats.totalTurns) * 100).toFixed(0) : 0}%)`,
    `  MEDIUM (summary): ${result.stats.mediumSummarized} (${result.stats.totalTurns > 0 ? ((result.stats.mediumSummarized / result.stats.totalTurns) * 100).toFixed(0) : 0}%)`,
    `  LOW (dropped):    ${result.stats.lowDropped} (${result.stats.totalTurns > 0 ? ((result.stats.lowDropped / result.stats.totalTurns) * 100).toFixed(0) : 0}%)`,
    ``,
    `── Score Distribution ──`,
  ];

  for (let i = 10; i >= 0; i--) {
    const entry = hist.get(i)!;
    if (entry.count === 0 && i !== settings.keepThreshold && i !== settings.dropThreshold && i !== settings.dropThreshold - 1) continue;
    const bar = formatBar(entry.count, maxCount, 20);
    lines.push(`  ${i.toString().padStart(2)} │ ${bar} ${entry.count.toString().padStart(3)} ${entry.cls}`);
  }

  if (result.retryLoops.length > 0) {
    lines.push(`\n── Retry Loops (${result.retryLoops.length}) ──`);
    for (const loop of result.retryLoops) {
      lines.push(`  ${loop.description}`);
    }
  }

  lines.push(`\n── Sample Messages ──`);
  for (const cls of ["HIGH", "MEDIUM", "LOW"] as const) {
    const msgs = result.messages.filter((m) => m.classification === cls).slice(0, 3);
    if (msgs.length === 0) continue;
    lines.push(`\n  **${cls} (${result.messages.filter((m) => m.classification === cls).length} total):**`);
    for (const m of msgs) {
      const preview = m.content.substring(0, 100).replace(/\n/g, " ");
      lines.push(`    [${m.role}] score=${m.score} tokens=${m.tokenEstimate} ${preview}`);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// In-session command handlers
// ---------------------------------------------------------------------------

async function cmdHistory(ctx: any, snapshots: CompactionSnapshot[], args: string) {
  const n = args ? Math.min(parseInt(args.trim(), 10) || 10, snapshots.length) : 10;

  if (snapshots.length === 0) {
    ctx.ui.notify("No compaction data yet. Run /compact to start collecting.", "info");
    return;
  }

  const totalSaved = snapshots.reduce((s, sn) => s + sn.postCompaction.tokensSaved, 0);
  const totalMsgs = snapshots.reduce((s, sn) => s + sn.stats.totalTurns, 0);
  const totalHigh = snapshots.reduce((s, sn) => s + sn.stats.highKept, 0);
  const totalMed = snapshots.reduce((s, sn) => s + sn.stats.mediumSummarized, 0);
  const totalLow = snapshots.reduce((s, sn) => s + sn.stats.lowDropped, 0);
  const totalLoops = snapshots.reduce((s, sn) => s + sn.retryLoops.length, 0);

  const lines = [
    `**Smart Compaction History** (${snapshots.length} compactions)`,
    "",
    `Total messages scored: ${totalMsgs.toLocaleString()}`,
    `  HIGH (verbatim):  ${totalHigh.toLocaleString()} (${totalMsgs > 0 ? ((totalHigh / totalMsgs) * 100).toFixed(0) : 0}%)`,
    `  MEDIUM (summary): ${totalMed.toLocaleString()} (${totalMsgs > 0 ? ((totalMed / totalMsgs) * 100).toFixed(0) : 0}%)`,
    `  LOW (filtered):   ${totalLow.toLocaleString()} (${totalMsgs > 0 ? ((totalLow / totalMsgs) * 100).toFixed(0) : 0}%)`,
    `Retry loops collapsed: ${totalLoops}`,
    `Total tokens saved: ~${(totalSaved / 1000).toFixed(0)}K`,
    `Avg per compaction: ~${(totalSaved / snapshots.length / 1000).toFixed(1)}K`,
    "",
    `**Last ${n} compactions:**`,
  ];

  for (const sn of snapshots.slice(0, n)) {
    const date = new Date(sn.timestamp).toLocaleString();
    lines.push(
      `\n${date} | ${sn.stats.totalTurns} msgs → ${sn.stats.highKept}H + ${sn.stats.mediumSummarized}M + ${sn.stats.lowDropped}L | ~${(sn.postCompaction.tokensSaved / 1000).toFixed(1)}K saved` +
      (sn.retryLoops.length > 0 ? ` | ${sn.retryLoops.length} loops` : "")
    );
  }

  ctx.ui.notify(lines.join("\n"), "info");
}

async function cmdStat(ctx: any, snapshots: CompactionSnapshot[]) {
  if (snapshots.length === 0) {
    ctx.ui.notify("No compaction data yet.", "info");
    return;
  }

  const totalSaved = snapshots.reduce((s, sn) => s + sn.postCompaction.tokensSaved, 0);
  const totalMsgs = snapshots.reduce((s, sn) => s + sn.stats.totalTurns, 0);
  const totalHigh = snapshots.reduce((s, sn) => s + sn.stats.highKept, 0);
  const totalMed = snapshots.reduce((s, sn) => s + sn.stats.mediumSummarized, 0);
  const totalLow = snapshots.reduce((s, sn) => s + sn.stats.lowDropped, 0);
  const totalLoops = snapshots.reduce((s, sn) => s + sn.retryLoops.length, 0);

  // Aggregate score distribution
  const aggHist = new Map<number, number>();
  for (let i = 0; i <= 10; i++) aggHist.set(i, 0);
  for (const sn of snapshots) {
    for (const m of sn.messages) {
      aggHist.set(m.score, (aggHist.get(m.score) ?? 0) + 1);
    }
  }
  const maxCount = Math.max(...aggHist.values());

  // Settings variation
  const settingSets = new Set(snapshots.map((sn) => `${sn.settings.keepThreshold}/${sn.settings.dropThreshold}`));

  const lines = [
    `**Aggregate Statistics** (${snapshots.length} compactions)`,
    "",
    `**Totals:**`,
    `  Messages scored: ${totalMsgs.toLocaleString()}`,
    `  HIGH: ${totalHigh.toLocaleString()} (${totalMsgs > 0 ? ((totalHigh / totalMsgs) * 100).toFixed(1) : 0}%)`,
    `  MEDIUM: ${totalMed.toLocaleString()} (${totalMsgs > 0 ? ((totalMed / totalMsgs) * 100).toFixed(1) : 0}%)`,
    `  LOW: ${totalLow.toLocaleString()} (${totalMsgs > 0 ? ((totalLow / totalMsgs) * 100).toFixed(1) : 0}%)`,
    `  Retry loops: ${totalLoops}`,
    `  Tokens saved: ~${(totalSaved / 1000).toFixed(0)}K`,
    `  Avg per compaction: ~${(totalSaved / snapshots.length / 1000).toFixed(1)}K`,
    "",
    `**Settings used:** ${[...settingSets].join(", ")}`,
    "",
    `**Aggregate Score Distribution:**`,
  ];

  const lastSn = snapshots[0];
  for (let i = 10; i >= 0; i--) {
    const count = aggHist.get(i) ?? 0;
    if (count === 0 && i !== lastSn.settings.keepThreshold && i !== lastSn.settings.dropThreshold && i !== lastSn.settings.dropThreshold - 1) continue;
    const bar = formatBar(count, maxCount, 20);
    const cls = i >= lastSn.settings.keepThreshold ? "HIGH" : i >= lastSn.settings.dropThreshold ? "MED" : "LOW";
    lines.push(`  ${i.toString().padStart(2)} │ ${bar} ${count.toString().padStart(5)}`);
  }

  // Threshold tuning suggestion
  const avgHighPct = totalMsgs > 0 ? (totalHigh / totalMsgs) * 100 : 0;
  lines.push("");
  if (avgHighPct > 70) {
    lines.push(`**Tuning suggestion:** ${avgHighPct.toFixed(0)}% of messages score HIGH. Consider raising keepThreshold to reduce verbatim content.`);
  } else if (avgHighPct < 20) {
    lines.push(`**Tuning suggestion:** Only ${avgHighPct.toFixed(0)}% score HIGH. Consider lowering keepThreshold to preserve more context.`);
  } else {
    lines.push(`**Tuning:** ${avgHighPct.toFixed(0)}% HIGH — thresholds look well-balanced.`);
  }

  ctx.ui.notify(lines.join("\n"), "info");
}

async function cmdTune(ctx: any, snapshots: CompactionSnapshot[], args: string) {
  if (snapshots.length === 0) {
    ctx.ui.notify("No compaction data yet.", "info");
    return;
  }

  const idx = args ? Math.max(0, parseInt(args.trim(), 10) - 1) : 0;
  const sn = snapshots[idx] ?? snapshots[0];
  const hist = buildScoreHistogram(sn.messages, sn.settings.keepThreshold, sn.settings.dropThreshold);
  const maxCount = Math.max(...Array.from(hist.values()).map((v) => v.count));

  const lines = [
    `**Tuning: Compaction #${idx + 1}** (${new Date(sn.timestamp).toLocaleString()})`,
    `Settings: keep≥${sn.settings.keepThreshold} drop<${sn.settings.dropThreshold} | scorer=${sn.settings.scoringProvider || "heuristic"}:${sn.settings.scoringModel || "—"}`,
    `Messages: ${sn.stats.totalTurns} | Saved: ~${(sn.postCompaction.tokensSaved / 1000).toFixed(1)}K`,
    "",
    `**Score Distribution:**`,
  ];

  for (let i = 10; i >= 0; i--) {
    const entry = hist.get(i)!;
    if (entry.count === 0 && i !== sn.settings.keepThreshold && i !== sn.settings.dropThreshold && i !== sn.settings.dropThreshold - 1) continue;
    const bar = formatBar(entry.count, maxCount, 20);
    lines.push(`  ${i.toString().padStart(2)} │ ${bar} ${entry.count.toString().padStart(3)} ${entry.cls}`);
  }

  // Simulate alternative thresholds
  const rawScores = sn.messages.map((m) => m.score);
  const msgTokens = sn.messages.map((m) => m.tokenEstimate);

  lines.push(`\n**Threshold Simulation:**`);
  lines.push(`  Keep  Drop  │  HIGH  MED  LOW  │  Output  Saved`);
  lines.push(`  ────────────┼───────────────────┼──────────────`);

  for (let keep = 4; keep <= 8; keep++) {
    for (let drop = 2; drop < keep; drop++) {
      let h = 0, m = 0, l = 0, hTok = 0, mTok = 0;
      for (let i = 0; i < rawScores.length; i++) {
        const cls = classify(rawScores[i], keep, drop);
        if (cls === "HIGH") { h++; hTok += msgTokens[i]; }
        else if (cls === "MEDIUM") { m++; mTok += msgTokens[i]; }
        else { l++; }
      }
      const output = hTok + Math.floor(mTok * 0.20);
      const saved = sn.tokensBefore - output;
      const marker = keep === sn.settings.keepThreshold && drop === sn.settings.dropThreshold ? " ← current" : "";
      lines.push(`  ${keep}     ${drop}     │  ${h.toString().padStart(3)}  ${m.toString().padStart(3)}  ${l.toString().padStart(3)}  │ ~${(output / 1000).toFixed(1)}K  ~${(saved / 1000).toFixed(1)}K${marker}`);
    }
  }

  ctx.ui.notify(lines.join("\n"), "info");
}

async function cmdReview(ctx: any, snapshots: CompactionSnapshot[], args: string) {
  if (snapshots.length === 0) {
    ctx.ui.notify("No compaction data yet.", "info");
    return;
  }

  const parts = args.trim().split(/\s+/).filter(Boolean);
  const idx = parts[0] ? Math.max(0, parseInt(parts[0], 10) - 1) : 0;
  const filterClass = parts[1]?.toUpperCase();
  const sn = snapshots[idx] ?? snapshots[0];

  const msgs = filterClass
    ? sn.messages.filter((m) => m.classification === filterClass)
    : sn.messages;

  if (msgs.length === 0) {
    ctx.ui.notify(filterClass ? `No ${filterClass} messages found.` : "No messages.", "warning");
    return;
  }

  const lines = [
    `**Scoring Review** (${sn.messages.length} total, ${msgs.length} shown)`,
    `Compaction #${idx + 1} — ${new Date(sn.timestamp).toLocaleString()}`,
    `Session: ${basename(sn.sessionFile).substring(0, 50)}`,
    "",
    `Score | Class │ Role | Content (truncated)`,
    `──────┼───────┼──────┼────────────────────────────────────`,
  ];

  for (const m of msgs) {
    const preview = m.content.substring(0, 100).replace(/\n/g, " ↵ ");
    lines.push(`  ${m.score}   │ ${m.classification.padEnd(5)} │ ${m.role.padEnd(6)} │ ${preview}`);
  }

  lines.push(`\nUsage: /smart-compress review [N] [HIGH|MEDIUM|LOW]`);

  ctx.ui.notify(lines.join("\n"), "info");
}

async function cmdDry(ctx: any, settings: SmartCompactionSettings) {
  const entries = ctx.sessionManager.getBranch();
  const flatMsgs: Array<{ role: string; content: unknown }> = [];

  for (const entry of entries) {
    if (entry.type === "message" && entry.message?.role) {
      // Skip compaction summary messages
      if (entry.message.role === "compactionSummary") continue;
      flatMsgs.push({ role: entry.message.role, content: entry.message.content ?? "" });
    }
  }

  if (flatMsgs.length < settings.skipUnderMessages) {
    ctx.ui.notify(`Session too small (${flatMsgs.length} messages). Need at least ${settings.skipUnderMessages}.`, "warning");
    return;
  }

  const result = analyzeMessages(flatMsgs, settings);

  const lines = formatAnalysisOutput(result, ctx.sessionManager.getSessionFile() ?? "current", settings).split("\n");
  lines.push(`\n> This is a dry run — no compaction was performed.`);
  lines.push(`> Run /compact to actually compact the session.`);

  ctx.ui.notify(lines.join("\n"), "info");
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  const settings = loadSettings();

  // Register CLI flag for offline session analysis
  pi.registerFlag("smart-compress", {
    description: "Analyze a session's compaction without compacting it. Accepts session ID, name, or partial match.",
    type: "string",
  });

  // Intercepts ALL compaction: auto-trigger + /compact
  pi.on("session_before_compact", async (event, ctx) => {
    ctx.ui.setStatus("smart-compaction", `smart: ${settings.scoringModel} keep≥${settings.keepThreshold}`);
    const result = await handleSmartCompaction(event, ctx, settings);
    ctx.ui.setStatus("smart-compaction", undefined);
    return result;
  });

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setStatus("smart-compaction", `smart: ${settings.scoringModel} keep≥${settings.keepThreshold}`);

    // Handle --smart-compress flag
    const flagValue = pi.getFlag("smart-compress") as string | undefined;
    if (flagValue) {
      const sessionInfo = await findSession(flagValue);
      if (!sessionInfo) {
        process.stdout.write(`Session not found: "${flagValue}"\n`);
        process.exit(1);
      }

      try {
        const sm = SessionManager.open(sessionInfo.path);
        const entries = sm.getBranch();
        const flatMsgs: Array<{ role: string; content: unknown }> = [];

        for (const entry of entries) {
          if (entry.type === "message" && entry.message?.role) {
            if (entry.message.role === "compactionSummary") continue;
            flatMsgs.push({ role: entry.message.role, content: entry.message.content ?? "" });
          }
        }

        if (flatMsgs.length === 0) {
          process.stdout.write(`No messages found in session: ${sessionInfo.name}\n`);
          process.exit(1);
        }

        const result = analyzeMessages(flatMsgs, settings);
        const output = formatAnalysisOutput(result, sessionInfo.name, settings);
        process.stdout.write(output + "\n");
      } catch (err: any) {
        process.stdout.write(`Error analyzing session: ${err.message}\n`);
        process.exit(1);
      }
      process.exit(0);
    }
  });

  pi.on("session_shutdown", () => {
    ctx.ui.setStatus("smart-compaction", undefined);
  });

  // ── /smart-compress [subcommand] ─────────────────────────────────────
  pi.registerCommand("smart-compress", {
    description: "Smart compaction analysis: stat, tune, review, dry, hist",
    getArgumentCompletions: (prefix: string) => {
      const subs = ["stat", "tune", "review", "dry", "hist"];
      const items = subs.filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const subcommand = parts[0] || "";
      const rest = parts.slice(1).join(" ");
      const snapshots = await loadAllSnapshots();

      switch (subcommand) {
        case "stat":
          await cmdStat(ctx, snapshots);
          break;

        case "tune":
          await cmdTune(ctx, snapshots, rest);
          break;

        case "review":
          await cmdReview(ctx, snapshots, rest);
          break;

        case "dry":
          await cmdDry(ctx, settings);
          break;

        case "hist":
          await cmdHistory(ctx, snapshots, rest);
          break;

        case "":
        default:
          // Quick status: current session context + last compaction
          const usage = ctx.getContextUsage();
          const currentTokens = usage?.tokens ? `${(usage.tokens / 1000).toFixed(1)}K` : "unknown";
          const lines = [
            `**Smart Compaction Status**`,
            "",
            `Current context: ~${currentTokens}`,
            `Settings: keep≥${settings.keepThreshold} drop<${settings.dropThreshold} | scorer=${settings.scoringProvider}:${settings.scoringModel}`,
            `Recorded compactions: ${snapshots.length}`,
            "",
            `**Subcommands:**`,
            `  /smart-compress stat   — Aggregate statistics across all compactions`,
            `  /smart-compress tune   — Score histogram + threshold simulation`,
            `  /smart-compress review — Tabular review of scored messages`,
            `  /smart-compress dry    — Dry-run analysis on current session`,
            `  /smart-compress hist   — Recent compaction events`,
          ];

          if (snapshots.length > 0) {
            const last = snapshots[0];
            lines.push("");
            lines.push(`**Last compaction:** ${new Date(last.timestamp).toLocaleString()}`);
            lines.push(`  ${last.stats.totalTurns} msgs → ${last.stats.highKept}H + ${last.stats.mediumSummarized}M + ${last.stats.lowDropped}L | ~${(last.postCompaction.tokensSaved / 1000).toFixed(1)}K saved`);
          }

          ctx.ui.notify(lines.join("\n"), "info");
      }
    },
  });
}
