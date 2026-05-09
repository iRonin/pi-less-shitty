/**
 * Tests for the anthropic-tool-parameters spec.
 *
 * Four mandatory tests per the patch-applier contract:
 *   1. STALE: verify rejects the un-patched pristine form
 *   2. ALREADY-PATCHED: verify accepts the current patched form
 *   3. PERMISSIVE: verify accepts alternate-but-equivalent forms (|| instead of ??, renamed variable)
 *   4. NEAR-MISS: verify rejects a deceptively-similar form that lacks the guard
 */

import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { spec as anthropicToolParametersSpec } from "../specs/anthropic-tool-parameters.ts";

// ---------------------------------------------------------------------------
// Synthetic fixtures
// ---------------------------------------------------------------------------

/**
 * PRISTINE — upstream pi-ai without the patch. The line `const schema = tool.parameters;`
 * appears with no guard.
 */
const PRISTINE = `
function convertToolSchema(tool) {
    const schema = tool.parameters;
    if (!schema.type) {
        schema.type = "object";
    }
    return {
        name: tool.name,
        description: tool.description,
        input_schema: schema,
    };
}
`;

/**
 * PATCHED — the current form with ?? {} guard.
 */
const PATCHED = `
function convertToolSchema(tool) {
    const schema = tool.parameters ?? {};
    if (!schema.type) {
        schema.type = "object";
    }
    return {
        name: tool.name,
        description: tool.description,
        input_schema: schema,
    };
}
`;

/**
 * ALTERNATE_LOGICAL_OR — uses || instead of ??. Semantically equivalent for
 * the null/undefined case, and the spec should accept it.
 */
const ALTERNATE_LOGICAL_OR = `
function convertToolSchema(tool) {
    const schema = tool.parameters || {};
    if (!schema.type) {
        schema.type = "object";
    }
    return {
        name: tool.name,
        description: tool.description,
        input_schema: schema,
    };
}
`;

/**
 * FUTURE_RENAMED — hypothetical future pi-ai where the variable name changed
 * from `schema` to `inputSchema`, but the guard is intact. The spec must
 * accept this (proof of decoupling from specific variable names).
 */
const FUTURE_RENAMED = `
function convertToolSchema(tool) {
    const inputSchema = tool.parameters ?? {};
    if (!inputSchema.type) {
        inputSchema.type = "object";
    }
    return {
        name: tool.name,
        description: tool.description,
        input_schema: inputSchema,
    };
}
`;

/**
 * NEAR_MISS — has a guard, but for a DIFFERENT variable, not tool.parameters.
 * The spec must reject this.
 */
const NEAR_MISS = `
function convertToolSchema(tool) {
    const schema = tool.parameters;
    const defaults = tool.defaults ?? {};
    if (!schema.type) {
        schema.type = "object";
    }
    return {
        name: tool.name,
        description: tool.description,
        input_schema: schema,
        defaults,
    };
}
`;

/**
 * PARTIAL — someone added a guard but the pristine form is also still present
 * (e.g. two different call sites, only one patched). The spec must reject this.
 */
const PARTIAL = `
function convertToolSchema(tool) {
    const schema = tool.parameters ?? {};
    return { input_schema: schema };
}
function anotherConverter(tool) {
    const s = tool.parameters;
    return s;
}
`;

// ---------------------------------------------------------------------------
// 1. verify() correctness
// ---------------------------------------------------------------------------

describe("anthropic-tool-parameters spec.verify", () => {
	test("STALE: rejects pristine pi-ai (no patch applied)", () => {
		const r = anthropicToolParametersSpec.verify(PRISTINE);
		assert.equal(r.ok, false);
		if (!r.ok) {
			assert.ok(
				r.failures.some((f) => /null guard/i.test(f)),
				"expected failure mentioning missing null guard",
			);
			assert.ok(
				r.failures.some((f) => /without guard/i.test(f)),
				"expected failure mentioning pristine assignment",
			);
		}
	});

	test("ALREADY-PATCHED: accepts the current ?? {} form", () => {
		const r = anthropicToolParametersSpec.verify(PATCHED);
		assert.equal(r.ok, true, !r.ok ? r.failures.join("; ") : undefined);
	});

	test("PERMISSIVE: accepts alternate form with || instead of ??", () => {
		const r = anthropicToolParametersSpec.verify(ALTERNATE_LOGICAL_OR);
		assert.equal(r.ok, true, !r.ok ? r.failures.join("; ") : undefined);
	});

	test("PERMISSIVE: accepts future-refactored form with renamed variable", () => {
		const r = anthropicToolParametersSpec.verify(FUTURE_RENAMED);
		assert.equal(r.ok, true, !r.ok ? r.failures.join("; ") : undefined);
	});

	test("NEAR-MISS: rejects when guard is present but for a different variable", () => {
		const r = anthropicToolParametersSpec.verify(NEAR_MISS);
		assert.equal(r.ok, false);
		if (!r.ok) {
			assert.ok(
				r.failures.some((f) => /tool\.parameters/i.test(f)),
				"expected failure mentioning tool.parameters specifically",
			);
		}
	});

	test("PARTIAL: rejects when one call site is patched but another pristine form remains", () => {
		const r = anthropicToolParametersSpec.verify(PARTIAL);
		assert.equal(r.ok, false);
		if (!r.ok) {
			assert.ok(
				r.failures.some((f) => /without guard/i.test(f)),
				"expected failure mentioning the remaining pristine assignment",
			);
		}
	});
});
