/**
 * agents-listing — Runtime patch to show discovered agents in pi's startup
 * header alongside Skills, Prompts, Extensions. Supports ctrl+o expand.
 *
 * Patched file: interactive-mode.js → showLoadedResources()
 *
 * Implementation note: Uses oh-pi's discoverAgents() to find actual agent
 * definitions (with name/description frontmatter), NOT pi's getAgentsFiles()
 * which returns context files (CLAUDE.md, AGENTS.md).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { findPiCodingAgentDistFromCaller } from "../../pi-resolve/src/index.ts";

/**
 * Resolve all agent directories pi should consider beyond the cwd-walk-up:
 *   1. ~/.pi/agent/agents/ (user-global)
 *   2. <each path-based package>/agents/ — covers oh-pi's bundled agents
 *      (~/Work/Pi-Agent/oh-pi/packages/subagents/agents/) and any other
 *      extension that ships agents alongside its source.
 * The cwd walk-up is done at runtime; THIS list is baked into the patch at
 * extension-load time. Re-runs at each session_start so a newly-added package
 * picks up next session.
 */
function resolveAdditionalAgentDirs(): string[] {
	const dirs: string[] = [];
	const home = os.homedir();
	dirs.push(path.join(home, ".pi", "agent", "agents"));

	try {
		const settingsPath = path.join(home, ".pi", "agent", "settings.json");
		const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
		for (const entry of settings.packages || []) {
			if (typeof entry !== "string") continue;
			// Skip non-local refs — we only want local paths that may have a sibling agents/ dir.
			if (entry.startsWith("npm:") || entry.startsWith("http") || entry.startsWith("github:") || entry.startsWith("git:")) continue;
			const agentsDir = path.join(entry, "agents");
			if (fs.existsSync(agentsDir) && fs.statSync(agentsDir).isDirectory()) {
				dirs.push(agentsDir);
			}
		}
	} catch {
		/* settings.json missing or invalid — skip */
	}

	// Dedupe
	return [...new Set(dirs)].filter((d) => fs.existsSync(d));
}

const PROBE = "modes/interactive/interactive-mode.js";

function findPiDistDir(override?: string): string | null {
	const res = findPiCodingAgentDistFromCaller(import.meta.url, { probe: PROBE, override });
	return res?.distDir ?? null;
}

const PATCH_MARKER = "// --- agents-listing patch ---";

function patchInteractiveModeJs(distDir: string): "patched" | "already" | "failed" {
	const filePath = path.join(distDir, "modes", "interactive", "interactive-mode.js");
	let content: string;
	try {
		content = fs.readFileSync(filePath, "utf8");
	} catch {
		return "failed";
	}

	if (content.includes(PATCH_MARKER)) return "already";

	// Anchor: the closing brace of the Skills `if` block followed by the
	// `templates` declaration. Tolerate whitespace drift via regex.
	const anchorRe =
		/(addLoadedSection\("Skills",\s*skillCompactList,\s*skillList\);\s*\}\s*)\n(\s*const templates = this\.session\.promptTemplates;)/;

	const match = content.match(anchorRe);
	if (!match) return "failed";

	// NOTE: interactive-mode.js is ESM (loaded as file:// URL). It already imports
	// `fs` and `path` at module top (line ~6: `import * as fs from "node:fs"`).
	// We MUST use those bindings — calling `require()` here would throw
	// `ReferenceError: require is not defined` at startup.
	const injectedBlock = `
            // --- agents-listing patch ---
            {
                // Find agent definition files (with frontmatter), not context files.
                // fs/path bindings come from the host module's existing imports.
                const _agentNames = [];

                const _findAgentFiles = (dir) => {
                    if (!fs.existsSync(dir)) return [];
                    const _files = [];
                    try {
                        const _entries = fs.readdirSync(dir, { withFileTypes: true });
                        for (const _e of _entries) {
                            if (_e.name.endsWith('.md') && !_e.name.endsWith('.chain.md') &&
                                !_e.name.match(/^(CLAUDE|AGENTS)\\.(md|MD)$/)) {
                                const _fp = path.join(dir, _e.name);
                                try {
                                    const _content = fs.readFileSync(_fp, 'utf8');
                                    // Check for agent frontmatter (starts with --- and has name:)
                                    if (_content.startsWith('---') && _content.match(/^---[\\s\\S]*?\\nname:\\s*.+/)) {
                                        const _nameMatch = _content.match(/^---[\\s\\S]*?\\nname:\\s*(.+)/m);
                                        if (_nameMatch) _files.push(_nameMatch[1].trim());
                                    }
                                } catch {}
                            }
                        }
                    } catch {}
                    return _files;
                };

                // 1. Walk up .pi/agents/ from cwd.
                // CRITICAL: use this.sessionManager.getCwd() — this.session.cwd
                // is undefined here (showLoadedResources runs before session
                // is fully set up).
                let _current = this.sessionManager.getCwd();
                const _visited = new Set();
                for (let _i = 0; _i < 10; _i++) {
                    const _agentsDir = path.join(_current, '.pi', 'agents');
                    if (!_visited.has(_agentsDir)) {
                        _visited.add(_agentsDir);
                        _agentNames.push(..._findAgentFiles(_agentsDir));
                    }
                    const _parent = path.dirname(_current);
                    if (_parent === _current) break;
                    _current = _parent;
                }

                // 2. Additional agent dirs (user-global + path-based package agents/).
                // List baked at extension-load time — see resolveAdditionalAgentDirs().
                const _extra = ${JSON.stringify(resolveAdditionalAgentDirs())};
                for (const _d of _extra) {
                    if (!_visited.has(_d)) {
                        _visited.add(_d);
                        _agentNames.push(..._findAgentFiles(_d));
                    }
                }

                if (_agentNames.length > 0) {
                    const _unique = [...new Set(_agentNames)].sort();
                    // Collapsed format: comma-separated names (matches Skills section style).
                    const _collapsed = _unique.join(", ");
                    const _expanded = _unique.map(n => "- " + n).join("\\n");
                    addLoadedSection("Agents", _collapsed, _expanded);
                }
            }
            // --- end agents-listing patch ---
`;

	const replacement = `$1${injectedBlock}$2`;
	const next = content.replace(anchorRe, replacement);
	if (next === content) return "failed";

	try {
		fs.writeFileSync(filePath, next, "utf8");
		return "patched";
	} catch {
		return "failed";
	}
}

// ── Extension entry ─────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	const distDir = findPiDistDir();
	const result = distDir ? patchInteractiveModeJs(distDir) : "failed";

	if (result === "patched") {
		console.error("[agents-listing] patched interactive-mode.js");
	} else if (result === "failed") {
		console.error("[agents-listing] FAILED to patch interactive-mode.js");
	}
	// (silent on "already" — avoids stderr spam every session)

	pi.on("session_start", async (_event: unknown, ctx: any) => {
		const d = findPiDistDir(ctx?.piInstallDir);
		if (d) patchInteractiveModeJs(d);
	});
}
