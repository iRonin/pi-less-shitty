import type { PatchSpec } from "../src/types.js";

/**
 * queue-emojis — adds visual emoji prefixes to pi's pending-message queue
 * status lines, so the user can distinguish steered vs follow-up messages
 * at a glance.
 *
 * Two label rewrites:
 *   "Steering: <message>"   →  "🎯 Steer: <message>"
 *   "Follow-up: <message>"  →  "📥 Follow-up: <message>"
 *
 * The labels are rendered from template literals inside `interactive-mode.js`
 * (the function that builds the pending-messages display). The variable name
 * holding the message text varies between pi versions — the spec is invariant
 * to that.
 */
export const spec: PatchSpec = {
	id: "queue-emojis",
	target: "modes/interactive/interactive-mode.js",
	intent:
		"In the pending-messages queue display, prepend '🎯 Steer: ' to lines currently labeled 'Steering: ' and prepend '📥 Follow-up: ' to lines currently labeled 'Follow-up: '. The message-content interpolation must be preserved unchanged.",
	hint: `Find template literals shaped like \`Steering: \${X}\` and \`Follow-up: \${X}\` (X is some variable name). Rewrite them to \`🎯 Steer: \${X}\` and \`📥 Follow-up: \${X}\` respectively. Preserve the variable name and template-literal syntax. Do not change anything else.`,
	marker: "🎯 Steer:",

	verify(content: string) {
		const failures: string[] = [];

		// 1. Idempotency markers must both be present
		if (!content.includes("🎯 Steer:")) {
			failures.push("Missing '🎯 Steer:' marker — Steering label not patched");
		}
		if (!content.includes("📥 Follow-up:")) {
			failures.push("Missing '📥 Follow-up:' marker — Follow-up label not patched");
		}

		// 2. Original "Steering: ${...}" template literal must be gone (else
		//    the patch is partial and the original ugly label still ships).
		//    NB: we only forbid the template-literal form, not the prose word
		//    "Steering" (which may appear in unrelated contexts).
		const originalSteering = /`Steering:\s*\$\{[^}]+\}`/;
		const originalFollowup = /`Follow-up:\s*\$\{[^}]+\}`/;
		if (originalSteering.test(content)) {
			failures.push("Original `Steering: ${...}` template literal still present");
		}
		if (originalFollowup.test(content)) {
			failures.push("Original `Follow-up: ${...}` template literal still present");
		}

		// 3. The new template literals must each preserve a variable interpolation
		//    (we don't pin the name, only that there IS one — proves the message
		//    body wasn't accidentally hardcoded).
		const newSteering = /`🎯 Steer:\s*\$\{(\w+)\}`/;
		const newFollowup = /`📥 Follow-up:\s*\$\{(\w+)\}`/;
		if (!newSteering.test(content)) {
			failures.push(
				"Patched '🎯 Steer:' template literal missing or has no variable interpolation",
			);
		}
		if (!newFollowup.test(content)) {
			failures.push(
				"Patched '📥 Follow-up:' template literal missing or has no variable interpolation",
			);
		}

		return failures.length === 0 ? { ok: true } : { ok: false, failures };
	},
};
