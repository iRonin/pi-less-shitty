/**
 * cascading-append-system — Runtime dist patch.
 *
 * Pi's stock resource-loader (`discoverAppendSystemPromptFile`) only ever
 * loads ONE `APPEND_SYSTEM.md`: project `<cwd>/.pi/APPEND_SYSTEM.md` if it
 * exists, else global `<agentDir>/APPEND_SYSTEM.md`. The intermediate
 * `<ancestor>/.pi/APPEND_SYSTEM.md` files described in our prompt-architecture
 * docs are silently shadowed.
 *
 * This extension patches `core/resource-loader.js` so the discovery cascades:
 * agentDir first, then every ancestor `<dir>/.pi/APPEND_SYSTEM.md` walked
 * from cwd up to root, in root-first order. The order mirrors how
 * `loadProjectContextFiles` already cascades AGENTS.md/CLAUDE.md.
 *
 * The patch is two parts:
 *
 *   1. Inject a new method `discoverAppendSystemPromptFiles()` that returns
 *      the full ordered array, and reduce the legacy
 *      `discoverAppendSystemPromptFile()` to a thin wrapper returning the
 *      first element (for any consumer that still calls the singular API).
 *
 *   2. Rewrite the single call site in `compute()` so it uses the new array
 *      method directly instead of the legacy single-file lookup.
 *
 * Both patches are idempotent (sentinel marker check) and re-applied at
 * session_start so they survive pi upgrades that overwrite the dist.
 */
import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { findPiCodingAgentDistFromCaller } from "../../pi-resolve/src/index.ts";

const PATCH_MARKER = "PATCHED by @ironin/pi-cascading-append-system";

function findPiDistDir(override?: string): string | null {
	const res = findPiCodingAgentDistFromCaller(import.meta.url, {
		probe: "core/resource-loader.js",
		override,
	});
	return res?.distDir ?? null;
}

// ── Patch 1: method body ────────────────────────────────────────────────
//
// We replace the body of `discoverAppendSystemPromptFile()` so it delegates
// to a new `discoverAppendSystemPromptFiles()` method (returns array). Both
// methods share the same signature shape pi's loader already uses; the only
// new symbol is the plural method, which is added immediately after.

const LEGACY_BODY_RE =
	/discoverAppendSystemPromptFile\(\) \{\s*\n\s*const projectPath = join\(this\.cwd, CONFIG_DIR_NAME, "APPEND_SYSTEM\.md"\);\s*\n\s*if \(existsSync\(projectPath\)\) \{\s*\n\s*return projectPath;\s*\n\s*\}\s*\n\s*const globalPath = join\(this\.agentDir, "APPEND_SYSTEM\.md"\);\s*\n\s*if \(existsSync\(globalPath\)\) \{\s*\n\s*return globalPath;\s*\n\s*\}\s*\n\s*return undefined;\s*\n\s*\}/;

const NEW_METHODS =
	`discoverAppendSystemPromptFile() {\n` +
	`        // ${PATCH_MARKER} — back-compat wrapper around the cascade\n` +
	`        const all = this.discoverAppendSystemPromptFiles();\n` +
	`        return all.length > 0 ? all[0] : undefined;\n` +
	`    }\n` +
	`    discoverAppendSystemPromptFiles() {\n` +
	`        // ${PATCH_MARKER} — cascades agentDir + cwd → root in root-first order\n` +
	`        const results = [];\n` +
	`        const seen = new Set();\n` +
	`        const globalPath = join(this.agentDir, "APPEND_SYSTEM.md");\n` +
	`        if (existsSync(globalPath)) {\n` +
	`            results.push(globalPath);\n` +
	`            seen.add(globalPath);\n` +
	`        }\n` +
	`        const ancestors = [];\n` +
	`        let dir = this.cwd;\n` +
	`        const root = resolve("/");\n` +
	`        for (let i = 0; i < 64; i++) {\n` +
	`            const candidate = join(dir, CONFIG_DIR_NAME, "APPEND_SYSTEM.md");\n` +
	`            if (existsSync(candidate) && !seen.has(candidate)) {\n` +
	`                ancestors.unshift(candidate);\n` +
	`                seen.add(candidate);\n` +
	`            }\n` +
	`            if (dir === root) break;\n` +
	`            const parent = resolve(dir, "..");\n` +
	`            if (parent === dir) break;\n` +
	`            dir = parent;\n` +
	`        }\n` +
	`        results.push(...ancestors);\n` +
	`        return results;\n` +
	`    }`;

export function patchMethodBody(content: string): [string, boolean] {
	if (content.includes(PATCH_MARKER)) return [content, false]; // already patched
	if (!LEGACY_BODY_RE.test(content)) return [content, false];
	return [content.replace(LEGACY_BODY_RE, NEW_METHODS), true];
}

// ── Patch 2: call site ───────────────────────────────────────────────────
//
// Rewrite the use site so it consumes the new array method directly. The
// original line constructs a one-element array (or empty) from the singular
// method — we replace that with the plural method call.

const LEGACY_CALL_RE =
	/const appendSources = this\.appendSystemPromptSource \?\?\s*\n\s*\(this\.discoverAppendSystemPromptFile\(\) \? \[this\.discoverAppendSystemPromptFile\(\)\] : \[\]\);/;

const NEW_CALL =
	`const appendSources = this.appendSystemPromptSource ?? this.discoverAppendSystemPromptFiles(); // ${PATCH_MARKER}`;

export function patchCallSite(content: string): [string, boolean] {
	if (content.includes(`${PATCH_MARKER} — call site`)) return [content, false];
	// Idempotency: if the patched call already exists with the cascade marker, skip.
	if (content.includes("this.discoverAppendSystemPromptFiles(); //")) return [content, false];
	if (!LEGACY_CALL_RE.test(content)) return [content, false];
	return [content.replace(LEGACY_CALL_RE, NEW_CALL), true];
}

// ── Driver ──────────────────────────────────────────────────────────────

function patchResourceLoader(distDir: string): { applied: string[]; skipped: boolean } {
	const filePath = path.join(distDir, "core", "resource-loader.js");
	let original: string;
	try {
		original = fs.readFileSync(filePath, "utf8");
	} catch {
		return { applied: [], skipped: true };
	}

	let next = original;
	const applied: string[] = [];

	const [a, didA] = patchMethodBody(next);
	next = a;
	if (didA) applied.push("method-body");

	const [b, didB] = patchCallSite(next);
	next = b;
	if (didB) applied.push("call-site");

	if (next === original) return { applied, skipped: false };

	try {
		fs.writeFileSync(filePath, next, "utf8");
	} catch {
		return { applied: [], skipped: true };
	}
	return { applied, skipped: false };
}

// ── Extension entry ─────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	const distDir = findPiDistDir();
	if (distDir) {
		const r = patchResourceLoader(distDir);
		if (r.applied.length > 0) {
			console.error(`[cascading-append-system] patched ✓ (${r.applied.join(", ")})`);
		} else if (!r.skipped) {
			// already patched — silent
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		const sessionDistDir = findPiDistDir(ctx.piInstallDir);
		if (sessionDistDir) {
			patchResourceLoader(sessionDistDir);
		}
	});
}
