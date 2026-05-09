/**
 * compaction-tokens — Runtime patch: show result token count in compaction UI.
 *
 * Patches `compaction-summary-message.js` to display both before and after
 * token counts: "Compacted from 264,779 → 12,345 tokens".
 *
 * Implementation note: previously this used `fs.copyFileSync(bundledPatch, dist)`
 * — a wholesale overwrite that silently destroyed any upstream fix on
 * `npm update`. This now does an in-place regex transform so upstream changes
 * to unrelated parts of the file are preserved.
 */
import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { findPiCodingAgentDistFromCaller } from "../../pi-resolve/src/index.ts";

const PROBE = "modes/interactive/interactive-mode.js";

function findPiDistDir(override?: string): string | null {
	const res = findPiCodingAgentDistFromCaller(import.meta.url, { probe: PROBE, override });
	return res?.distDir ?? null;
}

// Upstream pi v0.74.0+ ships this feature natively (variable name `tokenStrAfter`).
// Pre-0.74.0 dist had only the before-count and we patched it in (variable name
// `afterStr`). Detect EITHER form as "already" so we don't loop into a failed
// re-apply on the new dist.
const ALREADY_PATCHED_RE = /→\s*\$\{(?:afterStr|tokenStrAfter)\}\s+tokens/;

function patchCompactionSummary(distDir: string): "patched" | "already" | "failed" {
	const filePath = path.join(
		distDir,
		"modes",
		"interactive",
		"components",
		"compaction-summary-message.js",
	);
	let content: string;
	try {
		content = fs.readFileSync(filePath, "utf8");
	} catch {
		return "failed";
	}

	if (ALREADY_PATCHED_RE.test(content)) return "already";

	// Step 1 — inject tokensAfter / afterStr after the existing tokenStr line.
	const tokenStrAnchorRe =
		/(\s*const tokenStr = this\.message\.tokensBefore\.toLocaleString\(\);)/;
	if (!tokenStrAnchorRe.test(content)) return "failed";

	const insertedComputation = `\n        // compaction-tokens patch — estimate post-compaction tokens from summary length\n        const tokensAfter = Math.ceil(this.message.summary.length / 4);\n        const afterStr = tokensAfter.toLocaleString();`;

	let next = content.replace(tokenStrAnchorRe, `$1${insertedComputation}`);

	// Step 2 — rewrite expanded header. Tolerate spacing/quote variants.
	// Target pattern (template literal contents): "**Compacted ${tokenStr} tokens**"
	const expandedRe =
		/\*\*Compacted\s+\$\{tokenStr\}\s+tokens\*\*/g;
	next = next.replace(expandedRe, "**Compacted from \${tokenStr} → \${afterStr} tokens**");

	// Step 3 — rewrite collapsed line. Target: "Compacted ${tokenStr} tokens ("
	const collapsedRe = /Compacted\s+\$\{tokenStr\}\s+tokens\s+\(/g;
	next = next.replace(collapsedRe, "Compacted from \${tokenStr} → \${afterStr} tokens (");

	if (next === content) return "failed";
	if (!ALREADY_PATCHED_RE.test(next)) return "failed";

	try {
		fs.writeFileSync(filePath, next, "utf8");
		return "patched";
	} catch {
		return "failed";
	}
}

export default function (pi: ExtensionAPI) {
	const distDir = findPiDistDir();
	if (distDir) {
		const result = patchCompactionSummary(distDir);
		if (result === "patched")
			console.error("[compaction-tokens] patched compaction-summary-message.js");
		else if (result === "failed")
			console.error("[compaction-tokens] failed to patch");
	}

	pi.on("session_start", async (_event: unknown, ctx: any) => {
		const d = findPiDistDir(ctx?.piInstallDir);
		if (d) patchCompactionSummary(d);
	});
}
