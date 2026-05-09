/**
 * Tests for the agents-listing spec.
 *
 *   1. verify() correctness — pristine, fully-patched, two partial-states,
 *      and a future-version durability fixture where pi has reordered the
 *      startup header sections.
 *   2. applyOne integration — mock deriveEdits injects the patch block into
 *      the pristine fixture and the on-disk file must verify clean.
 *
 * The intent: prove the spec is durable (doesn't pin to surrounding-section
 * order or specific anchor text) AND tight (catches the previous personal-
 * path leak regression and truncated injections).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";

import { applyOne } from "../src/applier.ts";
import { spec as agentsListingSpec } from "../specs/agents-listing.ts";

// ---------------------------------------------------------------------------
// Synthetic fixtures (mimic pi's interactive-mode.js → showLoadedResources)
// ---------------------------------------------------------------------------

// Pristine: Skills then Prompts then Extensions, no Agents block.
const PRISTINE = `
class InteractiveMode {
    showLoadedResources(options) {
        const addLoadedSection = (name, collapsed, expanded = collapsed) => {};
        if (showListing) {
            const skills = skillsResult.skills;
            if (skills.length > 0) {
                const skillCompactList = formatCompactList(skills.map((s) => s.name));
                const skillList = "...";
                addLoadedSection("Skills", skillCompactList, skillList);
            }
            const templates = this.session.promptTemplates;
            if (templates.length > 0) {
                addLoadedSection("Prompts", promptCompactList, templateList);
            }
            if (extensions.length > 0) {
                addLoadedSection("Extensions", extensionCompactList, extList, "mdHeading");
            }
        }
    }
}
`;

const PATCH_BLOCK = `
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
            // --- end agents-listing patch ---`;

// Fully-patched: agents block injected after the Skills section.
const PATCHED = PRISTINE.replace(
	'addLoadedSection("Skills", skillCompactList, skillList);\n            }',
	`addLoadedSection("Skills", skillCompactList, skillList);
            }${PATCH_BLOCK}`,
);

// Partial #1 — start marker only, no end marker (truncated injection).
const TRUNCATED = PRISTINE.replace(
	'addLoadedSection("Skills", skillCompactList, skillList);\n            }',
	`addLoadedSection("Skills", skillCompactList, skillList);
            }
            // --- agents-listing patch ---
            {
                const _agentFiles = this.session.resourceLoader.getAgentsFiles().agentsFiles;
                addLoadedSection("Agents", "x", "y");
                // (end marker missing — simulates write/inject crash)`,
);

// Partial #2 — markers present but no addLoadedSection("Agents", ...) call.
const MISSING_SECTION_CALL = PRISTINE.replace(
	'addLoadedSection("Skills", skillCompactList, skillList);\n            }',
	`addLoadedSection("Skills", skillCompactList, skillList);
            }
            // --- agents-listing patch ---
            {
                const _agentFiles = this.session.resourceLoader.getAgentsFiles().agentsFiles;
                // todo: render the section
            }
            // --- end agents-listing patch ---`,
);

// Partial #3 — has addLoadedSection("Agents", ...) but reads from a
// hardcoded /Users/... path instead of the resourceLoader. This is the
// regression of the previous personal-path leak.
const HARDCODED_PATH_LEAK = PRISTINE.replace(
	'addLoadedSection("Skills", skillCompactList, skillList);\n            }',
	`addLoadedSection("Skills", skillCompactList, skillList);
            }
            // --- agents-listing patch ---
            {
                const _agentFiles = fs.readdirSync("/Users/somebody/.pi/agents");
                if (_agentFiles.length > 0) {
                    addLoadedSection("Agents", _agentFiles.length + " agents", _agentFiles.join("\\n"));
                }
            }
            // --- end agents-listing patch ---`,
);

// Future-version durability: pi has reordered the listing — Extensions is
// emitted *before* Skills, a new "Themes" section appears between Skills and
// Prompts, and the agents-listing block ends up wedged between Themes and
// Prompts. The spec should still accept this.
const FUTURE_REORDERED_PATCHED = `
class InteractiveMode {
    showLoadedResources(options) {
        const addLoadedSection = (name, collapsed, expanded = collapsed) => {};
        if (showListing) {
            // upstream reorder: Extensions now first
            if (extensions.length > 0) {
                addLoadedSection("Extensions", extensionCompactList, extList, "mdHeading");
            }
            const skills = skillsResult.skills;
            if (skills.length > 0) {
                addLoadedSection("Skills", skillCompactList, skillList);
            }
            // brand-new upstream section between Skills and Prompts
            if (themes.length > 0) {
                addLoadedSection("Themes", themeCompactList, themeList);
            }
            // --- agents-listing patch ---
            {
                const _af = this.session.resourceLoader.getAgentsFiles().agentsFiles;
                if (_af.length > 0) {
                    const _names = _af.map(f => f.path.split("/").pop().replace(/\\.(yaml|yml|json|md)$/, ""));
                    addLoadedSection("Agents", _names.length + " agent(s)", _names.sort().map(n => "- " + n).join("\\n"));
                }
            }
            // --- end agents-listing patch ---
            const templates = this.session.promptTemplates;
            if (templates.length > 0) {
                addLoadedSection("Prompts", promptCompactList, templateList);
            }
        }
    }
}
`;

// ---------------------------------------------------------------------------
// 1. verify() correctness
// ---------------------------------------------------------------------------

describe("agents-listing spec.verify", () => {
	test("rejects pristine (no patch applied)", () => {
		const r = agentsListingSpec.verify(PRISTINE);
		assert.equal(r.ok, false);
		if (!r.ok) {
			assert.ok(
				r.failures.some((f) => /missing start marker/.test(f)),
				`expected start-marker failure, got: ${r.failures.join(" | ")}`,
			);
		}
	});

	test("accepts fully-patched form", () => {
		const r = agentsListingSpec.verify(PATCHED);
		assert.equal(r.ok, true, !r.ok ? r.failures.join(" | ") : "");
	});

	test("rejects truncated injection (start marker, no end marker)", () => {
		const r = agentsListingSpec.verify(TRUNCATED);
		assert.equal(r.ok, false);
		if (!r.ok) {
			assert.ok(
				r.failures.some((f) => /end marker/.test(f)),
				`expected end-marker failure, got: ${r.failures.join(" | ")}`,
			);
		}
	});

	test("rejects partial: markers present but no addLoadedSection(\"Agents\", ...) call", () => {
		const r = agentsListingSpec.verify(MISSING_SECTION_CALL);
		assert.equal(r.ok, false);
		if (!r.ok) {
			assert.ok(
				r.failures.some((f) => /addLoadedSection\("Agents"/.test(f)),
				`expected missing-Agents-section failure, got: ${r.failures.join(" | ")}`,
			);
		}
	});

	test("rejects partial: has addLoadedSection(\"Agents\") but reads from a hardcoded /Users/... path (regression guard)", () => {
		const r = agentsListingSpec.verify(HARDCODED_PATH_LEAK);
		assert.equal(r.ok, false);
		if (!r.ok) {
			assert.ok(
				r.failures.some((f) => /hardcoded personal filesystem path/.test(f)),
				`expected personal-path failure, got: ${r.failures.join(" | ")}`,
			);
			assert.ok(
				r.failures.some((f) => /resourceLoader/.test(f)),
				`expected resourceLoader-source failure, got: ${r.failures.join(" | ")}`,
			);
		}
	});

	test("accepts a future pi version where startup sections were reordered (durability claim)", () => {
		const r = agentsListingSpec.verify(FUTURE_REORDERED_PATCHED);
		assert.equal(r.ok, true, !r.ok ? r.failures.join(" | ") : "");
	});
});

// ---------------------------------------------------------------------------
// 2. applyOne integration with mocked deriveEdits
// ---------------------------------------------------------------------------

describe("applyOne agents-listing", () => {
	let tmpDistDir: string;
	const targetRel = agentsListingSpec.target;

	before(() => {
		tmpDistDir = fs.mkdtempSync(path.join(os.tmpdir(), "patch-applier-agents-"));
		fs.mkdirSync(path.join(tmpDistDir, path.dirname(targetRel)), { recursive: true });
	});

	after(() => {
		fs.rmSync(tmpDistDir, { recursive: true, force: true });
	});

	function writeTarget(content: string) {
		fs.writeFileSync(path.join(tmpDistDir, targetRel), content, "utf8");
	}

	function readTarget(): string {
		return fs.readFileSync(path.join(tmpDistDir, targetRel), "utf8");
	}

	test("returns 'already' when fixture is fully patched", async () => {
		writeTarget(PATCHED);
		const result = await applyOne(agentsListingSpec, {
			distDir: tmpDistDir,
			deriveEdits: async () => {
				throw new Error("deriveEdits should not be called when already patched");
			},
		});
		assert.equal(result.status, "already");
	});

	test("applies edits from a perfect agent against pristine fixture", async () => {
		writeTarget(PRISTINE);

		// Mock agent: anchors on the unique closing brace of the Skills `if`
		// block (the `addLoadedSection("Skills"...);\n            }` pair) and
		// appends the patch block immediately after.
		const findAnchor =
			'addLoadedSection("Skills", skillCompactList, skillList);\n            }';
		const replacement = `${findAnchor}${PATCH_BLOCK}`;

		const result = await applyOne(agentsListingSpec, {
			distDir: tmpDistDir,
			deriveEdits: async (_spec, content) => {
				assert.ok(content.includes(findAnchor), "fixture sanity: anchor must be unique and present");
				return [{ find: findAnchor, replace: replacement }];
			},
		});
		assert.equal(result.status, "applied", result.message);
		const onDisk = readTarget();
		assert.equal(agentsListingSpec.verify(onDisk).ok, true);
		assert.ok(onDisk.includes("// --- agents-listing patch ---"));
		assert.ok(onDisk.includes("// --- end agents-listing patch ---"));
		assert.ok(onDisk.includes('addLoadedSection("Agents"'));
		assert.ok(onDisk.includes("resourceLoader.getAgentsFiles()"));
	});
});
