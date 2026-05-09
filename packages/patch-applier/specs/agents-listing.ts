import type { PatchSpec } from "../src/types.js";

/**
 * agents-listing — adds an `[Agents]` section to pi's TUI startup header
 * (alongside Skills, Prompts, Extensions, Themes). Renders as
 * `<count> agent(s)` collapsed; expands via Ctrl+O to a sorted list.
 *
 * The agent list MUST come from pi's own discovery
 * (`this.session.resourceLoader.getAgentsFiles()`). An earlier version of
 * this patch hand-rolled directory traversal and accidentally shipped a
 * hardcoded personal `/Users/...` fallback path; the verify gate below
 * actively rejects any such regression.
 *
 * The injected block is delimited by start/end markers so we can isolate
 * patch content from the surrounding pi source — making verification
 * agnostic to upstream section reordering or new sections appearing
 * between Skills, Prompts, Extensions, Themes.
 */
export const spec: PatchSpec = {
	id: "agents-listing",
	target: "modes/interactive/interactive-mode.js",
	intent:
		"Inside the showLoadedResources() method that builds pi's TUI startup header, inject a block that adds a section labeled \"Agents\" via the local addLoadedSection() helper. The collapsed body shows the agent count (e.g. \"3 agents\"); the expanded body shows a sorted list of agent names (one per line, derived from the basename of each agent file with its yaml/yml/json/md extension stripped). The agent list MUST be sourced from this.session.resourceLoader.getAgentsFiles().agentsFiles — pi's own resource discovery — never from a hardcoded filesystem path. The block must only render when at least one agent is discovered. The injection must sit inside the same listing branch that renders Skills/Prompts/Extensions, but its exact position relative to those siblings is not specified — pi may reorder them.",
	hint: `Wrap the addition in a block delimited by these exact comment markers so verify() can find it:

    // --- agents-listing patch ---
    {
        const _agentFiles = this.session.resourceLoader.getAgentsFiles().agentsFiles;
        if (_agentFiles.length > 0) {
            const _agentNames = _agentFiles.map(f => f.path.split("/").pop().replace(/\\.(yaml|yml|json|md)$/, ""));
            const _collapsed = _agentNames.length + " agent" + (_agentNames.length > 1 ? "s" : "");
            const _expanded = _agentNames.sort().map(n => "- " + n).join("\\n");
            addLoadedSection("Agents", _collapsed, _expanded);
        }
    }
    // --- end agents-listing patch ---

Place the block inside the listing branch that already calls addLoadedSection("Skills", ...) / addLoadedSection("Prompts", ...) — typically right after the Skills section ends, but any position inside that same branch is acceptable as long as addLoadedSection is in scope and the block is still bracketed by the start and end markers above. Do not introduce hardcoded filesystem paths; the agent list must come from this.session.resourceLoader.getAgentsFiles().`,
	marker: "// --- agents-listing patch ---",

	verify(content: string) {
		const failures: string[] = [];

		const startMarker = "// --- agents-listing patch ---";
		const endMarker = "// --- end agents-listing patch ---";

		const startIdx = content.indexOf(startMarker);
		if (startIdx === -1) {
			failures.push(`missing start marker '${startMarker}' — patch not applied`);
			return { ok: false, failures };
		}

		const endIdx = content.indexOf(endMarker, startIdx + startMarker.length);
		if (endIdx === -1) {
			failures.push(
				`missing end marker '${endMarker}' — injection appears truncated; refuse to trust partial state`,
			);
			return { ok: false, failures };
		}

		// Isolate patch content. Doing intent checks against the block (not the
		// whole file) makes the spec agnostic to surrounding pi source — other
		// patches, reordered sections, new sections — and keeps the
		// hardcoded-path regression guard scoped to what *we* injected.
		const block = content.slice(startIdx, endIdx + endMarker.length);

		// 1. Must register an "Agents" section via the local helper. The exact
		//    arity / argument names are not pinned — only that addLoadedSection
		//    is called with the literal section name "Agents".
		if (!/addLoadedSection\s*\(\s*["']Agents["']/.test(block)) {
			failures.push('no addLoadedSection("Agents", ...) call inside patch block');
		}

		// 2. The agent list MUST be sourced from pi's own resource loader.
		//    Anchors on resourceLoader.getAgentsFiles() — survives whitespace
		//    drift but rejects any hand-rolled discovery.
		if (!/resourceLoader\s*\.\s*getAgentsFiles\s*\(\s*\)/.test(block)) {
			failures.push(
				"agent list does not come from this.session.resourceLoader.getAgentsFiles() — refuse to ship hand-rolled discovery",
			);
		}

		// 3. Regression guard: the prior version of this patch leaked a
		//    hardcoded `/Users/<name>/...` fallback path into shipped code. We
		//    forbid any absolute personal path inside the block.
		if (/\/Users\/[^"'\s/]+\//.test(block) || /\/home\/[^"'\s/]+\//.test(block)) {
			failures.push(
				"hardcoded personal filesystem path leaked into patch block (regression of previous /Users/... fallback)",
			);
		}

		return failures.length === 0 ? { ok: true } : { ok: false, failures };
	},
};
