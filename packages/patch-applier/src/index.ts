/**
 * Extension entry point.
 *
 * Loads all specs from ../specs/, runs the applier against the resolved
 * pi dist directory at session_start. Failures are surfaced via stderr;
 * a future pass will add a TUI status section.
 *
 * The applier is also exposed as an exported function so a CLI wrapper
 * (or another extension) can trigger a pass on demand — e.g. after `npm update`.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { findPiCodingAgentDistFromCaller } from "../../pi-resolve/src/index.ts";

import { applyAll } from "./applier.ts";
import type { PatchSpec } from "./types.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function findPiDistDir(override?: string): string | null {
	const res = findPiCodingAgentDistFromCaller(import.meta.url, { override });
	return res?.distDir ?? null;
}

async function loadSpecs(): Promise<PatchSpec[]> {
	const specsDir = path.resolve(__dirname, "..", "specs");
	if (!fs.existsSync(specsDir)) return [];
	const out: PatchSpec[] = [];
	for (const f of fs.readdirSync(specsDir)) {
		if (!f.endsWith(".ts") && !f.endsWith(".js")) continue;
		const mod = await import(path.join(specsDir, f));
		const s: PatchSpec | undefined = mod.spec ?? mod.default;
		if (s && typeof s.id === "string" && typeof s.verify === "function") {
			out.push(s);
		} else {
			console.error(`[patch-applier] ${f} does not export a valid spec`);
		}
	}
	return out;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event: unknown, ctx: any) => {
		const distDir = findPiDistDir(ctx?.piInstallDir);
		if (!distDir) {
			console.error("[patch-applier] could not locate pi dist directory");
			return;
		}
		try {
			const specs = await loadSpecs();
			if (specs.length === 0) return;
			const results = await applyAll(specs, { distDir });
			for (const r of results) {
				const tag =
					r.status === "applied" ? "[patch-applier]" : r.status === "failed" ? "[patch-applier FAIL]" : "";
				if (tag) {
					console.error(`${tag} ${r.specId}: ${r.status}${r.message ? ` — ${r.message}` : ""}`);
				}
			}
		} catch (e: any) {
			console.error(`[patch-applier] crashed: ${e?.message ?? String(e)}`);
		}
	});
}
