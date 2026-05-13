/**
 * Pure helpers for the `hindsight-retain-zero-units-extracted` message renderer
 * and its module-level per-bank consecutive-zero counter.
 *
 * Kept in a standalone module (no pi-tui / pi-coding-agent peer-dep imports)
 * so the unit tests can exercise everything without instantiating the full
 * extension runtime. index.ts re-exports + wires these into the message
 * renderer and the lifecycle hooks (session_start, /hindsight reset).
 */

// ─── Per-bank consecutive-zero streak ───────────────────────────────────────
// Module-level: persists across watcher dispatches within one pi process.
// Reset semantics:
//   - session_start                              → resetConsecutiveZero()
//   - /hindsight reset                           → resetConsecutiveZero()
//   - any retain with delta > 0 to the same bank → resetConsecutiveZero(bank)
//   - any zero-units retain to bank              → bumpConsecutiveZero(bank)+1
const consecutiveZeroByBank = new Map<string, number>();

export function bumpConsecutiveZero(bank: string): number {
  const next = (consecutiveZeroByBank.get(bank) ?? 0) + 1;
  consecutiveZeroByBank.set(bank, next);
  return next;
}

export function resetConsecutiveZero(bank?: string): void {
  if (bank === undefined) {
    consecutiveZeroByBank.clear();
  } else {
    consecutiveZeroByBank.delete(bank);
  }
}

export function getConsecutiveZero(bank: string): number {
  return consecutiveZeroByBank.get(bank) ?? 0;
}

export function __getConsecutiveZeroMapForTests(): Map<string, number> {
  return new Map(consecutiveZeroByBank);
}

// ─── Duration bucket ────────────────────────────────────────────────────────
// Heuristic. Boundary semantics: `< 1s`, `1s ≤ op < 10s`, `10s ≤ op < 30s`,
// `op ≥ 30s` — so 1000ms is "normal", 10_000ms is "slow", 30_000ms is "very
// slow". Tests pin every boundary.
export function durationBucketLabel(opAgeMs: number): string {
  if (opAgeMs < 1000) return "fast — LLM likely bailed or rejected content";
  if (opAgeMs < 10_000) return "normal";
  if (opAgeMs < 30_000) return "slow";
  return "very slow — possible timeout";
}

// ─── Transcript head ────────────────────────────────────────────────────────
// Collapsed single-line preview. Replaces CR/LF with ⏎ so it stays on one
// row, truncates to `max` chars with ellipsis. Empty/missing → sentinel
// "(no transcript captured)" so the renderer never blanks-out the line.
export const TRANSCRIPT_HEAD_MAX = 200;
export function transcriptHead(s: string | null | undefined, max: number = TRANSCRIPT_HEAD_MAX): string {
  if (s === null || s === undefined || s === "") return "(no transcript captured)";
  const flat = String(s).replace(/\r\n|\r|\n/g, "⏎");
  return flat.length > max ? flat.slice(0, max) + "…" : flat;
}

// ─── Streak ordinal ─────────────────────────────────────────────────────────
// 1 → 1st, 2 → 2nd, 3 → 3rd, 4..20 → Nth, 21 → 21st, 22 → 22nd, … 111 → 111th.
export function streakOrdinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

// ─── Inspect curl ───────────────────────────────────────────────────────────
// Ready-to-paste line that uses the resolved api_url from the live config —
// NOT a hardcoded localhost:8787, so non-default ports surface correctly.
export function buildInspectCurl(apiUrl: string, bank: string, operationId: string): string {
  return `curl -s ${apiUrl}/v1/default/banks/${bank}/operations/${operationId} | jq`;
}

// ─── Themed render ──────────────────────────────────────────────────────────
// The `theme` parameter only needs an `fg(color, str) => str` method — that's
// the slice of the pi-tui Theme used by all message renderers in this repo.
// Stays portable so tests can pass a passthrough theme and assert on plain text.
export interface MinimalTheme {
  fg(color: string, s: string): string;
}

/**
 * Render the user-facing zero-units-extracted message body.
 *
 * `d` is the message.details payload built by watchRetainOperation. Fields:
 *   - bank, operation_id, op_age_ms, document_id
 *   - pre_units_count, post_units_count, transcript_len
 *   - transcript (capped to 50K in production), error_message, legit_empty
 *   - api_url, consecutive_zero_streak
 *
 * `expanded` toggles the ctrl+o pane (full transcript + curl + full error).
 */
export function renderZeroUnitsMessage(
  d: any,
  expanded: boolean,
  theme: MinimalTheme,
): string {
  const legitEmpty = d?.legit_empty === true;
  const opAgeMs = typeof d?.op_age_ms === "number" ? d.op_age_ms : 0;
  const durSec = (opAgeMs / 1000).toFixed(1);
  const durBucket = durationBucketLabel(opAgeMs);
  const bank = String(d?.bank ?? "");
  const transcriptLen = typeof d?.transcript_len === "number" ? d.transcript_len : 0;
  const opId = String(d?.operation_id ?? "");
  const apiUrl = String(d?.api_url ?? "");
  const preUnits = typeof d?.pre_units_count === "number" ? d.pre_units_count : 0;
  const postUnits = typeof d?.post_units_count === "number" ? d.post_units_count : 0;
  const delta = postUnits - preUnits;
  const streak = typeof d?.consecutive_zero_streak === "number" ? d.consecutive_zero_streak : 0;
  const errMsg = d?.error_message ? String(d.error_message) : "";
  const transcript = typeof d?.transcript === "string" ? d.transcript : "";

  // Header
  let t = legitEmpty
    ? theme.fg("accent", "ℹ Hindsight") + theme.fg("muted", ": 0 facts extracted")
    : theme.fg("warning", "⚠ Hindsight") + theme.fg("muted", " retain completed but added 0 units");
  if (bank) t += theme.fg("dim", ` → ${bank}`);
  t += theme.fg("dim", ` (${durSec}s, ${durBucket})`);
  t += theme.fg("dim", ` [${transcriptLen} chars in]`);

  // Sub-headline
  if (legitEmpty) {
    t += "\n" + theme.fg("dim", "  LLM responded normally — content may simply lack extractable claims.");
  } else {
    t += "\n" + theme.fg("dim", "  Substantial input + LLM error → extraction LLM may be unhealthy.");
    if (errMsg) t += "\n" + theme.fg("dim", `  ${errMsg.slice(0, 300)}`);
  }

  // units line — distinguish "fresh bank, no facts" from "existing data, no delta"
  if (preUnits === 0 && postUnits === 0) {
    t += "\n" + theme.fg("dim", `  units: 0 → 0 (fresh bank, no facts extracted)`);
  } else {
    const sign = delta > 0 ? `+${delta}` : `${delta}`;
    t += "\n" + theme.fg("dim", `  units: ${preUnits} → ${postUnits} (Δ ${sign})`);
  }

  // Streak line — single zeroes are noise; only render when ≥ 2.
  if (streak >= 2 && bank) {
    t += "\n" + theme.fg("dim", `  streak: ${streakOrdinal(streak)} consecutive 0-unit retain to ${bank}`);
  }

  // op_id
  if (opId) {
    t += "\n" + theme.fg("dim", `  op_id: ${opId}`);
  }

  // transcript preview (single-line head)
  t += "\n" + theme.fg("dim", `  input head: ${transcriptHead(transcript)}`);

  // Expanded section: full transcript + curl + (already-shown) error_message.
  if (expanded) {
    if (apiUrl && bank && opId) {
      t += "\n" + theme.fg("dim", `  inspect: ${buildInspectCurl(apiUrl, bank, opId)}`);
    }
    if (transcript) {
      t += "\n" + theme.fg("dim", "  ── full transcript ──");
      t += "\n" + theme.fg("dim", "  " + transcript.split("\n").join("\n  "));
    } else {
      t += "\n" + theme.fg("dim", "  (no transcript captured)");
    }
    if (errMsg) {
      t += "\n" + theme.fg("dim", "  ── full error ──");
      t += "\n" + theme.fg("dim", "  " + errMsg.split("\n").join("\n  "));
    }
  } else {
    t += "\n" + theme.fg("muted", "  (ctrl+o for full transcript + curl command to inspect operation)");
  }

  return t;
}
