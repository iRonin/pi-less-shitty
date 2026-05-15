import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findPiCodingAgentDistFromCaller } from "../../pi-resolve/src/index.ts";
import { patchMethodBody } from "../src/index.ts";

/**
 * Load the real installed resource-loader.js so the regexes are exercised
 * against actual upstream output.
 */
function loadResourceLoader(): string {
	const res = findPiCodingAgentDistFromCaller(import.meta.url, {
		probe: "core/resource-loader.js",
	});
	if (!res) throw new Error("pi-coding-agent dist not found — install pi first");
	const filePath = path.join(res.distDir, "core", "resource-loader.js");
	return fs.readFileSync(filePath, "utf8");
}

/**
 * Reconstruct the unpatched (upstream) shape so tests pass even if the
 * live dist is already patched in dev. Replaces the cascade method body
 * with the original two-check stub.
 */
function unpatch(content: string): string {
	return content.replace(
		/discoverSystemPromptFile\(\) \{\s*\n\s*\/\/ PATCHED by @ironin\/pi-cascading-system-md[\s\S]*?return undefined;\s*\n\s*\}/,
		`discoverSystemPromptFile() {\n        const projectPath = join(this.cwd, CONFIG_DIR_NAME, "SYSTEM.md");\n        if (existsSync(projectPath)) {\n            return projectPath;\n        }\n        const globalPath = join(this.agentDir, "SYSTEM.md");\n        if (existsSync(globalPath)) {\n            return globalPath;\n        }\n        return undefined;\n    }`,
	);
}

describe("patchMethodBody", () => {
	it("rewrites the legacy two-check stub into the cwd→root walk", () => {
		const original = unpatch(loadResourceLoader());
		const [patched, did] = patchMethodBody(original);
		expect(did).toBe(true);
		expect(patched).toContain("PATCHED by @ironin/pi-cascading-system-md");
		expect(patched).toMatch(/for \(let i = 0; i < 64; i\+\+\) \{/);
		// Still exposes the same method name (so pi's call site keeps working).
		expect(patched).toMatch(/discoverSystemPromptFile\(\) \{\s*\n\s*\/\/ PATCHED/);
		// The legacy two-check body is gone.
		expect(patched).not.toMatch(
			/discoverSystemPromptFile\(\) \{\s*\n\s*const projectPath = join\(this\.cwd, CONFIG_DIR_NAME, "SYSTEM\.md"\);/,
		);
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

/**
 * Faithful copy of the patched discoverSystemPromptFile algorithm,
 * lifted out of the dist so we can exercise it against a temp
 * filesystem. Mirrors what the patcher actually injects.
 */
function discover(cwd: string, agentDir: string): string | undefined {
	const CONFIG_DIR_NAME = ".pi";
	let dir = cwd;
	const root = path.resolve("/");
	for (let i = 0; i < 64; i++) {
		const candidate = path.join(dir, CONFIG_DIR_NAME, "SYSTEM.md");
		if (fs.existsSync(candidate)) return candidate;
		if (dir === root) break;
		const parent = path.resolve(dir, "..");
		if (parent === dir) break;
		dir = parent;
	}
	const globalPath = path.join(agentDir, "SYSTEM.md");
	if (fs.existsSync(globalPath)) return globalPath;
	return undefined;
}

describe("first-match-wins semantics (executable patched output)", () => {
	it("returns the cwd .pi/SYSTEM.md when present (deepest wins)", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cas-sys-cwd-"));
		try {
			const project = path.join(tmp, "root", "work", "proj");
			const agentDir = path.join(tmp, "agent");
			fs.mkdirSync(path.join(project, ".pi"), { recursive: true });
			fs.mkdirSync(path.join(tmp, "root", "work", ".pi"), { recursive: true });
			fs.mkdirSync(path.join(agentDir), { recursive: true });
			fs.writeFileSync(path.join(project, ".pi", "SYSTEM.md"), "project", "utf8");
			fs.writeFileSync(path.join(tmp, "root", "work", ".pi", "SYSTEM.md"), "work", "utf8");
			fs.writeFileSync(path.join(agentDir, "SYSTEM.md"), "agent", "utf8");

			const out = discover(project, agentDir);
			expect(out).toBe(path.join(project, ".pi", "SYSTEM.md"));
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("returns the FIRST ancestor when cwd has no SYSTEM.md", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cas-sys-anc-"));
		try {
			const project = path.join(tmp, "root", "work", "proj");
			const agentDir = path.join(tmp, "agent");
			fs.mkdirSync(project, { recursive: true });
			fs.mkdirSync(path.join(tmp, "root", "work", ".pi"), { recursive: true });
			fs.mkdirSync(path.join(tmp, "root", ".pi"), { recursive: true });
			fs.mkdirSync(agentDir, { recursive: true });
			// Two ancestors carry SYSTEM.md — we expect the closer one to win.
			fs.writeFileSync(path.join(tmp, "root", "work", ".pi", "SYSTEM.md"), "work", "utf8");
			fs.writeFileSync(path.join(tmp, "root", ".pi", "SYSTEM.md"), "root", "utf8");
			fs.writeFileSync(path.join(agentDir, "SYSTEM.md"), "agent", "utf8");

			const out = discover(project, agentDir);
			expect(out).toBe(path.join(tmp, "root", "work", ".pi", "SYSTEM.md"));
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("falls back to agentDir SYSTEM.md when no ancestor has one", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cas-sys-agent-"));
		try {
			const project = path.join(tmp, "root", "work", "proj");
			const agentDir = path.join(tmp, "agent");
			fs.mkdirSync(project, { recursive: true });
			fs.mkdirSync(agentDir, { recursive: true });
			fs.writeFileSync(path.join(agentDir, "SYSTEM.md"), "agent", "utf8");

			const out = discover(project, agentDir);
			expect(out).toBe(path.join(agentDir, "SYSTEM.md"));
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("returns undefined when nothing on disk (built-in base activates)", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cas-sys-none-"));
		try {
			const project = path.join(tmp, "root", "work", "proj");
			const agentDir = path.join(tmp, "agent");
			fs.mkdirSync(project, { recursive: true });
			fs.mkdirSync(agentDir, { recursive: true });

			const out = discover(project, agentDir);
			expect(out).toBeUndefined();
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("cwd === root does not infinite-loop", () => {
		// Use the actual filesystem root as cwd. No .pi/SYSTEM.md will exist
		// there in any sane environment; agentDir is a fresh tmp dir.
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cas-sys-root-"));
		try {
			const agentDir = path.join(tmp, "agent");
			fs.mkdirSync(agentDir, { recursive: true });

			const start = Date.now();
			const out = discover(path.resolve("/"), agentDir);
			const elapsed = Date.now() - start;
			expect(elapsed).toBeLessThan(1000); // sanity: terminates immediately
			// If /.pi/SYSTEM.md happens to exist on the host, accept it; otherwise undefined.
			if (out !== undefined) {
				expect(out).toBe(path.join(path.resolve("/"), ".pi", "SYSTEM.md"));
			} else {
				expect(out).toBeUndefined();
			}
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
});

describe("end-to-end patcher", () => {
	it("patch applies cleanly to a fresh upstream copy", () => {
		const original = unpatch(loadResourceLoader());
		const [patched, did] = patchMethodBody(original);
		expect(did).toBe(true);
		// The new walk loop must be syntactically present.
		expect(patched).toContain('const root = resolve("/");');
		expect(patched).toContain('const candidate = join(dir, CONFIG_DIR_NAME, "SYSTEM.md");');
		// Walk must terminate via parent === dir check.
		expect(patched).toContain("if (parent === dir) break;");
	});

	it("running the patch twice changes nothing the second time", () => {
		const original = unpatch(loadResourceLoader());
		const [once] = patchMethodBody(original);
		const [twice, did] = patchMethodBody(once);
		expect(did).toBe(false);
		expect(twice).toBe(once);
	});
});
