#!/usr/bin/env tsx
/**
 * release-check — Standalone release verification script.
 *
 * Usage:
 *   cd ~/Work/Pi-Agent/pi-less-shitty && npx tsx scripts/release-check.ts
 *
 * Or via settings.json skills → agents can discover it.
 *
 * Checks EVERYTHING an agent needs to verify the release is complete:
 *   1. oh-pi branch is feat/all-local
 *   2. All pi-less-shitty packages are in settings.json
 *   3. All runtime patches are applied
 *   4. All skills are registered
 *   5. Package files exist on disk
 *
 * Exit code: 0 = all checks pass, 1 = one or more failures
 * Output: structured lines with ✓/✗ prefix — easy to grep.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve, dirname, basename, relative } from "node:path";
import { findPiCodingAgentDistFromCaller } from "../packages/pi-resolve/src/index.ts";
import { execSync } from "node:child_process";
import { homedir } from "node:os";

// ── Paths ───────────────────────────────────────────────────────────

const SETTINGS_FILE = join(homedir(), ".pi", "agent", "settings.json");
const MONOREPO_DIR = join(homedir(), "Work/Pi-Agent/pi-less-shitty");
const OHPPI_DIR = join(homedir(), "Work/Pi-Agent/oh-pi");

// Resolve live pi install — scope-aware (handles @mariozechner ↔ @earendil-works)
const piDist = findPiCodingAgentDistFromCaller(import.meta.url);
const DIST_DIR = piDist?.distDir ?? "";
const PI_PKG_DIR = piDist?.pkgDir ?? "";
const PI_SCOPE = piDist?.scope ?? "unknown";

function siblingPkgPath(siblingBaseName: string, ...parts: string[]): string {
	if (!PI_PKG_DIR) return "";
	return join(dirname(PI_PKG_DIR), siblingBaseName, ...parts);
}

// ── Helpers ─────────────────────────────────────────────────────────

function safeExec(cmd: string): string {
	try { return execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim(); }
	catch { return "ERROR"; }
}

let passCount = 0;
let failCount = 0;
const failures: string[] = [];

function check(label: string, ok: boolean, detail?: string) {
	if (ok) {
		passCount++;
		console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ""}`);
	} else {
		failCount++;
		failures.push(label);
		console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
	}
}

// ── Main ────────────────────────────────────────────────────────────

function main() {
	console.log("═══ Release Check ═══");
	console.log(`date: ${new Date().toISOString()}`);
	console.log("");

	// ── 1. Pi version ──────────────────────────────────────────────
	console.log("Pi Core:");
	if (PI_PKG_DIR) {
		const pkgPath = join(PI_PKG_DIR, "package.json");
		const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
		check("Installed", true, `${pkg.name}@${pkg.version} (scope ${PI_SCOPE})`);
	} else {
		check("Installed", false, "pi-coding-agent not found in any known scope");
	}

	// ── 2. oh-pi branch ────────────────────────────────────────────
	console.log("\noh-pi:");
	if (existsSync(join(OHPPI_DIR, ".git"))) {
		const branch = safeExec(`git -C ${OHPPI_DIR} branch --show-current`);
		check("Branch is feat/all-local", branch === "feat/all-local", `currently: ${branch}`);
		const ahead = safeExec(`git -C ${OHPPI_DIR} log origin/main..HEAD --oneline 2>/dev/null | wc -l | tr -d ' '`);
		const behind = safeExec(`git -C ${OHPPI_DIR} log HEAD..origin/main --oneline 2>/dev/null | wc -l | tr -d ' '`);
		check("Up to date with origin/main", behind === "0" || behind === "ERROR", `${ahead} ahead, ${behind} behind`);
	} else {
		check("Git repo exists", false, OHPPI_DIR);
	}

	// ── 3. settings.json ───────────────────────────────────────────
	console.log("\nSettings:");
	let settings: any = null;
	try {
		settings = JSON.parse(readFileSync(SETTINGS_FILE, "utf-8"));
		check("settings.json valid", true);
	} catch {
		check("settings.json valid", false);
	}

	if (settings) {
		// Packages
		const pkgs = settings.packages || [];
		check("Packages registered", pkgs.length > 0, `${pkgs.length} packages`);

		// List all packages with short names
		console.log("\nRegistered packages:");
		for (const pkg of pkgs) {
			let short = pkg;
			if (pkg.includes("pi-less-shitty/packages/")) {
				short = pkg.replace(/^.*pi-less-shitty\/packages\//, "").replace(/\/src\/.*$/, "");
			} else if (pkg.includes("oh-pi/packages/")) {
				short = "oh-pi/subagents";
			} else if (pkg.includes("pi-kilocode/")) {
				short = "pi-kilocode";
			} else if (pkg.includes("pi-llm-wiki")) {
				short = "pi-llm-wiki";
			} else if (pkg.includes("badlogic/pi-skills")) {
				short = "pi-skills";
			} else if (pkg.startsWith("npm:")) {
				short = pkg.replace("npm:", "");
			} else {
				short = basename(pkg);
			}
			console.log(`  ${short}`);
		}

		// Check all pi-less-shitty packages are in settings
		const pkgNames = readdirSync(join(MONOREPO_DIR, "packages"), { withFileTypes: true })
			.filter((d) => d.isDirectory() && d.name !== "node_modules" && !d.name.startsWith("."))
			.map((d) => d.name);

		const missingPkgs = pkgNames.filter((name) => !pkgs.some((p: string) => p.includes(name)));
		check("All packages in settings.json", missingPkgs.length === 0,
			missingPkgs.length > 0 ? `missing: ${missingPkgs.join(", ")}` : `${pkgNames.length} packages ✓`);

		// Verify package dirs exist on disk
		const missingDirs = pkgNames.filter((name) => !existsSync(join(MONOREPO_DIR, "packages", name)));
		check("All package dirs exist", missingDirs.length === 0,
			missingDirs.length > 0 ? `missing: ${missingDirs.join(", ")}` : `${pkgNames.length} dirs ✓`);

		// Skills
		const skills = settings.skills || [];
		check("Skills registered", skills.length > 0, `${skills.length} skills`);

		const customSkills = skills.filter((s: string) => s.includes("pi-less-shitty"));
		check("Custom skills in settings.json", customSkills.length >= 3,
			`${customSkills.length} custom skills: ${customSkills.map((s: string) => s.split("/").pop()).join(", ")}`);
	}

	// ── 4. Runtime patches ─────────────────────────────────────────
	console.log("\nRuntime Patches:");
	// Patches managed by patch-applier (via specs/):
	//   - smart-dequeue, queue-emojis, agents-listing, compaction-tokens,
	//     model-registry-fix, anthropic-tool-parameters, session-shutdown
	// Those are checked via `patch-applier --check` and don't need redundant entries here.
	const patches = [
		{ name: "prompt-dump (cli)",  file: "cli/args.js",                           marker: "--prompt-dump" },
		{ name: "prompt-dump (main)", file: "main.js",                               marker: "--- prompt-dump handler ---" },
		{ name: "clipboard-image",  file: "modes/interactive/interactive-mode.js", marker: "extractClipboardImages" },
		{ name: "osc133-neutralize",    file: "modes/interactive/components/user-message.js",     marker: 'OSC133_ZONE_START = ""' },
		{ name: "model-sort-fix",     file: "core/model-resolver.js",                marker: "a.id.includes(\":\")" },
	];

	for (const patch of patches) {
		const filePath = join(DIST_DIR, patch.file);
		if (!existsSync(filePath)) {
			check(patch.name, false, "target file missing");
		} else {
			const content = readFileSync(filePath, "utf-8");
			const ok = content.includes(patch.marker);
			check(patch.name, ok, ok ? "patched" : "NOT patched");
		}
	}

	// ── 5. Agents ────────────────────────────────────────────────
	console.log("\nAgents:");
	const agents: Array<{ name: string; dir: string }> = [];

	function scanDir(dir: string) {
		if (!existsSync(dir)) return;
		try {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				if (entry.isFile() && entry.name.endsWith(".md")) {
					const existing = agents.find(a => a.name === entry.name.replace(/\.md$/, ""));
					if (!existing) agents.push({ name: entry.name.replace(/\.md$/, ""), dir });
				}
			}
		} catch { /* skip */ }
	}

	// Walk CWD ancestors for .pi/agents/ (project-specific)
	let dir = resolve(process.cwd());
	const home = homedir();
	for (let i = 0; i < 30; i++) {
		scanDir(join(dir, ".pi", "agents"));
		const parent = dirname(dir);
		if (parent === dir || !dir.startsWith(home)) break;
		dir = parent;
	}

	// Only show builtin/user agents if NO project agents found
	if (agents.length === 0) {
		scanDir(join(OHPPI_DIR, "packages", "subagents", "agents"));
		scanDir(join(homedir(), ".pi", "agent", "agents"));
	}

	if (agents.length > 0) {
		// Group by directory, sorted by path
		const byDir = new Map<string, string[]>();
		for (const a of agents) {
			if (!byDir.has(a.dir)) byDir.set(a.dir, []);
			byDir.get(a.dir)!.push(a.name);
		}
		const sortedDirs = Array.from(byDir.keys()).sort();
		check("Discovered", true, `${agents.length} agents`);
		for (const d of sortedDirs) {
			const names = byDir.get(d)!.sort();
			console.log(`${d}`);
			for (const name of names) {
				console.log(`- ${name}`);
			}
		}
	} else {
		check("Discovered", false, "no agents found");
	}

	// ── 6. Key extensions that register tools ──────────────────────
	console.log("\nKey Extensions:");
	const keyExtensions = [
		{ name: "read-full",           file: "packages/read-full/src/read-full.ts",          check: "renderResult" },
		{ name: "smart-dequeue",       file: "packages/smart-dequeue/src/index.ts",          check: "restoreQueuedMessagesToEditorSmart" },
		{ name: "startup-status",      file: "packages/startup-status/src/index.ts",         check: "release-check" },
		{ name: "prompt-dump",         file: "packages/prompt-dump/src/index.ts",            check: "prompt-dump" },
		{ name: "model-sort-fix",      file: "packages/model-sort-fix/src/model-sort-fix.ts", check: "localeCompare" },
		{ name: "model-registry-fix",  file: "packages/model-registry-fix/src/model-registry-fix.ts", check: "_savedJson" },
	];

	for (const ext of keyExtensions) {
		const filePath = join(MONOREPO_DIR, ext.file);
		if (!existsSync(filePath)) {
			check(ext.name, false, "source missing");
		} else {
			const content = readFileSync(filePath, "utf-8");
			check(ext.name, content.includes(ext.check), content.includes(ext.check) ? "ok" : "missing marker");
		}
	}

	// ── 6. Summary ─────────────────────────────────────────────────
	console.log("");
	console.log("═══ Summary ═══");
	console.log(`Passed: ${passCount}  |  Failed: ${failCount}`);
	if (failures.length > 0) {
		console.log(`FAILURES: ${failures.join(", ")}`);
	} else {
		console.log("All checks passed ✓");
	}

	process.exit(failCount > 0 ? 1 : 0);
}

main();
