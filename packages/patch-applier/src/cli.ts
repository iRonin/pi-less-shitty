#!/usr/bin/env node
/**
 * patch-applier CLI.
 *
 *   npx tsx packages/patch-applier/src/cli.ts                 # apply all
 *   npx tsx packages/patch-applier/src/cli.ts --check          # dry-run (verify only)
 *   npx tsx packages/patch-applier/src/cli.ts --spec queue-emojis
 *   npx tsx packages/patch-applier/src/cli.ts --dist /path/to/pi-dist
 *
 * Used by:
 *   - pi-upgrade skill, after npm update, to re-derive any patches that broke
 *   - pi-upgrade-checker skill, to dry-run patch survival before upgrade
 *   - Custom orchestration agents, autonomously after detecting upstream changes
 *   - Manual: when adding a new spec or debugging a failed apply
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyAll, applyOne } from "./applier.ts";
import type { PatchSpec, ApplyResult } from "./types.ts";
import { findPiCodingAgentDistFromCaller } from "../../pi-resolve/src/index.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface Args {
	check: boolean;
	spec?: string;
	dist?: string;
	help: boolean;
	json: boolean;
}

function parseArgs(argv: string[]): Args {
	const args: Args = { check: false, help: false, json: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--check" || a === "-c") args.check = true;
		else if (a === "--help" || a === "-h") args.help = true;
		else if (a === "--json") args.json = true;
		else if (a === "--spec") args.spec = argv[++i];
		else if (a === "--dist") args.dist = argv[++i];
	}
	return args;
}

function help() {
	console.log(`patch-applier — AI-driven runtime patcher for pi customizations

Usage:
  patch-applier [options]

Options:
  --check, -c           Dry-run: verify each spec, report status, do not modify dist
  --spec <id>           Apply only the named spec (e.g. queue-emojis)
  --dist <path>         Override pi dist directory (default: auto-detect)
  --json                Emit machine-readable JSON instead of human prose
  --help, -h            Show this help

Exit codes:
  0  — all specs verified or applied successfully
  1  — one or more specs failed to apply / verify
  2  — invocation error (bad args, no specs, no dist)
`);
}

function findPiDistDir(override?: string): string | null {
	const res = findPiCodingAgentDistFromCaller(import.meta.url, { override });
	return res?.distDir ?? null;
}

async function loadSpecs(filterId?: string): Promise<PatchSpec[]> {
	const specsDir = path.resolve(__dirname, "..", "specs");
	if (!fs.existsSync(specsDir)) return [];
	const out: PatchSpec[] = [];
	for (const f of fs.readdirSync(specsDir).sort()) {
		if (!f.endsWith(".ts") && !f.endsWith(".js")) continue;
		const mod = await import(path.join(specsDir, f));
		const s: PatchSpec | undefined = mod.spec ?? mod.default;
		if (!s || typeof s.id !== "string" || typeof s.verify !== "function") continue;
		if (filterId && s.id !== filterId) continue;
		out.push(s);
	}
	return out;
}

function summarize(results: ApplyResult[]): { ok: number; already: number; failed: number; skipped: number } {
	const counts = { ok: 0, already: 0, failed: 0, skipped: 0 };
	for (const r of results) {
		if (r.status === "applied") counts.ok++;
		else if (r.status === "already") counts.already++;
		else if (r.status === "failed") counts.failed++;
	}
	return counts;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		help();
		process.exit(0);
	}

	const distDir = findPiDistDir(args.dist);
	if (!distDir) {
		console.error(
			"error: could not locate pi dist directory. Pass --dist <path> or install @earendil-works/pi-coding-agent (or legacy @earendil-works/pi-coding-agent).",
		);
		process.exit(2);
	}

	const specs = await loadSpecs(args.spec);
	if (specs.length === 0) {
		const msg = args.spec ? `no spec named '${args.spec}'` : "no specs found in specs/ directory";
		if (args.json) {
			console.log(JSON.stringify({ error: msg, results: [] }));
		} else {
			console.error(`error: ${msg}`);
		}
		process.exit(2);
	}

	if (args.check) {
		// Dry-run: just verify each spec, no agent dispatch, no writes
		const results: ApplyResult[] = [];
		for (const spec of specs) {
			const target = path.join(distDir, spec.target);
			let content: string;
			try {
				content = fs.readFileSync(target, "utf8");
			} catch (e: any) {
				results.push({
					specId: spec.id,
					target: spec.target,
					status: "failed",
					message: `cannot read target: ${e?.message ?? e}`,
				});
				continue;
			}
			const v = spec.verify(content);
			results.push({
				specId: spec.id,
				target: spec.target,
				status: v.ok ? "already" : "failed",
				message: v.ok ? undefined : (v as { failures: string[] }).failures.join("; "),
			});
		}
		emit(results, args.json, /* dry */ true);
		const counts = summarize(results);
		process.exit(counts.failed > 0 ? 1 : 0);
	}

	// Live apply
	const results = await applyAll(specs, { distDir });
	emit(results, args.json, /* dry */ false);
	const counts = summarize(results);
	process.exit(counts.failed > 0 ? 1 : 0);
}

function emit(results: ApplyResult[], json: boolean, dry: boolean) {
	if (json) {
		console.log(JSON.stringify({ dry, results }, null, 2));
		return;
	}
	const head = dry ? "patch-applier --check" : "patch-applier";
	console.log(`\n${head}\n${"─".repeat(head.length)}`);
	for (const r of results) {
		const icon =
			r.status === "applied"
				? "✚"
				: r.status === "already"
					? "✓"
					: "✗";
		const status = r.status === "applied" ? "applied" : r.status === "already" ? (dry ? "verified" : "already") : "failed";
		console.log(`  ${icon} ${r.specId.padEnd(24)} ${status}${r.message ? ` — ${r.message}` : ""}`);
	}
	const counts = summarize(results);
	const verb = dry ? "verified" : "applied";
	console.log(
		`\n${counts.ok} ${verb}, ${counts.already} ${dry ? "already-ok" : "already-applied"}, ${counts.failed} failed\n`,
	);
}

main().catch((e) => {
	console.error("patch-applier crashed:", e?.stack ?? e?.message ?? e);
	process.exit(2);
});
