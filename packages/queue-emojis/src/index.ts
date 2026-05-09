/**
 * queue-emojis — Runtime patch for steer/follow-up queue display.
 *
 * Adds emojis to the pending-queue status lines in the TUI:
 *   "Steering:"  → "🎯 Steer:"
 *   "Follow-up:" → "📥 Follow-up:"
 *
 * Patched file:
 * - `interactive-mode.js` — `updatePendingMessagesDisplay()` label strings
 *
 * Applied synchronously at extension load and re-checked on every session_start
 * (survives npm update).
 */
import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { findPiCodingAgentDistFromCaller } from "../../pi-resolve/src/index.ts";

// ---------------------------------------------------------------------------
// File resolution — scope-aware (handles @mariozechner ↔ @earendil-works rename)
// ---------------------------------------------------------------------------

const PROBE = "modes/interactive/interactive-mode.js";

function findPiDistDir(override?: string): string | null {
	const res = findPiCodingAgentDistFromCaller(import.meta.url, { probe: PROBE, override });
	return res?.distDir ?? null;
}

// ---------------------------------------------------------------------------
// Patching
// ---------------------------------------------------------------------------

// Match template literals like `Steering: ${message}` / `Follow-up: ${message}`
// where the embedded variable name is captured so a rename (e.g. `msg`) still
// works. Whitespace between the colon and `${...}` is also tolerated.
const REPLACEMENTS: [RegExp, string][] = [
	[/`Steering:\s*\$\{(\w+)\}`/g, "`🎯 Steer: ${$1}`"],
	[/`Follow-up:\s*\$\{(\w+)\}`/g, "`📥 Follow-up: ${$1}`"],
];

export function patchInteractiveModeJs(distDir: string): "patched" | "already" | "failed" {
	const filePath = path.join(distDir, "modes", "interactive", "interactive-mode.js");
	let content: string;
	try {
		content = fs.readFileSync(filePath, "utf8");
	} catch {
		return "failed";
	}

	// Already patched — check for the emoji marker
	if (content.includes("🎯 Steer:")) return "already";

	let patched = content;
	for (const [oldRe, newStr] of REPLACEMENTS) {
		if (oldRe.test(patched)) {
			patched = patched.replace(oldRe, newStr);
		}
	}

	if (patched === content) return "failed"; // nothing matched

	try {
		fs.writeFileSync(filePath, patched, "utf8");
		return "patched";
	} catch {
		return "failed";
	}
}

// ---------------------------------------------------------------------------
// Session-time safety net
// ---------------------------------------------------------------------------

async function ensurePatchOnSessionStart(ctx: any) {
	const distDir = findPiDistDir(ctx.piInstallDir);
	if (!distDir) return;
	patchInteractiveModeJs(distDir);
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	const distDir = findPiDistDir();
	const result = distDir ? patchInteractiveModeJs(distDir) : "failed";

	// Re-apply on every session start (survives npm update during a running session)
	pi.on("session_start", async (_event, ctx) => {
		await ensurePatchOnSessionStart(ctx);
	});
}
