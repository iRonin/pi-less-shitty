/**
 * Phase F — topic-shift heuristic for hindsight auto-recall.
 *
 * This module is intentionally pi-agnostic (no `@earendil-works/*` imports)
 * so it can be unit-tested directly without the pi runtime. `index.ts`
 * re-exports the public functions for backwards-compatible discovery.
 *
 * Heuristic shape (hybrid, default):
 *   1. cooldown gate  — never re-fire within `cooldownSeconds`
 *   2. jaccard overlap — stopword-stripped token-set similarity
 *   3. N-turn fallback (hybrid only) — force fire after `everyNTurns`
 *   4. Trigger phrases (hybrid only) — explicit cross-session references
 *
 * First user turn always fires regardless of settings (legacy behavior).
 */

export type TopicShiftHeuristic = "hybrid" | "jaccard" | "off";

export interface TopicShiftRecallSettings {
  /** Master switch. When false, only the first turn fires auto-recall (legacy behavior). */
  enabled: boolean;
  /** Which heuristic decides a re-fire: `jaccard` (text overlap only), `hybrid` (overlap + N-turn fallback + high-precision trigger phrases), or `off`. */
  heuristic: TopicShiftHeuristic;
  /** Minimum seconds between successful recalls. Hard ceiling — even an obvious topic shift waits. */
  cooldownSeconds: number;
  /** Force a re-fire after N user turns without one, regardless of similarity. Hybrid only. */
  everyNTurns: number;
  /** Re-fire when Jaccard similarity (token overlap between current prompt and last-recalled prompt) drops below this threshold. */
  jaccardThreshold: number;
}

export const DEFAULT_TOPIC_SHIFT_SETTINGS: TopicShiftRecallSettings = {
  // Conservative defaults: enabled, but knobs picked so a typical
  // same-topic multi-turn conversation stays above the 0.2 jaccard floor
  // and the 60s cooldown prevents thrash even on a sudden shift.
  enabled: true,
  heuristic: "hybrid",
  cooldownSeconds: 60,
  everyNTurns: 8,
  jaccardThreshold: 0.2,
};

// High-precision phrase set. Single words like "remember", "earlier",
// "before", "recall" are deliberately EXCLUDED — they appear in too many
// unrelated contexts ("remember to lint", "earlier today", "recall the
// function signature"). Only multi-word phrases that strongly imply
// cross-session reference are matched.
export const TOPIC_SHIFT_TRIGGER_RE = /\b(?:we (?:decided|agreed|chose|said)|you (?:said|told me|mentioned|noted)|i (?:told you|mentioned|said) (?:earlier|before|previously)|last (?:session|time)|previously (?:discussed|decided|agreed|noted)|earlier (?:you|we|i) (?:said|noted|discussed|decided)|before (?:our|the) last|do you (?:remember|recall) (?:when|that|how|why))\b/i;

// Stopword set — removes high-frequency tokens that inflate jaccard
// similarity between otherwise unrelated prompts.
const JACCARD_STOPWORDS = new Set([
  "a", "an", "and", "the", "is", "are", "was", "were", "be", "been", "being",
  "to", "of", "in", "on", "at", "by", "for", "with", "from", "as", "into", "about",
  "i", "you", "we", "it", "he", "she", "they", "me", "us", "them", "my", "your", "our",
  "this", "that", "these", "those",
  "do", "does", "did", "can", "could", "would", "should", "will", "may", "might", "have", "has", "had",
  "what", "when", "where", "why", "how", "which", "who",
  "if", "then", "so", "or", "but", "not", "no",
  "please", "just", "now", "ok", "okay", "yes", "sure",
]);

/** Lowercase, strip punctuation, drop stopwords + short tokens, dedupe. */
export function tokenizeForJaccard(s: string): Set<string> {
  const tokens = (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]+/g, " ")
    .split(/\s+/)
    .filter(t => t.length >= 2 && !JACCARD_STOPWORDS.has(t));
  return new Set(tokens);
}

/** Jaccard similarity over content-word token sets. Two empty sets → 1 (no shift signal); one empty → 0 (shift). */
export function jaccardSimilarity(a: string, b: string): number {
  const A = tokenizeForJaccard(a);
  const B = tokenizeForJaccard(b);
  if (A.size === 0 && B.size === 0) return 1;
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const union = A.size + B.size - inter;
  return union > 0 ? inter / union : 0;
}

export interface ShouldRecallInput {
  currentPrompt: string;
  /** Empty string if recall has never fired this session. */
  lastRecallPrompt: string;
  /** Epoch ms of the last successful recall, or 0 if never. */
  lastRecallAt: number;
  /** Count of user turns since the last successful recall (0 immediately after one fires). */
  turnsSinceLastRecall: number;
  /** Date.now() injected for testability. */
  now: number;
  settings: TopicShiftRecallSettings;
}

export interface ShouldRecallDecision {
  fire: boolean;
  /** "first-turn" | "cooldown" | "jaccard" | "n-turn" | "trigger" | "disabled" | "similar" */
  reason: string;
  /** Diagnostic detail (similarity score, matched phrase, …). */
  detail?: string;
}

/**
 * Pure, deterministic policy: should the next user turn fire a fresh recall?
 *
 * Order of checks (priority, top wins):
 *   1. First-ever turn → fire (legacy behavior, beats every other check).
 *   2. enabled=false OR heuristic=off → never re-fire.
 *   3. Cooldown — hard gate, beats every signal except first-turn.
 *   4. Heuristic-specific:
 *        "jaccard" → fire iff overlap < threshold.
 *        "hybrid"  → fire on jaccard OR N-turn fallback OR trigger phrase.
 */
export function shouldRecall(input: ShouldRecallInput): ShouldRecallDecision {
  const { currentPrompt, lastRecallPrompt, lastRecallAt, turnsSinceLastRecall, now, settings } = input;

  if (lastRecallAt === 0) return { fire: true, reason: "first-turn" };

  if (!settings.enabled) return { fire: false, reason: "disabled" };
  if (settings.heuristic === "off") return { fire: false, reason: "disabled" };

  const cooldownMs = settings.cooldownSeconds * 1000;
  if (now - lastRecallAt < cooldownMs) {
    const remaining = Math.ceil((cooldownMs - (now - lastRecallAt)) / 1000);
    return { fire: false, reason: "cooldown", detail: `${remaining}s remaining` };
  }

  const sim = jaccardSimilarity(currentPrompt, lastRecallPrompt);
  if (sim < settings.jaccardThreshold) {
    return { fire: true, reason: "jaccard", detail: `${sim.toFixed(2)} < ${settings.jaccardThreshold}` };
  }

  if (settings.heuristic === "hybrid") {
    if (turnsSinceLastRecall >= settings.everyNTurns) {
      return { fire: true, reason: "n-turn", detail: `${turnsSinceLastRecall} >= ${settings.everyNTurns}` };
    }
    const triggerMatch = currentPrompt.match(TOPIC_SHIFT_TRIGGER_RE);
    if (triggerMatch) {
      return { fire: true, reason: "trigger", detail: triggerMatch[0].slice(0, 40) };
    }
  }

  return { fire: false, reason: "similar", detail: `jaccard=${sim.toFixed(2)}` };
}

export function normalizeHeuristic(v: unknown): TopicShiftHeuristic {
  return v === "hybrid" || v === "jaccard" || v === "off" ? v : DEFAULT_TOPIC_SHIFT_SETTINGS.heuristic;
}

// ---------------------------------------------------------------------------
// Recall policy — high-level switch for HOW OFTEN auto-recall fires.
//
//   every-turn    fire on every user turn, bounded by a 5s anti-thrash cooldown
//                 (DEFAULT — matches user expectation: "recall after each prompt")
//   topic-shift   Phase F behavior: jaccard / N-turn / trigger phrases, bounded
//                 by topicShiftRecall.cooldownSeconds
//   session-only  legacy pre-Phase-F: fire ONLY on the first user turn of a
//                 session, never re-fire
// ---------------------------------------------------------------------------

export type RecallPolicy = "every-turn" | "topic-shift" | "session-only";

export const DEFAULT_RECALL_POLICY: RecallPolicy = "every-turn";

/** 5s anti-thrash cooldown for `every-turn` mode — guards against Enter-spam. */
export const EVERY_TURN_COOLDOWN_MS = 5_000;

export function normalizeRecallPolicy(v: unknown): RecallPolicy {
  return v === "every-turn" || v === "topic-shift" || v === "session-only"
    ? v
    : DEFAULT_RECALL_POLICY;
}

/**
 * `every-turn` cooldown gate. Fires immediately on the first turn
 * (lastRecallAt === 0), then every `cooldownMs` thereafter.
 * Pure, deterministic, dependency-free — safe to unit-test directly.
 */
export function shouldFireEveryTurn(
  now: number,
  lastRecallAt: number,
  cooldownMs: number = EVERY_TURN_COOLDOWN_MS,
): boolean {
  if (lastRecallAt === 0) return true;
  return now - lastRecallAt >= cooldownMs;
}
