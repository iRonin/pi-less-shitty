import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Guards against false-positive writes when main.js lacks the listModels anchor,
 * and validates that the patch installs all four CLI flags + copies the runtime.
 */

describe("prompt-dump patchMainJs", () => {
	let tmpDir: string;
	let distDir: string;
	let mainPath: string;
	let argsPath: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-dump-test-"));
		distDir = path.join(tmpDir, "dist");
		fs.mkdirSync(path.join(distDir, "cli"), { recursive: true });
		mainPath = path.join(distDir, "main.js");
		argsPath = path.join(distDir, "cli", "args.js");
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	async function loadModule() {
		vi.resetModules();
		return await import("../src/index.ts");
	}

	function stubArgsJs() {
		// Minimal args.js stub containing the anchor line our patcher targets.
		fs.writeFileSync(
			argsPath,
			'export function parseArgs(args) {\n' +
			'  const result = {};\n' +
			'  for (let i = 0; i < args.length; i++) {\n' +
			'    const arg = args[i];\n' +
			'    if (false) {}\n' +
			'        else if (arg === "--offline") {\n' +
			'            result.offline = true;\n' +
			'        }\n' +
			'        else if (arg.startsWith("@")) {}\n' +
			'  }\n' +
			'  return result;\n' +
			'}\n',
			"utf8",
		);
	}

	function stubMainJsWithAnchor() {
		const original =
			'console.log("pre");\n' +
			'    if (parsed.listModels !== undefined) {\n' +
			'        const searchPattern = typeof parsed.listModels === "string" ? parsed.listModels : undefined;\n' +
			'        await listModels(modelRegistry, searchPattern);\n' +
			'        process.exit(0);\n' +
			'    }\n' +
			'    // Read piped stdin content\n' +
			'console.log("post");\n';
		fs.writeFileSync(mainPath, original, "utf8");
		return original;
	}

	it("returns without writing when listBlock anchor is missing", async () => {
		const original = '// stub main.js — no listModels block here\nconsole.log("hello");\n';
		fs.writeFileSync(mainPath, original, "utf8");
		stubArgsJs();

		const mod = await loadModule();
		let sessionHandler: any;
		const fakePi: any = { on: (evt: string, cb: any) => { if (evt === "session_start") sessionHandler = cb; } };
		mod.default(fakePi);

		const before = fs.readFileSync(mainPath, "utf8");
		await sessionHandler({}, { piInstallDir: distDir });
		const after = fs.readFileSync(mainPath, "utf8");

		expect(after).toBe(before);
		expect(after).toBe(original);
	});

	it("patches main.js + args.js + copies runtime when anchor present", async () => {
		stubMainJsWithAnchor();
		stubArgsJs();

		const mod = await loadModule();
		let sessionHandler: any;
		const fakePi: any = { on: (evt: string, cb: any) => { if (evt === "session_start") sessionHandler = cb; } };
		mod.default(fakePi);
		await sessionHandler({}, { piInstallDir: distDir });

		// main.js patched with wrapper + dynamic import
		const mainAfter = fs.readFileSync(mainPath, "utf8");
		expect(mainAfter).toContain("// --- prompt-dump handler ---");
		expect(mainAfter).toContain("// --- end prompt-dump handler ---");
		expect(mainAfter).toContain('await import("./_prompt-dump-runtime.js")');
		expect(mainAfter).toContain("parsed.promptDump");
		expect(mainAfter).toContain("parsed.promptDumpDry");
		expect(mainAfter).toContain("parsed.promptDumpJson");
		expect(mainAfter).toContain("parsed.promptDumpSection");

		// args.js patched with all four flags
		const argsAfter = fs.readFileSync(argsPath, "utf8");
		expect(argsAfter).toContain('arg === "--prompt-dump"');
		expect(argsAfter).toContain('arg === "--prompt-dump-dry"');
		expect(argsAfter).toContain('arg === "--prompt-dump-json"');
		expect(argsAfter).toContain('arg === "--prompt-dump-section"');
		expect(argsAfter).toContain("result.promptDumpSection = args[++i]");

		// runtime copied next to main.js
		const runtimeDest = path.join(distDir, "_prompt-dump-runtime.js");
		expect(fs.existsSync(runtimeDest)).toBe(true);
		expect(fs.readFileSync(runtimeDest, "utf8")).toContain("export async function runPromptDump");
	});

	it("is idempotent — re-running session_start does not duplicate the handler", async () => {
		stubMainJsWithAnchor();
		stubArgsJs();

		const mod = await loadModule();
		let sessionHandler: any;
		const fakePi: any = { on: (evt: string, cb: any) => { if (evt === "session_start") sessionHandler = cb; } };
		mod.default(fakePi);
		await sessionHandler({}, { piInstallDir: distDir });
		const first = fs.readFileSync(mainPath, "utf8");
		await sessionHandler({}, { piInstallDir: distDir });
		const second = fs.readFileSync(mainPath, "utf8");

		expect(second).toBe(first);
		// Exactly one handler block in the file
		// Exactly one open + one close marker in the file (no duplicates).
		const opens = (first.match(/\/\/ --- prompt-dump handler ---/g) || []).length;
		const closes = (first.match(/\/\/ --- end prompt-dump handler ---/g) || []).length;
		expect(opens).toBe(1);
		expect(closes).toBe(1);
	});
});
