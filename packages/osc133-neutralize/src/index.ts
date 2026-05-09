/**
 * osc133-neutralize — Runtime patch to remove OSC 133 iTerm2 markers.
 *
 * Pi core emits OSC 133;A/B/C sequences around user/assistant messages
 * for iTerm2 prompt navigation. These cause viewport/graphics corruption
 * in many terminal setups. This extension neutralizes them at load time
 * and on every session_start.
 */
import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { findPiCodingAgentDistFromCaller } from "../../pi-resolve/src/index.ts";

const PROBE = "modes/interactive/components/user-message.js";

function findPiDistDir(override?: string): string | null {
	const res = findPiCodingAgentDistFromCaller(import.meta.url, { probe: PROBE, override });
	return res?.distDir ?? null;
}

function neutralizeOsc133(distDir: string): "patched" | "already" | "failed" {
	const files = [
		path.join(distDir, "modes", "interactive", "components", "user-message.js"),
		path.join(distDir, "modes", "interactive", "components", "assistant-message.js"),
	];

	let anyPatched = false;
	for (const filePath of files) {
		if (!fs.existsSync(filePath)) continue;
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf8");
		} catch {
			return "failed";
		}

		if (content.includes('const OSC133_ZONE_START = "";')) continue;

		content = content.replace(/const OSC133_ZONE_START = "[^"]*";/g, 'const OSC133_ZONE_START = "";');
		content = content.replace(/const OSC133_ZONE_END = "[^"]*";/g, 'const OSC133_ZONE_END = "";');
		content = content.replace(/const OSC133_ZONE_FINAL = "[^"]*";/g, 'const OSC133_ZONE_FINAL = "";');

		try {
			fs.writeFileSync(filePath, content, "utf8");
			anyPatched = true;
		} catch {
			return "failed";
		}
	}

	return anyPatched ? "patched" : "already";
}

export default function (pi: ExtensionAPI) {
	const distDir = findPiDistDir();
	const result = distDir ? neutralizeOsc133(distDir) : "failed";

	if (result === "patched") {
		console.error("[osc133-neutralize] patched");
	} else if (result === "already") {
		console.error("[osc133-neutralize] already neutralized");
	} else {
		console.error("[osc133-neutralize] FAILED");
	}

	pi.on("session_start", async (_event, ctx: any) => {
		const d = findPiDistDir(ctx?.piInstallDir);
		if (d) neutralizeOsc133(d);
	});
}
