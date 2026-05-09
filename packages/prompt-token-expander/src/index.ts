/**
 * Prompt Token Expander Extension
 *
 * Expands tokens like {{PI_DIST}} in the assembled system prompt before it's
 * sent to the LLM. Solves the scope-rename auto-refresh problem by making
 * prompt files reference install paths via durable tokens instead of hardcoded
 * paths.
 *
 * Tokens supported:
 *   {{PI_DIST}}      - pi-coding-agent/dist directory
 *   {{PI_PKG_DIR}}   - pi-coding-agent package root
 *   {{PI_PKG_NAME}}  - e.g. @earendil-works/pi-coding-agent
 *   {{PI_SCOPE}}     - e.g. @earendil-works
 *   {{PI_VERSION}}   - version from package.json
 *   {{PI_DOCS}}      - package docs directory
 *   {{PI_EXAMPLES}}  - package examples directory
 *   {{PI_README}}    - package README.md path
 *
 * Unknown tokens are left untouched (not an error).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { findPiCodingAgentDistFromCaller } from "../../pi-resolve/src/index.ts";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Build the token substitution map from the current pi install.
 * Returns empty object if pi-resolve fails to locate the install.
 */
export function buildTokenMap(): Record<string, string> {
	const res = findPiCodingAgentDistFromCaller(import.meta.url);
	if (!res) return {};

	let version = "unknown";
	try {
		const pkgJsonPath = path.join(res.pkgDir, "package.json");
		const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8")) as {
			version?: string;
		};
		version = pkgJson.version ?? "unknown";
	} catch {
		// keep "unknown"
	}

	return {
		PI_DIST: res.distDir,
		PI_PKG_DIR: res.pkgDir,
		PI_PKG_NAME: res.pkgName,
		PI_SCOPE: res.scope,
		PI_VERSION: version,
		PI_DOCS: path.join(res.pkgDir, "docs"),
		PI_EXAMPLES: path.join(res.pkgDir, "examples"),
		PI_README: path.join(res.pkgDir, "README.md"),
	};
}

/**
 * Expand tokens in the given text. Tokens are case-sensitive and must be
 * uppercase with underscores, wrapped in double braces: {{TOKEN_NAME}}.
 * Unknown tokens are left as-is.
 */
export function expandTokens(text: string, tokens: Record<string, string>): string {
	return text.replace(/\{\{([A-Z_]+)\}\}/g, (match, key) => tokens[key] ?? match);
}

export default function (pi: ExtensionAPI) {
	const tokens = buildTokenMap();

	pi.on("before_agent_start", async (event, _ctx) => {
		// Expand tokens in the chained system prompt
		const expanded = expandTokens(event.systemPrompt, tokens);
		return { systemPrompt: expanded };
	});
}
