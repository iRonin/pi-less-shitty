/**
 * Smart compaction turn scorer.
 *
 * Primary: LLM-based batch scoring — sends the full conversation to a cheap
 * model (gemini-2.5-flash) and gets back a JSON array of 0–10 scores.
 * The LLM has full context of the conversation, enabling nuanced scoring
 * that regex heuristics cannot match.
 *
 * Fallback: heuristic regex-based scoring (the original Hermes port) used
 * when the LLM call fails (no API key, timeout, model unavailable, etc.).
 */

// LLM scoring uses dynamic import of @mariozechner/pi-ai to avoid
// dependency issues when running standalone heuristic tests.

// ---------------------------------------------------------------------------
// LLM batch scorer
// ---------------------------------------------------------------------------

/** Shape of the JSON response the LLM must return. */
interface LlmScoreResponse {
  scores: number[];
}

/**
 * Score all messages via a single LLM call.
 *
 * Each message is rendered as a numbered line with role + truncated content
 * so the LLM can reference by index. The LLM returns a JSON array of scores.
 *
 * @returns Array of scores 0–10, one per message, or null on failure.
 */
export async function scoreMessagesLlm(
  messages: Array<{ role: string; content: unknown }>,
  opts: {
    modelRegistry: any;
    signal?: AbortSignal;
    providerId: string;   // e.g. "openrouter"
    modelId: string;      // e.g. "google/gemini-2.5-flash-lite"
  },
): Promise<number[] | null> {
  if (messages.length === 0) return [];

  const model = opts.modelRegistry.find(opts.providerId, opts.modelId);

  if (!model) return null;

  const auth = await opts.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) return null;

  // Render messages for the LLM
  const lines = messages.map((m, i) => {
    const text = extractText(m.content);
    const truncated = text.length > 600 ? text.substring(0, 600) + "…" : text;
    const toolInfo = extractToolInfo(m.content);
    const toolTag = toolInfo ? ` [tools: ${toolInfo}]` : "";
    return `#${i + 1} [${m.role}]${toolTag}: ${truncated.replace(/\n/g, " ")}`;
  }).join("\n");

  const prompt = `You are a context compaction scoring assistant. Score each message turn on a 0–10 scale based on its value for preserving developer context.

Scoring guide:
- **10**: Critical — user directives, final solutions, key architectural decisions, important error diagnoses
- **8-9**: Very important — code changes, test results with outcomes, design rationale, specific file operations with results
- **6-7**: Important — partial progress, useful exploration, intermediate tool outputs with meaningful data
- **4-5**: Moderate — acknowledgments with substance, routine tool calls, partial information
- **2-3**: Low — brief acknowledgments ("ok", "got it"), routine exploratory reads
- **0-1**: Minimal — pure retries, "let me try again", tool errors with no new info, conversational filler

Context awareness:
- A message's value depends on what came before. A retry that finally succeeds is HIGH; the same retry on the 5th attempt is LOW.
- Tool errors are only valuable if they diagnose a new problem or lead to a fix.
- File reads are LOW unless they discover something important.
- File writes/edits are generally HIGH — they represent real progress.
- User instructions are always HIGH.
- Intermediate thinking/exploration that leads nowhere is LOW.

Return a JSON object with a "scores" array containing exactly ${messages.length} integers (0–10), one per message in order.

<message-list>
${lines}
</message-list>

Return ONLY the JSON object, no other text.`;

  try {
    const { complete } = await import("@mariozechner/pi-ai");
    const response = await complete(
      model,
      {
        messages: [{
          role: "user" as const,
          content: [{ type: "text" as const, text: prompt }],
          timestamp: Date.now(),
        }],
      },
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
        maxTokens: Math.max(512, messages.length * 10),
        signal: opts.signal,
        temperature: 0,
      },
    );

    const text = response.content
      .filter((c: any): c is { type: "text"; text: string } => c.type === "text")
      .map((c: any) => c.text)
      .join("\n")
      .trim();

    // Parse JSON — strip markdown code fences if present
    const cleaned = text.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
    const parsed = JSON.parse(cleaned) as LlmScoreResponse;

    if (!Array.isArray(parsed.scores)) return null;

    // Validate: must have exactly the right number of scores, all 0-10
    if (parsed.scores.length !== messages.length) return null;
    const scores = parsed.scores.map((s) => {
      const n = Math.round(Number(s));
      return isNaN(n) ? 5 : Math.max(0, Math.min(10, n));
    });

    return scores;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Heuristic fallback scorer (original Hermes port)
// ---------------------------------------------------------------------------

// HIGH signals — things that indicate substantive content
const HIGH_SIGNALS: Array<{
  name: string;
  regex: RegExp | null;
  weight: number;
  roles: string[];
}> = [
  {
    name: "user_directive",
    regex: /\b(do|change|update|fix|create|add|remove|delete|implement|rewrite|refactor|configure|install|build|test|run|deploy|restart|stop|start)\b/i,
    weight: 3,
    roles: ["user", "bashExecution"],
  },
  {
    name: "design_decision",
    regex: /\b(I['']ll use|using|I chose|decided to|pattern|approach|strategy|because|since|therefore)\b/i,
    weight: 3,
    roles: ["assistant"],
  },
  {
    name: "error_diagnosis",
    regex: /\b(issue was|problem was|root cause|error was|the bug|fixed by|the fix|resolved by|caused by)\b/i,
    weight: 3,
    roles: ["assistant"],
  },
  {
    name: "file_success",
    regex: /\b(file written|created|updated|modified|saved successfully)\b/i,
    weight: 2,
    roles: ["toolResult"],
  },
  {
    name: "test_pass",
    regex: /\b(\d+ passed|all tests passed|test.*pass|PASSED)\b/i,
    weight: 2,
    roles: ["toolResult"],
  },
  {
    name: "specific_value",
    regex: /([/\\][\w.\-]+|line \d+|error \d+|\b0x[0-9a-f]+\b|\b\d+\.\d+\.\d+\b)/,
    weight: 2,
    roles: ["user", "assistant", "toolResult", "bashExecution"],
  },
];

// LOW signals — things that indicate low-value content
const LOW_SIGNALS: Array<{
  name: string;
  regex: RegExp | null;
  weight: number;
}> = [
  {
    name: "retry_language",
    regex: /\b(let me try|oops|actually|wait|let['']s try|retrying|trying again|give me another|one more)\b/i,
    weight: -2,
  },
  {
    name: "tool_error_retry",
    regex: /\b(error|failed|crashed|timeout|exception|traceback)(:| occurred| detected| found| thrown| caught| message)\b/i,
    weight: -2,
  },
  {
    name: "acknowledgment",
    regex: /\b(got it|understood|sure|okay|ok|will do|on it|let me)\b/i,
    weight: -2,
  },
];

const TOOL_ERROR_RE = /\b(error|failed|crashed|exception|traceback)(:| occurred| detected| found| thrown| caught| message)\b/i;

/**
 * Extract text content from a message.
 */
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c: any) => c?.type === "text" && typeof c.text === "string")
    .map((c: any) => c.text)
    .join("\n");
}

/**
 * Extract a brief summary of tool calls for the LLM prompt.
 */
function extractToolInfo(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const tools: string[] = [];
  for (const block of content) {
    if (block?.type === "toolCall") {
      const name = block.name || "";
      const args = typeof block.arguments === "string" ? block.arguments : JSON.stringify(block.arguments || {});
      const pathMatch = args.match(/"path"\s*:\s*"([^"]+)"/);
      const cmdMatch = args.match(/"command"\s*:\s*"([^"]+)"/);
      if (pathMatch) tools.push(`${name}(${pathMatch[1].split("/").pop()})`);
      else if (cmdMatch) tools.push(`${name}("${cmdMatch[1].substring(0, 40)}")`);
      else tools.push(name);
    }
  }
  return tools.length > 0 ? tools.join(", ") : null;
}

/**
 * Extract tool name and file path from tool_calls in a message.
 */
function extractToolAndFile(content: unknown): { tool: string; path: string } {
  let tool = "";
  let path = "";
  const pathRe = /["']?path["']?\s*[:=]\s*["']([^"']+)["']/;

  if (Array.isArray(content)) {
    for (const block of content) {
      if (block?.type === "toolCall") {
        tool = block.name || "";
        const args = typeof block.arguments === "string" ? block.arguments : JSON.stringify(block.arguments || {});
        const m = pathRe.exec(args);
        if (m) path = m[1];
        break; // take first tool call
      }
    }
  }
  return { tool, path };
}

/**
 * Check if a message has tool calls (for pi's content array format).
 */
function hasToolCalls(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((c: any) => c?.type === "toolCall");
}

/**
 * Score a single message turn from 0 to 10 using heuristic regex matching.
 * Used as fallback when LLM scoring is unavailable.
 */
function scoreTurnHeuristic(
  role: string,
  content: unknown,
  context?: { prevMessages?: Array<{ role: string; content: unknown }>; window?: number },
): number {
  let score = 5; // neutral baseline

  const text = extractText(content);

  // Empty content → penalty, but NOT for tool-calling messages
  if (!text.trim()) {
    if (hasToolCalls(content)) {
      score += 1; // bonus for active tool work
    } else {
      return Math.max(0, score - 3);
    }
  }

  // Short text penalty — but NOT for assistant messages with tool_calls
  if (role === "user" || role === "assistant") {
    if (text.trim().length < 50 && !(role === "assistant" && hasToolCalls(content))) {
      score -= 1;
    }
  }

  // Tool-calling bonus
  if (role === "assistant" && hasToolCalls(content)) {
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === "toolCall") {
          const tname = block.name || "";
          if (tname === "write" || tname === "edit") {
            score += 2;
          }
          // read, grep, find, ls, bash — expected, no bonus
        }
      }
    }
  }

  // HIGH signals
  for (const signal of HIGH_SIGNALS) {
    if (!signal.roles.includes(role)) continue;
    if (!signal.regex) continue;
    if (signal.regex.test(text)) {
      score += signal.weight;
    }
  }

  // LOW signals
  for (const signal of LOW_SIGNALS) {
    if (signal.name === "tool_error_retry") {
      // Context-aware: only penalize if previous message was an error
      if (context?.prevMessages) {
        const window = context.window ?? 3;
        const recent = context.prevMessages.slice(-window);
        for (const prev of recent) {
          const prevText = extractText(prev.content);
          if (TOOL_ERROR_RE.test(prevText)) {
            // Check if same tool is being retried
            const prevTool = extractToolAndFile(prev.content).tool;
            const curTool = extractToolAndFile(content).tool;
            if (prevTool && curTool && prevTool === curTool) {
              score += signal.weight;
            }
          }
        }
      }
      continue;
    }
    if (signal.name === "short_text") continue; // handled above
    if (!signal.regex) continue;
    if (signal.regex.test(text)) {
      score += signal.weight;
    }
  }

  // Context-aware: first occurrence of a tool pattern gets bonus
  if (context?.prevMessages && role === "assistant" && hasToolCalls(content)) {
    const tools = new Set<string>();
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === "toolCall" && block.name) {
          tools.add(block.name);
        }
      }
    }
    for (const tool of tools) {
      const window = context.window ?? 3;
      const recent = context.prevMessages.slice(-window * 2);
      const seen = recent.some((prev) => {
        if (!Array.isArray(prev.content)) return false;
        return prev.content.some(
          (c: any) => c?.type === "toolCall" && c.name === tool,
        );
      });
      if (!seen) score += 1;
    }
  }

  return Math.max(0, Math.min(10, score));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Score all messages. Tries LLM first, falls back to heuristic.
 */
export async function scoreAllMessages(
  messages: Array<{ role: string; content: unknown }>,
  keepThreshold = 7,
  dropThreshold = 4,
  window = 3,
  llmOpts?: {
    modelRegistry: any;
    signal?: AbortSignal;
    providerId: string;
    modelId: string;
  },
): Promise<Array<{ score: number; classification: "HIGH" | "MEDIUM" | "LOW"; method: "llm" | "heuristic" }>> {
  let scores: number[] | null = null;
  let method: "llm" | "heuristic" = "heuristic";

  // Try LLM scoring first
  if (llmOpts?.modelRegistry) {
    scores = await scoreMessagesLlm(messages, {
      modelRegistry: llmOpts.modelRegistry,
      signal: llmOpts.signal,
      providerId: llmOpts.providerId,
      modelId: llmOpts.modelId,
    });
    if (scores) method = "llm";
  }

  // Fallback to heuristic
  if (!scores) {
    scores = messages.map((msg, i) => {
      const contextStart = Math.max(0, i - window);
      const prev = messages.slice(contextStart, i);
      return scoreTurnHeuristic(msg.role, msg.content, { prevMessages: prev, window });
    });
    method = "heuristic";
  }

  return scores.map((score) => ({
    score,
    classification: classify(score, keepThreshold, dropThreshold),
    method,
  }));
}

/**
 * Classify a score into HIGH / MEDIUM / LOW.
 */
export function classify(
  score: number,
  keepThreshold: number,
  dropThreshold: number,
): "HIGH" | "MEDIUM" | "LOW" {
  if (score >= keepThreshold) return "HIGH";
  if (score >= dropThreshold) return "MEDIUM";
  return "LOW";
}

/**
 * Synchronous heuristic-only scoring (for CLI dry-run without model access).
 */
export function scoreAllMessagesSync(
  messages: Array<{ role: string; content: unknown }>,
  keepThreshold = 7,
  dropThreshold = 4,
  window = 3,
): Array<{ score: number; classification: "HIGH" | "MEDIUM" | "LOW" }> {
  const results: Array<{ score: number; classification: "HIGH" | "MEDIUM" | "LOW" }> = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const contextStart = Math.max(0, i - window);
    const prev = messages.slice(contextStart, i);
    const score = scoreTurnHeuristic(msg.role, msg.content, { prevMessages: prev, window });
    const classification = classify(score, keepThreshold, dropThreshold);
    results.push({ score, classification });
  }

  return results;
}

// Legacy alias for backward compat with synchronous callers
export { scoreTurnHeuristic as scoreTurn };
