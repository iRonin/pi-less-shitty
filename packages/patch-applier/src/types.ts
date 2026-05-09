/**
 * Patch spec + verifier contract.
 *
 * Each patch is a triple:
 *   1. SPEC      — durable plain-language description of what the patch does and why
 *   2. VERIFY    — programmatic test that proves the patch is correctly applied
 *                  against whatever the current dist looks like (no anchors, no string
 *                  literals from a specific pi version)
 *   3. APPLIER   — at apply-time, an LLM agent reads the spec + current dist + verify
 *                  test failures, derives the minimal text edits, applies them, and
 *                  the verify test gates correctness.
 *
 * This makes patches survivable across upstream pi refactors because the spec
 * (intent + verification) is durable — the actual text edits are re-derived
 * each time pi changes shape.
 */

export interface PatchSpec {
	/** Stable identifier (e.g. "queue-emojis") — used as filename, log key, marker. */
	id: string;

	/** Path inside pi-coding-agent dist (e.g. "modes/interactive/interactive-mode.js"). */
	target: string;

	/** Plain-language description: what behavior changes, where, why. */
	intent: string;

	/**
	 * Hint for the applier agent — pseudocode or a concrete before/after snippet
	 * showing the *shape* of the change. The applier will adapt it to the actual
	 * dist content. Should not be relied on by the verifier.
	 */
	hint?: string;

	/**
	 * Idempotency check — fast string match used to skip the verify step entirely
	 * when an obvious marker is present. Optional. The verify function is the
	 * authoritative check.
	 */
	marker?: string;

	/**
	 * Programmatic verification. Receives the file content, returns either
	 * { ok: true } or { ok: false, failures: string[] } describing what's wrong.
	 *
	 * MUST be deterministic and fast — runs on every session_start.
	 * MUST verify behavioral intent, not specific text shape (otherwise we're
	 * back to fragile anchors).
	 */
	verify: (content: string) => VerifyResult;
}

export type VerifyResult = { ok: true } | { ok: false; failures: string[] };

export interface ApplyResult {
	specId: string;
	target: string;
	status: "already" | "applied" | "failed";
	message?: string;
	edits?: Array<{ find: string; replace: string }>;
}

export interface ApplierState {
	/** SHA-256 of the (post-patch) dist file. Detects upstream npm-update overwrites. */
	targetHash: string;
	piVersion: string;
	appliedAt: string;
	edits: Array<{ find: string; replace: string }>;
}
