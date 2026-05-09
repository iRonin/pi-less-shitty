/**
 * read_full — Read entire files with configurable cap.
 *
 * Unlike the built-in `read` tool (capped at 50KB / 2000 lines),
 * this tool reads files up to a configurable limit (default: 150KB).
 * Files exceeding the limit return a warning header with size info
 * but still deliver full content — the cap is advisory metadata,
 * not a hard enforcement, so the agent decides whether to proceed.
 *
 * Settings: ~/.pi/agent/read-full.json
 *   { "maxBytes": 153600 }  // 150KB default
 *
 * Benchmark: typical large technical documents range 100–350KB.
 */

import type { ExtensionAPI, AgentToolResult, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import type { Theme, Component } from "@earendil-works/pi-tui";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { readFile, access, stat } from "node:fs/promises";
import { constants, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, isAbsolute, dirname, join } from "node:path";
import { homedir } from "node:os";

// ── Lazy-loaded theme helpers (avoid circular dep at module init) ───────────

let _keyHint: ((action: string, text: string) => string) | null = null;
let _getLanguageFromPath: ((path: string) => string | undefined) | null = null;
let _highlightCode: ((code: string, lang: string) => string[]) | null = null;

function keyHint(action: string, text: string): string {
	if (!_keyHint) {
		try { _keyHint = require("@earendil-works/pi-tui").keyHint; } catch { _keyHint = (_a: string, t: string) => t; }
	}
	return _keyHint!(action, text);
}

function getLanguageFromPath(p: string): string | undefined {
	if (!_getLanguageFromPath) {
		try { _getLanguageFromPath = require("@earendil-works/pi-tui").getLanguageFromPath; } catch { _getLanguageFromPath = () => undefined; }
	}
	return _getLanguageFromPath!(p);
}

function highlightCode(code: string, lang: string): string[] {
	if (!_highlightCode) {
		try { _highlightCode = require("@earendil-works/pi-tui").highlightCode; } catch { _highlightCode = (s: string) => [s]; }
	}
	return _highlightCode!(code, lang);
}

// ── Allowed file types ──────────────────────────────────────────────────────

const ALLOWED_EXTENSIONS = new Set([
	// Documents / markup
	"txt", "md", "markdown", "html", "htm", "xml", "json", "yaml", "yml", "toml", "ini", "cfg", "conf",
	"csv", "tsv", "log", "text", "rst", "asciidoc", "adoc",
	// Programming languages
	"js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "rb", "pl", "pm", "php",
	"java", "kt", "kts", "scala", "clj", "cljs", "edn",
	"go", "rs", "c", "h", "cpp", "hpp", "cc", "cxx", "cs", "swift",
	"m", "mm", "r", "jl", "lua", "dart", "zig", "nim", "v",
	"hs", "lhs", "ex", "exs", "erl", "hrl", "ml", "mli", "fs", "fsx",
	"groovy", "gvy", "tf", "hcl",
	// Shell / scripts
	"sh", "bash", "zsh", "fish", "ps1", "psm1", "bat", "cmd", "mk", "makefile",
	"dockerfile", "containerfile",
	// Config / templating
	"env", "gitignore", "dockerignore", "editorconfig", "prettierrc", "eslintrc",
	"css", "scss", "sass", "less", "styl", "svg",
	"vue", "svelte", "astro",
	// Data / query
	"sql", "graphql", "gql", "proto", "thrift",
	"wasm", "wat",
	// Other
	"diff", "patch", "po", "pot",
	"tex", "bib", "sty", "cls",
]);

// Binary extensions that should NEVER be read as text (explicit blocklist as safety net)
const BLOCKED_EXTENSIONS = new Set([
	"pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
	"odt", "ods", "odp", "rtf",
	"zip", "gz", "tar", "bz2", "xz", "7z", "rar", "tgz",
	"jpg", "jpeg", "png", "gif", "bmp", "ico", "webp", "tiff", "tif", "svgz",
	"mp3", "mp4", "avi", "mov", "mkv", "webm", "flv", "wav", "ogg",
	"exe", "dll", "so", "dylib", "a", "o", "obj", "lib",
	"bin", "dat", "db", "sqlite", "sqlite3",
	"wasm", // binary wasm (wat is the text format)
	"class", "pyc", "pyo", "pyd",
	"tflite", "pt", "pth", "pb", "onnx",
]);

// Common binary magic byte prefixes
const BINARY_MAGIC: [number[], string][] = [
	[[0x25, 0x50, 0x44, 0x46], "PDF"],       // %PDF
	[[0x50, 0x4B, 0x03, 0x04], "ZIP/Office"], // PK.. (zip, docx, xlsx, etc.)
	[[0xD0, 0xCF, 0x11, 0xE0], "OLE"],       // OLE compound (old doc/xls)
	[[0x7F, 0x45, 0x4C, 0x46], "ELF"],       // \x7fELF
	[[0x4D, 0x5A], "PE/EXE"],               // MZ
	[[0x89, 0x50, 0x4E, 0x47], "PNG"],      // \x89PNG
	[[0xFF, 0xD8, 0xFF], "JPEG"],           // \xFF\xD8\xFF
	[[0x47, 0x49, 0x46], "GIF"],            // GIF
	[[0x52, 0x49, 0x46, 0x46], "RIFF"],    // RIFF (wav, webp, avi)
	[[0x1F, 0x8B], "GZIP"],                 // \x1f\x8b
];

/**
 * Check if a file path has a supported text/programming extension.
 * Returns null if allowed, or an error string if blocked.
 */
function checkFileExtension(filePath: string): string | null {
	const fileName = filePath.split(/[\/\\]/).pop() ?? "";
	const ext = fileName.includes(".")
		? fileName.substring(fileName.lastIndexOf(".") + 1).toLowerCase()
		: "";

	if (!ext) {
		// Extensionless files: check if they look like known config/script names
		const knownNames = new Set([
			"makefile", "dockerfile", "vagrantfile", "gemfile", "rakefile",
			"license", "readme", "changelog", "authors", "contributors",
			"copying", "install", "news", "todo", "changes",
		]);
		if (knownNames.has(fileName.toLowerCase())) return null;
		// Fall through to binary detection for extensionless files
		return null;
	}

	if (BLOCKED_EXTENSIONS.has(ext)) {
		return `read_full does not support .${ext} files (binary / non-text format). Use bash with a tool like \`pdftotext\`, \`pdfgrep\`, or \`strings\` instead.`;
	}

	// If extension is not in the allow-list, reject it
	if (!ALLOWED_EXTENSIONS.has(ext)) {
		return `read_full does not support .${ext} files. Only text and programming language files are supported (txt, md, html, js, ts, py, etc.). For binary files, use bash with appropriate tools (e.g. pdftotext, pdfgrep, strings).`;
	}

	return null;
}

/**
 * Check if file content starts with known binary magic bytes.
 * Reads first 16 bytes. Returns null if text-safe, or error string if binary.
 */
async function checkBinaryMagic(filePath: string): Promise<string | null> {
	try {
		const fd = await import("node:fs/promises").then(m => m.open(filePath, "r"));
		const buffer = Buffer.alloc(16);
		const { bytesRead } = await fd.read(buffer, 0, 16, 0);
		await fd.close();

		for (const [magic, formatName] of BINARY_MAGIC) {
			if (bytesRead >= magic.length) {
				let match = true;
				for (let i = 0; i < magic.length; i++) {
					if (buffer[i] !== magic[i]) { match = false; break; }
				}
				if (match) {
					return `read_full detected a ${formatName} file (binary). Use bash with appropriate tools instead (e.g. pdftotext, pdfgrep, strings, file).`;
				}
			}
		}
	} catch {
		// If we can't read the header, don't block — let the main read attempt handle it
	}
	return null;
}

// ── Config ──────────────────────────────────────────────────────────────────

const DEFAULT_MAX_BYTES = 150 * 1024; // 150KB
const COLLAPSED_LINES = 10;
const SETTINGS_FILE = join(homedir(), ".pi", "agent", "read-full.json");

interface ReadFullSettings {
	maxBytes: number;
}

function loadSettings(): ReadFullSettings {
	try {
		if (existsSync(SETTINGS_FILE)) {
			return JSON.parse(readFileSync(SETTINGS_FILE, "utf-8"));
		}
	} catch {
		// fall through
	}
	return { maxBytes: DEFAULT_MAX_BYTES };
}

function saveSettings(settings: ReadFullSettings): void {
	const dir = dirname(SETTINGS_FILE);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), "utf-8");
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// ── TUI rendering helpers ───────────────────────────────────────────────────

function trimTrailingEmptyLines(lines: string[]): string[] {
	let end = lines.length;
	while (end > 0 && lines[end - 1].trim() === "") end--;
	return lines.slice(0, end);
}

function str(v: unknown): string {
	return typeof v === "string" ? v : String(v ?? "");
}

function shortenPath(p: string, maxLen = 60): string {
	if (p.length <= maxLen) return p;
	const parts = p.split("/");
	if (parts.length <= 2) return p;
	const tail = parts[parts.length - 1];
	const head = parts[0];
	const mid = "…";
	const available = maxLen - head.length - mid.length - tail.length - 2;
	if (available <= 0) return `${head}/${mid}/${tail}`;
	const middle = parts.slice(1, -1);
	while (middle.join("/").length > available && middle.length > 1) middle.shift();
	return `${head}/${mid}/${middle.join("/")}/${tail}`;
}

// ── Details type ────────────────────────────────────────────────────────────

interface ReadFullDetails {
	path: string;
	totalLines: number;
	totalBytes: number;
	fileSizeBytes: number;
	limitBytes: number;
	overLimit: boolean;
	truncated: boolean;
}

// ── Render functions ────────────────────────────────────────────────────────

function formatReadFullCall(args: { path: string }, theme: Theme): string {
	const rawPath = str(args?.path);
	const pathDisplay = shortenPath(rawPath);
	return `${theme.fg("toolTitle", theme.bold("read_full"))} ${pathDisplay}`;
}

function formatReadFullResult(
	args: { path: string },
	result: AgentToolResult<ReadFullDetails>,
	options: ToolRenderResultOptions,
	theme: Theme,
): string {
	const rawPath = str(args?.path);

	// Extract text content from result
	const output = result.content
		.filter((c: { type: string }) => c.type === "text")
		.map((c: { text: string }) => c.text)
		.join("\n");

	const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
	const lines = output.split("\n");
	const trimmedLines = trimTrailingEmptyLines(lines);
	const maxLines = options.expanded ? trimmedLines.length : COLLAPSED_LINES;
	const displayLines = trimmedLines.slice(0, maxLines);
	const remaining = trimmedLines.length - maxLines;

	let text = "\n" + displayLines.map((line: string) => {
		const replaced = line.replace(/\t/g, "  ");
		return lang ? replaced : theme.fg("toolOutput", replaced);
	}).join("\n");

	if (remaining > 0) {
		text += theme.fg("muted", `\n... (${remaining} more lines, `) + keyHint("app.tools.expand", "to expand") + ")";
	}

	// Show over-limit warning
	const details = result.details;
	if (details?.overLimit) {
		text += `\n${theme.fg("warning", `[⚠️ File ${formatSize(details.totalBytes)} exceeds ${formatSize(details.limitBytes)} advisory limit — full content sent to model]`)}`;
	}

	return text;
}

// ── Extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let settings = loadSettings();

	pi.on("session_start", () => {
		settings = loadSettings();
	});

	pi.registerCommand("read-full", {
		description: "Configure read_full tool (show · set <N> · reset). N in KB (e.g. 200) or with suffix (200KB, 2MB).",
		handler: async (args, ctx) => {
			const trimmed = args.trim().toLowerCase();

			if (!trimmed || trimmed === "show") {
				ctx.ui.notify(`read_full limit: ${formatSize(settings.maxBytes)} (${settings.maxBytes.toLocaleString()} bytes)`, "info");
				return;
			}

			if (trimmed === "reset") {
				settings.maxBytes = DEFAULT_MAX_BYTES;
				saveSettings(settings);
				ctx.ui.notify(`read_full limit reset to default: ${formatSize(DEFAULT_MAX_BYTES)}`, "info");
				return;
			}

			// Parse: "200", "200kb", "2mb"
			const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*(kb|mb|b)?$/);
			if (!match) {
				ctx.ui.notify("Usage: /read-full set <N> [kb|mb] — e.g. /read-full set 200kb", "warning");
				return;
			}
			const value = parseFloat(match[1]);
			const unit = (match[2] || "kb").toLowerCase();
			const multiplier = unit === "mb" ? 1024 * 1024 : unit === "b" ? 1 : 1024;
			settings.maxBytes = Math.round(value * multiplier);
			saveSettings(settings);
			ctx.ui.notify(`read_full limit set to ${formatSize(settings.maxBytes)}`, "info");
		},
	});

	pi.registerTool({
		name: "read_full",
		label: "read_full",
		description: `Read the COMPLETE contents of a text or programming file up to ${formatSize(settings.maxBytes)}. The built-in 'read' tool truncates at 50KB/2000 lines — use read_full for larger files. Only supports text formats: txt, md, html, code files (js, ts, py, etc.), configs (json, yaml, toml), logs, etc. Will reject binary files (PDF, images, archives, executables) — for those, use bash with appropriate tools like pdftotext, pdfgrep, or strings. Returns a warning header if the file exceeds the configured ${formatSize(settings.maxBytes)} limit, but still delivers full content.`,
		promptSnippet: "Read entire text/code file (configurable limit, currently " + formatSize(settings.maxBytes) + ")",
		promptGuidelines: [
			"Use read_full instead of read when you need the complete contents of a large text or code file.",
			"Only works with text-based files — binary files (PDF, images, etc.) will be rejected. Use bash tools instead.",
			`Files over ${formatSize(settings.maxBytes)} will show a ⚠️ warning header — the content is still fully delivered.`,
			"Very large files consume significant context window. Consider using an offset-based approach for files > 500KB.",
		],
		parameters: Type.Object({
			path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
		}),

		renderCall: (args: { path: string }, theme: Theme): Component => {
			const text = new Text("", 0, 0);
			text.setText(formatReadFullCall(args, theme));
			return text;
		},

		renderResult: (result: AgentToolResult<ReadFullDetails>, options: ToolRenderResultOptions, theme: Theme): Component => {
			const text = new Text("", 0, 0);
			text.setText(formatReadFullResult({ path: result.details?.path ?? "" }, result, options, theme));
			return text;
		},

		async execute(_toolCallId: string, { path: rawPath }: { path: string }, _signal, _onUpdate, ctx) {
			// Resolve path — strip leading @ if present (some models include it)
			let raw = rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
			const absolutePath = isAbsolute(raw) ? raw : resolve(ctx.cwd, raw);

			// Check readability
			try {
				await access(absolutePath, constants.R_OK);
			} catch {
				if (!existsSync(absolutePath)) {
					return {
						content: [{ type: "text", text: `Error: File not found: ${raw}` }],
						details: { error: "ENOENT" },
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: `Error: Permission denied: ${raw}` }],
					details: { error: "EACCES" },
					isError: true,
				};
			}

			// Check file extension — block binary / unsupported file types
			const extError = checkFileExtension(absolutePath);
			if (extError) {
				return {
					content: [{ type: "text", text: extError }],
					details: { error: "UNSUPPORTED_TYPE" },
					isError: true,
				};
			}

			// Double-check: binary magic bytes catch mislabelled files
			const magicError = await checkBinaryMagic(absolutePath);
			if (magicError) {
				return {
					content: [{ type: "text", text: magicError }],
					details: { error: "BINARY_FILE" },
					isError: true,
				};
			}

			// Stat file size before reading
			const fileStat = await stat(absolutePath);
			const fileSizeBytes = fileStat.size;

			// Read full content
			const content = await readFile(absolutePath, "utf-8");
			const lines = content.split("\n");
			const totalLines = lines.length;
			const totalBytes = Buffer.byteLength(content, "utf-8");

			// Build header for LLM (not visible in TUI — TUI uses renderResult)
			const overLimit = totalBytes > settings.maxBytes;
			const header = `[read_full: ${raw}]\n[Total: ${totalLines.toLocaleString()} lines, ${formatSize(totalBytes)}]${overLimit ? `\n⚠️ EXCEEDS ${formatSize(settings.maxBytes)} limit — full content delivered (use with caution)` : ""}\n${"─".repeat(60)}\n`;

			return {
				content: [{ type: "text", text: header + content }],
				details: {
					path: absolutePath,
					totalLines,
					totalBytes,
					fileSizeBytes,
					limitBytes: settings.maxBytes,
					overLimit,
					truncated: false,
				} satisfies ReadFullDetails,
			};
		},
	});
}
