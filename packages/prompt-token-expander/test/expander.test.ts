/**
 * Tests for prompt-token-expander
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { expandTokens, buildTokenMap } from "../src/index.ts";

test("expandTokens replaces known tokens", () => {
	const tokens = {
		PI_DIST: "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist",
		PI_VERSION: "0.74.0",
		PI_SCOPE: "@earendil-works",
	};

	const input = "Pi is at {{PI_DIST}} version {{PI_VERSION}} scope {{PI_SCOPE}}";
	const expected =
		"Pi is at /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist version 0.74.0 scope @earendil-works";

	assert.equal(expandTokens(input, tokens), expected);
});

test("expandTokens leaves unknown tokens untouched", () => {
	const tokens = { PI_DIST: "/some/path" };
	const input = "Known: {{PI_DIST}}, unknown: {{FOOBAR}}, another: {{UNKNOWN_TOKEN}}";
	const expected = "Known: /some/path, unknown: {{FOOBAR}}, another: {{UNKNOWN_TOKEN}}";

	assert.equal(expandTokens(input, tokens), expected);
});

test("expandTokens leaves text without tokens unchanged", () => {
	const tokens = { PI_DIST: "/some/path" };
	const input = "This text has no tokens at all.";

	assert.equal(expandTokens(input, tokens), input);
});

test("expandTokens handles empty string", () => {
	const tokens = { PI_DIST: "/some/path" };
	assert.equal(expandTokens("", tokens), "");
});

test("expandTokens handles multiple occurrences of same token", () => {
	const tokens = { PI_DIST: "/path/to/dist" };
	const input = "{{PI_DIST}} and {{PI_DIST}} and {{PI_DIST}}";
	const expected = "/path/to/dist and /path/to/dist and /path/to/dist";

	assert.equal(expandTokens(input, tokens), expected);
});

test("expandTokens does not match lowercase or mixed case tokens", () => {
	const tokens = { PI_DIST: "/path/to/dist" };
	const input = "{{pi_dist}} {{Pi_Dist}} {{PI_DIST}}";
	const expected = "{{pi_dist}} {{Pi_Dist}} /path/to/dist";

	assert.equal(expandTokens(input, tokens), expected);
});

test("buildTokenMap returns expected keys when pi-resolve succeeds", () => {
	const tokens = buildTokenMap();

	// If pi-resolve succeeds, we should have all expected keys
	if (Object.keys(tokens).length > 0) {
		const expectedKeys = [
			"PI_DIST",
			"PI_PKG_DIR",
			"PI_PKG_NAME",
			"PI_SCOPE",
			"PI_VERSION",
			"PI_DOCS",
			"PI_EXAMPLES",
			"PI_README",
		];

		for (const key of expectedKeys) {
			assert.ok(key in tokens, `Expected key ${key} to be present`);
			assert.equal(typeof tokens[key], "string", `Expected ${key} to be a string`);
			assert.ok(tokens[key].length > 0, `Expected ${key} to be non-empty`);
		}

		// Validate structure
		assert.ok(
			tokens.PI_DIST.endsWith("/dist"),
			"PI_DIST should end with /dist",
		);
		assert.ok(
			tokens.PI_PKG_NAME.includes("pi-coding-agent"),
			"PI_PKG_NAME should include pi-coding-agent",
		);
		assert.ok(
			tokens.PI_SCOPE.startsWith("@"),
			"PI_SCOPE should start with @",
		);
		assert.ok(
			tokens.PI_DOCS.endsWith("/docs"),
			"PI_DOCS should end with /docs",
		);
		assert.ok(
			tokens.PI_EXAMPLES.endsWith("/examples"),
			"PI_EXAMPLES should end with /examples",
		);
		assert.ok(
			tokens.PI_README.endsWith("/README.md"),
			"PI_README should end with /README.md",
		);
	} else {
		// If pi-resolve fails (e.g. in a test environment without pi installed),
		// the map should be empty
		assert.deepEqual(tokens, {});
	}
});

test("default export hooks before_agent_start", async () => {
	const events: string[] = [];

	// Mock ExtensionAPI
	const mockPi = {
		on: (event: string, handler: Function) => {
			events.push(event);
		},
	};

	// Import and run the default export
	const extensionModule = await import("../src/index.ts");
	extensionModule.default(mockPi as any);

	// Verify it registered the before_agent_start event
	assert.ok(
		events.includes("before_agent_start"),
		"Extension should register before_agent_start event",
	);
});

test("extension expands tokens in system prompt", async () => {
	let handler: Function | undefined;

	// Mock ExtensionAPI that captures the handler
	const mockPi = {
		on: (event: string, h: Function) => {
			if (event === "before_agent_start") {
				handler = h;
			}
		},
	};

	// Import and run the default export
	const extensionModule = await import("../src/index.ts");
	extensionModule.default(mockPi as any);

	assert.ok(handler, "Handler should be registered");

	// Mock event with a system prompt containing tokens
	const mockEvent = {
		systemPrompt: "Pi is at {{PI_DIST}} version {{PI_VERSION}}",
	};

	const mockCtx = {};

	// Call the handler
	const result = await handler!(mockEvent, mockCtx);

	// Verify tokens are expanded (or left alone if buildTokenMap returned empty)
	assert.ok(result, "Handler should return a result");
	assert.ok("systemPrompt" in result, "Result should have systemPrompt");

	// The prompt should either be expanded (if tokens were built) or unchanged (if empty)
	const tokens = extensionModule.buildTokenMap();
	if (Object.keys(tokens).length > 0) {
		// Tokens should be expanded
		assert.ok(
			!result.systemPrompt.includes("{{PI_DIST}}"),
			"PI_DIST token should be expanded",
		);
		assert.ok(
			!result.systemPrompt.includes("{{PI_VERSION}}"),
			"PI_VERSION token should be expanded",
		);
	} else {
		// No tokens, should be unchanged
		assert.equal(
			result.systemPrompt,
			mockEvent.systemPrompt,
			"System prompt should be unchanged when tokens are empty",
		);
	}
});
