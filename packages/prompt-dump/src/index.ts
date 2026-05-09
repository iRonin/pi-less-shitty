/**
 * prompt-dump — dist patch for `pi --prompt-dump`
 *
 * Patches:
 *   1. cli/args.js   — recognise `--prompt-dump`
 *   2. main.js       — dump assembled prompt with chalk colours, section breakdown, file list
 *
 * Replaces the lost --prompt-dump CLI flag.
 * Original was in local pi-mono clone (TRASHED). Rebuilt from session logs.
 */
import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { findPiCodingAgentDistFromCaller } from "../../pi-resolve/src/index.ts";

function findPiDistDir(override?: string): string | null {
	const res = findPiCodingAgentDistFromCaller(import.meta.url, "cli/args.js", override);
	return res?.distDir ?? null;
}

function patchArgsJs(distDir: string): boolean {
	const filePath = path.join(distDir, "cli", "args.js");
	if (!fs.existsSync(filePath)) return false;
	let c = fs.readFileSync(filePath, "utf8");

	if (c.includes("--prompt-dump")) return true; // already patched

	c = c.replace(
		'else if (arg === "--offline") {\n            result.offline = true;\n        }\n        else if (arg.startsWith("@"))',
		'else if (arg === "--offline") {\n            result.offline = true;\n        }\n        else if (arg === "--prompt-dump") {\n            result.promptDump = true;\n        }\n        else if (arg.startsWith("@"))'
	);

	fs.writeFileSync(filePath, c, "utf8");
	return true;
}

function patchMainJs(distDir: string): boolean {
	const filePath = path.join(distDir, "main.js");
	if (!fs.existsSync(filePath)) return false;
	let c = fs.readFileSync(filePath, "utf8");

	if (c.includes("--- prompt-dump handler ---")) return true;

	const promptDumpHandler = `    if (parsed.promptDump) {
        // Trigger extension resource discovery (normally done by modes via bindExtensions)
        await session.bindExtensions({});

        const sysPrompt = session.systemPrompt || "";
        const totalTokens = Math.ceil(sysPrompt.length / 4);

        // Section breakdown — detect structural boundaries of the system prompt
        const sectionMarkers = [
            { name: "Available tools", regex: /^Available tools:/m },
            { name: "Guidelines", regex: /^Guidelines:/m },
            { name: "Pi documentation", regex: /^Pi documentation/m },
            { name: "# Project Context", regex: /^# Project Context/m },
            { name: "Skills (<available_skills>)", regex: /<available_skills>/m },
            { name: "Footer (date/cwd)", regex: /^Current date:/m },
        ];
        const boundaries = [{ name: "Preamble", index: 0 }];
        for (const sp of sectionMarkers) {
            sp.regex.lastIndex = 0;
            const m = sp.regex.exec(sysPrompt);
            if (m) boundaries.push({ name: sp.name, index: m.index });
        }
        boundaries.sort((a, b) => a.index - b.index);

        const stats = [];
        for (let i = 0; i < boundaries.length; i++) {
            const start = boundaries[i].index;
            const end = i + 1 < boundaries.length ? boundaries[i + 1].index : sysPrompt.length;
            const t = Math.ceil(sysPrompt.slice(start, end).length / 4);
            stats.push({ name: boundaries[i].name, tokens: t, pct: ((t / totalTokens) * 100).toFixed(1) });
        }

        console.error("\\n" + chalk.bold("System Prompt Token Analysis"));
        console.error("─".repeat(60));
        console.error(chalk.bold("Total (chars/4 est.)".padEnd(35)) + chalk.bold(String(totalTokens).padStart(10)) + " tokens");
        console.error("");
        console.error(chalk.bold("Section Breakdown"));
        console.error("─".repeat(60));
        for (const s of stats) {
            const bar = "█".repeat(Math.round(parseFloat(s.pct) / 2));
            console.error(\`  \${chalk.green(s.name.padEnd(35))}\${String(s.tokens).padStart(8)} tokens  \${s.pct}% \${chalk.dim(bar)}\`);
        }
        console.error("");

        // Context files
        const agentsFiles = resourceLoader.getAgentsFiles().agentsFiles || [];
        if (agentsFiles.length > 0) {
            console.error(chalk.bold("Context Files"));
            console.error("─".repeat(60));
            for (const f of agentsFiles) {
                const ft = Math.ceil((f.content || "").length / 4);
                console.error(\`  \${chalk.cyan(f.path)}  \${ft} tokens\`);
            }
            console.error("");
        }

        // Skills
        const skills = resourceLoader.getSkills() || [];
        const skillList = Array.isArray(skills) ? skills : (skills.skills || []);
        if (skillList.length > 0) {
            console.error(chalk.bold("Skills"));
            console.error("─".repeat(60));
            for (const sk of skillList) {
                const skPath = sk.path || sk.file || "";
                const skName = sk.name || path.basename(skPath, ".md");
                console.error(\`  \${chalk.yellow(skName)}\`);
            }
            console.error("");
        }

        // Full prompt
        console.error(chalk.bold("Full System Prompt"));
        console.error("─".repeat(60));
        console.error(sysPrompt);
        console.error("");
        console.error("─".repeat(60));
        console.error(chalk.bold("Total") + ": ~" + totalTokens.toLocaleString() + " tokens");
        console.error(chalk.bold("Chars") + ": " + sysPrompt.length.toLocaleString());

        process.exit(0);
    }`;

	const listBlock = `    if (parsed.listModels !== undefined) {
        const searchPattern = typeof parsed.listModels === "string" ? parsed.listModels : undefined;
        await listModels(modelRegistry, searchPattern);
        process.exit(0);
    }
    // Read piped stdin content`;

	const newBlock = `    if (parsed.listModels !== undefined) {
        const searchPattern = typeof parsed.listModels === "string" ? parsed.listModels : undefined;
        await listModels(modelRegistry, searchPattern);
        process.exit(0);
    }

    // --- prompt-dump handler ---
${promptDumpHandler}
    // --- end prompt-dump handler ---
    // Read piped stdin content`;

	if (!c.includes(listBlock)) return false;
	const next = c.replace(listBlock, newBlock);
	if (next === c) return false;
	fs.writeFileSync(filePath, next, "utf8");
	return true;
}

// ── Extension entry ─────────────────────────────────────────────────

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
