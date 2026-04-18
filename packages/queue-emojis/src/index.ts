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
import os from "node:os";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// ---------------------------------------------------------------------------
// File resolution
// ---------------------------------------------------------------------------

function findPiDistDir(): string | null {
	const candidates = [
		"/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/dist",
		"/usr/local/lib/node_modules/@mariozechner/pi-coding-agent/dist",
	];
	for (const c of candidates) {
		if (fs.existsSync(path.join(c, "modes", "interactive", "interactive-mode.js"))) return c;
	}
	let dir = __dirname;
	for (let i = 0; i < 10; i++) {
		const candidate = path.join(dir, "node_modules", "@mariozechner", "pi-coding-agent", "dist");
		if (fs.existsSync(path.join(candidate, "modes", "interactive", "interactive-mode.js"))) return candidate;
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

// ---------------------------------------------------------------------------
// Patching
// ---------------------------------------------------------------------------

const REPLACEMENTS: [string, string][] = [
	["`Steering: ${message}`", "`🎯 Steer: ${message}`"],
	["`Follow-up: ${message}`", "`📥 Follow-up: ${message}`"],
];

function patchInteractiveModeJs(distDir: string): "patched" | "already" | "failed" {
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
	for (const [oldStr, newStr] of REPLACEMENTS) {
		if (patched.includes(oldStr)) {
			patched = patched.replaceAll(oldStr, newStr);
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
	const distDir = ctx.piInstallDir ?? findPiDistDir();
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
