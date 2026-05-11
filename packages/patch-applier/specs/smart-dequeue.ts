import type { PatchSpec } from "../src/types.js";

/**
 * smart-dequeue — one-at-a-time LIFO Alt+Up dequeue in pi's TUI.
 *
 * Pi's stock dequeue handler (bound to `app.message.dequeue`, fired by Alt+Up)
 * pulls EVERY queued message into the editor in a single press. This patch
 * turns it into a LIFO pop-one-at-a-time loop:
 *
 *   • Each press pops ONE message into the editor.
 *   • Within each queue we pop the newest item first (LIFO).
 *   • The steer queue is exhausted FIRST. Only when there are no more steer
 *     messages do follow-up messages start coming back.
 *   • Compaction-queued messages of the matching mode are popped before
 *     session-queued ones in the same pool (they're newer in practical terms).
 *   • If the editor already has non-empty content when the message is
 *     popped (because the user typed something or already pulled a previous
 *     queue item back), the popped message is APPENDED after a blank line
 *     rather than replacing the existing text. This is the primary
 *     non-destructive guard. A repeat press within ~500 ms is retained as
 *     a redundant trigger for append mode, but is no longer the only path:
 *     the helper must not destroy editor content even on a single slow
 *     press when the editor is non-empty.
 *
 * The patch introduces one durable named hook that the spec verifies against:
 *
 *   - `popOneQueuedMessageToEditor(options)` — pops one queued message
 *     using the LIFO + steer-first ordering described above and returns
 *     `{ popped, source, remaining }` so the dequeue handler can format
 *     a status line. Takes `{ append?: boolean }` to control replace vs
 *     append into the editor.
 *
 * Internal pi symbols used to read/clear individual queues
 * (`getSteeringMessages`, `getFollowUpMessages`, `clearQueue`, `steer`,
 * `followUp`, `compactionQueuedMessages`, `editor`, …) are pi-internal and
 * intentionally NOT pinned by this spec. Upstream may rename them at any
 * time; the agent re-derives the helper body against whatever pi currently
 * exposes. The verify function only asserts the BEHAVIOR contract:
 *   - the named hook exists,
 *   - the dequeue handler delegates to it (and is therefore not the legacy
 *     dump-everything body any more),
 *   - the legacy bulk-staged variant (phase counter + bulk Smart helper
 *     called from the dequeue handler) is GONE,
 *   - the abort-path bulk restore is preserved (it's invoked from pi
 *     internals when the user aborts a streaming response — popping one at
 *     a time would strand the rest in the queue).
 */
export const spec: PatchSpec = {
	id: "smart-dequeue",
	target: "modes/interactive/interactive-mode.js",
	intent:
		"Replace pi's single-shot Alt+Up dequeue with a LIFO pop-one-at-a-time dequeue. " +
		"Each invocation of the handler that pi binds to app.message.dequeue must pop exactly " +
		"ONE queued message into the editor. The pop order is: steer queue first (every steer " +
		"message must come back before the first follow-up message does), within each queue the " +
		"newest-queued item comes back first (LIFO), and within the same mode pool compaction-" +
		"queued messages (whatever shape pi currently uses for those) are popped before session-" +
		"queued ones. CRITICAL non-destructive guard: whenever the editor already has " +
		"non-empty content at pop time (the user typed something OR previously pulled a queue " +
		"item back), the popped message MUST be APPENDED after a blank line rather than " +
		"replacing the existing text — Alt+Up must never destroy what is already in the editor. " +
		"A repeat press within ~500 ms is also retained as a redundant trigger for append mode, " +
		"but it is no longer the only path: a single slow press into a non-empty editor still " +
		"appends. The bulk-restore path that pi calls " +
		"internally on abort (e.g. when the user cancels a streaming response and expects all " +
		"queued messages back in the editor at once) MUST still work — only the interactive " +
		"Alt+Up handler changes its semantics. The patch introduces a single named hook on the " +
		"interactive-mode instance that other code (and the verify function) can rely on: a " +
		"helper method `popOneQueuedMessageToEditor(options)` that takes an optional " +
		"`{ append?: boolean }` discriminator, performs the LIFO pop with steer-first ordering, " +
		"writes the popped message into the editor (replace only when the editor is empty, " +
		"append otherwise), drains-and-re-queues the " +
		"survivors so pi's queue state stays consistent, and returns " +
		"`{ popped, source, remaining }` where `popped` is the popped text or null when the " +
		"queues were empty, `source` is the string `\"steer\"` or `\"follow-up\"`, and " +
		"`remaining` is the total count of messages still queued across both queues. The earlier " +
		"bulk-staged variant of this patch (phase counter `__smartDequeuePhase` plus bulk Smart " +
		"helper called from the dequeue handler) MUST be replaced entirely; both variants must " +
		"not coexist. The patch must NOT pin to, or freeze, any specific upstream symbol names " +
		"for queue storage or per-queue clearing methods — those are pi-internal and may be " +
		"renamed across pi versions; the helper must read whatever the current pi exposes for " +
		"steer messages, follow-up messages, compaction-queued messages, queue clearing, and " +
		"editor text manipulation.",
	hint:
		"Replace the body of the method bound to app.message.dequeue (typically named " +
		"`handleDequeue`) with: a quick-press detector that compares Date.now() against " +
		"`this.__smartDequeueLastPress` and switches to append mode when the gap is < 500 ms, " +
		"a single call to `this.popOneQueuedMessageToEditor({ append })`, and a status update " +
		"that reports what was popped (`steer`/`follow-up`) and how many messages remain. " +
		"NOTE: the helper itself ALSO appends whenever the editor has non-empty content, so the " +
		"handler may pass `append: false` and the helper will still preserve typed text — the " +
		"quick-press flag is a hint, not the sole determinant. " +
		"Add the `popOneQueuedMessageToEditor` helper to the same class. Inside the helper: " +
		"read steer messages, follow-up messages, and the compaction-queued list from whatever " +
		"symbols the current pi exposes (discover them by reading the file — typical names are " +
		"`session.getSteeringMessages()`, `session.getFollowUpMessages()`, " +
		"`this.compactionQueuedMessages`); pop the newest item from the steer pool first " +
		"(compaction-steer before session-steer), falling through to the follow-up pool when " +
		"the steer pool is empty; if nothing was popped return `{ popped: null, source: null, " +
		"remaining: 0 }`; otherwise drain pi's queues (use whatever the current pi exposes — " +
		"`session.clearQueue()` is the usual one) and re-queue every survivor via " +
		"`session.steer(text)` / `session.followUp(text)` (or whatever the current equivalents " +
		"are); rebuild the compaction-queued list from the survivors; insert the popped text " +
		"into `this.editor` (replace by default, append-after-blank-line when `options.append` " +
		"is true OR when the editor's current text is non-empty — never destroy typed text); " +
		"call `this.updatePendingMessagesDisplay()` if it exists so the queue UI " +
		"refreshes; return `{ popped, source, remaining }`. Wrap the helper body in try/catch " +
		"so that if upstream renames internal symbols the helper no-ops returning " +
		"`{ popped: null, source: null, remaining: 0 }` instead of crashing pi. Keep the " +
		"existing bulk-restore plumbing (`restoreQueuedMessagesToEditor` / " +
		"`restoreQueuedMessagesToEditorSmart`) intact because pi's abort path calls it.",
	marker: "popOneQueuedMessageToEditor",

	verify(content: string) {
		const failures: string[] = [];

		// 1. The new LIFO helper must exist AND be referenced from at least
		//    one other site. Pristine pi has 0 hits; a partial patch with
		//    only the helper definition has exactly 1; a fully patched form
		//    has the definition plus the dequeue handler call — at least 2.
		const helperHits = (content.match(/popOneQueuedMessageToEditor/g) ?? []).length;
		if (helperHits === 0) {
			failures.push(
				"Helper 'popOneQueuedMessageToEditor' is missing — LIFO dequeue helper not injected",
			);
		} else if (helperHits < 2) {
			failures.push(
				"Helper 'popOneQueuedMessageToEditor' is defined but never called — LIFO dequeue is not wired into the dequeue handler",
			);
		}

		// 2. The earlier bulk-staged variant MUST be gone. The phase counter
		//    `__smartDequeuePhase` was the marker of that variant; if it's
		//    still in the file the dequeue handler is still doing bulk
		//    per-stage restores instead of one-at-a-time pops.
		if (content.includes("__smartDequeuePhase")) {
			failures.push(
				"Stale bulk-staged variant detected: '__smartDequeuePhase' is still present — " +
				"the previous bulk dequeue body has not been replaced with the LIFO pop-one body",
			);
		}

		// 3. The handler must be expressible as ONE pop per press. We
		//    enforce this structurally rather than syntactically: the
		//    helper must be called from a context where its return value
		//    is destructured or consulted via a `popped`-named binding,
		//    and the helper itself must return a shape that includes the
		//    `popped`/`source`/`remaining` keys. We accept either order
		//    of keys and either string-quoted or shorthand property form.
		const returnsPopShape =
			/popOneQueuedMessageToEditor[\s\S]{0,4000}?(["']?popped["']?)\s*:/.test(content) &&
			/popOneQueuedMessageToEditor[\s\S]{0,4000}?(["']?source["']?)\s*:/.test(content) &&
			/popOneQueuedMessageToEditor[\s\S]{0,4000}?(["']?remaining["']?)\s*:/.test(content);
		if (!returnsPopShape) {
			failures.push(
				"Helper 'popOneQueuedMessageToEditor' does not return the expected shape " +
				"`{ popped, source, remaining }` — the handler can't tell what was popped or " +
				"how many remain",
			);
		}

		// 4. The OLD pristine pi handler called
		//    `this.restoreQueuedMessagesToEditor()` with NO arguments to
		//    restore everything in one go. The patched LIFO handler never
		//    does that; it always goes through `popOneQueuedMessageToEditor`.
		//    Any bare no-arg `this.restoreQueuedMessagesToEditor()` call
		//    means the pristine pi dequeue body is still around (catches
		//    partial patches even when the helper has been added). We do
		//    NOT object to `this.restoreQueuedMessagesToEditor({ … })` —
		//    pi's abort path passes `{ abort: true }` and that wrapper
		//    must keep working.
		if (/\bthis\.restoreQueuedMessagesToEditor\s*\(\s*\)/.test(content)) {
			failures.push(
				"Legacy `this.restoreQueuedMessagesToEditor()` no-arg call still present — " +
				"pristine pi dequeue body has not been replaced",
			);
		}

		// 5. The handler must contain quick-press logic. Without it Alt+Up
		//    in rapid succession would clobber what the user just popped.
		//    The exact constant doesn't matter (we accept anything in
		//    the 200..1000 ms range), but a numeric threshold compared
		//    against a Date.now() delta inside a region near the helper
		//    invocation must exist.
		const handlerRegion = (() => {
			const m = content.match(
				/handleDequeue\s*\([^)]*\)\s*\{([\s\S]{0,2000}?)\n[ \t]+\}/,
			);
			return m ? m[1] : "";
		})();
		const hasQuickPress =
			/Date\.now\s*\(\s*\)/.test(handlerRegion) &&
			/\b[2-9]\d{2}\b|\b1000\b/.test(handlerRegion);
		if (!hasQuickPress) {
			failures.push(
				"Quick-press detection missing from the dequeue handler — rapid Alt+Up presses " +
				"would replace each other; expected a Date.now() delta compared against a " +
				"~500ms threshold to switch to append mode",
			);
		}

		// 6. Non-destructive guard: somewhere in the same file, the helper
		//    must read the current editor text AND write back a value that
		//    contains that current text concatenated with the popped
		//    message. Without this, a future re-derivation could silently
		//    drop the append branch and Alt+Up would clobber typed text —
		//    which is the exact UX bug this spec exists to prevent.
		//    We scope this check to the region from the helper's definition
		//    onward, but use a brace-balanced extraction so nested blocks
		//    don't truncate the body capture. There is only one method
		//    named `popOneQueuedMessageToEditor` in the file (the verify
		//    above checks the name is used at least twice — once defined,
		//    once called — not three times), so this region is unambiguous.
		const helperBody = (() => {
			const sigRe = /popOneQueuedMessageToEditor\s*\([^)]*\)\s*\{/g;
			const m = sigRe.exec(content);
			if (!m) return "";
			let depth = 1;
			let i = m.index + m[0].length;
			const maxScan = Math.min(content.length, i + 12000);
			for (; i < maxScan && depth > 0; i++) {
				const c = content[i];
				if (c === "{") depth++;
				else if (c === "}") depth--;
			}
			return content.slice(m.index + m[0].length, i);
		})();
		if (helperBody) {
			const readsCurrentText = /\.editor\.getText\s*\(\s*\)/.test(helperBody);
			// Look for a blank-line-separated concatenation of two interpolated
			// values (template-literal `${X}\n\n${Y}` form) or a string-concat
			// form X + "\n\n" + Y. Pattern matches whether the result is
			// assigned to a temp variable or inlined into setText().
			const appendsConcat =
				/`\$\{[^}]+\}\\n\\n\$\{[^}]+\}`/.test(helperBody) ||
				/\+\s*["'`]\\n\\n["'`]\s*\+/.test(helperBody);
			const writesEditor = /\.editor\.setText\s*\(/.test(helperBody);
			// The append branch must be reachable from editor-content state
			// alone — NOT gated solely on the rapid-press hint. Otherwise a
			// single slow press into a non-empty editor would destroy typed
			// text. We approximate this by requiring a conditional whose
			// predicate mentions a text-length/trim check that does NOT also
			// mention the rapid-press hint variable (`append`). Concretely:
			// look for any of these forms in the helper body:
			//   currentText.trim()
			//   currentText.length
			//   <some>.trim().length
			// AND require that the FIRST predicate guarding the concat form
			// does NOT have `append` AND'd with a length/trim check. The
			// (append && currentText.length > 0) form is the bug pattern.
			const checksEditorEmptiness =
				/\.trim\s*\(\s*\)(?:\.length)?/.test(helperBody) ||
				/\.length\s*[<>=!]/.test(helperBody) ||
				/\.length\s*===?\s*0/.test(helperBody);
			const bugPattern =
				/\bappend\s*&&\s*[A-Za-z_$][\w$]*\.(?:length|trim)/.test(helperBody);
			if (!readsCurrentText) {
				failures.push(
					"Helper 'popOneQueuedMessageToEditor' never reads the current editor text " +
					"(no `this.editor.getText()` call inside its body) — it cannot append to existing " +
					"content, which means Alt+Up would destroy typed text",
				);
			}
			if (!appendsConcat || !writesEditor) {
				failures.push(
					"Helper 'popOneQueuedMessageToEditor' has no append branch: expected an " +
					"expression concatenating the current editor text with the popped message " +
					"separated by a blank line (e.g. `` `${current}\\n\\n${popped}` `` or " +
					"`current + \"\\n\\n\" + popped`) plus a `this.editor.setText(...)` call to " +
					"write it back. Without this the append branch is missing and Alt+Up would " +
					"destroy typed text",
				);
			}
			if (!checksEditorEmptiness) {
				failures.push(
					"Helper 'popOneQueuedMessageToEditor' has no editor-emptiness check " +
					"(expected a `.trim()` / `.length` predicate that gates the append branch " +
					"on whether the editor already has content) — without this the append branch " +
					"only fires on rapid press, and a single slow press into a non-empty editor " +
					"would destroy typed text",
				);
			}
			if (bugPattern) {
				failures.push(
					"Helper 'popOneQueuedMessageToEditor' gates the append branch on the " +
					"rapid-press hint (`append && X.length` or `append && X.trim` pattern). " +
					"This is the user-reported bug: a single slow press into a non-empty editor " +
					"destroys typed text. The append branch must be reachable from editor " +
					"content alone (e.g. `currentText.trim().length > 0 ? ... : ...`)",
				);
			}
		}

		return failures.length === 0 ? { ok: true } : { ok: false, failures };
	},
};
