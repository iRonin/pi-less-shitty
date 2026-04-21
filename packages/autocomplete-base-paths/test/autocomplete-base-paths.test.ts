import assert from "node:assert";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

// ---------------------------------------------------------------------------
// Helper: write file ensuring parent dirs exist
// ---------------------------------------------------------------------------

function writeFile(filePath: string, content: string) {
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, content);
}

// ---------------------------------------------------------------------------
// Replicate the parent-walking logic from the extension
// ---------------------------------------------------------------------------

function collectAutocompleteBasePaths(cwd: string): string[] {
	const paths: string[] = [];
	const seen = new Set<string>();
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
		} catch { /* ignore parse errors */ }
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return paths;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("collectAutocompleteBasePaths", () => {
	let rootDir: string;

	beforeEach(() => {
		rootDir = mkdtempSync(join(tmpdir(), "pi-acbp-test-"));
	});

	afterEach(() => {
		rmSync(rootDir, { recursive: true, force: true });
	});

	it("finds autocompleteBasePaths from parent .pi/settings.json", () => {
		const cwd = join(rootDir, "deep", "sub", "dir");
		mkdirSync(cwd, { recursive: true });

		writeFile(join(rootDir, ".pi", "settings.json"), JSON.stringify({
			autocompleteBasePaths: [rootDir],
		}));

		const result = collectAutocompleteBasePaths(cwd);
		assert.deepStrictEqual(result, [rootDir]);
	});

	it("collects from multiple parent .pi/settings.json files", () => {
		const cwd = join(rootDir, "project", "packages", "sub");
		mkdirSync(cwd, { recursive: true });

		writeFile(join(rootDir, "project", ".pi", "settings.json"), JSON.stringify({
			autocompleteBasePaths: [join(rootDir, "project")],
		}));

		writeFile(join(rootDir, ".pi", "settings.json"), JSON.stringify({
			autocompleteBasePaths: [rootDir],
		}));

		const result = collectAutocompleteBasePaths(cwd);
		// CWD-first walk: project (closest parent) then root
		assert.deepStrictEqual(result, [join(rootDir, "project"), rootDir]);
	});

	it("deduplicates the same path found in multiple settings", () => {
		const cwd = join(rootDir, "sub");
		mkdirSync(cwd, { recursive: true });

		writeFile(join(rootDir, ".pi", "settings.json"), JSON.stringify({
			autocompleteBasePaths: [rootDir],
		}));

		writeFile(join(rootDir, "sub", ".pi", "settings.json"), JSON.stringify({
			autocompleteBasePaths: [rootDir], // same path
		}));

		const result = collectAutocompleteBasePaths(cwd);
		assert.strictEqual(result.length, 1, "should deduplicate");
		assert.deepStrictEqual(result, [rootDir]);
	});

	it("expands ~ paths", () => {
		const cwd = join(rootDir, "sub");
		mkdirSync(cwd, { recursive: true });

		writeFile(join(rootDir, ".pi", "settings.json"), JSON.stringify({
			autocompleteBasePaths: ["~/Documents"],
		}));

		const result = collectAutocompleteBasePaths(cwd);
		assert.deepStrictEqual(result, [join(os.homedir(), "Documents")]);
	});

	it("returns empty array when no settings found", () => {
		const cwd = join(rootDir, "nowhere");
		mkdirSync(cwd, { recursive: true });

		const result = collectAutocompleteBasePaths(cwd);
		assert.deepStrictEqual(result, []);
	});

	it("returns empty array when setting key is absent", () => {
		const cwd = join(rootDir, "sub");
		mkdirSync(cwd, { recursive: true });

		writeFile(join(rootDir, ".pi", "settings.json"), JSON.stringify({
			theme: "dark",
		}));

		const result = collectAutocompleteBasePaths(cwd);
		assert.deepStrictEqual(result, []);
	});

	it("handles malformed .pi/settings.json gracefully", () => {
		const cwd = join(rootDir, "sub");
		mkdirSync(cwd, { recursive: true });

		writeFile(join(rootDir, ".pi", "settings.json"), "{ bad json }");

		const result = collectAutocompleteBasePaths(cwd);
		assert.deepStrictEqual(result, []);
	});

	it("handles paths with spaces", () => {
		const spaceDir = join(rootDir, "My Legal Project", "RA Claim", "Payment Appeal");
		const basePath = join(rootDir, "My Legal Project");
		mkdirSync(spaceDir, { recursive: true });

		writeFile(join(basePath, ".pi", "settings.json"), JSON.stringify({
			autocompleteBasePaths: [basePath],
		}));

		const result = collectAutocompleteBasePaths(spaceDir);
		assert.deepStrictEqual(result, [basePath]);
	});

	it("skips non-parent .pi/settings.json (sibling directories)", () => {
		const cwd = join(rootDir, "project-a", "sub");
		const sibling = join(rootDir, "project-b");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(sibling, { recursive: true });

		writeFile(join(sibling, ".pi", "settings.json"), JSON.stringify({
			autocompleteBasePaths: [sibling],
		}));

		const result = collectAutocompleteBasePaths(cwd);
		assert.deepStrictEqual(result, [], "should not find sibling's settings");
	});
});

// ---------------------------------------------------------------------------
// Integration: fd-based fuzzy search with multiple base paths
// ---------------------------------------------------------------------------

const resolveFdPath = (): string | null => {
	const command = process.platform === "win32" ? "where" : "which";
	const result = spawnSync(command, ["fd"], { encoding: "utf-8" });
	if (result.status !== 0 || !result.stdout) return null;
	return result.stdout.split(/\r?\n/).find(Boolean)?.trim() ?? null;
};

const fdPath = resolveFdPath();

describe("fd fuzzy search with spaces and case-insensitive", { skip: !fdPath }, () => {
	let rootDir: string;

	beforeEach(() => {
		rootDir = mkdtempSync(join(tmpdir(), "pi-acbp-fd-"));
	});

	afterEach(() => {
		rmSync(rootDir, { recursive: true, force: true });
	});

	it("finds files across base paths with case-insensitive matching", () => {
		const cwd = join(rootDir, "project", "deep", "nested");
		const baseDir = rootDir;
		mkdirSync(cwd, { recursive: true });

		writeFile(join(baseDir, "ECSC CPR 2023.md"), "content");
		writeFile(join(cwd, "local.txt"), "local");

		writeFile(join(baseDir, ".pi", "settings.json"), JSON.stringify({
			autocompleteBasePaths: [baseDir],
		}));

		const collectedPaths = collectAutocompleteBasePaths(cwd);
		assert.ok(collectedPaths.includes(baseDir), "should collect base path");

		// Run fd against the collected base paths
		const results: string[] = [];
		for (const basePath of [cwd, ...collectedPaths]) {
			const out = spawnSync(fdPath!, [
				"--base-directory", basePath,
				"--max-results", "20",
				"--type", "f", "--type", "d",
				"--full-path", "--hidden", "--ignore-case",
				"--exclude", ".git", "cpr",
			], { encoding: "utf-8" });

			if (out.stdout) {
				for (const line of out.stdout.trim().split("\n").filter(Boolean)) {
					const absolute = join(basePath, line);
					results.push(absolute);
				}
			}
		}

		const found = results.some(r => r.includes("ECSC CPR 2023.md"));
		assert.ok(found, "should find ECSC CPR 2023.md with case-insensitive @cpr");
	});

	it("prioritizes files closer to search root (proximity bonus)", () => {
		const baseDir = join(rootDir, "project");
		const deepDir = join(baseDir, "deep", "nested", "folder");
		mkdirSync(deepDir, { recursive: true });

		// Create files at different depths
		writeFile(join(baseDir, "config.json"), "root");
		writeFile(join(baseDir, "deep", "config.json"), "depth1");
		writeFile(join(deepDir, "config.json"), "depth3");

		writeFile(join(baseDir, ".pi", "settings.json"), JSON.stringify({
			autocompleteBasePaths: [baseDir],
		}));

		const collectedPaths = collectAutocompleteBasePaths(deepDir);
		assert.ok(collectedPaths.includes(baseDir), "should collect base path from parent");

		const out = spawnSync(fdPath!, [
			"--base-directory", baseDir,
			"--max-results", "20",
			"--type", "f",
			"--full-path", "--ignore-case",
			"--exclude", ".git",
			"config",
		], { encoding: "utf-8" });

		assert.ok(out.stdout.includes("config.json"), "should find config.json files");
		// The proximity bonus is applied in buildFuzzySuggestions (scoring layer),
		// not in fd itself — this test just confirms fd finds all depth levels
	});

	it("fuzzy-matches file with spaces via @ECSCCPR (no spaces in query)", () => {
		const spaceDir = join(rootDir, "My Project With Spaces", "Sub Dir");
		const baseDir = join(rootDir, "My Project With Spaces");
		mkdirSync(spaceDir, { recursive: true });

		writeFile(join(baseDir, "ECSC CPR 2023.md"), "content");
		writeFile(join(baseDir, "ECSC Rules.pdf"), "content");
		writeFile(join(baseDir, "random.txt"), "content");

		writeFile(join(baseDir, ".pi", "settings.json"), JSON.stringify({
			autocompleteBasePaths: [baseDir],
		}));

		const collectedPaths = collectAutocompleteBasePaths(spaceDir);
		assert.ok(collectedPaths.includes(baseDir));

		// Simulate what buildFdQueryRegex does: E.*C.*S.*C.*C.*P.*R
		const fuzzyPattern = "ECSCCPR".split("").map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");

		const out = spawnSync(fdPath!, [
			"--base-directory", baseDir,
			"--max-results", "20",
			"--type", "f",
			"--full-path", "--ignore-case", "--regex",
			"--exclude", ".git",
			fuzzyPattern,
		], { encoding: "utf-8" });

		assert.ok(out.stdout.includes("ECSC CPR 2023.md"), "should fuzzy-match ECSC CPR 2023.md with @ECSCCPR");
		assert.ok(!out.stdout.includes("random.txt"), "should NOT match unrelated files");
	});

	it("handles spaces in paths", () => {
		const spaceDir = join(rootDir, "My Project With Spaces", "Sub Dir");
		const baseDir = join(rootDir, "My Project With Spaces");
		mkdirSync(spaceDir, { recursive: true });

		writeFile(join(baseDir, "ECSC CPR 2023.md"), "content");

		writeFile(join(baseDir, ".pi", "settings.json"), JSON.stringify({
			autocompleteBasePaths: [baseDir],
		}));

		const collectedPaths = collectAutocompleteBasePaths(spaceDir);
		assert.ok(collectedPaths.includes(baseDir));

		const out = spawnSync(fdPath!, [
			"--base-directory", baseDir,
			"--max-results", "5",
			"--type", "f",
			"--full-path", "--ignore-case",
			"ecsc",
		], { encoding: "utf-8" });

		assert.ok(out.stdout.includes("ECSC CPR 2023.md"), "should find file with spaces in parent dir");
	});
});
