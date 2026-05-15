/**
 * Per-session context tracker for the LLM judge.
 *
 * Maintains a tiny in-memory rolling window of:
 *   - the last user input text (truncated)
 *   - the last N bash commands the agent has run
 *
 * Used by `llm-judge.ts` to ground its verdict in what's actually been
 * happening this session. State is intentionally short-lived (cleared on
 * `session_start`) and bounded so it cannot grow with a long session.
 */

const MAX_BASH_HISTORY = 10;
const MAX_USER_PROMPT_BYTES = 1500;

let lastUserPrompt: string | null = null;
const recentBash: string[] = [];

export function recordUserPrompt(text: string): void {
  if (!text) return;
  lastUserPrompt = text.length > MAX_USER_PROMPT_BYTES
    ? text.slice(0, MAX_USER_PROMPT_BYTES) + "\n…[truncated]"
    : text;
}

export function recordBashCommand(cmd: string): void {
  if (!cmd) return;
  // Coalesce contiguous duplicates so a noisy agent doesn't flood the buffer.
  if (recentBash.length && recentBash[recentBash.length - 1] === cmd) return;
  recentBash.push(cmd);
  while (recentBash.length > MAX_BASH_HISTORY) recentBash.shift();
}

export function getJudgeContext(): { lastUserPrompt: string | null; recentBash: string[] } {
  return { lastUserPrompt, recentBash: recentBash.slice() };
}

export function clearJudgeContext(): void {
  lastUserPrompt = null;
  recentBash.length = 0;
}
