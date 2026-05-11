/**
 * Tests for the smart-dequeue spec (LIFO pop-one variant).
 *
 * Three layers, mirroring applier.test.ts:
 *   1. verify() correctness against synthetic fixtures:
 *      - PRISTINE     (no patch applied)
 *      - PATCHED      (current LIFO form)
 *      - STALE_BULK   (previous bulk-staged form, must now be REJECTED so
 *                      the applier knows to re-derive an upgrade patch)
 *      - PARTIAL      (helper exists but dequeue handler still pristine)
 *      - FUTURE       (pi internals renamed; LIFO contract intact)
 *      - COEXISTING   (queue-emojis + agents-listing patches alongside;
 *                      smart-dequeue verify must stay agnostic)
 *   2. applyOne integration with a mocked deriveEdits — agent simulates
 *      replacing the pristine handler/helper bodies; the file on disk must
 *      end up verifying clean.
 *   3. Upgrade path: applyOne against the STALE_BULK fixture must dispatch
 *      the agent (not be reported as 'already'), simulating the rollout of
 *      the new spec across an existing install.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { test, describe, before, after } from "node:test";

import { applyOne } from "../src/applier.ts";
import { spec as smartDequeueSpec } from "../specs/smart-dequeue.ts";

// ---------------------------------------------------------------------------
// Synthetic fixtures
// ---------------------------------------------------------------------------

/**
 * PRISTINE — bare upstream pi shape. handleDequeue() pulls everything in
 * one shot via the per-queue restorer; restoreQueuedMessagesToEditor()
 * destructures clearAllQueues(); no smart helpers, no phase counter.
 */
const PRISTINE = `
class InteractiveMode {
    handleDequeue() {
        const restored = this.restoreQueuedMessagesToEditor();
        if (restored === 0) {
            this.showStatus("No queued messages to restore");
        }
    }
    clearAllQueues() {
        const { steering, followUp } = this.session.clearQueue();
        const compactionSteering = this.compactionQueuedMessages
            .filter((msg) => msg.mode === "steer")
            .map((msg) => msg.text);
        const compactionFollowUp = this.compactionQueuedMessages
            .filter((msg) => msg.mode === "followUp")
            .map((msg) => msg.text);
        this.compactionQueuedMessages = [];
        return {
            steering: [...steering, ...compactionSteering],
            followUp: [...followUp, ...compactionFollowUp],
        };
    }
    restoreQueuedMessagesToEditor(options) {
        const { steering, followUp } = this.clearAllQueues();
        const all = [...steering, ...followUp];
        if (all.length === 0) {
            this.updatePendingMessagesDisplay();
            return 0;
        }
        this.editor.setText(all.join("\\n\\n"));
        this.updatePendingMessagesDisplay();
        return all.length;
    }
}
`;

const PRISTINE_HANDLE_DEQUEUE_BLOCK = `    handleDequeue() {
        const restored = this.restoreQueuedMessagesToEditor();
        if (restored === 0) {
            this.showStatus("No queued messages to restore");
        }
    }`;

const PRISTINE_RESTORE_BLOCK = `    restoreQueuedMessagesToEditor(options) {
        const { steering, followUp } = this.clearAllQueues();
        const all = [...steering, ...followUp];
        if (all.length === 0) {
            this.updatePendingMessagesDisplay();
            return 0;
        }
        this.editor.setText(all.join("\\n\\n"));
        this.updatePendingMessagesDisplay();
        return all.length;
    }`;

/**
 * PATCHED — the current LIFO pop-one-at-a-time form. handleDequeue() does a
 * quick-press check then delegates to popOneQueuedMessageToEditor; the new
 * helper performs LIFO across steer-pool then follow-up-pool; the abort-path
 * bulk restore is preserved by routing through the existing Smart helper.
 */
const PATCHED_HANDLE_DEQUEUE = `    handleDequeue() {
        const now = Date.now();
        const lastPress = typeof this.__smartDequeueLastPress === "number" ? this.__smartDequeueLastPress : 0;
        const append = lastPress > 0 && (now - lastPress) < 500;
        this.__smartDequeueLastPress = now;
        const result = this.popOneQueuedMessageToEditor({ append });
        if (!result || !result.popped) {
            this.showStatus("No queued messages to restore");
            return;
        }
        const remStr = result.remaining > 0 ? \` (\${result.remaining} remaining)\` : "";
        const suffix = append ? " (appended)" : "";
        this.showStatus(\`Restored \${result.source} message\${suffix}\${remStr}\`);
    }`;

const PATCHED_RESTORE_AND_HELPERS = `    restoreQueuedMessagesToEditor(options) {
        return this.restoreQueuedMessagesToEditorSmart(options);
    }
    restoreQueuedMessagesToEditorSmart(options) {
        // Bulk restore — kept for pi's abort path which expects everything
        // back in the editor at once when the user cancels streaming.
        const sessionSteer = this.session.getSteeringMessages?.() ?? [];
        const sessionFU = this.session.getFollowUpMessages?.() ?? [];
        const compSteer = (this.compactionQueuedMessages ?? []).filter((m) => m && m.mode === "steer").map((m) => m.text);
        const compFU = (this.compactionQueuedMessages ?? []).filter((m) => m && m.mode === "followUp").map((m) => m.text);
        const all = [...sessionSteer, ...compSteer, ...sessionFU, ...compFU];
        if (this.session && typeof this.session.clearQueue === "function") this.session.clearQueue();
        this.compactionQueuedMessages = [];
        if (all.length === 0) {
            this.updatePendingMessagesDisplay();
            return 0;
        }
        this.editor.setText(all.join("\\n\\n"));
        this.updatePendingMessagesDisplay();
        return all.length;
    }
    popOneQueuedMessageToEditor(options) {
        try {
            const append = options?.append === true;
            const session = this.session;
            const sessionSteer = session && typeof session.getSteeringMessages === "function" ? [...session.getSteeringMessages()] : [];
            const sessionFollowUp = session && typeof session.getFollowUpMessages === "function" ? [...session.getFollowUpMessages()] : [];
            const compactionList = Array.isArray(this.compactionQueuedMessages) ? this.compactionQueuedMessages : [];
            const compactionSteer = compactionList.filter((m) => m && m.mode === "steer").map((m) => m.text);
            const compactionFollowUp = compactionList.filter((m) => m && m.mode === "followUp").map((m) => m.text);
            // LIFO: steer pool exhausted first; within each pool compaction-queued
            // (newer in practice) precedes session-queued.
            let popped = null;
            let source = null;
            if (compactionSteer.length > 0) { popped = compactionSteer.pop(); source = "steer"; }
            else if (sessionSteer.length > 0) { popped = sessionSteer.pop(); source = "steer"; }
            else if (compactionFollowUp.length > 0) { popped = compactionFollowUp.pop(); source = "follow-up"; }
            else if (sessionFollowUp.length > 0) { popped = sessionFollowUp.pop(); source = "follow-up"; }
            if (popped == null) return { popped: null, source: null, remaining: 0 };
            // Drain pi's queues then re-queue every survivor in original order.
            if (session && typeof session.clearQueue === "function") session.clearQueue();
            if (session && typeof session.steer === "function") {
                for (const text of sessionSteer) void session.steer(text);
            }
            if (session && typeof session.followUp === "function") {
                for (const text of sessionFollowUp) void session.followUp(text);
            }
            const newCompaction = [];
            for (const t of compactionSteer) newCompaction.push({ mode: "steer", text: t });
            for (const t of compactionFollowUp) newCompaction.push({ mode: "followUp", text: t });
            this.compactionQueuedMessages = newCompaction;
            // Non-destructive guard: if the editor already has content,
            // always append after a blank line. Never destroy typed text.
            const currentText = this.editor.getText();
            const newText = currentText.trim().length > 0 ? \`\${currentText}\\n\\n\${popped}\` : popped;
            this.editor.setText(newText);
            if (typeof this.updatePendingMessagesDisplay === "function") this.updatePendingMessagesDisplay();
            const remaining = sessionSteer.length + sessionFollowUp.length + compactionSteer.length + compactionFollowUp.length;
            return { popped, source, remaining };
        }
        catch (e) {
            console.error("[smart-dequeue]", e);
            return { popped: null, source: null, remaining: 0 };
        }
    }`;

const PATCHED = PRISTINE
	.replace(PRISTINE_HANDLE_DEQUEUE_BLOCK, PATCHED_HANDLE_DEQUEUE)
	.replace(PRISTINE_RESTORE_BLOCK, PATCHED_RESTORE_AND_HELPERS);

/**
 * STALE_BULK — the *previous* shape of this patch (bulk staged dequeue with
 * a phase counter). The new spec must REJECT this so the applier dispatches
 * an agent to upgrade an existing install to the LIFO form.
 */
const STALE_BULK = `
class InteractiveMode {
    handleDequeue() {
        const now = Date.now();
        const elapsed = now - (this.__smartDequeueLastPress || 0);
        this.__smartDequeueLastPress = now;
        const append = elapsed < 500;
        if (this.__smartDequeuePhase === 0) {
            const restored = this.restoreQueuedMessagesToEditorSmart({ type: "steer" });
            if (restored > 0) { this.__smartDequeuePhase = 1; return; }
        }
        if (this.__smartDequeuePhase <= 1) {
            const restored = this.restoreQueuedMessagesToEditorSmart({ type: "followUp" });
            if (restored > 0) { this.__smartDequeuePhase = 2; return; }
        }
        this.__smartDequeuePhase = 0;
        this.restoreQueuedMessagesToEditorSmart({ type: "all" });
    }
    restoreQueuedMessagesToEditor(options) {
        return this.restoreQueuedMessagesToEditorSmart(options);
    }
    restoreQueuedMessagesToEditorSmart(options) {
        return 0;
    }
}
`;

/**
 * PARTIAL — agent crashed half-way: helper got injected but the dequeue
 * handler is still pristine (calls the bare no-arg restorer). Verify must
 * catch this.
 */
const PARTIAL = PRISTINE.replace(
	PRISTINE_RESTORE_BLOCK,
	`${PRISTINE_RESTORE_BLOCK}
    popOneQueuedMessageToEditor(options) {
        // helper exists but is dead code — handleDequeue still bypasses it
        return { popped: null, source: null, remaining: 0 };
    }`,
);

/**
 * FUTURE_REFACTORED_PATCHED — durability claim. A hypothetical future pi
 * has internally renamed the per-queue accessors and clearers:
 *   - `getSteeringMessages()` →  `peekSteeringQueue()`
 *   - `getFollowUpMessages()` →  `peekFollowUpQueue()`
 *   - `clearQueue()`          →  `purgeAllQueues()`
 *   - `steer()`               →  `enqueueSteer()`
 *   - `followUp()`            →  `enqueueFollowUp()`
 *   - `compactionQueuedMessages` →  `pendingCompactionMessages`
 * The agent re-derives the helper body using these new symbols. Our patch's
 * own contract — `popOneQueuedMessageToEditor`, the `{popped,source,remaining}`
 * return shape, the LIFO-with-steer-first ordering, the quick-press append
 * detector — is unchanged. Verify must pass.
 */
const FUTURE_REFACTORED_PATCHED = `
class InteractiveMode {
    handleDequeue() {
        const now = Date.now();
        const lastPress = typeof this.__smartDequeueLastPress === "number" ? this.__smartDequeueLastPress : 0;
        const append = lastPress > 0 && (now - lastPress) < 500;
        this.__smartDequeueLastPress = now;
        const out = this.popOneQueuedMessageToEditor({ append });
        if (!out || !out.popped) {
            this.showStatus("No queued messages to restore");
            return;
        }
        this.showStatus(\`Restored \${out.source} (\${out.remaining} left)\`);
    }
    restoreQueuedMessagesToEditor(options) {
        return this.restoreQueuedMessagesToEditorSmart(options);
    }
    restoreQueuedMessagesToEditorSmart(options) {
        // Bulk: still works on the renamed pi internals.
        const s = this.session.peekSteeringQueue?.() ?? [];
        const fu = this.session.peekFollowUpQueue?.() ?? [];
        const all = [...s, ...fu];
        this.session.purgeAllQueues?.();
        this.pendingCompactionMessages = [];
        if (all.length === 0) return 0;
        this.editor.setText(all.join("\\n\\n"));
        return all.length;
    }
    popOneQueuedMessageToEditor(options) {
        try {
            const append = options?.append === true;
            const session = this.session;
            const ss = [...(session?.peekSteeringQueue?.() ?? [])];
            const fu = [...(session?.peekFollowUpQueue?.() ?? [])];
            const compList = Array.isArray(this.pendingCompactionMessages) ? this.pendingCompactionMessages : [];
            const cs = compList.filter((m) => m && m.mode === "steer").map((m) => m.text);
            const cf = compList.filter((m) => m && m.mode === "followUp").map((m) => m.text);
            let popped = null, source = null;
            if (cs.length > 0) { popped = cs.pop(); source = "steer"; }
            else if (ss.length > 0) { popped = ss.pop(); source = "steer"; }
            else if (cf.length > 0) { popped = cf.pop(); source = "follow-up"; }
            else if (fu.length > 0) { popped = fu.pop(); source = "follow-up"; }
            if (popped == null) return { popped: null, source: null, remaining: 0 };
            session?.purgeAllQueues?.();
            for (const t of ss) session?.enqueueSteer?.(t);
            for (const t of fu) session?.enqueueFollowUp?.(t);
            const np = [];
            for (const t of cs) np.push({ mode: "steer", text: t });
            for (const t of cf) np.push({ mode: "followUp", text: t });
            this.pendingCompactionMessages = np;
            // Non-destructive guard: if the editor already has content,
            // always append. Never destroy typed text.
            const cur = this.editor.getText();
            this.editor.setText(cur.trim().length > 0 ? \`\${cur}\\n\\n\${popped}\` : popped);
            return { popped, source, remaining: ss.length + fu.length + cs.length + cf.length };
        }
        catch (e) {
            return { popped: null, source: null, remaining: 0 };
        }
    }
}
`;

// ---------------------------------------------------------------------------
// 1. verify() correctness
// ---------------------------------------------------------------------------

describe("smart-dequeue spec.verify", () => {
	test("rejects pristine pi (no patch applied)", () => {
		const r = smartDequeueSpec.verify(PRISTINE);
		assert.equal(r.ok, false);
		if (!r.ok) {
			// Should flag missing helper AND the legacy no-arg restorer call.
			assert.ok(
				r.failures.some((f) => /popOneQueuedMessageToEditor/.test(f)),
				"expected failure mentioning the missing LIFO helper",
			);
			assert.ok(
				r.failures.some((f) => /no-arg/.test(f) || /pristine/.test(f)),
				"expected failure mentioning the pristine no-arg dequeue call",
			);
		}
	});

	test("accepts fully patched LIFO form", () => {
		// Sanity: the fixture has the markers we expect to see.
		assert.ok(PATCHED.includes("popOneQueuedMessageToEditor"), "fixture sanity");
		assert.ok(!PATCHED.includes("__smartDequeuePhase"), "fixture sanity");
		assert.ok(!/this\.restoreQueuedMessagesToEditor\(\s*\)/.test(PATCHED), "fixture sanity");

		const r = smartDequeueSpec.verify(PATCHED);
		assert.equal(r.ok, true, !r.ok ? r.failures.join("; ") : undefined);
	});

	test("rejects STALE_BULK — previous bulk-staged variant must trigger an upgrade", () => {
		// Sanity: it has the OLD markers, none of the new ones.
		assert.ok(STALE_BULK.includes("__smartDequeuePhase"), "fixture sanity");
		assert.ok(!STALE_BULK.includes("popOneQueuedMessageToEditor"), "fixture sanity");

		const r = smartDequeueSpec.verify(STALE_BULK);
		assert.equal(r.ok, false);
		if (!r.ok) {
			assert.ok(
				r.failures.some((f) => /popOneQueuedMessageToEditor/.test(f)),
				"expected failure mentioning the missing LIFO helper",
			);
			assert.ok(
				r.failures.some((f) => /__smartDequeuePhase/.test(f) || /bulk-staged/.test(f)),
				"expected failure mentioning the stale bulk-staged variant",
			);
		}
	});

	test("rejects partial patch (helper exists, dequeue handler still pristine)", () => {
		const r = smartDequeueSpec.verify(PARTIAL);
		assert.equal(r.ok, false);
		if (!r.ok) {
			// Helper is referenced exactly once (its own definition); must
			// be flagged as defined-but-not-called.
			assert.ok(
				r.failures.some((f) => /never called|defined but/.test(f)),
				"expected failure mentioning helper-defined-but-not-called",
			);
			// And the legacy pristine no-arg restorer call must still be flagged.
			assert.ok(
				r.failures.some((f) => /no-arg/.test(f) || /pristine/.test(f)),
				"expected failure mentioning the pristine no-arg dequeue call",
			);
		}
	});

	test("accepts a future pi where internal queue symbols were renamed (durability claim)", () => {
		// Sanity: this fixture has NONE of the legacy internal symbol names
		// the spec might be tempted to anchor against — proving the spec
		// is decoupled from them.
		assert.ok(!/_steeringMessages/.test(FUTURE_REFACTORED_PATCHED), "fixture sanity");
		assert.ok(!/getSteeringMessages/.test(FUTURE_REFACTORED_PATCHED), "fixture sanity");
		assert.ok(!/clearAllQueues/.test(FUTURE_REFACTORED_PATCHED), "fixture sanity");
		assert.ok(!/compactionQueuedMessages/.test(FUTURE_REFACTORED_PATCHED), "fixture sanity");
		// But our patch's contract is intact:
		assert.ok(
			FUTURE_REFACTORED_PATCHED.includes("popOneQueuedMessageToEditor"),
			"fixture sanity",
		);
		assert.ok(!/__smartDequeuePhase/.test(FUTURE_REFACTORED_PATCHED), "fixture sanity");

		const r = smartDequeueSpec.verify(FUTURE_REFACTORED_PATCHED);
		assert.equal(r.ok, true, !r.ok ? r.failures.join("; ") : undefined);
	});

	test("agnostic to other patches on the same file (queue-emojis / agents-listing)", () => {
		// Splice in queue-emojis-style template literals and a fake
		// agents-listing marker; smart-dequeue verify must still pass.
		const coexisting =
			PATCHED +
			"\n// other-patches:\n" +
			"const a = `🎯 Steer: ${msg}`;\n" +
			"const b = `📥 Follow-up: ${msg}`;\n" +
			'const agents = "[Agents]";\n';
		const r = smartDequeueSpec.verify(coexisting);
		assert.equal(r.ok, true, !r.ok ? r.failures.join("; ") : undefined);
	});

	// REGRESSION 1: the exact "verbatim user bug" — the helper exists,
	// quick-press detector is wired, append branch is present, but the
	// append branch is GATED on the rapid-press hint. Single slow press
	// into a non-empty editor still destroys typed text. This was the
	// state of the dist BEFORE the May-2026 fix.
	test("rejects patch where append branch is gated on rapid-press hint (slow press destroys typed text)", () => {
		const BUGGY_HELPER = `    popOneQueuedMessageToEditor(options) {
        try {
            const append = options?.append === true;
            const session = this.session;
            const sessionSteer = session && typeof session.getSteeringMessages === "function" ? [...session.getSteeringMessages()] : [];
            const sessionFollowUp = session && typeof session.getFollowUpMessages === "function" ? [...session.getFollowUpMessages()] : [];
            let popped = null;
            let source = null;
            if (sessionSteer.length > 0) { popped = sessionSteer.pop(); source = "steer"; }
            else if (sessionFollowUp.length > 0) { popped = sessionFollowUp.pop(); source = "follow-up"; }
            if (popped == null) return { popped: null, source: null, remaining: 0 };
            const currentText = this.editor.getText();
            // BUG: append only when rapid-press hint is set. Slow press into
            // non-empty editor replaces (destroys typed text).
            if (append && currentText.length > 0) {
                this.editor.setText(\`\${currentText}\\n\\n\${popped}\`);
            }
            else {
                this.editor.setText(popped);
            }
            return { popped, source, remaining: sessionSteer.length + sessionFollowUp.length };
        }
        catch (e) {
            return { popped: null, source: null, remaining: 0 };
        }
    }`;
		const BUGGY = PATCHED.replace(
			/    popOneQueuedMessageToEditor\(options\) \{[\s\S]*?\n    \}/,
			BUGGY_HELPER,
		);
		assert.ok(BUGGY.includes(BUGGY_HELPER), "fixture sanity: helper body replaced");
		const r = smartDequeueSpec.verify(BUGGY);
		assert.equal(r.ok, false);
		if (!r.ok) {
			assert.ok(
				r.failures.some((f) => /rapid-press hint|append && X\.|gates the append/.test(f)),
				`expected failure mentioning the append-gated-on-rapid-press bug pattern; got: ${r.failures.join("; ")}`,
			);
		}
	});

	// REGRESSION 2: helper drops the append branch entirely — silently
	// replaces every time. Verify must reject so a re-derivation that
	// drops the append branch cannot land unnoticed.
	test("rejects regressed patch where helper destroys typed text (always replaces)", () => {
		const REGRESSED_HELPER = `    popOneQueuedMessageToEditor(options) {
        try {
            const session = this.session;
            const sessionSteer = session && typeof session.getSteeringMessages === "function" ? [...session.getSteeringMessages()] : [];
            const sessionFollowUp = session && typeof session.getFollowUpMessages === "function" ? [...session.getFollowUpMessages()] : [];
            let popped = null;
            let source = null;
            if (sessionSteer.length > 0) { popped = sessionSteer.pop(); source = "steer"; }
            else if (sessionFollowUp.length > 0) { popped = sessionFollowUp.pop(); source = "follow-up"; }
            if (popped == null) return { popped: null, source: null, remaining: 0 };
            // BUG: always replaces. No editor text read, no append branch.
            this.editor.setText(popped);
            return { popped, source, remaining: sessionSteer.length + sessionFollowUp.length };
        }
        catch (e) {
            return { popped: null, source: null, remaining: 0 };
        }
    }`;
		const REGRESSED = PATCHED.replace(
			/    popOneQueuedMessageToEditor\(options\) \{[\s\S]*?\n    \}/,
			REGRESSED_HELPER,
		);
		// Sanity: the regressed fixture still has the helper name & quick-press
		// detector, so without the new check verify would falsely pass.
		assert.ok(REGRESSED.includes("popOneQueuedMessageToEditor"), "fixture sanity");
		assert.ok(/Date\.now\(\)/.test(REGRESSED), "fixture sanity");
		assert.ok(REGRESSED.includes(REGRESSED_HELPER), "fixture sanity: helper body actually replaced");
		// The regressed helper itself contains no getText / append concat —
		// that's the bug we want verify to catch.
		assert.ok(!/getText/.test(REGRESSED_HELPER), "fixture sanity: regressed helper has no getText");
		assert.ok(
			!/`\$\{[^}]+\}\\n\\n\$\{[^}]+\}`/.test(REGRESSED_HELPER),
			"fixture sanity: regressed helper has no append concat",
		);

		const r = smartDequeueSpec.verify(REGRESSED);
		assert.equal(r.ok, false);
		if (!r.ok) {
			assert.ok(
				r.failures.some((f) => /never reads the current editor text|append branch is missing|destroy typed text/.test(f)),
				`expected failure mentioning the missing append branch; got: ${r.failures.join("; ")}`,
			);
		}
	});
});

// ---------------------------------------------------------------------------
// 2. Applier integration with mocked deriveEdits
// ---------------------------------------------------------------------------

describe("applyOne(smart-dequeue)", () => {
	let tmpDistDir: string;
	const targetRel = smartDequeueSpec.target;

	before(() => {
		tmpDistDir = fs.mkdtempSync(path.join(os.tmpdir(), "patch-applier-smart-dequeue-"));
		fs.mkdirSync(path.join(tmpDistDir, path.dirname(targetRel)), { recursive: true });
	});

	after(() => {
		fs.rmSync(tmpDistDir, { recursive: true, force: true });
	});

	function writeTarget(content: string) {
		fs.writeFileSync(path.join(tmpDistDir, targetRel), content, "utf8");
	}

	function readTarget(): string {
		return fs.readFileSync(path.join(tmpDistDir, targetRel), "utf8");
	}

	test("returns 'already' when fully patched fixture is in place", async () => {
		writeTarget(PATCHED);
		const result = await applyOne(smartDequeueSpec, {
			distDir: tmpDistDir,
			deriveEdits: async () => {
				throw new Error("should not be called when already patched");
			},
		});
		assert.equal(result.status, "already");
	});

	test("applies edits from a perfect agent against pristine pi and verifies clean", async () => {
		writeTarget(PRISTINE);
		const result = await applyOne(smartDequeueSpec, {
			distDir: tmpDistDir,
			deriveEdits: async (_spec, content) => {
				// Sanity: the agent sees the pristine bodies it needs to replace.
				assert.ok(content.includes(PRISTINE_HANDLE_DEQUEUE_BLOCK), "fixture sanity");
				assert.ok(content.includes(PRISTINE_RESTORE_BLOCK), "fixture sanity");
				return [
					{ find: PRISTINE_HANDLE_DEQUEUE_BLOCK, replace: PATCHED_HANDLE_DEQUEUE },
					{ find: PRISTINE_RESTORE_BLOCK, replace: PATCHED_RESTORE_AND_HELPERS },
				];
			},
		});
		assert.equal(result.status, "applied", result.message);
		// File on disk must verify clean against the spec.
		assert.equal(smartDequeueSpec.verify(readTarget()).ok, true);
	});

	// BEHAVIORAL: load the PATCHED helper body into a real class and
	// exercise the user's bug-report scenario end to end. This is the
	// integration test the previous spec lacked.
	test("helper preserves typed text on a single slow press (user-reported bug, behavioral)", () => {
		// Extract popOneQueuedMessageToEditor body from PATCHED_RESTORE_AND_HELPERS
		// and synthesize a class around it so we can invoke the method.
		const helperMatch = PATCHED_RESTORE_AND_HELPERS.match(
			/popOneQueuedMessageToEditor\(options\)\s*\{[\s\S]*?\n    \}/,
		);
		assert.ok(helperMatch, "fixture sanity: helper body extractable");
		const helperSource = helperMatch![0];
		// Build a minimal class with mocked session/editor and invoke the helper.
		const factory = new Function(
			`return class {
              constructor(session, editor) { this.session = session; this.editor = editor; this.compactionQueuedMessages = []; }
              ${helperSource}
            }`,
		);
		const Cls = factory();
		const makeSession = (steerQueue: string[]) => ({
			_steer: [...steerQueue],
			_fu: [] as string[],
			getSteeringMessages() { return [...this._steer]; },
			getFollowUpMessages() { return [...this._fu]; },
			clearQueue() { this._steer = []; this._fu = []; },
			steer(t: string) { this._steer.push(t); },
			followUp(t: string) { this._fu.push(t); },
		});
		const makeEditor = (initial: string) => ({
			_text: initial,
			getText() { return this._text; },
			setText(t: string) { this._text = t; },
		});

		// Scenario 1: user typed something, then Alt+Up (single slow press,
		// append flag FALSE). Editor MUST still contain the typed text.
		{
			const sess = makeSession(["queued-A"]);
			const ed = makeEditor("user typed this");
			const inst = new Cls(sess, ed);
			const r = inst.popOneQueuedMessageToEditor({ append: false });
			assert.equal(r.popped, "queued-A");
			assert.ok(
				ed._text.includes("user typed this"),
				`SLOW PRESS BUG: editor lost user-typed text. got: ${JSON.stringify(ed._text)}`,
			);
			assert.ok(
				ed._text.includes("queued-A"),
				`editor missing popped message. got: ${JSON.stringify(ed._text)}`,
			);
			assert.equal(ed._text, "user typed this\n\nqueued-A");
		}

		// Scenario 2: empty editor, single press. Popped message replaces
		// the empty content (no destruction since editor was empty).
		{
			const sess = makeSession(["queued-B"]);
			const ed = makeEditor("");
			const inst = new Cls(sess, ed);
			inst.popOneQueuedMessageToEditor({ append: false });
			assert.equal(ed._text, "queued-B");
		}

		// Scenario 3: rapid press (append=true) with content. Appends.
		{
			const sess = makeSession(["queued-C1", "queued-C2"]);
			const ed = makeEditor("");
			const inst = new Cls(sess, ed);
			inst.popOneQueuedMessageToEditor({ append: false });
			assert.equal(ed._text, "queued-C2"); // LIFO: newest first
			inst.popOneQueuedMessageToEditor({ append: true });
			assert.equal(ed._text, "queued-C2\n\nqueued-C1");
		}

		// Scenario 4: whitespace-only editor counts as empty.
		{
			const sess = makeSession(["queued-D"]);
			const ed = makeEditor("   \n  \n");
			const inst = new Cls(sess, ed);
			inst.popOneQueuedMessageToEditor({ append: false });
			assert.equal(ed._text, "queued-D");
		}
	});

	test("dispatches agent (not 'already') when STALE_BULK is in place — upgrade path", async () => {
		writeTarget(STALE_BULK);
		let agentInvoked = false;
		try {
			await applyOne(smartDequeueSpec, {
				distDir: tmpDistDir,
				deriveEdits: async () => {
					agentInvoked = true;
					// Minimal upgrade simulation: hard-replace the whole file
					// with the LIFO patched fixture. We don't need a full,
					// realistic agent here — only that applyOne dispatches
					// rather than short-circuiting on the spec being already
					// applied.
					return [{ find: STALE_BULK, replace: PATCHED }];
				},
			});
		} catch {
			// applyOne may report failure if the simulated upgrade doesn't
			// pass internal validation — that's fine for this test, what
			// matters is that the agent was dispatched.
		}
		assert.equal(agentInvoked, true, "agent must be dispatched when stale variant is in place");
	});
});
