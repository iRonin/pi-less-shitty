/**
 * autocomplete-base-paths — Runtime patch for multi-directory file autocomplete.
 *
 * Adds `autocompleteBasePaths` setting to `.pi/settings.json`. When set, the
 * TUI's `@` fuzzy file search walks multiple root directories and deduplicates
 * results. Parent `.pi/settings.json` files are discovered by walking up from CWD.
 *
 * Patched files:
 * - `autocomplete.js` — CombinedAutocompleteProvider gets additionalBasePaths
 * - `interactive-mode.js` — parent-walking collection at startup
 * - `settings-manager.js` — getAutocompleteBasePaths() getter
 *
 * Usage in any .pi/settings.json:
 *   { "autocompleteBasePaths": ["/absolute/path/to/project/root"] }
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
	// Fallback: walk up from __dirname through node_modules
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

function findPiTuiDistDir(distDir: string): string | null {
	const candidate = path.join(distDir, "node_modules", "@mariozechner", "pi-tui", "dist");
	if (fs.existsSync(path.join(candidate, "autocomplete.js"))) return candidate;
	// Fallback: check global node_modules
	const globalNode = path.join(distDir, "..", "..", "node_modules", "@mariozechner", "pi-tui", "dist");
	if (fs.existsSync(path.join(globalNode, "autocomplete.js"))) return globalNode;
	return null;
}

// ---------------------------------------------------------------------------
// Patching (applied synchronously at extension load)
// ---------------------------------------------------------------------------

/** Marker strings used to detect if a file is already patched. */
const MARKERS = {
	autocomplete: "additionalBasePaths;",
	interactiveMode: "collectAutocompleteBasePaths",
	settingsManager: "getAutocompleteBasePaths()",
};

/**
 * Patch autocomplete.js to support multiple base paths.
 * - Adds additionalBasePaths field to CombinedAutocompleteProvider
 * - Adds --ignore-case to fd args
 * - Multi-base search with deduplication
 */
function patchAutocompleteJs(tuiDistDir: string): "patched" | "already" | "failed" {
	const filePath = path.join(tuiDistDir, "autocomplete.js");
	let content: string;
	try {
		content = fs.readFileSync(filePath, "utf8");
	} catch {
		return "failed";
	}

	if (content.includes(MARKERS.autocomplete)) return "already";

	// Copy the bundled patched file
	const patchPath = path.join(__dirname, "..", "patches", "autocomplete.js");
	if (fs.existsSync(patchPath)) {
		try {
			fs.copyFileSync(patchPath, filePath);
			return "patched";
		} catch {
			return "failed";
		}
	}

	// No bundled patch file — fail silently
	return "failed";
}

/**
 * Patch interactive-mode.js to walk parent .pi/settings.json for autocompleteBasePaths.
 */
function patchInteractiveModeJs(distDir: string): "patched" | "already" | "failed" {
	const filePath = path.join(distDir, "modes", "interactive", "interactive-mode.js");
	let content: string;
	try {
		content = fs.readFileSync(filePath, "utf8");
	} catch {
		return "failed";
	}

	if (content.includes(MARKERS.interactiveMode)) return "already";

	const patchPath = path.join(__dirname, "..", "patches", "interactive-mode.js");
	if (fs.existsSync(patchPath)) {
		try {
			fs.copyFileSync(patchPath, filePath);
			return "patched";
		} catch {
			return "failed";
		}
	}

	return "failed";
}

/**
 * Patch settings-manager.js to add getAutocompleteBasePaths() getter.
 */
function patchSettingsManagerJs(distDir: string): "patched" | "already" | "failed" {
	const filePath = path.join(distDir, "core", "settings-manager.js");
	let content: string;
	try {
		content = fs.readFileSync(filePath, "utf8");
	} catch {
		return "failed";
	}

	if (content.includes(MARKERS.settingsManager)) return "already";

	const patchPath = path.join(__dirname, "..", "patches", "settings-manager.js");
	if (fs.existsSync(patchPath)) {
		try {
			fs.copyFileSync(patchPath, filePath);
			return "patched";
		} catch {
			return "failed";
		}
	}

	return "failed";
}

// ---------------------------------------------------------------------------
// Session-time safety net
// ---------------------------------------------------------------------------

/**
 * Re-apply patches at session_start in case another process (e.g. npm update)
 * reverted them. Also collects autocompleteBasePaths from parent settings.
 */
async function ensurePatchesOnSessionStart(pi: ExtensionAPI, ctx: any) {
	const distDir = ctx.piInstallDir ?? findPiDistDir();
	if (!distDir) return;

	const tuiDistDir = findPiTuiDistDir(distDir);
	if (tuiDistDir) patchAutocompleteJs(tuiDistDir);
	patchSettingsManagerJs(distDir);
	patchInteractiveModeJs(distDir);
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	const distDir = findPiDistDir();
	const results: string[] = [];

	if (distDir) {
		const tuiDistDir = findPiTuiDistDir(distDir);
		if (tuiDistDir) results.push(`autocomplete.js: ${patchAutocompleteJs(tuiDistDir)}`);
		results.push(`settings-manager.js: ${patchSettingsManagerJs(distDir)}`);
		results.push(`interactive-mode.js: ${patchInteractiveModeJs(distDir)}`);
	}

	// Re-apply on every session start (survives npm update during a running session)
	pi.on("session_start", async (_event, ctx) => {
		await ensurePatchesOnSessionStart(pi, ctx);
	});
}
