/**
 * ctrl-a-multiline — Rapid Ctrl+A presses navigate to previous lines.
 *
 * When the cursor is already at the start of a line and Ctrl+A is pressed
 * again (within 500ms), the cursor moves to the start of the previous line.
 * Each subsequent rapid press continues up the document until reaching
 * the beginning of the first line.
 *
 * Patched file:
 * - `@mariozechner/pi-tui/dist/components/editor.js` — adds rapid-press
 *   state tracking and modifies moveToLineStart() behavior
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

const PATCH_MARKER = "// ctrl-a-multiline patch";

function applyPatch(filePath: string): "patched" | "already" | "failed" {
	let content: string;
	try {
		content = fs.readFileSync(filePath, "utf8");
	} catch {
		return "failed";
	}

	if (content.includes(PATCH_MARKER)) return "already";

	// 1. Add state tracking properties after "jumpMode = null;"
	const injectStateOld = "    jumpMode = null;";
	const injectStateNew = `    jumpMode = null;
    // ctrl-a-multiline patch — track rapid Ctrl+A presses for multi-line navigation
    ctrlALastPressTime = 0;
    ctrlAPressThreshold = 500; // ms`;

	// 2. Replace moveToLineStart() with multi-line version
	const moveToLineStartOld = `    moveToLineStart() {
        this.lastAction = null;
        this.setCursorCol(0);
    }`;

	const moveToLineStartNew = `    moveToLineStart() {
        this.lastAction = null;
        // ctrl-a-multiline patch — rapid Ctrl+A navigates to previous lines
        const now = Date.now();
        const rapidPress = (now - this.ctrlALastPressTime) < this.ctrlAPressThreshold;
        this.ctrlALastPressTime = now;

        if (this.state.cursorCol === 0 && this.state.cursorLine > 0 && rapidPress) {
            // Already at start of line and rapid press — go to start of previous line
            this.state.cursorLine--;
            this.setCursorCol(0);
        } else {
            // Normal behavior — go to start of current line
            this.setCursorCol(0);
        }
    }`;

	if (!content.includes(injectStateOld) || !content.includes(moveToLineStartOld)) {
		return "failed";
	}

	content = content.replace(injectStateOld, injectStateNew);
	content = content.replace(moveToLineStartOld, moveToLineStartNew);

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
		console.error("[ctrl-a-multiline] Failed to patch editor.js");
	}

	// Re-apply on every session start (survives npm update)
	pi.on("session_start", async () => {
		const fp = findPiTuiEditorJs();
		if (fp) applyPatch(fp);
	});
}
