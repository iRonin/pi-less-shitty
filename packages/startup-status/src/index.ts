/**
 * startup-status — Prints full release diagnostics at pi startup.
 *
 * Output matches pi core's startup header format for skills/agents.
 * Appears in TUI scrollback after the native header.
 *
 * Standalone: npx tsx scripts/release-check.ts
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { findPiCodingAgentDistFromCaller } from "../../pi-resolve/src/index.ts";

// ── Paths ───────────────────────────────────────────────────────────

const res = findPiCodingAgentDistFromCaller(import.meta.url);
const DIST_DIR = res?.distDir;  // null when pi not found
const AGENT_DIR = join(homedir(), ".pi", "agent");

/**
 * Discover the oh-pi root by scanning the agent settings.json packages array
 * for any entry that ends in /oh-pi/packages/subagents. Returns null if
 * not found — the oh-pi diagnostic section is omitted in that case.
 */
function findOhPiDir(): string | null {
	try {
		const settingsPath = join(AGENT_DIR, "settings.json");
		const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
		const pkgs: string[] = Array.isArray(settings.packages) ? settings.packages : [];
		for (const pkg of pkgs) {
			if (typeof pkg !== "string") continue;
			// Match either trailing /oh-pi/packages/subagents or that path
			// inside a longer string (loaders sometimes prefix with "file:").
			const m = pkg.match(/(.*\/oh-pi)\/packages\/subagents(?:\/?$|\/.*$)/);
			if (m && existsSync(m[1])) return m[1];
		}
	} catch { /* no settings or unreadable — fall through */ }
	return null;
}

const OHPPI_DIR = findOhPiDir();

// ── Helpers ─────────────────────────────────────────────────────────

function safeExec(cmd: string): string {
	try { return execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim(); }
	catch { return "ERROR"; }
}

// ── Runtime patches ─────────────────────────────────────────────────

const PATCHES = [
	{ name: "smart-dequeue",      file: "modes/interactive/interactive-mode.js", marker: "popOneQueuedMessageToEditor" },
	{ name: "queue-emojis",       file: "modes/interactive/interactive-mode.js", marker: "🎯 Steer:" },
	{ name: "model-sort-fix",     file: "core/model-resolver.js",                marker: "a.id.includes(\":\")" },
	{ name: "model-registry-fix", file: "core/model-registry.js",                marker: "this.authStorage.hasAuth(providerName)" },
];

function checkPatches(): Array<{ name: string; ok: boolean; detail: string }> {
	if (!DIST_DIR) {
		return PATCHES.map((patch) => ({ name: patch.name, ok: false, detail: "pi not found" }));
	}
	return PATCHES.map((patch) => {
		const filePath = join(DIST_DIR, patch.file);
		if (!existsSync(filePath)) return { name: patch.name, ok: false, detail: "target missing" };
		const content = readFileSync(filePath, "utf-8");
		return { name: patch.name, ok: content.includes(patch.marker), detail: content.includes(patch.marker) ? "patched" : "NOT patched" };
	});
}

// ── Discover skills ─────────────────────────────────────────────────

function discoverSkillNames(cwd: string): string[] {
	const names = new Set<string>();
	let dir = resolve(cwd);
	const home = homedir();
	for (let i = 0; i < 30; i++) {
		const skillsDir = join(dir, ".pi", "skills");
		if (existsSync(skillsDir)) {
			try {
				for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
					if (entry.isDirectory() && existsSync(join(skillsDir, entry.name, "SKILL.md"))) {
						names.add(entry.name);
					}
				}
			} catch { /* skip */ }
		}
		const parent = dirname(dir);
		if (parent === dir || !dir.startsWith(home)) break;
		dir = parent;
	}
	return Array.from(names).sort();
}

// ── Build report ────────────────────────────────────────────────────

function buildReport(ctx: any): string {
	const lines: string[] = [];

	// ── Version ──────────────────────────────────────────────────
	if (DIST_DIR) {
		const piPkgPath = join(DIST_DIR, "..", "package.json");
		const piVer = safeExec(`node -e "console.log(require('${piPkgPath}').version)"`);
		lines.push(`pi:    ${piVer}`);
	} else {
		lines.push("pi:    NOT FOUND");
	}

	if (OHPPI_DIR) {
		const ohBranch = safeExec(`git -C ${OHPPI_DIR} branch --show-current`);
		const ohAhead = safeExec(`git -C ${OHPPI_DIR} log origin/main..HEAD --oneline 2>/dev/null | wc -l | tr -d ' '`);
		lines.push(`oh-pi: ${ohBranch} (${ohAhead} ahead of origin/main)`);
	}

	// ── Runtime Patches ──────────────────────────────────────────
	const patches = checkPatches();
	const okCount = patches.filter((r) => r.ok).length;
	lines.push(`Runtime Patches: ${okCount}/${patches.length}`);
	for (const r of patches) {
		lines.push(`  ${r.ok ? "✓" : "✗"} ${r.name}: ${r.detail}`);
	}

	// ── Tools ────────────────────────────────────────────────────
	if (ctx) {
		try {
			const allTools = ctx.getAllTools();
			const activeTools = ctx.getActiveTools();
			const toolLines = allTools.map((tool: any) => {
				const isActive = activeTools.includes(tool.name);
				const marker = isActive ? "✓" : "○";
				const source = tool.sourceInfo || "builtin";
				return `${marker} ${tool.name} (${source})`;
			});
			lines.push(`Tools (${allTools.length}):`);
			lines.push(`  ${toolLines.join(", ")}`);
		} catch {
			lines.push("Tools: (unable to retrieve)");
		}
	}

	// ── Packages ─────────────────────────────────────────────────
	if (ctx) {
		try {
			const settingsPath = join(AGENT_DIR, "settings.json");
			const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			const allTools = ctx.getAllTools();
			const activeTools = ctx.getActiveTools();
			const toolMap = new Map<string, any>();
			for (const tool of allTools) {
				const src = (tool as any).sourceInfo || "builtin";
				if (!toolMap.has(src)) toolMap.set(src, []);
				toolMap.get(src).push(tool.name);
			}

			const pkgs = settings.packages || [];
			lines.push(`Packages (${pkgs.length}):`);
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
				const tools = toolMap.get(pkg) || toolMap.get(short);
				if (tools) {
					lines.push(`  ${short} → ${tools.join(", ")}`);
				} else {
					lines.push(`  ${short}`);
				}
			}
		} catch { /* skip */ }
	}

	// ── Agents ───────────────────────────────────────────────────
	const agents: Array<{ name: string; dir: string }> = [];

	function scanDir(dir: string) {
		if (!existsSync(dir)) return;
		try {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				if (entry.isFile() && entry.name.endsWith(".md")) {
					const existing = agents.find(a => a.name === entry.name.replace(/\.md$/, ""));
					if (!existing) {
						agents.push({ name: entry.name.replace(/\.md$/, ""), dir });
					}
				}
			}
		} catch { /* skip */ }
	}

	// Walk CWD ancestors for .pi/agents/ (project-specific)
	let cwd = resolve(ctx.cwd || process.cwd());
	const home = homedir();
	for (let i = 0; i < 30; i++) {
		scanDir(join(cwd, ".pi", "agents"));
		const parent = dirname(cwd);
		if (parent === cwd || !cwd.startsWith(home)) break;
		cwd = parent;
	}

	// Only show builtin/user agents if NO project agents found
	if (agents.length === 0) {
		if (OHPPI_DIR) scanDir(join(OHPPI_DIR, "packages", "subagents", "agents"));
		scanDir(join(AGENT_DIR, "agents"));
	}

	if (agents.length > 0) {
		// Group by directory, sorted by path
		const byDir = new Map<string, string[]>();
		for (const a of agents) {
			if (!byDir.has(a.dir)) byDir.set(a.dir, []);
			byDir.get(a.dir)!.push(a.name);
		}
		const sortedDirs = Array.from(byDir.keys()).sort();
		lines.push(`Agents (${agents.length}):`);
		for (const d of sortedDirs) {
			lines.push(d);
			for (const name of byDir.get(d)!.sort()) {
				lines.push(`- ${name}`);
			}
		}
	} else {
		lines.push("Agents: (none)");
	}

	// ── Skills ───────────────────────────────────────────────────
	if (ctx) {
		const skills = discoverSkillNames(ctx.cwd);
		if (skills.length > 0) {
			lines.push(`Skills (${skills.length}):`);
			lines.push(`  ${skills.join(", ")}`);
		} else {
			lines.push("Skills: (none discovered)");
		}
	}

	// ── System Prompt ────────────────────────────────────────────
	if (ctx) {
		try {
			const prompt = ctx.getSystemPrompt();
			const tokens = Math.ceil(prompt.length / 4);
			lines.push(`System Prompt: ~${tokens.toLocaleString()} tokens (${prompt.length.toLocaleString()} chars)`);
		} catch { /* skip */ }
	}

	// ── Context Usage ────────────────────────────────────────────
	if (ctx) {
		try {
			const usage = ctx.getContextUsage();
			if (usage && usage.tokensLimit) {
				lines.push(`Context: ${usage.tokensUsed?.toLocaleString() ?? "?"} / ${usage.tokensLimit.toLocaleString()}`);
			}
		} catch { /* skip */ }
	}

	lines.push("pi --release-check  or  npx tsx /Users/ironin/Work/Pi-Agent/pi-less-shitty/scripts/release-check.ts");

	return lines.join("\n");
}

// ── Extension entry ─────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// Minimal load-time check
	const patches = checkPatches();
	const failed = patches.filter((r) => !r.ok);
	if (failed.length > 0) {
		console.error(`[startup-status] ⚠️ Patches failed: ${failed.map((r) => r.name).join(", ")}`);
	}

	// Full diagnostics at session_start — prints to console.error.
	// No-op when running outside an interactive UI (e.g. inside a subagent
	// or non-TTY mode); buildReport is expensive and the output would just
	// pollute the parent agent's stderr.
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx?.hasUI || typeof ctx?.ui?.notify !== "function") return;

		const report = buildReport(ctx);
		console.error("\n" + report + "\n");

		if (failed.length > 0) {
			ctx.ui.notify(`⚠️ Runtime patches failed: ${failed.map((f) => f.name).join(", ")}`, "warning");
		}
	});

	// /startup-status — in-session fallback
	pi.registerCommand("startup-status", {
		description: "Show full release diagnostics: patches, tools, agents, skills, context.",
		handler: async (_args, ctx) => {
			const report = buildReport(ctx);
			ctx.ui.setEditorText(report);
			ctx.ui.notify("Release diagnostics generated. See editor.", "info");
		},
	});

	// /release-check — alias
	pi.registerCommand("release-check", {
		description: "Alias for /startup-status.",
		handler: async (_args, ctx) => {
			const report = buildReport(ctx);
			ctx.ui.setEditorText(report);
			ctx.ui.notify("Release diagnostics generated. See editor.", "info");
		},
	});
}
