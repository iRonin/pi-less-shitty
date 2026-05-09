/**
 * Tests for the compaction-tokens spec.
 *
 * Same shape as applier.test.ts:
 *   1. verify() correctness — pristine, fully-patched, partial, and a
 *      hypothetical refactored future-pi where variable names AND the
 *      estimator divisor changed but the patch was correctly re-derived.
 *   2. Applier integration with a mocked deriveEdits proving a "perfect
 *      agent" run end-to-end against the pristine fixture.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { test, describe, before, after } from "node:test";

import { applyOne } from "../src/applier.ts";
import { spec as compactionTokensSpec } from "../specs/compaction-tokens.ts";

// ---------------------------------------------------------------------------
// Synthetic dist fixtures
// ---------------------------------------------------------------------------

/** Pristine — what the dist looks like before the patch. Single before-count
 *  in both branches; no reference to `summary.length`. */
const PRISTINE = `
export class CompactionSummaryMessageComponent extends Box {
    expanded = false;
    constructor(message, markdownTheme) {
        super(1, 1, (t) => theme.bg("customMessageBg", t));
        this.message = message;
        this.markdownTheme = markdownTheme;
        this.updateDisplay();
    }
    updateDisplay() {
        this.clear();
        const tokenStr = this.message.tokensBefore.toLocaleString();
        const label = theme.fg("customMessageLabel", \`\\x1b[1m[compaction]\\x1b[22m\`);
        this.addChild(new Text(label, 0, 0));
        this.addChild(new Spacer(1));
        if (this.expanded) {
            const header = \`**Compacted \${tokenStr} tokens**\\n\\n\`;
            this.addChild(new Markdown(header + this.message.summary, 0, 0, this.markdownTheme, {
                color: (text) => theme.fg("customMessageText", text),
            }));
        }
        else {
            this.addChild(new Text(theme.fg("customMessageText", \`Compacted \${tokenStr} tokens (\`) +
                theme.fg("dim", keyText("app.tools.expand")) +
                theme.fg("customMessageText", " to expand)"), 0, 0));
        }
    }
}
`;

/** Fully patched — the form the current applier emits. */
const PATCHED = `
export class CompactionSummaryMessageComponent extends Box {
    expanded = false;
    constructor(message, markdownTheme) {
        super(1, 1, (t) => theme.bg("customMessageBg", t));
        this.message = message;
        this.markdownTheme = markdownTheme;
        this.updateDisplay();
    }
    updateDisplay() {
        this.clear();
        const tokenStr = this.message.tokensBefore.toLocaleString();
        const tokensAfter = Math.ceil(this.message.summary.length / 4);
        const afterStr = tokensAfter.toLocaleString();
        const label = theme.fg("customMessageLabel", \`\\x1b[1m[compaction]\\x1b[22m\`);
        this.addChild(new Text(label, 0, 0));
        this.addChild(new Spacer(1));
        if (this.expanded) {
            const header = \`**Compacted from \${tokenStr} → \${afterStr} tokens**\\n\\n\`;
            this.addChild(new Markdown(header + this.message.summary, 0, 0, this.markdownTheme, {
                color: (text) => theme.fg("customMessageText", text),
            }));
        }
        else {
            this.addChild(new Text(theme.fg("customMessageText", \`Compacted from \${tokenStr} → \${afterStr} tokens (\`) +
                theme.fg("dim", keyText("app.tools.expand")) +
                theme.fg("customMessageText", " to expand)"), 0, 0));
        }
    }
}
`;

/** Partial — only the expanded branch was rewritten; collapsed still pristine.
 *  This is a real failure mode of a sloppy applier and verify must catch it.
 *  We also include the new computation lines so the only remaining defect
 *  is the un-rewritten collapsed template literal. */
const PARTIAL = `
export class CompactionSummaryMessageComponent extends Box {
    updateDisplay() {
        this.clear();
        const tokenStr = this.message.tokensBefore.toLocaleString();
        const tokensAfter = Math.ceil(this.message.summary.length / 4);
        const afterStr = tokensAfter.toLocaleString();
        if (this.expanded) {
            const header = \`**Compacted from \${tokenStr} → \${afterStr} tokens**\\n\\n\`;
            this.addChild(new Markdown(header + this.message.summary));
        }
        else {
            this.addChild(new Text(\`Compacted \${tokenStr} tokens (\` + " to expand)"));
        }
    }
}
`;

/** Future-pi — both variables renamed (tokenStr → before, afterStr → after)
 *  AND a different estimator divisor (3.5 instead of 4). The intent is the
 *  same and the patch was correctly re-derived. Verify must accept this — if
 *  it doesn't, we're back to fragile anchors. */
const PATCHED_V2_REFACTORED = `
export class CompactionSummaryMessageComponent extends Box {
    updateDisplay() {
        this.clear();
        const before = this.message.tokensBefore.toLocaleString();
        const after = Math.ceil(this.message.summary.length / 3.5).toLocaleString();
        if (this.expanded) {
            const header = \`**Compacted from \${before} → \${after} tokens**\\n\\n\`;
            this.addChild(new Markdown(header + this.message.summary));
        }
        else {
            this.addChild(new Text(\`Compacted from \${before} → \${after} tokens (\` + " to expand)"));
        }
    }
}
`;

// ---------------------------------------------------------------------------
// 1. verify() correctness
// ---------------------------------------------------------------------------

describe("compaction-tokens spec.verify", () => {
	test("rejects pristine (no patch applied)", () => {
		const r = compactionTokensSpec.verify(PRISTINE);
		assert.equal(r.ok, false);
		if (!r.ok) {
			// Should flag missing computation, missing expanded, missing collapsed,
			// and the original `Compacted ${...}` form still present.
			assert.ok(r.failures.length >= 3, `expected ≥3 failures, got: ${r.failures.join(" | ")}`);
			assert.ok(
				r.failures.some((f) => /summary\.length/.test(f)),
				"expected failure about missing summary.length-derived computation",
			);
			assert.ok(
				r.failures.some((f) => /original.*Compacted/i.test(f)),
				"expected failure flagging the original `Compacted ${...}` form still present",
			);
		}
	});

	test("accepts fully patched form", () => {
		const r = compactionTokensSpec.verify(PATCHED);
		assert.equal(r.ok, true, r.ok ? "" : (r as { failures: string[] }).failures.join(" | "));
	});

	test("rejects partial patch (collapsed branch left untouched)", () => {
		const r = compactionTokensSpec.verify(PARTIAL);
		assert.equal(r.ok, false);
		if (!r.ok) {
			// The remaining defect is the old `Compacted ${...}` template literal
			// in the collapsed branch — verify must catch this.
			assert.ok(
				r.failures.some((f) => /partial|Compacted \$\{/i.test(f)),
				`expected a failure flagging the partial / leftover collapsed form, got: ${r.failures.join(" | ")}`,
			);
		}
	});

	test("accepts future-pi refactor with renamed variables AND a different estimator divisor", () => {
		// Durability claim: the spec must not pin to `tokenStr`/`afterStr`/
		// `tokensAfter` variable names, nor to the `/4` divisor in the estimator.
		// Re-deriving the patch against this hypothetical pi version produces
		// PATCHED_V2_REFACTORED; verify must accept it.
		const r = compactionTokensSpec.verify(PATCHED_V2_REFACTORED);
		assert.equal(
			r.ok,
			true,
			r.ok ? "" : (r as { failures: string[] }).failures.join(" | "),
		);
	});
});

// ---------------------------------------------------------------------------
// 2. Applier integration with mocked deriveEdits
// ---------------------------------------------------------------------------

describe("applyOne(compaction-tokens)", () => {
	let tmpDistDir: string;
	const targetRel = compactionTokensSpec.target;

	before(() => {
		tmpDistDir = fs.mkdtempSync(path.join(os.tmpdir(), "patch-applier-cmp-"));
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

	test("applies edits from a perfect agent against pristine fixture", async () => {
		writeTarget(PRISTINE);

		// Simulate a well-behaved agent producing three minimal, uniquely-anchored
		// edits: insert the after-count computation, rewrite the expanded
		// template literal, rewrite the collapsed template literal.
		const result = await applyOne(compactionTokensSpec, {
			distDir: tmpDistDir,
			deriveEdits: async (_spec, content) => {
				assert.ok(
					content.includes("const tokenStr = this.message.tokensBefore.toLocaleString();"),
					"fixture sanity: expected the before-count line",
				);
				return [
					{
						find: "const tokenStr = this.message.tokensBefore.toLocaleString();",
						replace:
							"const tokenStr = this.message.tokensBefore.toLocaleString();\n        const tokensAfter = Math.ceil(this.message.summary.length / 4);\n        const afterStr = tokensAfter.toLocaleString();",
					},
					{
						find: "`**Compacted ${tokenStr} tokens**\\n\\n`",
						replace: "`**Compacted from ${tokenStr} → ${afterStr} tokens**\\n\\n`",
					},
					{
						find: "`Compacted ${tokenStr} tokens (`",
						replace: "`Compacted from ${tokenStr} → ${afterStr} tokens (`",
					},
				];
			},
		});

		assert.equal(result.status, "applied", result.message);
		assert.equal(compactionTokensSpec.verify(readTarget()).ok, true);
	});

	test("returns 'already' when fixture already verifies", async () => {
		writeTarget(PATCHED);
		const result = await applyOne(compactionTokensSpec, {
			distDir: tmpDistDir,
			deriveEdits: async () => {
				throw new Error("should not be called when already patched");
			},
		});
		assert.equal(result.status, "already");
	});
});
