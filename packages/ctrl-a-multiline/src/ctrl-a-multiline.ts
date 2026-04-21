/**
 * ctrl-a-multiline — Rapid Ctrl+A presses navigate to previous lines.
 * Plus: ctrl+shift+up/down jump to beginning/end of prompt.
 *
 * Ctrl+A rapid-press behavior:
 * When the cursor is already at the start of a line and Ctrl+A is pressed
 * again (within 500ms), the cursor moves to the start of the previous line.
 * Each subsequent rapid press continues up the document until reaching
 * the beginning of the first line.
 *
 * ctrl+shift+up/down behavior:
 * Jump to the very beginning or end of the entire prompt text — no Fn combos needed.
 *
 * Patched files:
 * - `@mariozechner/pi-tui/dist/components/editor.js` — adds rapid-press
 *   state tracking, modifies moveToLineStart(), adds cursorDocumentStart/End
 * - `@mariozechner/pi-coding-agent/dist/core/keybindings.js` — adds keybindings
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

function findKeybindingsJs(): string | null {
	const candidates = [
		"/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/dist/core/keybindings.js",
		"/usr/local/lib/node_modules/@mariozechner/pi-coding-agent/dist/core/keybindings.js",
	];
	for (const c of candidates) {
		if (fs.existsSync(c)) return c;
	}
	return null;
}

// ---------------------------------------------------------------------------
// Patching
// ---------------------------------------------------------------------------

const PATCH_MARKER = "// ctrl-a-multiline patch";
const JUMP_MARKER = "// cursor-document-jump patch";

function applyEditorPatch(filePath: string): "patched" | "already" | "failed" {
	let content: string;
	try {
		content = fs.readFileSync(filePath, "utf8");
	} catch {
		return "failed";
	}

	if (content.includes(PATCH_MARKER) && content.includes(JUMP_MARKER)) return "already";

	// 1. Add state tracking for rapid Ctrl+A
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

	// 3. Add cursorDocumentStart/End methods before deleteToStartOfLine
	const deleteToStartMarker = "    deleteToStartOfLine() {";

	const jumpMethods = `    // cursor-document-jump patch — jump to beginning/end of entire prompt
    cursorDocumentStart() {
        this.lastAction = null;
        this.state.cursorLine = 0;
        this.setCursorCol(0);
    }
    cursorDocumentEnd() {
        this.lastAction = null;
        const lastIdx = this.state.lines.length - 1;
        this.state.cursorLine = lastIdx;
        const lastLine = this.state.lines[lastIdx] || "";
        this.setCursorCol(lastLine.length);
    }
    deleteToStartOfLine() {`;

	// 4. Add keybinding handlers after pageDown block
	const pageDownOld = `        if (kb.matches(data, "tui.editor.pageDown")) {
            this.pageScroll(1);
            return;
        }
        // Character jump mode triggers`;

	const pageDownNew = `        if (kb.matches(data, "tui.editor.pageDown")) {
            this.pageScroll(1);
            return;
        }
        // cursor-document-jump patch — jump to top/bottom of prompt
        if (kb.matches(data, "tui.editor.cursorDocumentStart")) {
            this.cursorDocumentStart();
            return;
        }
        if (kb.matches(data, "tui.editor.cursorDocumentEnd")) {
            this.cursorDocumentEnd();
            return;
        }
        // Character jump mode triggers`;

	let patched = content;

	if (content.includes(injectStateOld)) {
		patched = patched.replace(injectStateOld, injectStateNew);
	}
	if (content.includes(moveToLineStartOld)) {
		patched = patched.replace(moveToLineStartOld, moveToLineStartNew);
	}
	if (!content.includes(JUMP_MARKER)) {
		if (content.includes(deleteToStartMarker)) {
			patched = patched.replace(deleteToStartMarker, jumpMethods);
		}
		if (content.includes(pageDownOld)) {
			patched = patched.replace(pageDownOld, pageDownNew);
		}
	}

	if (patched === content && !content.includes(JUMP_MARKER)) return "failed";

	try {
		fs.writeFileSync(filePath, patched, "utf8");
		return content.includes(PATCH_MARKER) && content.includes(JUMP_MARKER) ? "already" : "patched";
	} catch {
		return "failed";
	}
}

function applyKeybindingsPatch(filePath: string): "patched" | "already" | "failed" {
	let content: string;
	try {
		content = fs.readFileSync(filePath, "utf8");
	} catch {
		return "failed";
	}

	if (content.includes("cursorDocumentStart")) return "already";

	// Add keybindings after deleteNoninvasive
	const injectAfter = `    "app.session.deleteNoninvasive": {
        defaultKeys: "ctrl+backspace",
        description: "Delete session when query is empty",
    },
};`;

	const injectNew = `    "app.session.deleteNoninvasive": {
        defaultKeys: "ctrl+backspace",
        description: "Delete session when query is empty",
    },
    "tui.editor.cursorDocumentStart": {
        defaultKeys: "ctrl+shift+up",
        description: "Jump to beginning of prompt",
    },
    "tui.editor.cursorDocumentEnd": {
        defaultKeys: "ctrl+shift+down",
        description: "Jump to end of prompt",
    },
};`;

	if (!content.includes(injectAfter)) return "failed";

	content = content.replace(injectAfter, injectNew);

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
	const results: string[] = [];

	const editorPath = findPiTuiEditorJs();
	if (editorPath) {
		results.push(`editor.js: ${applyEditorPatch(editorPath)}`);
	} else {
		results.push("editor.js: NOT FOUND");
	}

	const kbPath = findKeybindingsJs();
	if (kbPath) {
		results.push(`keybindings.js: ${applyKeybindingsPatch(kbPath)}`);
	} else {
		results.push("keybindings.js: NOT FOUND");
	}

	// Re-apply on every session start (survives npm update)
	pi.on("session_start", async () => {
		const ep = findPiTuiEditorJs();
		if (ep) applyEditorPatch(ep);
		const kp = findKeybindingsJs();
		if (kp) applyKeybindingsPatch(kp);
	});
}
