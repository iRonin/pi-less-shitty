import type { PatchSpec } from "../src/types.js";

/**
 * compaction-tokens — show post-compaction token count in the compaction
 * summary message.
 *
 * The original UI shows only the BEFORE count: "Compacted ${X} tokens" in
 * both an expanded markdown header and a collapsed single-line text. This
 * patch displays both: "Compacted from ${BEFORE} → ${AFTER} tokens", where
 * AFTER is estimated from the summary string length (rough char→token).
 *
 * The exact estimator (e.g. `Math.ceil(summary.length / 4)`) is an
 * implementation detail that pi may change; we only require that the
 * computation is derived from the summary's length and that both UI forms
 * render the resulting value next to the before-count behind an arrow.
 */
export const spec: PatchSpec = {
	id: "compaction-tokens",
	target: "modes/interactive/components/compaction-summary-message.js",
	intent:
		"In the compaction summary message component (the one rendered by `updateDisplay()`), the user-facing text must show BOTH the before-compaction token count AND an after-compaction token count. The after-count is estimated from `this.message.summary.length` (a rough characters-per-token approximation; the exact divisor is unimportant). Both UI forms — the expanded markdown header (bold) AND the collapsed single-line text that ends with an opening parenthesis — must render as `Compacted from <before> → <after> tokens` (with a literal Unicode RIGHTWARDS ARROW '→' between the two counts). The original single-count form `Compacted <before> tokens` must be entirely gone.",
	hint: `Three changes inside updateDisplay():

1. After the existing line that computes the before-string from \`this.message.tokensBefore\`, insert a computation of the after-count derived from \`this.message.summary.length\` (e.g. \`Math.ceil(this.message.summary.length / 4)\`) and a localised string version of it (e.g. \`.toLocaleString()\`).

2. In the expanded branch, find the template literal of the form
   \`**Compacted \${X} tokens**\`
   and rewrite it to
   \`**Compacted from \${X} → \${Y} tokens**\`
   where X is the existing before-variable and Y is the new after-variable.

3. In the collapsed branch, find the template literal of the form
   \`Compacted \${X} tokens (\`
   and rewrite it to
   \`Compacted from \${X} → \${Y} tokens (\`
   with the same X/Y.

Preserve the surrounding code, the variable names already in the file, the indentation, and the trailing parenthesis in the collapsed form. Do not invent variable names beyond the two derived from summary length.`,
	marker: "→ ${",

	verify(content: string) {
		const failures: string[] = [];

		// 1. The after-count computation must be present somewhere in the file.
		//    Durable check: the patch derives the after-count from the summary
		//    string's length. The pristine file never references `.summary.length`
		//    (the summary is only rendered as markdown body), so its presence is
		//    a reliable behavioural marker. We do NOT pin to any specific
		//    estimator (Math.ceil/floor, divisor 4 vs 3.5, etc).
		if (!/\.summary\.length/.test(content)) {
			failures.push(
				"after-count computation missing — expected a reference to `.summary.length` (the after-token estimator) somewhere in the file",
			);
		}

		// 2. Expanded form: bold markdown header with arrow + two interpolations.
		//    Pattern: `**Compacted from ${A} → ${B} tokens**`
		//    Variable names are not pinned.
		const expandedPatched =
			/`\*\*Compacted from \$\{[^}]+\}\s*→\s*\$\{[^}]+\}\s+tokens\*\*/;
		if (!expandedPatched.test(content)) {
			failures.push(
				"expanded-form template literal not patched — expected `**Compacted from ${before} → ${after} tokens**` shape",
			);
		}

		// 3. Collapsed form: plain text with arrow + two interpolations + trailing `(`.
		//    Pattern: `Compacted from ${A} → ${B} tokens (`
		//    The trailing ` (` distinguishes it from the expanded bold form.
		const collapsedPatched =
			/Compacted from \$\{[^}]+\}\s*→\s*\$\{[^}]+\}\s+tokens\s*\(/;
		if (!collapsedPatched.test(content)) {
			failures.push(
				"collapsed-form template literal not patched — expected `Compacted from ${before} → ${after} tokens (` shape",
			);
		}

		// 4. The original single-count form must be gone. In the pristine source
		//    the substring `Compacted ${` appears immediately (no "from " in
		//    between). The patched form always inserts `from ` between the word
		//    "Compacted" and the first interpolation, so this substring is the
		//    cleanest "old form still present" sentinel — and crucially also
		//    catches the partial case where one branch was rewritten but the
		//    other wasn't.
		if (/Compacted \$\{/.test(content)) {
			failures.push(
				"original `Compacted ${...} tokens` template literal still present (partial patch?) — every occurrence must read `Compacted from ${...} → ${...} tokens`",
			);
		}

		return failures.length === 0 ? { ok: true } : { ok: false, failures };
	},
};
