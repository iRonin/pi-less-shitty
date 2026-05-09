/**
 * ctrl-e-multiline — Rapid Ctrl+E presses navigate to next lines.
 *
 * When the cursor is already at the end of a line and Ctrl+E is pressed
 * again (within 500ms), the cursor moves to the end of the next line.
 * Each subsequent rapid press continues down the document until reaching
 * the end of the last line.
 *
 * Patched file:
 * - `@earendil-works/pi-tui/dist/components/editor.js` — adds rapid-press
 *   state tracking and modifies moveToLineEnd() behavior
 */
import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { findPiCodingAgentDistFromCaller, findPiTuiDist } from "../../pi-resolve/src/index.ts";

// ---------------------------------------------------------------------------
// File resolution
// ---------------------------------------------------------------------------

function findPiTuiEditorJs(override?: string): string | null {
	const res = findPiCodingAgentDistFromCaller(import.meta.url, { override });
	if (!res?.distDir) return null;
	const tuiDist = findPiTuiDist(res.distDir, { probe: "components/editor.js" });
	if (!tuiDist) return null;
	return path.join(tuiDist, "components", "editor.js");
}

// ---------------------------------------------------------------------------
// Patching
// ---------------------------------------------------------------------------

export function applyPatch(filePath: string): "patched" | "already" | "failed" {
	let content: string;
	try {
		content = fs.readFileSync(filePath, "utf8");
	} catch {
		return "failed";
	}

	// Idempotency: the patched build defines `ctrlELastPressTime`. Skip if present.
	if (content.includes("ctrlELastPressTime")) return "already";

	// 1. Anchor on the upstream-stable `jumpMode = null;` class field (exists
	// pre-patch and is unrelated to ctrl-a/ctrl-e patching, so it survives the
	// presence/absence of those patches). Append ctrl-e state immediately after.
	const stateAnchorRe = /(?<line>[ \t]+jumpMode\s*=\s*null;)/;

	// 2. Match the upstream pre-patch moveToLineEnd() body. Lazy `[\s\S]*?` and
	// `\1\}` close at the matching method-indent brace. Tolerant of indentation
	// drift. Will NOT match the patched body because that uses `ctrlELastPressTime`.
	const moveToLineEndOldRe =
		/(?<indent>[ \t]+)moveToLineEnd\(\)\s*\{\s*\n[ \t]+this\.lastAction = null;\s*\n[ \t]+const currentLine = this\.state\.lines\[this\.state\.cursorLine\] \|\| "";\s*\n[ \t]+this\.setCursorCol\(currentLine\.length\);\s*\n\k<indent>\}/;

	const stateMatch = content.match(stateAnchorRe);
	if (!stateMatch) return "failed";
	const anchorIndent = (stateMatch.groups?.["line"] ?? "    jumpMode = null;")
		.match(/^[ \t]+/)?.[0] ?? "    ";
	const stateAppend =
		"\n" +
		anchorIndent +
		"// ctrl-e-multiline patch — track rapid Ctrl+E presses for multi-line navigation\n" +
		anchorIndent +
		"ctrlELastPressTime = 0;\n" +
		anchorIndent +
		"ctrlEPressThreshold = 500; // ms";

	if (!moveToLineEndOldRe.test(content)) return "failed";

	content = content.replace(stateAnchorRe, (m) => m + stateAppend);

	const moveMatch = content.match(moveToLineEndOldRe);
	const methodIndent = moveMatch?.groups?.["indent"] ?? "    ";
	const bodyIndent = methodIndent + "    ";
	const moveToLineEndNew =
		methodIndent + "moveToLineEnd() {\n" +
		bodyIndent + "this.lastAction = null;\n" +
		bodyIndent + "// ctrl-e-multiline patch — rapid Ctrl+E navigates to next lines\n" +
		bodyIndent + "const now = Date.now();\n" +
		bodyIndent + "const rapidPress = (now - this.ctrlELastPressTime) < this.ctrlEPressThreshold;\n" +
		bodyIndent + "this.ctrlELastPressTime = now;\n" +
		bodyIndent + "\n" +
		bodyIndent + "const currentLine = this.state.lines[this.state.cursorLine] || \"\";\n" +
		bodyIndent + "if (this.state.cursorCol >= currentLine.length && this.state.cursorLine < this.state.lines.length - 1 && rapidPress) {\n" +
		bodyIndent + "    // Already at end of line and rapid press — go to end of next line\n" +
		bodyIndent + "    this.state.cursorLine++;\n" +
		bodyIndent + "    const nextLine = this.state.lines[this.state.cursorLine] || \"\";\n" +
		bodyIndent + "    this.setCursorCol(nextLine.length);\n" +
		bodyIndent + "} else {\n" +
		bodyIndent + "    // Normal behavior — go to end of current line\n" +
		bodyIndent + "    this.setCursorCol(currentLine.length);\n" +
		bodyIndent + "}\n" +
		methodIndent + "}";

	content = content.replace(moveToLineEndOldRe, moveToLineEndNew);

	try {
		fs.writeFileSync(filePath, content, "utf8");
		return "patched";
	} catch {
		return "failed";
	}
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	const filePath = findPiTuiEditorJs();
	const result = filePath ? applyPatch(filePath) : "failed";

	if (result === "failed") {
		console.error("[ctrl-e-multiline] Failed to patch editor.js");
	}

	// Re-apply on every session start (survives npm update)
	pi.on("session_start", async () => {
		const fp = findPiTuiEditorJs();
		if (fp) applyPatch(fp);
	});
}
