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
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { findPiCodingAgentDistFromCaller, findPiTuiDist } from "../../pi-resolve/src/index.ts";

// ---------------------------------------------------------------------------
// File resolution
// ---------------------------------------------------------------------------

function findPiDistDir(override?: string): string | null {
	const res = findPiCodingAgentDistFromCaller(import.meta.url, {
		probe: "modes/interactive/interactive-mode.js",
		override,
	});
	return res?.distDir ?? null;
}

function findPiTuiDistDir(piDist: string): string | null {
	return findPiTuiDist(piDist, { probe: "components/autocomplete.js" });
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
 * Uses text injection — does NOT replace the entire file.
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

	// 1. Add additionalBasePaths field
	content = content.replace("    fdPath;", "    additionalBasePaths;\n    fdPath;");

	// 2. Add constructor param
	content = content.replace(
		"constructor(commands = [], basePath = process.cwd(), fdPath = null)",
		"constructor(commands = [], basePath = process.cwd(), fdPath = null, additionalBasePaths = [])",
	);

	// 3. Store it
	content = content.replace("this.fdPath = fdPath;", "this.additionalBasePaths = additionalBasePaths;\n        this.fdPath = fdPath;");

	// 4. Multi-base search — inject before walkDirectoryWithFd call
	// 0.70.6 uses resolveScopedFuzzyQuery with fdBaseDir variable
	const oldSearch = '            const entries = await walkDirectoryWithFd(fdBaseDir, this.fdPath, fdQuery, 100, options.signal);\n            if (options.signal.aborted) {\n                return [];\n            }\n            const scoredEntries = entries';
	const newSearch = '            const searchDirs = [fdBaseDir, ...(this.additionalBasePaths || [])];\n            const seenPaths = new Set();\n            const allEntries = [];\n            for (const searchDir of searchDirs) {\n                const entries = await walkDirectoryWithFd(searchDir, this.fdPath, fdQuery, 100, options.signal);\n                if (options.signal.aborted) {\n                    return [];\n                }\n                for (const entry of entries) {\n                    const key = entry.path;\n                    if (!seenPaths.has(key)) {\n                        seenPaths.add(key);\n                        allEntries.push(entry);\n                    }\n                }\n            }\n            const scoredEntries = allEntries';
	content = content.replace(oldSearch, newSearch);

	// 5. Rename entries to allEntries for the scoring/filtering (already done above via scoredEntries = allEntries)
	// No additional changes needed — the scoredEntries variable flows through naturally

	try {
		fs.writeFileSync(filePath, content, "utf8");
		return "patched";
	} catch {
		return "failed";
	}
}

/**
 * Patch interactive-mode.js to walk parent .pi/settings.json for autocompleteBasePaths.
 * Uses text injection — does NOT replace the entire file.
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

	// Find the CombinedAutocompleteProvider constructor call
	const oldCall = "return new CombinedAutocompleteProvider([...slashCommands, ...templateCommands, ...extensionCommands, ...skillCommandList], this.sessionManager.getCwd(), this.fdPath);";
	const idx = content.indexOf(oldCall);
	if (idx === -1) return "failed";

	const collectFn = `        const collectAutocompleteBasePaths = (cwd) => {
            const paths = [];
            const seen = new Set();
            let dir = cwd;
            while (true) {
                const settingsPath = path.join(dir, ".pi", "settings.json");
                try {
                    if (fs.existsSync(settingsPath)) {
                        const content = fs.readFileSync(settingsPath, "utf-8");
                        const parsed = JSON.parse(content);
                        if (Array.isArray(parsed.autocompleteBasePaths)) {
                            for (const p of parsed.autocompleteBasePaths) {
                                const resolved = p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
                                if (!seen.has(resolved)) {
                                    seen.add(resolved);
                                    paths.push(resolved);
                                }
                            }
                        }
                    }
                }
                catch { }
                const parent = path.dirname(dir);
                if (parent === dir) break;
                dir = parent;
            }
            return paths;
        };
        const collectedBasePaths = collectAutocompleteBasePaths(this.sessionManager.getCwd());
`;

	const newCall = "return new CombinedAutocompleteProvider([...slashCommands, ...templateCommands, ...extensionCommands, ...skillCommandList], this.sessionManager.getCwd(), this.fdPath, collectedBasePaths);";

	content = content.slice(0, idx) + collectFn + newCall + content.slice(idx + oldCall.length);

	try {
		fs.writeFileSync(filePath, content, "utf8");
		return "patched";
	} catch {
		return "failed";
	}
}

/**
 * Patch settings-manager.js to add getAutocompleteBasePaths() getter.
 * Uses text injection — does NOT replace the entire file.
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

	// Inject the getter before the closing class brace.
	// Anchor on the last known method that exists across versions.
	const anchor = "    getCodeBlockIndent() {";
	const idx = content.indexOf(anchor);
	if (idx === -1) return "failed";

	// Find the end of the getCodeBlockIndent method (next method or closing brace)
	const afterAnchor = idx + anchor.length;
	const nextMethod = content.indexOf("\n    get", afterAnchor);
	if (nextMethod === -1) return "failed";

	const injection = '\n    getAutocompleteBasePaths() {\n        return this.settings.autocompleteBasePaths ?? [];\n    }';
	content = content.slice(0, nextMethod) + injection + content.slice(nextMethod);

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

/**
 * Re-apply patches at session_start in case another process (e.g. npm update)
 * reverted them. Also collects autocompleteBasePaths from parent settings.
 */
async function ensurePatchesOnSessionStart(pi: ExtensionAPI, ctx: any) {
	const distDir = findPiDistDir(ctx.piInstallDir);
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
