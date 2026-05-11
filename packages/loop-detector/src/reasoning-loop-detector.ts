/**
 * Reasoning-content loop detector.
 *
 * Catches repeated paragraphs inside a single assistant turn — the failure
 * mode where a local reasoning model (e.g. qwen 35b a3b) emits the same
 * 4–6 paragraphs 20+ times each inside a `thinking` block, never calling
 * a tool. The existing `ToolLoopDetector` has zero visibility into this
 * because no tool calls happen during the loop.
 *
 * Algorithm:
 *   1. Buffer streamed text. Segment into paragraphs on `\n\n` (with a
 *      forced split fallback if a paragraph grows past `maxParagraphLen`).
 *   2. Normalize each paragraph: lowercase, collapse whitespace, strip
 *      leading list markers (`1.`, `- `, etc.), strip trailing punctuation.
 *   3. Tier 1 — exact match: SHA-256 of normalized text against any of
 *      the last K paragraphs in the rolling window.
 *   4. Tier 2 — near-duplicate: shingled trigram Jaccard ≥ `jaccardThreshold`
 *      against any of the last K normalized paragraphs.
 *   5. Track the number of repeats (exact + near) within the rolling K
 *      window. When count >= threshold → `critical`. At count == threshold-1
 *      → `warning`.
 *
 * Coexists with `ToolLoopDetector` — both are loaded from the same package
 * but operate on disjoint event streams.
 */

import { createHash } from "node:crypto";

// ── Types ────────────────────────────────────────────────────────────────────

export type ReasoningLoopMode = "warn" | "stop";

export interface ReasoningLoopVerdict {
  severity: "none" | "warning" | "critical";
  /** "exact" or "near" if the most-recently-recorded paragraph matched
   *  a prior paragraph in the rolling window. `null` otherwise. */
  matchType: "exact" | "near" | null;
  /** Total repeats (exact + near) inside the current rolling K window. */
  repeatCount: number;
  /** First ~200 chars of the repeated unit, for status / steering text. */
  sampleUnit: string | null;
  /** How many paragraphs the detector has classified so far this turn.
   *  Useful for tests; not part of the public spec. */
  paragraphsSeen: number;
}

export interface ReasoningLoopConfig {
  /** Repeats (exact + near) within window required to escalate to critical. */
  threshold: number;
  /** Rolling window size — how many of the most recent paragraphs to compare against. */
  windowSize: number;
  /** Jaccard similarity (0..1) for Tier 2 near-duplicate detection. */
  jaccardThreshold: number;
  /** Behavior on critical verdict. Detector itself doesn't act; the caller does. */
  mode: ReasoningLoopMode;
  /** Minimum length (chars, post-normalize) of a paragraph before it is considered.
   *  Very short paragraphs ("ok.", "now what") are noisy. */
  minParagraphLen: number;
  /** Force a paragraph break inside a giant block of text without `\n\n`. */
  maxParagraphLen: number;
  /** N for n-gram shingling used in Jaccard. 3 = trigrams. */
  shingleN: number;
}

export const DEFAULT_REASONING_CONFIG: ReasoningLoopConfig = {
  threshold: 3,
  windowSize: 10,
  jaccardThreshold: 0.8,
  mode: "stop",
  minParagraphLen: 20,
  maxParagraphLen: 2000,
  shingleN: 3,
};

// ── Normalization ────────────────────────────────────────────────────────────

const LEADING_LIST_MARKER = /^(?:\d{1,3}[.)]|[-*•·]|>+)\s+/;
const TRAILING_PUNCT_RUN = /[\s.,;:!?"'`)\]]+$/;
const WS_RUN = /\s+/g;

/** Lowercase, collapse whitespace, strip a leading list marker and trailing punctuation. */
export function normalizeParagraph(text: string): string {
  let s = text.trim().replace(LEADING_LIST_MARKER, "");
  s = s.toLowerCase().replace(WS_RUN, " ");
  s = s.replace(TRAILING_PUNCT_RUN, "");
  return s.trim();
}

function shortHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** Character trigrams (or N-grams) of a normalized string. Returns a Set. */
export function shingles(normalized: string, n: number): Set<string> {
  const out = new Set<string>();
  if (normalized.length < n) {
    if (normalized.length > 0) out.add(normalized);
    return out;
  }
  for (let i = 0; i <= normalized.length - n; i++) {
    out.add(normalized.slice(i, i + n));
  }
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of small) if (large.has(x)) intersection++;
  const union = a.size + b.size - intersection;
  return intersection / union;
}

// ── Segmentation ─────────────────────────────────────────────────────────────

/**
 * Pull complete paragraphs out of `buffer`. A paragraph is bounded by `\n\n`
 * (with optional whitespace between the newlines). If the buffer grows past
 * `maxLen` without a paragraph break, force-split on the most recent
 * sentence boundary so a runaway block of text without blank lines still
 * gets segmented. The returned `remainder` is what couldn't be fully closed
 * yet (and must be re-fed on the next call).
 */
export function segmentBuffer(
  buffer: string,
  maxLen: number,
): { paragraphs: string[]; remainder: string } {
  const paragraphs: string[] = [];
  let rest = buffer;

  // Eat all complete `\n\s*\n` separated blocks.
  // We don't want to consume the LAST block — it may still be growing.
  while (true) {
    const m = /\n[ \t]*\n+/.exec(rest);
    if (!m) break;
    const end = m.index;
    const block = rest.slice(0, end).trim();
    if (block.length > 0) paragraphs.push(block);
    rest = rest.slice(end + m[0].length);
  }

  // Force-split if the remaining "still-open" paragraph has grown too long.
  while (rest.length > maxLen) {
    // Find the last sentence-end boundary in the first maxLen chars.
    const head = rest.slice(0, maxLen);
    let cut = -1;
    const sentenceEnd = /[.!?]\s+/g;
    let m: RegExpExecArray | null;
    while ((m = sentenceEnd.exec(head)) !== null) {
      cut = m.index + m[0].length;
    }
    if (cut <= 0) cut = maxLen; // hard cut
    const forced = rest.slice(0, cut).trim();
    if (forced.length > 0) paragraphs.push(forced);
    rest = rest.slice(cut);
  }

  return { paragraphs, remainder: rest };
}

// ── Detector ─────────────────────────────────────────────────────────────────

interface ParagraphEntry {
  raw: string;
  normalized: string;
  hash: string;
  shingles: Set<string>;
}

export class ReasoningLoopDetector {
  private config: ReasoningLoopConfig;
  /** Streaming text buffer — refilled by `record()` from arbitrary chunks. */
  private buffer = "";
  /** Rolling window of the last K paragraphs (oldest at index 0). */
  private window: ParagraphEntry[] = [];
  /** Repeat counter for the current window. Bookkept on push & shift. */
  private windowRepeats = 0;
  /** Total paragraphs ever recorded this turn. */
  private paragraphsSeen = 0;
  /** Highest verdict seen so far this turn — verdict is monotonic per turn. */
  private latched: ReasoningLoopVerdict["severity"] = "none";
  /** Most recent sample-unit text (raw) of a detected repeat. */
  private latestSampleUnit: string | null = null;

  constructor(config: Partial<ReasoningLoopConfig> = {}) {
    this.config = { ...DEFAULT_REASONING_CONFIG, ...config };
  }

  /** Apply a partial config update (used for per-model overrides). */
  updateConfig(partial: Partial<ReasoningLoopConfig>): void {
    this.config = { ...this.config, ...partial };
  }

  /** Snapshot of the effective config — handy for tests/diagnostics. */
  getConfig(): ReasoningLoopConfig {
    return { ...this.config };
  }

  /** Clear all state. Call between turns. */
  reset(): void {
    this.buffer = "";
    this.window = [];
    this.windowRepeats = 0;
    this.paragraphsSeen = 0;
    this.latched = "none";
    this.latestSampleUnit = null;
  }

  /**
   * Append `chunk` of new assistant text to the buffer, segment off any
   * completed paragraphs, and run the duplicate check on each. Returns
   * the worst verdict produced by anything in this chunk. If no new
   * paragraph was completed, returns the latched severity (`none` initially).
   *
   * `chunk` can be a partial delta or a full message. The detector handles
   * both cases the same way.
   */
  record(chunk: string): ReasoningLoopVerdict {
    if (!chunk) return this.currentVerdict(null);
    this.buffer += chunk;

    const { paragraphs, remainder } = segmentBuffer(this.buffer, this.config.maxParagraphLen);
    this.buffer = remainder;

    let lastMatchType: "exact" | "near" | null = null;
    for (const para of paragraphs) {
      const v = this.recordParagraph(para);
      if (v !== null) lastMatchType = v;
    }
    return this.currentVerdict(lastMatchType);
  }

  /**
   * Flush whatever remains in the buffer as a final paragraph (if non-empty
   * and long enough). Use this from a `message_end` handler to catch a loop
   * whose final paragraph wasn't terminated with `\n\n`.
   */
  flush(): ReasoningLoopVerdict {
    if (this.buffer.trim().length === 0) {
      this.buffer = "";
      return this.currentVerdict(null);
    }
    const para = this.buffer.trim();
    this.buffer = "";
    const matchType = this.recordParagraph(para);
    return this.currentVerdict(matchType);
  }

  /** Feed a single complete paragraph. Returns the match type, or null if rejected/no match. */
  private recordParagraph(raw: string): "exact" | "near" | null {
    const normalized = normalizeParagraph(raw);
    if (normalized.length < this.config.minParagraphLen) {
      // Too short to be meaningful. Don't count toward window but also don't reset.
      return null;
    }
    const hash = shortHash(normalized);
    const sh = shingles(normalized, this.config.shingleN);

    // Match against window
    let matchType: "exact" | "near" | null = null;
    for (let i = this.window.length - 1; i >= 0; i--) {
      const prior = this.window[i];
      if (prior.hash === hash) {
        matchType = "exact";
        break;
      }
    }
    if (matchType === null) {
      for (let i = this.window.length - 1; i >= 0; i--) {
        const prior = this.window[i];
        if (jaccard(sh, prior.shingles) >= this.config.jaccardThreshold) {
          matchType = "near";
          break;
        }
      }
    }

    this.paragraphsSeen++;
    const entry: ParagraphEntry = { raw, normalized, hash, shingles: sh };
    this.window.push(entry);
    if (matchType !== null) {
      this.windowRepeats++;
      this.latestSampleUnit = raw;
    }
    // Shrink window. If the evicted entry was a repeat, decrement the counter.
    while (this.window.length > this.config.windowSize) {
      const evicted = this.window.shift()!;
      // The evicted entry is a "repeat" iff some EARLIER entry matched it.
      // We tracked that at insertion time only — but the counter remains
      // monotone-correct if we recompute on eviction: count how many entries
      // remaining in the window are repeats of someone *earlier* in the new window.
      // Cheaper: simply recompute the running repeat count when we evict.
      // (Window is at most K ≈ 10, so O(K²) per eviction is fine.)
      void evicted; // reference to silence lint
      this.windowRepeats = this.recomputeWindowRepeats();
    }

    // Latch severity (monotone within a turn)
    const sev = this.severityFor(this.windowRepeats);
    if (sev === "critical" || (sev === "warning" && this.latched === "none")) {
      this.latched = sev;
    }
    return matchType;
  }

  private recomputeWindowRepeats(): number {
    let count = 0;
    for (let i = 1; i < this.window.length; i++) {
      const cur = this.window[i];
      let hit = false;
      for (let j = 0; j < i; j++) {
        const prior = this.window[j];
        if (prior.hash === cur.hash) {
          hit = true;
          break;
        }
        if (jaccard(cur.shingles, prior.shingles) >= this.config.jaccardThreshold) {
          hit = true;
          break;
        }
      }
      if (hit) count++;
    }
    return count;
  }

  private severityFor(repeats: number): ReasoningLoopVerdict["severity"] {
    if (repeats >= this.config.threshold) return "critical";
    if (this.config.threshold >= 2 && repeats >= this.config.threshold - 1) return "warning";
    return "none";
  }

  private currentVerdict(lastMatchType: "exact" | "near" | null): ReasoningLoopVerdict {
    return {
      severity: this.latched,
      matchType: lastMatchType,
      repeatCount: this.windowRepeats,
      sampleUnit: this.latestSampleUnit,
      paragraphsSeen: this.paragraphsSeen,
    };
  }
}

// ── Convenience: run detector against a full assistant message (offline replay) ──

/**
 * Convenience wrapper for offline replay — feed a complete text blob and
 * a fresh detector, return the final verdict after flushing. Used by
 * `scripts/loop-replay.sh`.
 */
export function detectInText(
  text: string,
  config: Partial<ReasoningLoopConfig> = {},
): ReasoningLoopVerdict {
  const d = new ReasoningLoopDetector(config);
  d.record(text);
  return d.flush();
}
