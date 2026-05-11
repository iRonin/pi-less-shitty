/**
 * smart-dequeue — Runtime patch for Alt+Up queue retrieval.
 *
 * Behaviour after this patch:
 *   1. Each Alt+Up press pops ONE queued message into the editor (LIFO).
 *   2. Steer queue is exhausted FIRST — no follow-up message comes back
 *      until every steer message has.
 *   3. Within each pool: compaction-queued items (newer in practice) come
 *      back before session-queued items.
 *   4. Non-destructive: if the editor already has content (user typed
 *      something, or a previous Alt+Up popped an item), the popped
 *      message is APPENDED after a blank line. Alt+Up never destroys
 *      what is already in the editor. The ~500 ms rapid-press detector
 *      is retained as a redundant hint but is no longer load-bearing
 *      — the helper checks editor content directly.
 *
 * Patched file:
 *   - `interactive-mode.js`
 *       • `handleDequeue()` body  →  one-pop dispatcher
 *       • `restoreQueuedMessagesToEditor()` body  →  thin wrapper that
 *         delegates to the bulk Smart helper (kept for pi's abort path)
 *       • two helpers added:
 *           - `restoreQueuedMessagesToEditorSmart(options)` (bulk; abort path)
 *           - `popOneQueuedMessageToEditor(options)`        (LIFO pop one)
 *
 * Applied synchronously at extension load and re-checked on every
 * session_start (survives npm update).
 *
 * NOTE: The canonical patcher for this customization is the patch-applier
 * spec at `packages/patch-applier/specs/smart-dequeue.ts`. This runtime
 * extension is the legacy fallback path and is intentionally idempotent —
 * its "already patched" check looks for `popOneQueuedMessageToEditor`, so
 * a dist already patched by patch-applier (which produces the same
 * behavioural form) is left untouched.
 */
import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { findPiCodingAgentDistFromCaller } from "../../pi-resolve/src/index.ts";

// ---------------------------------------------------------------------------
// File resolution
// ---------------------------------------------------------------------------

const PROBE = "modes/interactive/interactive-mode.js";

function findPiDistDir(override?: string): string | null {
	const res = findPiCodingAgentDistFromCaller(import.meta.url, { probe: PROBE, override });
	return res?.distDir ?? null;
}

// ---------------------------------------------------------------------------
// Patches
// ---------------------------------------------------------------------------

const QUICK_PRESS_MS = 500;

// Matches BOTH the upstream pristine handleDequeue() body AND the previous
// bulk-staged version produced by an older copy of this extension. The
// indent capture + lazy `[\s\S]*?` close at the matching method-indent
// brace and prevent runaway matches into adjacent methods.
//
// The discriminator: any handleDequeue body that does NOT yet call
// `popOneQueuedMessageToEditor`. The "already patched" guard above this
// regex ensures we never re-match a file already in the new form.
const OLD_HANDLE_DEQUEUE_RE =
	/(?<indent>[ \t]+)handleDequeue\(\)\s*\{(?:(?!popOneQueuedMessageToEditor)[\s\S])*?\n\k<indent>\}/;

const NEW_HANDLE_DEQUEUE = [
	"    handleDequeue() {",
	"        const now = Date.now();",
	'        const lastPress = typeof this.__smartDequeueLastPress === "number" ? this.__smartDequeueLastPress : 0;',
	"        const append = lastPress > 0 && (now - lastPress) < " + QUICK_PRESS_MS + ";",
	"        this.__smartDequeueLastPress = now;",
	"        const result = this.popOneQueuedMessageToEditor({ append });",
	"        if (!result || !result.popped) {",
	'            this.showStatus("No queued messages to restore");',
	"            return;",
	"        }",
	'        const remStr = result.remaining > 0 ? ` (${result.remaining} remaining)` : "";',
	'        const suffix = append ? " (appended)" : "";',
	"        this.showStatus(`Restored ${result.source} message${suffix}${remStr}`);",
	"    }",
].join("\n");

// Matches the upstream pristine restoreQueuedMessagesToEditor() body.
// Anchored on the unique `clearAllQueues()` destructure call, which the
// patched form removes.
const OLD_RESTORE_RE =
	/(?<indent>[ \t]+)restoreQueuedMessagesToEditor\(options\)\s*\{\s*\n[ \t]+const \{ steering, followUp \} = this\.clearAllQueues\(\);[\s\S]*?\n\k<indent>\}/;

// Replacement: thin wrapper + bulk Smart helper (kept for pi's abort path)
// + new LIFO popOneQueuedMessageToEditor helper. Helper bodies are wrapped
// in try/catch so that if upstream renames internal symbols (queue
// accessors, clearers, …) the patched pi still boots — the helpers just
// no-op with a "no messages" return.
const NEW_RESTORE = [
	"    restoreQueuedMessagesToEditor(options) {",
	"        return this.restoreQueuedMessagesToEditorSmart(options);",
	"    }",
	"    restoreQueuedMessagesToEditorSmart(options) {",
	"        try {",
	"            const session = this.session;",
	'            const sessionSteer = session && typeof session.getSteeringMessages === "function" ? [...session.getSteeringMessages()] : [];',
	'            const sessionFU = session && typeof session.getFollowUpMessages === "function" ? [...session.getFollowUpMessages()] : [];',
	"            const compactionList = Array.isArray(this.compactionQueuedMessages) ? this.compactionQueuedMessages : [];",
	'            const compSteer = compactionList.filter((m) => m && m.mode === "steer").map((m) => m.text);',
	'            const compFU = compactionList.filter((m) => m && m.mode === "followUp").map((m) => m.text);',
	"            const all = [...sessionSteer, ...compSteer, ...sessionFU, ...compFU];",
	'            if (session && typeof session.clearQueue === "function") session.clearQueue();',
	"            this.compactionQueuedMessages = [];",
	"            if (all.length === 0) {",
	'                if (typeof this.updatePendingMessagesDisplay === "function") this.updatePendingMessagesDisplay();',
	"                if (options?.abort) this.agent.abort();",
	"                return 0;",
	"            }",
	'            const queuedText = all.join("\\n\\n");',
	"            const currentText = options?.currentText ?? this.editor.getText();",
	"            const append = options?.append === true;",
	"            const combined = (append && currentText.trim())",
	'                ? [currentText, queuedText].filter((t) => t.trim()).join("\\n\\n")',
	'                : [queuedText, currentText].filter((t) => t.trim()).join("\\n\\n");',
	"            this.editor.setText(combined);",
	'            if (typeof this.updatePendingMessagesDisplay === "function") this.updatePendingMessagesDisplay();',
	"            if (options?.abort) this.agent.abort();",
	"            return all.length;",
	"        }",
	"        catch (e) {",
	"            console.error('[smart-dequeue]', e);",
	"            return 0;",
	"        }",
	"    }",
	"    popOneQueuedMessageToEditor(options) {",
	"        try {",
	"            const append = options?.append === true;",
	"            const session = this.session;",
	'            const sessionSteer = session && typeof session.getSteeringMessages === "function" ? [...session.getSteeringMessages()] : [];',
	'            const sessionFollowUp = session && typeof session.getFollowUpMessages === "function" ? [...session.getFollowUpMessages()] : [];',
	"            const compactionList = Array.isArray(this.compactionQueuedMessages) ? this.compactionQueuedMessages : [];",
	'            const compactionSteer = compactionList.filter((m) => m && m.mode === "steer").map((m) => m.text);',
	'            const compactionFollowUp = compactionList.filter((m) => m && m.mode === "followUp").map((m) => m.text);',
	"            // LIFO pop: steer pool exhausted first; within each pool",
	"            // compaction-queued (newer in practice) precedes session-queued.",
	"            let popped = null;",
	"            let source = null;",
	'            if (compactionSteer.length > 0) { popped = compactionSteer.pop(); source = "steer"; }',
	'            else if (sessionSteer.length > 0) { popped = sessionSteer.pop(); source = "steer"; }',
	'            else if (compactionFollowUp.length > 0) { popped = compactionFollowUp.pop(); source = "follow-up"; }',
	'            else if (sessionFollowUp.length > 0) { popped = sessionFollowUp.pop(); source = "follow-up"; }',
	"            if (popped == null) return { popped: null, source: null, remaining: 0 };",
	"            // Drain pi's queues then re-queue every survivor in original order.",
	'            if (session && typeof session.clearQueue === "function") session.clearQueue();',
	'            if (session && typeof session.steer === "function") {',
	"                for (const text of sessionSteer) void session.steer(text);",
	"            }",
	'            if (session && typeof session.followUp === "function") {',
	"                for (const text of sessionFollowUp) void session.followUp(text);",
	"            }",
	"            const newCompaction = [];",
	'            for (const t of compactionSteer) newCompaction.push({ mode: "steer", text: t });',
	'            for (const t of compactionFollowUp) newCompaction.push({ mode: "followUp", text: t });',
	"            this.compactionQueuedMessages = newCompaction;",
	"            // Non-destructive guard: if the editor already has content,",
	"            // always append after a blank line. Never destroy typed text.",
	"            const currentText = this.editor.getText();",
	"            const newText = currentText.trim().length > 0 ? `${currentText}\\n\\n${popped}` : popped;",
	"            this.editor.setText(newText);",
	'            if (typeof this.updatePendingMessagesDisplay === "function") this.updatePendingMessagesDisplay();',
	"            const remaining = sessionSteer.length + sessionFollowUp.length + compactionSteer.length + compactionFollowUp.length;",
	"            return { popped, source, remaining };",
	"        }",
	"        catch (e) {",
	"            console.error('[smart-dequeue]', e);",
	"            return { popped: null, source: null, remaining: 0 };",
	"        }",
	"    }",
].join("\n");

// ---------------------------------------------------------------------------
// Patching
// ---------------------------------------------------------------------------

export function patchInteractiveModeJs(distDir: string): "patched" | "already" | "failed" {
	const filePath = path.join(distDir, "modes", "interactive", "interactive-mode.js");
	let content: string;
	try {
		content = fs.readFileSync(filePath, "utf8");
	} catch {
		return "failed";
	}

	// Already patched (LIFO form). Detected via the LIFO-only helper name.
	if (content.includes("popOneQueuedMessageToEditor")) return "already";

	if (!OLD_HANDLE_DEQUEUE_RE.test(content)) return "failed";
	content = content.replace(OLD_HANDLE_DEQUEUE_RE, NEW_HANDLE_DEQUEUE);

	if (OLD_RESTORE_RE.test(content)) {
		// Pristine pi: replace the destructured-clearAllQueues body.
		content = content.replace(OLD_RESTORE_RE, NEW_RESTORE);
	} else if (/restoreQueuedMessagesToEditorSmart\s*\(/.test(content)) {
		// Coming from the previous bulk-staged variant: the wrapper +
		// bulk helper are already in place, just need to add the LIFO
		// helper. Inject it as a sibling of the existing
		// restoreQueuedMessagesToEditorSmart method.
		const SMART_METHOD_RE =
			/(?<indent>[ \t]+)restoreQueuedMessagesToEditorSmart\s*\(options\)\s*\{[\s\S]*?\n\k<indent>\}/;
		const m = content.match(SMART_METHOD_RE);
		if (!m) return "failed";
		// Extract just the popOneQueuedMessageToEditor block from NEW_RESTORE.
		const popOneStart = NEW_RESTORE.indexOf("    popOneQueuedMessageToEditor(options) {");
		const popOneBlock = NEW_RESTORE.slice(popOneStart);
		content = content.replace(SMART_METHOD_RE, m[0] + "\n" + popOneBlock);
	} else {
		return "failed";
	}

	try {
		fs.writeFileSync(filePath, content, "utf8");
		return "patched";
	} catch {
		return "failed";
	}
}

// ---------------------------------------------------------------------------
// Session-time safety net
// ---------------------------------------------------------------------------

async function ensurePatchOnSessionStart(ctx: any) {
	const distDir = findPiDistDir(ctx?.piInstallDir);
	if (!distDir) return;
	patchInteractiveModeJs(distDir);
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	const distDir = findPiDistDir();
	const result = distDir ? patchInteractiveModeJs(distDir) : "failed";

	if (result === "patched") {
		console.error("[smart-dequeue] patched interactive-mode.js");
	} else if (result === "already") {
		console.error("[smart-dequeue] already patched");
	} else {
		console.error("[smart-dequeue] FAILED to patch interactive-mode.js");
	}

	// Re-apply on every session start (survives npm update during a running session)
	pi.on("session_start", async (_event, ctx) => {
		await ensurePatchOnSessionStart(ctx);
	});
}
