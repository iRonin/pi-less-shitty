import type { PatchSpec } from "../src/types.js";

/**
 * model-registry-fix — two behavior fixes to pi's ModelRegistry that survive
 * `npm install` (i.e. get re-applied to the dist after an upstream upgrade).
 *
 * Fix 1 — validateConfig:
 *   pi's validateConfig() throws "apiKey is required when defining custom
 *   models" for any provider in models.json that defines custom models.
 *   This is wrong for providers that authenticate via OAuth (e.g. kilocode),
 *   where credentials live in pi's authStorage, not in the config object.
 *   The fix changes the guard from "no apiKey → throw" to "no apiKey AND
 *   no auth-storage credential → throw".
 *
 * Fix 2 — applyProviderConfig:
 *   When an extension calls registerProvider() (which happens on every
 *   session_start), applyProviderConfig() rebuilds the provider's model list
 *   from scratch. Any custom models the user added for that provider via
 *   ~/.pi/agent/models.json are silently wiped. The fix snapshots the
 *   provider's existing models BEFORE the wipe (these are the merged
 *   models.json entries from a previous loadModels()) and re-merges them
 *   AFTER the rebuild so user-defined models survive.
 *
 * The spec is invariant to:
 *   - error-message wording (pi may reword the apiKey message)
 *   - indentation of the dist (compiler-emitted whitespace can drift)
 *   - the variable names "providerConfig", "providerName", "_savedJson", "_s"
 *     (only the structural pattern matters)
 *
 * If only one of the two fixes is applied, verify() reports a *specific*
 * failure naming the missing fix — this prevents silent half-patched dists.
 */
export const spec: PatchSpec = {
	id: "model-registry-fix",
	target: "core/model-registry.js",
	intent:
		"Two behavioral fixes inside core/model-registry.js. " +
		"(1) validateConfig must accept providers that authenticate via authStorage " +
		"(e.g. OAuth) without requiring an apiKey in the config — the apiKey-required " +
		"guard must also check authStorage.hasAuth(providerName) before throwing. " +
		"(2) applyProviderConfig must preserve custom models loaded from " +
		"~/.pi/agent/models.json: snapshot the provider's existing models before the " +
		"full-replacement filter, then re-merge any not present after the new models " +
		"and any OAuth modifyModels hook have run. Both fixes must be present; a " +
		"partial application is treated as failed.",
	hint:
		"Fix 1 (validateConfig): locate the guard\n" +
		"    if (!providerConfig.apiKey) { throw new Error(`Provider ${providerName}: \"apiKey\" is required when defining custom models.`); }\n" +
		"and rewrite it to\n" +
		"    if (!providerConfig.apiKey && !this.authStorage.hasAuth(providerName)) { throw new Error(`Provider ${providerName}: \"apiKey\" is required when defining custom models (or authenticate via /login).`); }\n" +
		"\n" +
		"Fix 2 (applyProviderConfig): inside the `if (config.models && config.models.length > 0)` branch:\n" +
		"  (a) BEFORE the line\n" +
		"      this.models = this.models.filter((m) => m.provider !== providerName);\n" +
		"      insert\n" +
		"      const _savedJson = this.models.filter((m) => m.provider === providerName);\n" +
		"  (b) AFTER all the new models have been pushed (and any `config.oauth?.modifyModels` block has run, if present), but BEFORE the closing brace of the `if (config.models …)` block, insert the merge-back loop:\n" +
		"      for (const _s of _savedJson) {\n" +
		"          if (!this.models.some((m) => m.id === _s.id)) this.models.push(_s);\n" +
		"      }\n" +
		"\n" +
		"Variable names (providerConfig, providerName, _savedJson, _s) and the exact error-message wording are not load-bearing — match the dist's existing style.",
	marker: "_savedJson = this.models.filter",

	verify(content: string) {
		const failures: string[] = [];

		// ------------------------------------------------------------------
		// Fix 1: validateConfig accepts authStorage-authenticated providers
		// ------------------------------------------------------------------
		// Match the patched apiKey guard:
		//     if (!<X>.apiKey && !<Y>.hasAuth(<Z>)) { ... }
		// where:
		//   - <X> is some object expression (e.g. providerConfig) — \w-only is fine,
		//     pi's compiler emits plain identifiers here
		//   - <Y> is some object/member chain (e.g. this.authStorage) — allow dotted
		//   - <Z> is some identifier passed to hasAuth (e.g. providerName)
		// Whitespace is fully flexible. The order ("apiKey first, hasAuth second")
		// is conventional but we accept either order.
		const fix1Forward =
			/!\s*\w+(?:\.\w+)*\.apiKey\s*&&\s*!\s*\w+(?:\.\w+)*\.hasAuth\s*\(\s*\w+\s*\)/;
		const fix1Reverse =
			/!\s*\w+(?:\.\w+)*\.hasAuth\s*\(\s*\w+\s*\)\s*&&\s*!\s*\w+(?:\.\w+)*\.apiKey\b/;
		const fix1Applied = fix1Forward.test(content) || fix1Reverse.test(content);

		if (!fix1Applied) {
			failures.push(
				"Fix 1 not applied: validateConfig still requires apiKey unconditionally — " +
					"the guard must also check authStorage.hasAuth(providerName) " +
					"so OAuth-authenticated providers don't throw.",
			);
		}

		// ------------------------------------------------------------------
		// Fix 2: applyProviderConfig snapshots + re-merges custom models
		// ------------------------------------------------------------------
		// Snapshot pattern: a const declaration that captures the provider's
		// existing models BEFORE the wipe filter. Variable name not pinned;
		// the right-hand side is what defines the behavior.
		const fix2Snapshot =
			/\bconst\s+\w+\s*=\s*this\.models\.filter\s*\(\s*\(?\s*\w+\s*\)?\s*=>\s*\w+\.provider\s*===\s*\w+\s*\)/;
		// Restore loop: iterate the snapshot and push back missing entries.
		// Matches `for (const X of <snapVar>)` where the loop body contains
		// `this.models.push` — which is the merge-back behavior.
		const fix2RestoreLoop =
			/for\s*\(\s*(?:const|let|var)\s+\w+\s+of\s+(\w+)\s*\)\s*\{[\s\S]{0,400}?this\.models\.push\b/;

		const snapshotMatch = content.match(fix2Snapshot);
		const restoreMatch = content.match(fix2RestoreLoop);

		// Establish that the snapshot variable from (a) is the one iterated in (b).
		// We don't pin the name, but the two halves must reference the same var.
		let fix2Applied = false;
		if (snapshotMatch && restoreMatch) {
			// Pull the variable name from the snapshot match by re-running with a capture group
			const snapVarRe =
				/\bconst\s+(\w+)\s*=\s*this\.models\.filter\s*\(\s*\(?\s*\w+\s*\)?\s*=>\s*\w+\.provider\s*===\s*\w+\s*\)/;
			const snapVar = content.match(snapVarRe)?.[1];
			const restoreVar = restoreMatch[1];
			if (snapVar && restoreVar && snapVar === restoreVar) {
				fix2Applied = true;
			}
		}

		if (!fix2Applied) {
			if (!snapshotMatch) {
				failures.push(
					"Fix 2 not applied: applyProviderConfig does not snapshot custom " +
						"models before the full-replacement filter — custom models from " +
						"~/.pi/agent/models.json will be wiped on every registerProvider() call.",
				);
			} else if (!restoreMatch) {
				failures.push(
					"Fix 2 incomplete: snapshot is captured but never merged back — " +
						"a `for (const _ of <snapshot>) { ... this.models.push(...) }` " +
						"loop must run after the new models are pushed.",
				);
			} else {
				failures.push(
					"Fix 2 incomplete: snapshot variable and restore-loop variable " +
						"do not match — the merge-back loop is iterating the wrong array.",
				);
			}
		}

		return failures.length === 0 ? { ok: true } : { ok: false, failures };
	},
};
