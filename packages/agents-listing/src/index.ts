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
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { findPiCodingAgentDistFromCaller } from "../../pi-resolve/src/index.ts";

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

	const injectedBlock = `
            // --- agents-listing patch ---
            {
                // Find agent definition files (with frontmatter), not context files
                const _fs = require('fs');
                const _path = require('path');
                const _agentNames = [];
                
                function _findAgentFiles(dir) {
                    if (!_fs.existsSync(dir)) return [];
                    const _files = [];
                    try {
                        const _entries = _fs.readdirSync(dir, { withFileTypes: true });
                        for (const _e of _entries) {
                            if (_e.name.endsWith('.md') && !_e.name.endsWith('.chain.md') && 
                                !_e.name.match(/^(CLAUDE|AGENTS)\\.(md|MD)$/)) {
                                const _fp = _path.join(dir, _e.name);
                                try {
                                    const _content = _fs.readFileSync(_fp, 'utf8');
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
                }
                
                // Check .pi/agents in current directory and walk up
                let _current = this.session.cwd;
                const _visited = new Set();
                for (let _i = 0; _i < 10; _i++) {
                    const _agentsDir = _path.join(_current, '.pi', 'agents');
                    if (!_visited.has(_agentsDir)) {
                        _visited.add(_agentsDir);
                        _agentNames.push(..._findAgentFiles(_agentsDir));
                    }
                    const _parent = _path.dirname(_current);
                    if (_parent === _current) break;
                    _current = _parent;
                }
                
                if (_agentNames.length > 0) {
                    const _unique = [...new Set(_agentNames)].sort();
                    const _collapsed = _unique.length + " agent" + (_unique.length > 1 ? "s" : "");
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
