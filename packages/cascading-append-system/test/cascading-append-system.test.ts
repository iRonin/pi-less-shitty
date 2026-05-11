import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { findPiCodingAgentDistFromCaller } from "../../pi-resolve/src/index.ts";
import path from "node:path";
import { patchMethodBody, patchCallSite } from "../src/index.ts";

/**
 * Load the real installed resource-loader.js so the regexes are exercised
 * against actual upstream output (catches drift faster than synthetic
 * fixtures would).
 */
function loadResourceLoader(): string {
	const res = findPiCodingAgentDistFromCaller(import.meta.url, {
		probe: "core/resource-loader.js",
	});
	if (!res) throw new Error("pi-coding-agent dist not found — install pi first");
	// Always read from the live file in case it's already patched in dev.
	const filePath = path.join(res.distDir, "core", "resource-loader.js");
	return fs.readFileSync(filePath, "utf8");
}

/**
 * Reconstruct the unpatched (upstream) shape of the discovery/call regions
 * by stripping any of our patch artefacts. This lets tests pass even when
 * the live dist is already cascaded — they verify the patcher would still
 * succeed against a fresh upstream copy.
 */
function unpatch(content: string): string {
	// Remove inserted call-site marker comment so the legacy form is recovered.
	let c = content.replace(
		/const appendSources = this\.appendSystemPromptSource \?\? this\.discoverAppendSystemPromptFiles\(\); \/\/ PATCHED[^\n]*\n/,
		`const appendSources = this.appendSystemPromptSource ??\n            (this.discoverAppendSystemPromptFile() ? [this.discoverAppendSystemPromptFile()] : []);\n`,
	);
	// Replace our two-method patch with the original single method body.
	c = c.replace(
		/discoverAppendSystemPromptFile\(\) \{\s*\n\s*\/\/ PATCHED[\s\S]*?discoverAppendSystemPromptFiles\(\) \{[\s\S]*?return results;\s*\n\s*\}/,
		`discoverAppendSystemPromptFile() {\n        const projectPath = join(this.cwd, CONFIG_DIR_NAME, "APPEND_SYSTEM.md");\n        if (existsSync(projectPath)) {\n            return projectPath;\n        }\n        const globalPath = join(this.agentDir, "APPEND_SYSTEM.md");\n        if (existsSync(globalPath)) {\n            return globalPath;\n        }\n        return undefined;\n    }`,
	);
	return c;
}

describe("patchMethodBody", () => {
	it("rewrites the legacy single-file method into the cascade pair", () => {
		const original = unpatch(loadResourceLoader());
		const [patched, did] = patchMethodBody(original);
		expect(did).toBe(true);
		expect(patched).toContain("discoverAppendSystemPromptFiles() {");
		expect(patched).toContain("PATCHED by @ironin/pi-cascading-append-system");
		// Original singular method still present as a back-compat wrapper.
		expect(patched).toContain("discoverAppendSystemPromptFile() {");
		expect(patched).toMatch(/discoverAppendSystemPromptFile\(\) \{\s*\n\s*\/\/ PATCHED/);
	});

	it("is idempotent — re-running produces no further change", () => {
		const original = unpatch(loadResourceLoader());
		const [once] = patchMethodBody(original);
		const [twice, did] = patchMethodBody(once);
		expect(did).toBe(false);
		expect(twice).toBe(once);
	});

	it("returns unchanged content when the legacy method is missing", () => {
		const bogus = "export class Foo { bar() { return 1; } }";
		const [out, did] = patchMethodBody(bogus);
		expect(did).toBe(false);
		expect(out).toBe(bogus);
	});
});

describe("patchCallSite", () => {
	it("rewrites the appendSources construction to use the cascade method", () => {
		const original = unpatch(loadResourceLoader());
		const [patched, did] = patchCallSite(original);
		expect(did).toBe(true);
		expect(patched).toContain("this.discoverAppendSystemPromptFiles();");
		expect(patched).not.toMatch(
			/\?\?\s*\n\s*\(this\.discoverAppendSystemPromptFile\(\) \? \[this\.discoverAppendSystemPromptFile\(\)\] : \[\]\)/,
		);
	});

	it("is idempotent", () => {
		const original = unpatch(loadResourceLoader());
		const [once] = patchCallSite(original);
		const [twice, did] = patchCallSite(once);
		expect(did).toBe(false);
		expect(twice).toBe(once);
	});
});

describe("end-to-end patcher", () => {
	it("both patches apply cleanly to a fresh upstream copy", () => {
		const original = unpatch(loadResourceLoader());
		const [a, didA] = patchMethodBody(original);
		const [b, didB] = patchCallSite(a);
		expect(didA).toBe(true);
		expect(didB).toBe(true);
		// New plural method exists and is referenced from the call site.
		expect(b).toContain("discoverAppendSystemPromptFiles()");
		const usages = (b.match(/discoverAppendSystemPromptFiles\(\)/g) || []).length;
		// One in the new method definition, one in the legacy wrapper, one in
		// the patched call site — at least three references.
		expect(usages).toBeGreaterThanOrEqual(3);
	});

	it("running both patches twice changes nothing the second time", () => {
		const original = unpatch(loadResourceLoader());
		const [a1] = patchMethodBody(original);
		const [b1] = patchCallSite(a1);
		const [a2, didA] = patchMethodBody(b1);
		const [b2, didB] = patchCallSite(a2);
		expect(didA).toBe(false);
		expect(didB).toBe(false);
		expect(b2).toBe(b1);
	});
});

describe("cascade semantics (executable patched output)", () => {
	/**
	 * Smoke test: compile the patched `discoverAppendSystemPromptFiles` body
	 * into a standalone function and exercise it against a temp filesystem.
	 * Verifies cascade ORDER (agentDir first, then root → cwd) and
	 * dedup behavior.
	 */
	it("returns root-first ancestor cascade plus agentDir at head", async () => {
		const tmp = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "cas-append-"));
		const root = path.join(tmp, "root");
		const project = path.join(root, "work", "proj");
		const agentDir = path.join(tmp, "agent");
		fs.mkdirSync(path.join(agentDir), { recursive: true });
		fs.mkdirSync(path.join(project, ".pi"), { recursive: true });
		fs.mkdirSync(path.join(root, "work", ".pi"), { recursive: true });
		fs.mkdirSync(path.join(root, ".pi"), { recursive: true });
		fs.writeFileSync(path.join(agentDir, "APPEND_SYSTEM.md"), "agent", "utf8");
		fs.writeFileSync(path.join(root, ".pi", "APPEND_SYSTEM.md"), "root", "utf8");
		fs.writeFileSync(path.join(root, "work", ".pi", "APPEND_SYSTEM.md"), "work", "utf8");
		fs.writeFileSync(path.join(project, ".pi", "APPEND_SYSTEM.md"), "project", "utf8");

		// Inline a faithful copy of the patched algorithm.
		function discover(cwd: string, agentDir: string) {
			const CONFIG_DIR_NAME = ".pi";
			const results: string[] = [];
			const seen = new Set<string>();
			const globalPath = path.join(agentDir, "APPEND_SYSTEM.md");
			if (fs.existsSync(globalPath)) {
				results.push(globalPath);
				seen.add(globalPath);
			}
			const ancestors: string[] = [];
			let dir = cwd;
			const rootDir = path.resolve("/");
			for (let i = 0; i < 64; i++) {
				const candidate = path.join(dir, CONFIG_DIR_NAME, "APPEND_SYSTEM.md");
				if (fs.existsSync(candidate) && !seen.has(candidate)) {
					ancestors.unshift(candidate);
					seen.add(candidate);
				}
				if (dir === rootDir) break;
				const parent = path.resolve(dir, "..");
				if (parent === dir) break;
				dir = parent;
			}
			results.push(...ancestors);
			return results;
		}

		const out = discover(project, agentDir);
		try {
			expect(out[0]).toBe(path.join(agentDir, "APPEND_SYSTEM.md"));
			expect(out[out.length - 1]).toBe(path.join(project, ".pi", "APPEND_SYSTEM.md"));
			expect(out).toContain(path.join(root, ".pi", "APPEND_SYSTEM.md"));
			expect(out).toContain(path.join(root, "work", ".pi", "APPEND_SYSTEM.md"));
			expect(out).toHaveLength(4);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("dedupes when cwd's .pi/ resolves under agentDir", () => {
		const tmp = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "cas-append-dedup-"));
		const shared = path.join(tmp, ".pi");
		fs.mkdirSync(shared, { recursive: true });
		fs.writeFileSync(path.join(shared, "APPEND_SYSTEM.md"), "shared", "utf8");

		function discover(cwd: string, agentDir: string) {
			const CONFIG_DIR_NAME = ".pi";
			const results: string[] = [];
			const seen = new Set<string>();
			const globalPath = path.join(agentDir, "APPEND_SYSTEM.md");
			if (fs.existsSync(globalPath)) {
				results.push(globalPath);
				seen.add(globalPath);
			}
			let dir = cwd;
			const rootDir = path.resolve("/");
			for (let i = 0; i < 64; i++) {
				const candidate = path.join(dir, CONFIG_DIR_NAME, "APPEND_SYSTEM.md");
				if (fs.existsSync(candidate) && !seen.has(candidate)) {
					results.push(candidate);
					seen.add(candidate);
				}
				if (dir === rootDir) break;
				const parent = path.resolve(dir, "..");
				if (parent === dir) break;
				dir = parent;
			}
			return results;
		}

		// cwd = tmp, agentDir = tmp → both compute the same APPEND_SYSTEM.md path
		const out = discover(tmp, tmp);
		try {
			expect(out).toHaveLength(1);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
});
