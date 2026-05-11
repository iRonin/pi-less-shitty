/**
 * prompt-dump — dist patch for `pi --prompt-dump[-dry|-json|-section <name>]`
 *
 * Patches:
 *   1. cli/args.js   — recognise --prompt-dump and the dry/json/section variants
 *   2. main.js       — copies runtime.js next to main.js and inserts a tiny snippet
 *                      that dynamic-imports the runtime to render the dump
 *
 * The runtime (src/runtime.js) is pure JS ESM, importable for tests. The patch
 * surface in main.js is intentionally tiny — all logic lives in runtime.js so
 * upgrades only need to refresh the small wrapper snippet.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { findPiCodingAgentDistFromCaller } from "../../pi-resolve/src/index.ts";

const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_SRC = path.join(SELF_DIR, "runtime.js");
const RUNTIME_BASENAME = "_prompt-dump-runtime.js";

const HANDLER_MARKER = "prompt-dump handler";

function findPiDistDir(override?: string): string | null {
	const res = findPiCodingAgentDistFromCaller(import.meta.url, { probe: "cli/args.js", override });
	return res?.distDir ?? null;
}

function patchArgsJs(distDir: string): boolean {
	const filePath = path.join(distDir, "cli", "args.js");
	if (!fs.existsSync(filePath)) return false;
	let c = fs.readFileSync(filePath, "utf8");

	const wanted = [
		"--prompt-dump",
		"--prompt-dump-dry",
		"--prompt-dump-json",
		"--prompt-dump-section",
		"--prompt-dump-grep",
	];
	if (wanted.every((flag) => c.includes(flag))) return true; // already patched (current shape)

	// Strip any older partial patch so we re-insert a clean canonical block.
	c = c.replace(
		/\s*else if \(arg === "--prompt-dump(-dry|-json|-section|-grep)?"\s*(?:&& i \+ 1 < args\.length\s*)?\) \{[\s\S]*?\}\s*\n/g,
		"\n",
	);
	c = c.replace(
		/\s*else if \(arg === "--prompt-dump"\) \{\s*result\.promptDump = true;\s*\}\s*\n/g,
		"\n",
	);
	// Collapse any blank-line runs the cleanup left between offline's `}` and
	// the `arg.startsWith("@")` anchor so the literal anchor below matches.
	// Note: the `\s*\n` form is wrong here because `\s*` is greedy and would
	// consume the very newline `\n+` needs to match. Use a literal `\}` followed
	// by `\n+` and require an explicit re-emit of `\n` in the replacement.
	c = c.replace(
		/(\})\n+(\s*else if \(arg\.startsWith\("@"\))/,
		"$1\n$2",
	);

	const anchor =
		'else if (arg === "--offline") {\n            result.offline = true;\n        }\n        else if (arg.startsWith("@"))';
	const block =
		'else if (arg === "--offline") {\n            result.offline = true;\n        }\n' +
		'        else if (arg === "--prompt-dump") {\n            result.promptDump = true;\n        }\n' +
		'        else if (arg === "--prompt-dump-dry") {\n            result.promptDumpDry = true;\n        }\n' +
		'        else if (arg === "--prompt-dump-json") {\n            result.promptDumpJson = true;\n        }\n' +
		'        else if (arg === "--prompt-dump-section" && i + 1 < args.length) {\n            result.promptDumpSection = args[++i];\n        }\n' +
		'        else if (arg === "--prompt-dump-grep" && i + 1 < args.length) {\n            result.promptDumpGrep = args[++i];\n        }\n' +
		'        else if (arg.startsWith("@"))';

	if (!c.includes(anchor)) return false;
	const next = c.replace(anchor, block);
	if (next === c) return false;
	fs.writeFileSync(filePath, next, "utf8");
	return true;
}

function copyRuntime(distDir: string): string | null {
	if (!fs.existsSync(RUNTIME_SRC)) {
		console.error("[prompt-dump] runtime.js missing at " + RUNTIME_SRC);
		return null;
	}
	const dest = path.join(distDir, RUNTIME_BASENAME);
	try {
		const src = fs.readFileSync(RUNTIME_SRC, "utf8");
		if (fs.existsSync(dest) && fs.readFileSync(dest, "utf8") === src) return dest;
		fs.writeFileSync(dest, src, "utf8");
		return dest;
	} catch (err) {
		console.error("[prompt-dump] failed to copy runtime: " + (err as Error).message);
		return null;
	}
}

function patchMainJs(distDir: string): boolean {
	const filePath = path.join(distDir, "main.js");
	if (!fs.existsSync(filePath)) return false;
	const original = fs.readFileSync(filePath, "utf8");

	const runtimeDest = copyRuntime(distDir);
	if (!runtimeDest) return false;

	// Tiny wrapper — dispatches all flags to the runtime. `chalk` is imported
	// at the top of main.js so we forward it to keep the runtime importable
	// in test environments without chalk in node_modules.
	const wrapper =
		'    // --- ' + HANDLER_MARKER + ' ---\n' +
		'    if (parsed.promptDump || parsed.promptDumpDry || parsed.promptDumpJson || parsed.promptDumpSection !== undefined || parsed.promptDumpGrep !== undefined) {\n' +
		'        await session.bindExtensions({});\n' +
		'        const { runPromptDump } = await import("./' + RUNTIME_BASENAME + '");\n' +
		'        await runPromptDump({ cwd, agentDir, session, resourceLoader, parsed, chalk });\n' +
		'        process.exit(0);\n' +
		'    }\n' +
		'    // --- end ' + HANDLER_MARKER + ' ---\n';

	const listBlock =
		'    if (parsed.listModels !== undefined) {\n' +
		'        const searchPattern = typeof parsed.listModels === "string" ? parsed.listModels : undefined;\n' +
		'        await listModels(modelRegistry, searchPattern);\n' +
		'        process.exit(0);\n' +
		'    }\n' +
		'    // Read piped stdin content';

	// Remove any previous handler block (legacy or current) so we rewrite cleanly
	// against an untouched anchor. The legacy handler sits between listBlock's
	// closing brace and "// Read piped stdin content" so we must strip it first
	// before the anchor reappears in the source. The regex tolerates any
	// surrounding dash/space decoration (older patcher versions accidentally
	// doubled the dashes).
	let cleaned = original.replace(
		/\s*\/\/[- ]*prompt-dump handler[- ]*\n[\s\S]*?\/\/[- ]*end[- ]+prompt-dump handler[- ]*\n/g,
		"\n",
	);

	if (!cleaned.includes(listBlock)) {
		// Anchor missing even after stripping any legacy handler — guard against
		// false-positive write.
		return false;
	}

	const replacement =
		'    if (parsed.listModels !== undefined) {\n' +
		'        const searchPattern = typeof parsed.listModels === "string" ? parsed.listModels : undefined;\n' +
		'        await listModels(modelRegistry, searchPattern);\n' +
		'        process.exit(0);\n' +
		'    }\n\n' +
		wrapper +
		'    // Read piped stdin content';

	if (!cleaned.includes(listBlock)) return false;
	const next = cleaned.replace(listBlock, replacement);
	if (next === cleaned) return false;
	if (next === original) return true; // nothing to do
	fs.writeFileSync(filePath, next, "utf8");
	return true;
}

// ── Extension entry ─────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	const distDir = findPiDistDir();

	if (distDir) {
		const argsOk = patchArgsJs(distDir);
		const mainOk = patchMainJs(distDir);
		if (argsOk && mainOk) {
			console.error("[prompt-dump] dist patched ✓");
		} else if (argsOk || mainOk) {
			console.error("[prompt-dump] partially patched");
		} else {
			console.error("[prompt-dump] FAILED to patch dist");
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		const sessionDistDir = findPiDistDir(ctx.piInstallDir);
		if (sessionDistDir) {
			patchArgsJs(sessionDistDir);
			patchMainJs(sessionDistDir);
		}
	});
}
