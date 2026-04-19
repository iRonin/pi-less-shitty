/**
 * ctrl-e-multiline — Rapid Ctrl+E presses navigate to next lines.
 *
 * When the cursor is already at the end of a line and Ctrl+E is pressed
 * again (within 500ms), the cursor moves to the end of the next line.
 * Each subsequent rapid press continues down the document until reaching
 * the end of the last line.
 *
 * Patched file:
 * - `@mariozechner/pi-tui/dist/components/editor.js` — adds rapid-press
 *   state tracking and modifies moveToLineEnd() behavior
 */
import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// ---------------------------------------------------------------------------
// File resolution
// ---------------------------------------------------------------------------

function findPiTuiEditorJs(): string | null {
	const candidates = [
		"/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/node_modules/@mariozechner/pi-tui/dist/components/editor.js",
		"/usr/local/lib/node_modules/@mariozechner/pi-coding-agent/node_modules/@mariozechner/pi-tui/dist/components/editor.js",
	];
	for (const c of candidates) {
		if (fs.existsSync(c)) return c;
	}
	// Fallback: resolve relative to __dirname
	let dir = __dirname;
	for (let i = 0; i < 10; i++) {
		const candidate = path.join(dir, "node_modules", "@mariozechner", "pi-tui", "dist", "components", "editor.js");
		if (fs.existsSync(candidate)) return candidate;
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

// ---------------------------------------------------------------------------
// Patching
// ---------------------------------------------------------------------------

const PATCH_MARKER = "// ctrl-e-multiline patch";

function applyPatch(filePath: string): "patched" | "already" | "failed" {
	let content: string;
	try {
		content = fs.readFileSync(filePath, "utf8");
	} catch {
		return "failed";
	}

	if (content.includes(PATCH_MARKER)) return "already";

	// 1. Add state tracking properties after the ctrl-a-multiline block
	const injectStateOld = "    ctrlAPressThreshold = 500; // ms";
	const injectStateNew = `    ctrlAPressThreshold = 500; // ms
    // ctrl-e-multiline patch — track rapid Ctrl+E presses for multi-line navigation
    ctrlELastPressTime = 0;
    ctrlEPressThreshold = 500; // ms`;

	// 2. Replace moveToLineEnd() with multi-line version
	const moveToLineEndOld = `    moveToLineEnd() {
        this.lastAction = null;
        const currentLine = this.state.lines[this.state.cursorLine] || "";
        this.setCursorCol(currentLine.length);
    }`;

	const moveToLineEndNew = `    moveToLineEnd() {
        this.lastAction = null;
        // ctrl-e-multiline patch — rapid Ctrl+E navigates to next lines
        const now = Date.now();
        const rapidPress = (now - this.ctrlELastPressTime) < this.ctrlEPressThreshold;
        this.ctrlELastPressTime = now;

        const currentLine = this.state.lines[this.state.cursorLine] || "";
        if (this.state.cursorCol >= currentLine.length && this.state.cursorLine < this.state.lines.length - 1 && rapidPress) {
            // Already at end of line and rapid press — go to end of next line
            this.state.cursorLine++;
            const nextLine = this.state.lines[this.state.cursorLine] || "";
            this.setCursorCol(nextLine.length);
        } else {
            // Normal behavior — go to end of current line
            this.setCursorCol(currentLine.length);
        }
    }`;

	if (!content.includes(injectStateOld) || !content.includes(moveToLineEndOld)) {
		return "failed";
	}

	content = content.replace(injectStateOld, injectStateNew);
	content = content.replace(moveToLineEndOld, moveToLineEndNew);

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
