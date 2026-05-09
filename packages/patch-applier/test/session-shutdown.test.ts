/**
 * Tests for the session-shutdown spec.
 *
 * Four mandatory tests per the patch-applier contract:
 *   1. STALE: verify rejects the un-patched pristine form
 *   2. ALREADY-PATCHED: verify accepts the current patched form
 *   3. PERMISSIVE: verify accepts alternate-but-equivalent forms (|| instead of ??, renamed variable)
 *   4. NEAR-MISS: verify rejects a deceptively-similar form that lacks the guard
 */

import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { spec as sessionShutdownSpec } from "../specs/session-shutdown.ts";

// ---------------------------------------------------------------------------
// Synthetic fixtures
// ---------------------------------------------------------------------------

/**
 * PRISTINE — upstream pi without the patch. The event parameter is used
 * directly with no guard.
 */
const PRISTINE = `
export async function emitSessionShutdownEvent(extensionRunner, event) {
    if (extensionRunner.hasHandlers("session_shutdown")) {
        console.log("Emitting session_shutdown event");
    }
    await extensionRunner.emit(event);
}
`;

/**
 * PATCHED — the current form with the shutdownEvent guard variable.
 */
const PATCHED = `
export async function emitSessionShutdownEvent(extensionRunner, event) {
    const shutdownEvent = event ?? { type: "session_shutdown" };
    if (extensionRunner.hasHandlers("session_shutdown")) {
        console.log("Emitting session_shutdown event");
    }
    await extensionRunner.emit(shutdownEvent);
}
`;

/**
 * ALTERNATE_LOGICAL_OR — uses || instead of ??. Semantically equivalent for
 * the null/undefined case, and the spec should accept it.
 */
const ALTERNATE_LOGICAL_OR = `
export async function emitSessionShutdownEvent(extensionRunner, event) {
    const shutdownEvent = event || { type: "session_shutdown" };
    if (extensionRunner.hasHandlers("session_shutdown")) {
        console.log("Emitting session_shutdown event");
    }
    await extensionRunner.emit(shutdownEvent);
}
`;

/**
 * FUTURE_RENAMED — hypothetical future pi where the variable name changed
 * from `shutdownEvent` to `evt`, but the guard and usage are intact. The spec
 * must accept this (proof of decoupling from specific variable names).
 */
const FUTURE_RENAMED = `
export async function emitSessionShutdownEvent(extensionRunner, event) {
    const evt = event ?? { type: "session_shutdown" };
    if (extensionRunner.hasHandlers("session_shutdown")) {
        console.log("Emitting session_shutdown event");
    }
    await extensionRunner.emit(evt);
}
`;

/**
 * NEAR_MISS — defines a guarded variable but still emits the raw event
 * parameter (the guard is dead code). The spec must reject this.
 */
const NEAR_MISS = `
export async function emitSessionShutdownEvent(extensionRunner, event) {
    const shutdownEvent = event ?? { type: "session_shutdown" };
    if (extensionRunner.hasHandlers("session_shutdown")) {
        console.log("Emitting session_shutdown event");
    }
    await extensionRunner.emit(event);
}
`;

/**
 * PARTIAL — the guard variable is introduced but only one emit call was
 * updated; another still uses the raw event. The spec must reject this.
 */
const PARTIAL = `
export async function emitSessionShutdownEvent(extensionRunner, event) {
    const shutdownEvent = event ?? { type: "session_shutdown" };
    if (extensionRunner.hasHandlers("session_shutdown")) {
        await extensionRunner.emit(shutdownEvent);
    }
    await extensionRunner.emit(event);
}
`;

// ---------------------------------------------------------------------------
// 1. verify() correctness
// ---------------------------------------------------------------------------

describe("session-shutdown spec.verify", () => {
	test("STALE: rejects pristine pi (no patch applied)", () => {
		const r = sessionShutdownSpec.verify(PRISTINE);
		assert.equal(r.ok, false);
		if (!r.ok) {
			assert.ok(
				r.failures.some((f) => /null guard/i.test(f)),
				"expected failure mentioning missing null guard",
			);
		}
	});

	test("ALREADY-PATCHED: accepts the current ?? {} form", () => {
		const r = sessionShutdownSpec.verify(PATCHED);
		assert.equal(r.ok, true, !r.ok ? r.failures.join("; ") : undefined);
	});

	test("PERMISSIVE: accepts alternate form with || instead of ??", () => {
		const r = sessionShutdownSpec.verify(ALTERNATE_LOGICAL_OR);
		assert.equal(r.ok, true, !r.ok ? r.failures.join("; ") : undefined);
	});

	test("PERMISSIVE: accepts future-refactored form with renamed variable", () => {
		const r = sessionShutdownSpec.verify(FUTURE_RENAMED);
		assert.equal(r.ok, true, !r.ok ? r.failures.join("; ") : undefined);
	});

	test("NEAR-MISS: rejects when guard is defined but not used (still emits raw event)", () => {
		const r = sessionShutdownSpec.verify(NEAR_MISS);
		assert.equal(r.ok, false);
		if (!r.ok) {
			assert.ok(
				r.failures.some((f) => /emit.*event/i.test(f)),
				"expected failure mentioning emit(event)",
			);
		}
	});

	test("PARTIAL: rejects when one emit is patched but another still uses raw event", () => {
		const r = sessionShutdownSpec.verify(PARTIAL);
		assert.equal(r.ok, false);
		if (!r.ok) {
			assert.ok(
				r.failures.some((f) => /emit.*event/i.test(f)),
				"expected failure mentioning emit(event)",
			);
		}
	});
});
