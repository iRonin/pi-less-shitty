/**
 * Tests for the AI-driven patch applier.
 *
 * Two layers of testing:
 *   1. Verify-function tests — prove the spec's verify() correctly distinguishes
 *      patched / unpatched / partially-patched / refactored-but-still-correct
 *      states. These run in pure Node, no LLM.
 *   2. Applier integration tests — run the applier with a *mock* deriveEdits
 *      function (simulating a perfect agent) and a *flawed* one (simulating an
 *      agent that produces ambiguous or wrong edits) to prove the validation
 *      layer rejects bad output.
 *
 * The point: when a real LLM is plugged in via defaultDeriveEdits, the
 * validation layer + verify gate is what guarantees correctness — even if the
 * model has a bad day.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { test, describe, before, after } from "node:test";

import { applyOne, parseEditsResponse, extractAssistantText, type Edit } from "../src/applier.ts";
import { spec as queueEmojisSpec } from "../specs/queue-emojis.ts";

// ---------------------------------------------------------------------------
// Synthetic dist fixtures
// ---------------------------------------------------------------------------

const PRISTINE_V1 = `
class InteractiveMode {
    updatePendingMessagesDisplay() {
        const lines = [];
        for (const message of this.steeringMessages) {
            lines.push(\`Steering: \${message}\`);
        }
        for (const message of this.followUpMessages) {
            lines.push(\`Follow-up: \${message}\`);
        }
        return lines;
    }
}
`;

// Future hypothetical pi version where the variable was renamed:
//   message → msg (refactor)
//   added a guard clause (also unrelated)
const PRISTINE_V2_REFACTORED = `
class InteractiveMode {
    updatePendingMessagesDisplay() {
        if (!this.steeringMessages?.length && !this.followUpMessages?.length) return [];
        const lines = [];
        for (const msg of this.steeringMessages) {
            lines.push(\`Steering: \${msg}\`);
        }
        for (const msg of this.followUpMessages) {
            lines.push(\`Follow-up: \${msg}\`);
        }
        return lines;
    }
}
`;

// Already-patched form (what queue-emojis emits today)
const PATCHED = PRISTINE_V1
	.replace("`Steering: ${message}`", "`🎯 Steer: ${message}`")
	.replace("`Follow-up: ${message}`", "`📥 Follow-up: ${message}`");

// Half-patched (only Steering replaced — proves verify catches partials)
const PARTIAL = PRISTINE_V1.replace("`Steering: ${message}`", "`🎯 Steer: ${message}`");

// ---------------------------------------------------------------------------
// 1. verify() correctness
// ---------------------------------------------------------------------------

describe("queue-emojis spec.verify", () => {
	test("rejects pristine v1 (no patch applied)", () => {
		const r = queueEmojisSpec.verify(PRISTINE_V1);
		assert.equal(r.ok, false);
		if (!r.ok) {
			// Should flag the missing markers and the originals still present
			assert.ok(r.failures.length >= 2);
			assert.ok(r.failures.some((f) => /🎯/.test(f)));
			assert.ok(r.failures.some((f) => /📥/.test(f)));
		}
	});

	test("rejects pristine v2 (refactored variable name, no patch)", () => {
		const r = queueEmojisSpec.verify(PRISTINE_V2_REFACTORED);
		assert.equal(r.ok, false);
	});

	test("rejects partial patch", () => {
		const r = queueEmojisSpec.verify(PARTIAL);
		assert.equal(r.ok, false);
		if (!r.ok) {
			// Steering done, Follow-up not — verify must catch this
			assert.ok(r.failures.some((f) => /Follow-up/.test(f)));
		}
	});

	test("accepts fully patched form", () => {
		const r = queueEmojisSpec.verify(PATCHED);
		assert.equal(r.ok, true);
	});

	test("accepts a hypothetical future patched form with a renamed variable", () => {
		// This is the durability claim: an agent applying the patch to v2
		// produces this shape; verify must accept it.
		const v2Patched = PRISTINE_V2_REFACTORED.replace(
			"`Steering: ${msg}`",
			"`🎯 Steer: ${msg}`",
		).replace("`Follow-up: ${msg}`", "`📥 Follow-up: ${msg}`");
		const r = queueEmojisSpec.verify(v2Patched);
		assert.equal(r.ok, true);
	});
});

// ---------------------------------------------------------------------------
// 2. Applier integration with mocked derive function
// ---------------------------------------------------------------------------

describe("applyOne", () => {
	let tmpDistDir: string;
	const targetRel = queueEmojisSpec.target;

	before(() => {
		tmpDistDir = fs.mkdtempSync(path.join(os.tmpdir(), "patch-applier-test-"));
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

	test("returns 'already' when marker present and verify passes", async () => {
		writeTarget(PATCHED);
		const result = await applyOne(queueEmojisSpec, {
			distDir: tmpDistDir,
			deriveEdits: async () => {
				throw new Error("should not be called when already patched");
			},
		});
		assert.equal(result.status, "already");
	});

	test("applies edits from a perfect agent against pristine v1", async () => {
		writeTarget(PRISTINE_V1);
		const result = await applyOne(queueEmojisSpec, {
			distDir: tmpDistDir,
			deriveEdits: async () => [
				{ find: "`Steering: ${message}`", replace: "`🎯 Steer: ${message}`" },
				{ find: "`Follow-up: ${message}`", replace: "`📥 Follow-up: ${message}`" },
			],
		});
		assert.equal(result.status, "applied", result.message);
		// File on disk must verify clean
		assert.equal(queueEmojisSpec.verify(readTarget()).ok, true);
	});

	test("applies edits against the refactored v2 (durability claim)", async () => {
		writeTarget(PRISTINE_V2_REFACTORED);
		// Simulate the agent correctly inferring the new variable name from the file
		const result = await applyOne(queueEmojisSpec, {
			distDir: tmpDistDir,
			deriveEdits: async (_spec, content) => {
				// Pretend the agent read the file and saw `msg` instead of `message`
				assert.ok(content.includes("`Steering: ${msg}`"), "fixture sanity");
				return [
					{ find: "`Steering: ${msg}`", replace: "`🎯 Steer: ${msg}`" },
					{ find: "`Follow-up: ${msg}`", replace: "`📥 Follow-up: ${msg}`" },
				];
			},
		});
		assert.equal(result.status, "applied", result.message);
		assert.equal(queueEmojisSpec.verify(readTarget()).ok, true);
	});

	test("rejects edits with a 'find' string that doesn't appear in the file", async () => {
		writeTarget(PRISTINE_V1);
		const result = await applyOne(queueEmojisSpec, {
			distDir: tmpDistDir,
			deriveEdits: async () => [
				{ find: "this string does not exist in the file", replace: "x" },
			],
		});
		assert.equal(result.status, "failed");
		assert.match(result.message ?? "", /not present/);
		// File on disk must be unchanged
		assert.equal(readTarget(), PRISTINE_V1);
	});

	test("rejects edits with an ambiguous (multi-match) 'find' string", async () => {
		writeTarget(PRISTINE_V1);
		const result = await applyOne(queueEmojisSpec, {
			distDir: tmpDistDir,
			deriveEdits: async () => [
				// `for (const message of` appears twice — ambiguous
				{ find: "for (const message of", replace: "for (const messageX of" },
			],
		});
		assert.equal(result.status, "failed");
		assert.match(result.message ?? "", /ambiguous/);
		assert.equal(readTarget(), PRISTINE_V1);
	});

	test("rejects edits that pass uniqueness but fail verify (e.g. agent missed Follow-up)", async () => {
		writeTarget(PRISTINE_V1);
		const result = await applyOne(queueEmojisSpec, {
			distDir: tmpDistDir,
			deriveEdits: async () => [
				// Only Steering — Follow-up left unpatched
				{ find: "`Steering: ${message}`", replace: "`🎯 Steer: ${message}`" },
			],
		});
		assert.equal(result.status, "failed");
		assert.match(result.message ?? "", /verify still failing/);
		// File on disk must be unchanged (we didn't write a partial patch)
		assert.equal(readTarget(), PRISTINE_V1);
	});

	test("returns 'failed' when agent produces empty edits but file still doesn't verify", async () => {
		writeTarget(PRISTINE_V1);
		const result = await applyOne(queueEmojisSpec, {
			distDir: tmpDistDir,
			deriveEdits: async () => [],
		});
		assert.equal(result.status, "failed");
		assert.match(result.message ?? "", /no edits/);
	});
});

// ---------------------------------------------------------------------------
// 3. parseEditsResponse robustness
// ---------------------------------------------------------------------------

describe("parseEditsResponse", () => {
	test("parses bare JSON", () => {
		const r = parseEditsResponse(
			'{"replacements":[{"find":"a","replace":"b"}]}',
		);
		assert.deepEqual(r, [{ find: "a", replace: "b" }]);
	});

	test("parses fenced JSON", () => {
		const r = parseEditsResponse(
			'```json\n{"replacements":[{"find":"a","replace":"b"}]}\n```',
		);
		assert.deepEqual(r, [{ find: "a", replace: "b" }]);
	});

	test("parses JSON embedded in prose", () => {
		const r = parseEditsResponse(
			'Sure, here are the edits:\n{"replacements":[{"find":"a","replace":"b"}]}\n',
		);
		assert.deepEqual(r, [{ find: "a", replace: "b" }]);
	});

	test("rejects malformed shape", () => {
		assert.throws(() => parseEditsResponse('{"replacements":"not-an-array"}'));
		assert.throws(() =>
			parseEditsResponse('{"replacements":[{"find":1,"replace":"b"}]}'),
		);
	});

	test("rejects non-JSON garbage", () => {
		assert.throws(() => parseEditsResponse("just prose, no json here"));
	});
});

describe("extractAssistantText", () => {
	test("extracts text from {role:assistant, text}", () => {
		const stream = '{"role":"assistant","text":"hello"}\n';
		assert.equal(extractAssistantText(stream), "hello");
	});

	test("extracts text from content-array form", () => {
		const stream = '{"role":"assistant","content":[{"type":"text","text":"hi"}]}\n';
		assert.equal(extractAssistantText(stream), "hi");
	});

	test("returns last assistant message in a multi-event stream", () => {
		const stream = [
			'{"role":"user","text":"q"}',
			'{"role":"assistant","text":"thinking..."}',
			'{"role":"assistant","text":"final"}',
		].join("\n");
		assert.equal(extractAssistantText(stream), "final");
	});
});
