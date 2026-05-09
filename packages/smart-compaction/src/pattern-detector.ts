/**
 * Retry loop detector for smart compaction.
 *
 * Detects when the same tool operates on the same file within a window
 * and collapses them into a single entry in the summary.
 */

const FILE_PATH_RE = /["']?path["']?\s*[:=]\s*["']([^"']+)["']/;

function extractToolFilePair(content: unknown): { tool: string; path: string } {
  let tool = "";
  let path = "";

  if (Array.isArray(content)) {
    for (const block of content) {
      if (block?.type === "toolCall") {
        tool = block.name || "";
        const args = typeof block.arguments === "string" ? block.arguments : JSON.stringify(block.arguments || {});
        const m = FILE_PATH_RE.exec(args);
        if (m) path = m[1];
      }
    }
  }

  // Also check text content for file references (tool results)
  if (typeof content === "string") {
    const m = content.match(/(?:file|path)\s+["']?([/\w.\-]+)["']?/);
    if (m) path = m[1];
  } else if (Array.isArray(content)) {
    const text = content
      .filter((c: any) => c?.type === "text")
      .map((c: any) => c.text)
      .join("\n");
    const m = text.match(/(?:file|path)\s+["']?([/\w.\-]+)["']?/);
    if (m) path = m[1];
  }

  return { tool, path };
}

export interface RetryLoop {
  startIdx: number;
  endIdx: number;
  description: string;
  lastResult: string;
}

/**
 * Detect retry loops in a message sequence.
 * A retry loop is when the same tool operates on the same file
 * within `window` consecutive turns.
 */
export function detectRetryLoops(
  messages: Array<{ role: string; content: unknown }>,
  window = 3,
): RetryLoop[] {
  if (!messages.length) return [];

  const loops: RetryLoop[] = [];
  const n = messages.length;
  let i = 0;

  while (i < n) {
    const { tool, path } = extractToolFilePair(messages[i].content);
    if (!tool) {
      i++;
      continue;
    }

    let j = i + 1;
    let seenSame = false;
    while (j < Math.min(i + window * 2, n)) {
      const { tool: t2, path: p2 } = extractToolFilePair(messages[j].content);
      if (t2 === tool && (!path || p2 === path)) {
        seenSame = true;
        j++;
      } else if (messages[j].role === "toolResult") {
        j++;
      } else {
        break;
      }
    }

    if (seenSame && (j - i) >= 3) {
      // Extract the last result for the collapsed entry
      let lastResult = "";
      for (let k = j - 1; k >= i; k--) {
        const text = extractText(messages[k].content);
        if (text.trim()) {
          lastResult = text.trim().substring(0, 200);
          break;
        }
      }

      const desc = `${tool} loop on ${path || "unknown"} (${j - i} attempts)`;
      loops.push({ startIdx: i, endIdx: j, description: desc, lastResult });
      i = j;
    } else {
      i++;
    }
  }

  return loops;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c: any) => c?.type === "text" && typeof c.text === "string")
    .map((c: any) => c.text)
    .join("\n");
}
