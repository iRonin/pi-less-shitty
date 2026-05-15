/**
 * cascading-system-md — Runtime dist patch.
 *
 * Pi's stock resource-loader (`discoverSystemPromptFile`) only ever checks
 * two locations: `<cwd>/.pi/SYSTEM.md` and `<agentDir>/SYSTEM.md`. Any
 * `<ancestor>/.pi/SYSTEM.md` between cwd and root is invisible.
 *
 * Concrete bug: a legal specialist SYSTEM.md placed at
 * `<legal-root>/.pi/SYSTEM.md` is silently ignored when pi starts from
 * a deeper working subfolder (`<legal-root>/<case>/<phase>/`), and pi
 * falls back to the built-in coding-agent base prompt.
 *
 * Unlike APPEND_SYSTEM.md (additive cascade), SYSTEM.md is REPLACEMENT
 * semantics — pi loads exactly one file. So the patch is first-match-wins:
 * walk cwd → root for `.pi/SYSTEM.md`, then fall back to agentDir, then
 * return undefined (so pi's loader activates the built-in base).
 *
 * The patch is idempotent (sentinel marker check) and re-applied at
 * session_start so it survives pi upgrades that overwrite the dist.
 */
import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { findPiCodingAgentDistFromCaller } from "../../pi-resolve/src/index.ts";

const PATCH_MARKER = "PATCHED by @ironin/pi-cascading-system-md";

function findPiDistDir(override?: string): string | null {
	const res = findPiCodingAgentDistFromCaller(import.meta.url, {
		probe: "core/resource-loader.js",
		override,
	});
	return res?.distDir ?? null;
}

// ── Patch: replace the method body ──────────────────────────────────────
//
// Stock body checks `<cwd>/.pi/SYSTEM.md` then `<agentDir>/SYSTEM.md`.
// Patched body walks cwd → root for `.pi/SYSTEM.md` (first-match wins),
// then falls back to `<agentDir>/SYSTEM.md`, then returns undefined.

const LEGACY_BODY_RE =
	/discoverSystemPromptFile\(\) \{\s*\n\s*const projectPath = join\(this\.cwd, CONFIG_DIR_NAME, "SYSTEM\.md"\);\s*\n\s*if \(existsSync\(projectPath\)\) \{\s*\n\s*return projectPath;\s*\n\s*\}\s*\n\s*const globalPath = join\(this\.agentDir, "SYSTEM\.md"\);\s*\n\s*if \(existsSync\(globalPath\)\) \{\s*\n\s*return globalPath;\s*\n\s*\}\s*\n\s*return undefined;\s*\n\s*\}/;

const NEW_METHOD =
	`discoverSystemPromptFile() {\n` +
	`        // ${PATCH_MARKER} — walks cwd → root for .pi/SYSTEM.md (first-match wins), then agentDir fallback\n` +
	`        let dir = this.cwd;\n` +
	`        const root = resolve("/");\n` +
	`        for (let i = 0; i < 64; i++) {\n` +
	`            const candidate = join(dir, CONFIG_DIR_NAME, "SYSTEM.md");\n` +
	`            if (existsSync(candidate)) return candidate;\n` +
	`            if (dir === root) break;\n` +
	`            const parent = resolve(dir, "..");\n` +
	`            if (parent === dir) break;\n` +
	`            dir = parent;\n` +
	`        }\n` +
	`        const globalPath = join(this.agentDir, "SYSTEM.md");\n` +
	`        if (existsSync(globalPath)) return globalPath;\n` +
	`        return undefined;\n` +
	`    }`;

export function patchMethodBody(content: string): [string, boolean] {
	if (content.includes(PATCH_MARKER)) return [content, false]; // already patched
	if (!LEGACY_BODY_RE.test(content)) return [content, false];
	return [content.replace(LEGACY_BODY_RE, NEW_METHOD), true];
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

	const [next, did] = patchMethodBody(original);
	if (!did || next === original) return { applied: [], skipped: false };

	try {
		fs.writeFileSync(filePath, next, "utf8");
	} catch {
		return { applied: [], skipped: true };
	}
	return { applied: ["method-body"], skipped: false };
}

// ── Extension entry ─────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	const distDir = findPiDistDir();
	if (distDir) {
		const r = patchResourceLoader(distDir);
		if (r.applied.length > 0) {
			console.error(`[cascading-system-md] patched ✓ (${r.applied.join(", ")})`);
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		const sessionDistDir = findPiDistDir(ctx.piInstallDir);
		if (sessionDistDir) {
			patchResourceLoader(sessionDistDir);
		}
	});
}
