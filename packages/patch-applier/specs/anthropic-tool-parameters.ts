import type { PatchSpec } from "../src/types.js";

/**
 * anthropic-tool-parameters — null guard for tool.parameters in pi-ai's
 * anthropic provider.
 *
 * When pi-ai's anthropic provider converts a tool schema for submission to
 * Claude, it reads `tool.parameters` and assumes it's always defined. But
 * some tool schemas have `parameters: undefined`, which crashes Opus with
 * a type error. This patch adds a null guard (`?? {}`) so undefined becomes
 * an empty schema object.
 *
 * Target location: pi-ai is a nested dependency under pi-coding-agent,
 * not a sibling at the scope level. The actual path is:
 *   <pi-coding-agent>/node_modules/@earendil-works/pi-ai/dist/providers/anthropic.js
 *
 * From the `distDir` passed to the applier (which is `<pi-coding-agent>/dist`),
 * the relative path is `../node_modules/@earendil-works/pi-ai/dist/providers/anthropic.js`.
 *
 * **Scope dependency**: This spec hardcodes `@earendil-works` (the current
 * scope as of pi v0.74.0+). If the scope changes again, the target won't
 * resolve and the applier will report "cannot read target". Extending the
 * applier to support scope-agnostic sibling resolution is future work.
 */
export const spec: PatchSpec = {
	id: "anthropic-tool-parameters",
	target: "../node_modules/@earendil-works/pi-ai/dist/providers/anthropic.js",
	intent:
		"In the anthropic provider's tool schema conversion logic, ensure that `tool.parameters` is never undefined. When assigning it to a local variable (commonly named `schema`), apply a null-coalescing operator so undefined becomes an empty object. The rest of the function must be preserved unchanged.",
	hint: `Look for a line shaped like:
  const schema = tool.parameters;

Rewrite it to:
  const schema = tool.parameters ?? {};

Preserve the variable name (it may not be "schema" in future pi versions),
and preserve all surrounding code. Only add the null guard.`,
	marker: "tool.parameters ?? {}",

	verify(content: string) {
		const failures: string[] = [];

		// 1. The null-guarded form must be present somewhere
		const hasNullishCoalescing = /tool\.parameters\s*\?\?\s*\{\s*\}/.test(content);
		const hasLogicalOr = /tool\.parameters\s*\|\|\s*\{\s*\}/.test(content);
		const hasExplicitCheck = /if\s*\(\s*!tool\.parameters\s*\)/.test(content);

		if (!hasNullishCoalescing && !hasLogicalOr && !hasExplicitCheck) {
			failures.push(
				"Missing null guard for tool.parameters — expected `?? {}`, `|| {}`, or an explicit if-check",
			);
		}

		// 2. The original un-guarded form must be gone (partial patch detection)
		const pristineAssignment = /const\s+\w+\s*=\s*tool\.parameters\s*;/;
		if (pristineAssignment.test(content)) {
			failures.push(
				"Original `const <var> = tool.parameters;` still present without guard",
			);
		}

		return failures.length === 0 ? { ok: true } : { ok: false, failures };
	},
};
