/**
 * prompt-dump runtime — pure JS ESM, copied into <distDir>/_prompt-dump-runtime.js
 * by the extension entry. Imported dynamically from the patched main.js.
 *
 * Exports:
 *   - runPromptDump(opts)   main handler used by all four flags
 *   - discoverContext(opts) pure helper, exported for tests
 *   - splitSections(opts)   pure helper, exported for tests
 */
import fs from "node:fs";
import path from "node:path";

// `chalk` is injected by the caller (passed through opts.chalk in runPromptDump)
// so this module stays importable in tests where chalk may not be installed
// in the local node_modules tree.

const CONFIG_DIR_NAME = ".pi"; // matches dist/config.js
const CONTEXT_CANDIDATES = ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];

/**
 * Mimics pi's resource-loader.loadProjectContextFiles + discoverSystemPromptFile
 * + discoverAppendSystemPromptFile. Pure: takes (cwd, agentDir, fsImpl?) and
 * returns the discovery shape without touching the real filesystem if fsImpl
 * is overridden in tests.
 */
export function discoverContext({ cwd, agentDir, fsImpl = fs }) {
	const exists = (p) => {
		try { return fsImpl.existsSync(p); } catch { return false; }
	};
	const statSize = (p) => {
		try { return fsImpl.statSync(p).size; } catch { return 0; }
	};
	const findContextInDir = (dir) => {
		for (const f of CONTEXT_CANDIDATES) {
			const p = path.join(dir, f);
			if (exists(p)) return p;
		}
		return null;
	};

	const systemMdCandidates = [
		{ path: path.join(cwd, CONFIG_DIR_NAME, "SYSTEM.md"), label: "project" },
		{ path: path.join(agentDir, "SYSTEM.md"), label: "global" },
	];
	const systemMdLoaded = systemMdCandidates.find((c) => exists(c.path))?.path ?? null;

	// Walk-up uses a fixed depth budget bounded by the absolute root.
	const root = path.resolve("/");

	// APPEND_SYSTEM.md candidates: agentDir + every ancestor `<dir>/.pi/APPEND_SYSTEM.md`
	// walked from cwd up to root. With the stock pi loader only the first existing
	// match wins; with the @ironin/pi-cascading-append-system extension ALL existing
	// matches are concatenated. Discovery surfaces every candidate either way so
	// the verification block can flag drift.
	const appendMdCandidates = [
		{ path: path.join(agentDir, "APPEND_SYSTEM.md"), label: "agentDir" },
	];
	{
		const seen = new Set([appendMdCandidates[0].path]);
		const ancestors = [];
		let dir = cwd;
		for (let i = 0; i < 64; i++) {
			const candidate = path.join(dir, CONFIG_DIR_NAME, "APPEND_SYSTEM.md");
			if (!seen.has(candidate)) {
				ancestors.unshift({
					path: candidate,
					label: dir === cwd ? "cwd" : dir,
				});
				seen.add(candidate);
			}
			if (dir === root) break;
			const parent = path.resolve(dir, "..");
			if (parent === dir) break;
			dir = parent;
		}
		appendMdCandidates.push(...ancestors);
	}
	const appendMdExisting = appendMdCandidates.filter((c) => exists(c.path)).map((c) => c.path);
	// `loaded` is preserved as the SINGLE first match for back-compat with the
	// JSON schema and prior renderer expectations; loadedAll captures the full
	// cascade so the verification step can detect whether pi is in single-file
	// mode or cascade mode.
	const appendMdLoaded = appendMdExisting.length > 0 ? appendMdExisting[0] : null;
	const appendMdLoadedAll = appendMdExisting;

	// Project context cascade — mimics loadProjectContextFiles in resource-loader.js
	const contextFiles = [];
	const seen = new Set();
	const globalCtx = findContextInDir(agentDir);
	if (globalCtx) {
		contextFiles.push({ path: globalCtx, origin: "agentDir", size: statSize(globalCtx) });
		seen.add(globalCtx);
	}
	const ancestors = [];
	let dir = cwd;
	while (true) {
		const f = findContextInDir(dir);
		if (f && !seen.has(f)) {
			ancestors.unshift({ path: f, origin: dir === cwd ? "cwd" : dir, size: statSize(f) });
			seen.add(f);
		}
		if (dir === root) break;
		const parent = path.resolve(dir, "..");
		if (parent === dir) break;
		dir = parent;
	}
	contextFiles.push(...ancestors);

	return {
		systemMdCandidates,
		systemMdLoaded,
		appendMdCandidates,
		appendMdLoaded,
		appendMdLoadedAll,
		contextFiles,
	};
}

/**
 * Split the assembled system prompt into ordered sections. Pure: takes the
 * sysPrompt string + loaded append array and returns [{kind, source, start, end}].
 *
 * Anchors used:
 *   - footer:  trailing `\nCurrent date: YYYY-MM-DD\nCurrent working directory: …`
 *   - skills:  `<available_skills>…</available_skills>` (with preceding intro line)
 *   - context: `\n\n# Project Context\n\nProject-specific instructions and guidelines:\n\n`
 *   - context entries: `^## /abs/path\n\n` headers within the context block
 *   - append:  located by substring match of resourceLoader.appendSystemPrompt joined
 *   - base:    everything before the first downstream section
 */
export function splitSections({ sysPrompt, appendArr, systemMdLoaded, appendMdLoaded, appendMdLoadedAll }) {
	const total = sysPrompt.length;

	// Footer
	const footerMatch = sysPrompt.match(/\nCurrent date: \d{4}-\d{2}-\d{2}\nCurrent working directory: [^\n]*$/);
	const footerStart = footerMatch ? footerMatch.index : total;

	// Skills
	let skillsStart = footerStart, skillsEnd = footerStart;
	const skillsBlockMatch = sysPrompt.match(/\nThe following skills provide[\s\S]*?<\/available_skills>/);
	if (skillsBlockMatch) {
		skillsStart = skillsBlockMatch.index;
		skillsEnd = skillsBlockMatch.index + skillsBlockMatch[0].length;
	} else {
		const tagsMatch = sysPrompt.match(/<available_skills>[\s\S]*?<\/available_skills>/);
		if (tagsMatch) {
			skillsStart = tagsMatch.index;
			skillsEnd = tagsMatch.index + tagsMatch[0].length;
		}
	}

	// Context
	const ctxIntro = sysPrompt.match(/\n# Project Context\n\nProject-specific instructions and guidelines:\n\n/);
	let ctxStart = -1, ctxEnd = -1;
	const contextEntries = [];
	if (ctxIntro) {
		ctxStart = ctxIntro.index;
		ctxEnd = skillsStart > ctxStart ? skillsStart : footerStart;
		const headerRegex = /^## (\/[^\n]+)\n\n/gm;
		const headers = [];
		let m;
		while ((m = headerRegex.exec(sysPrompt))) {
			if (m.index < ctxStart || m.index >= ctxEnd) continue;
			headers.push({ path: m[1], index: m.index });
		}
		// Extend the first entry's start back to ctxStart so the shared intro
		// ("# Project Context\n\nProject-specific instructions...\n\n") is
		// accounted for under the first context file's banner. Extend the last
		// entry's end to ctxEnd to absorb any trailing whitespace before the
		// next downstream section. This guarantees the sum of all section
		// chars equals the assembled prompt length.
		for (let i = 0; i < headers.length; i++) {
			const h = headers[i];
			const start = i === 0 ? ctxStart : h.index;
			const end = i + 1 < headers.length ? headers[i + 1].index : ctxEnd;
			contextEntries.push({ path: h.path, start, end });
		}
	}

	// Append: resourceLoader.appendSystemPrompt is an array pi joined with
	// "\n\n" and prefixed with "\n\n" before concatenating to base — see
	// system-prompt.js. When the cascade extension is active, each array entry
	// corresponds to one source file in `appendMdLoadedAll` (same order).
	let appendStart = -1, appendEnd = -1;
	const appendEntries = []; // [{source, start, end}]
	const appendContent = (appendArr && appendArr.length > 0)
		? "\n\n" + appendArr.join("\n\n")
		: "";
	if (appendContent) {
		const searchCeiling = ctxStart >= 0 ? ctxStart : (skillsStart < footerStart ? skillsStart : footerStart);
		const idx = sysPrompt.lastIndexOf(appendContent, searchCeiling);
		if (idx >= 0) {
			appendStart = idx;
			appendEnd = idx + appendContent.length;
			// Attribute each loaded entry to a source path when counts match.
			const sources = (appendMdLoadedAll && appendMdLoadedAll.length === appendArr.length)
				? appendMdLoadedAll
				: null;
			let cursor = appendStart;
			appendArr.forEach((entry, i) => {
				// The "\n\n" separator before each entry belongs to that entry's
				// range so the concatenation still rebuilds bit-for-bit.
				const chunk = "\n\n" + entry;
				appendEntries.push({
					source: sources ? sources[i] : (appendMdLoaded || "<unknown>"),
					start: cursor,
					end: cursor + chunk.length,
				});
				cursor += chunk.length;
			});
		}
	}

	// Base
	const baseEnd =
		appendStart >= 0 ? appendStart :
		ctxStart >= 0 ? ctxStart :
		skillsStart < footerStart ? skillsStart :
		footerStart;

	const sections = [];
	sections.push({
		kind: "base",
		source: systemMdLoaded || "<built-in>",
		start: 0,
		end: baseEnd,
	});
	if (appendEntries.length > 0) {
		for (const e of appendEntries) {
			sections.push({ kind: "append", source: e.source, start: e.start, end: e.end });
		}
	} else if (appendStart >= 0) {
		// Single-entry / unattributed fallback
		sections.push({
			kind: "append",
			source: appendMdLoaded || "<unknown>",
			start: appendStart,
			end: appendEnd,
		});
	}
	for (const e of contextEntries) {
		sections.push({ kind: "context", source: e.path, start: e.start, end: e.end });
	}
	if (skillsStart < skillsEnd) {
		sections.push({ kind: "skills", source: "<available_skills>", start: skillsStart, end: skillsEnd });
	}
	if (footerStart < total) {
		sections.push({ kind: "footer", source: "<date+cwd>", start: footerStart, end: total });
	}

	for (const s of sections) {
		s.chars = s.end - s.start;
		s.tokens = Math.ceil(s.chars / 4);
		s.pct = total > 0 ? (s.chars / total) * 100 : 0;
	}

	return { sections, anchors: { baseEnd, appendStart, appendEnd, ctxStart, ctxEnd, skillsStart, skillsEnd, footerStart, total } };
}

/**
 * Build the verification list — compares discovered cascade against actually
 * loaded sections + resourceLoader state.
 */
export function buildVerification({ discovery, sections, loadedAppendPresent, loaderSystemPrompt, loadedAppendArr: loadedAppendArrInput }) {
	const out = [];
	const loadedCtx = new Set(sections.filter((s) => s.kind === "context").map((s) => s.source));
	for (const ec of discovery.contextFiles) {
		out.push({
			ok: loadedCtx.has(ec.path),
			msg: `context: ${ec.path}` + (loadedCtx.has(ec.path) ? "" : "  ← discovered but NOT in assembled prompt"),
		});
	}
	// SYSTEM.md
	if (discovery.systemMdLoaded) {
		out.push({
			ok: !!loaderSystemPrompt,
			msg: `SYSTEM.md → ${discovery.systemMdLoaded}` + (loaderSystemPrompt ? " (active, REPLACES built-in base)" : " (DISCOVERED BUT NOT LOADED)"),
		});
	} else {
		out.push({
			ok: !loaderSystemPrompt,
			msg: loaderSystemPrompt
				? "SYSTEM.md: not on disk but loader has a custom systemPrompt — drift"
				: "SYSTEM.md: <none on disk> — built-in base in use",
		});
	}
	// APPEND_SYSTEM.md cascade — we cannot map loaded content strings back to
	// their source paths (pi's loader joins them all into one array of
	// content), so we verify by COUNT: every existing candidate should have a
	// corresponding loaded entry. A shortfall flags the stock pi single-match
	// behavior; an overshoot flags something we did not discover (e.g.
	// --append-system-prompt CLI overrides).
	const loadedCount = (loadedAppendArrInput || []).length;
	const existingAppendPaths = (discovery.appendMdLoadedAll || []);
	if (existingAppendPaths.length === 0) {
		out.push({
			ok: !loadedAppendPresent,
			msg: loadedAppendPresent
				? `APPEND_SYSTEM.md: no candidates on disk but loader has ${loadedCount} appended entries — drift (likely --append-system-prompt CLI overrides)`
				: "APPEND_SYSTEM.md: <no candidates on disk>",
		});
	} else if (loadedCount === existingAppendPaths.length) {
		out.push({
			ok: true,
			msg: `APPEND_SYSTEM.md cascade: ${loadedCount}/${existingAppendPaths.length} loaded (CASCADE active)`,
		});
	} else if (loadedCount === 1 && existingAppendPaths.length > 1) {
		out.push({
			ok: false,
			msg: `APPEND_SYSTEM.md cascade: 1/${existingAppendPaths.length} loaded (stock pi single-match) — install @ironin/pi-cascading-append-system to cascade all ${existingAppendPaths.length}`,
		});
	} else if (loadedCount === 0) {
		out.push({
			ok: false,
			msg: `APPEND_SYSTEM.md: ${existingAppendPaths.length} on disk but NONE loaded — loader did not pick them up`,
		});
	} else {
		out.push({
			ok: false,
			msg: `APPEND_SYSTEM.md: ${loadedCount} loaded vs ${existingAppendPaths.length} discovered — count mismatch`,
		});
	}
	return out;
}

// ── ANSI helpers ────────────────────────────────────────────────────────
// Factories that take an injected chalk and return the per-kind colorisers.
function kindColors(chalk) {
	return {
		base: chalk.magenta,
		append: chalk.blue,
		context: chalk.cyan,
		skills: chalk.yellow,
		footer: chalk.gray,
	};
}
function kindBackgrounds(chalk) {
	return {
		base: chalk.bgMagenta.white,
		append: chalk.bgBlue.white,
		context: chalk.bgCyan.black,
		skills: chalk.bgYellow.black,
		footer: chalk.bgWhite.black,
	};
}

function truncatePath(p, max = 60) {
	if (p.length <= max) return p.padEnd(max);
	return "…" + p.slice(-(max - 1));
}

function shortenHome(p) {
	const home = process.env.HOME || "";
	if (home && p.startsWith(home)) return "~" + p.slice(home.length);
	return p;
}

// ── Renderers ──────────────────────────────────────────────────────────
function renderDiscovery(discovery, chalk, fsImpl = fs) {
	const out = [];
	out.push(chalk.bold("Discovery"));
	out.push("─".repeat(72));

	// SYSTEM.md
	out.push(chalk.bold("  SYSTEM.md ") + chalk.dim("(REPLACES built-in base — first match wins)"));
	let usedSystem = false;
	for (const c of discovery.systemMdCandidates) {
		const ex = fsImpl.existsSync(c.path);
		const used = ex && !usedSystem;
		if (used) usedSystem = true;
		const marker = used ? chalk.green("✓ used   ") : ex ? chalk.yellow("· shadowed") : chalk.dim("· n/a     ");
		out.push(`    ${marker} ${shortenHome(c.path)} ${chalk.dim("(" + c.label + ")")}`);
	}
	if (!usedSystem) out.push(`    ${chalk.green("✓ used   ")} ${chalk.dim("<built-in base>")}`);

	// APPEND_SYSTEM.md — cascading-append-system extension enables full cascade.
	out.push("");
	const loadedAllSet = new Set(discovery.appendMdLoadedAll || []);
	const cascadeMode = loadedAllSet.size > 1;
	out.push(
		chalk.bold("  APPEND_SYSTEM.md ") +
			chalk.dim(
				cascadeMode
					? "(CASCADE active — all matches loaded, agentDir + cwd → root)"
					: "(stock pi: first match wins — install @ironin/pi-cascading-append-system to cascade)",
			),
	);
	for (const c of discovery.appendMdCandidates) {
		const ex = fsImpl.existsSync(c.path);
		let marker;
		if (!ex) {
			marker = chalk.dim("· n/a     ");
		} else if (loadedAllSet.has(c.path)) {
			marker = chalk.green("✓ used   ");
		} else {
			marker = chalk.yellow("· shadowed");
		}
		out.push(`    ${marker} ${shortenHome(c.path)} ${chalk.dim("(" + c.label + ")")}`);
	}
	if (loadedAllSet.size === 0) out.push(`    ${chalk.dim("· n/a       <no append section>")}`);

	// Context cascade
	out.push("");
	out.push(chalk.bold("  Project Context ") + chalk.dim("(AGENTS.md|CLAUDE.md cascade — ALL matches loaded)"));
	if (discovery.contextFiles.length === 0) {
		out.push(`    ${chalk.dim("(none)")}`);
	} else {
		discovery.contextFiles.forEach((c, i) => {
			const kb = (c.size / 1024).toFixed(1);
			out.push(`    ${chalk.green("✓")} ${String(i + 1).padStart(2)}. ${shortenHome(c.path)} ${chalk.dim("(" + c.origin + ", " + kb + " KB)")}`);
		});
	}
	return out.join("\n");
}

function renderSectionsTable(sections, total, chalk) {
	const KIND_COLOR = kindColors(chalk);
	const out = [];
	out.push(chalk.bold("Sections") + chalk.dim("  (order of appearance in assembled prompt)"));
	out.push("─".repeat(72));
	sections.forEach((s, i) => {
		const color = KIND_COLOR[s.kind] || chalk.white;
		const idx = String(i + 1).padStart(2, "0");
		const kind = color(s.kind.padEnd(8));
		const src = truncatePath(shortenHome(s.source), 50);
		out.push(`  [${idx}] ${kind} ${src}  ${String(s.chars).padStart(7)} ch  ${String(s.tokens).padStart(6)} tok  ${s.pct.toFixed(1).padStart(5)}%`);
	});
	out.push("");
	out.push(chalk.bold(`  TOTAL: ${total.toLocaleString()} chars / ~${Math.ceil(total / 4).toLocaleString()} tokens`));
	return out.join("\n");
}

function renderVerification(verification, chalk) {
	const out = [];
	out.push(chalk.bold("Verification"));
	out.push("─".repeat(72));
	for (const v of verification) {
		const marker = v.ok ? chalk.green("  ✓") : chalk.red("  ✗");
		out.push(`${marker} ${v.msg}`);
	}
	const allOk = verification.every((v) => v.ok);
	out.push("");
	out.push(allOk ? chalk.green.bold("  All checks passed.") : chalk.red.bold("  DRIFT DETECTED — see ✗ entries above."));
	return out.join("\n");
}

function renderFullContent(sysPrompt, sections, sectionFilter, chalk) {
	const KIND_BG = kindBackgrounds(chalk);
	const out = [];
	out.push(chalk.bold("Full System Prompt (per-source banners)"));
	out.push("═".repeat(72));
	sections.forEach((s, i) => {
		if (sectionFilter && !sectionMatchesFilter(s, sectionFilter)) return;
		const bg = KIND_BG[s.kind] || chalk.bgWhite.black;
		const idx = String(i + 1).padStart(2, "0");
		out.push("");
		out.push(bg.bold(` [${idx}] ${s.kind.toUpperCase()} `) + "  " + chalk.cyan(shortenHome(s.source)) + chalk.dim(`   ${s.chars} ch  ~${s.tokens} tok  ${s.pct.toFixed(1)}%`));
		out.push(chalk.dim("─".repeat(72)));
		out.push(sysPrompt.slice(s.start, s.end));
	});
	return out.join("\n");
}

// Minimal chalk stub so this module can be imported / called without chalk.
// Each color method is a function (string → string) AND has further nested
// methods as properties (e.g. chalk.bgBlue.white.bold). This covers every
// usage above without any external dependency.
function makeChalkStub() {
	const id = (s) => String(s);
	const props = [
		"bold", "dim", "reset", "italic",
		"red", "green", "yellow", "blue", "magenta", "cyan", "white", "gray", "black",
		"bgRed", "bgGreen", "bgYellow", "bgBlue", "bgMagenta", "bgCyan", "bgWhite", "bgBlack",
	];
	function make() {
		const fn = (s) => id(s);
		for (const k of props) Object.defineProperty(fn, k, { get: make });
		return fn;
	}
	return make();
}

function sectionMatchesFilter(section, filter) {
	const f = filter.toLowerCase();
	if (section.kind === f) return true;
	if (section.source.toLowerCase().includes(f)) return true;
	return false;
}

// ── Main entry ──────────────────────────────────────────────────────────
/**
 * @param {object} opts
 * @param {string} opts.cwd
 * @param {string} opts.agentDir
 * @param {object} opts.session         pi session (has .systemPrompt)
 * @param {object} opts.resourceLoader  pi resource loader
 * @param {object} opts.parsed          parsed CLI args
 * @param {object} [opts.chalk]         injected chalk (defaults to a no-op stub)
 */
export async function runPromptDump(opts) {
	const { cwd, agentDir, session, resourceLoader, parsed } = opts;
	const chalk = opts.chalk || makeChalkStub();

	const mode = parsed.promptDumpJson ? "json"
		: parsed.promptDumpDry ? "dry"
		: parsed.promptDumpSection !== undefined ? "section"
		: "full";
	const sectionFilter = typeof parsed.promptDumpSection === "string" && parsed.promptDumpSection.length > 0
		? parsed.promptDumpSection
		: null;

	const sysPrompt = session.systemPrompt || "";
	const totalChars = sysPrompt.length;
	const appendArr = resourceLoader.appendSystemPrompt || [];

	const discovery = discoverContext({ cwd, agentDir });
	const { sections } = splitSections({
		sysPrompt,
		appendArr,
		systemMdLoaded: discovery.systemMdLoaded,
		appendMdLoaded: discovery.appendMdLoaded,
		appendMdLoadedAll: discovery.appendMdLoadedAll,
	});

	const verification = buildVerification({
		discovery,
		sections,
		loadedAppendPresent: appendArr.length > 0,
		loadedAppendArr: appendArr,
		loaderSystemPrompt: resourceLoader.systemPrompt,
	});

	// (chalk-using renderers initialised below)

	if (mode === "json") {
		const out = {
			cwd,
			agentDir,
			mode,
			discovery: {
				systemMd: { candidates: discovery.systemMdCandidates, loaded: discovery.systemMdLoaded },
				appendMd: { candidates: discovery.appendMdCandidates, loaded: discovery.appendMdLoaded },
				contextFiles: discovery.contextFiles,
			},
			sections: sections.map((s) => ({
				kind: s.kind,
				source: s.source,
				chars: s.chars,
				tokens: s.tokens,
				pct: Number(s.pct.toFixed(2)),
				content: sysPrompt.slice(s.start, s.end),
			})),
			totals: { chars: totalChars, tokens: Math.ceil(totalChars / 4) },
			verification,
		};
		process.stdout.write(JSON.stringify(out, null, 2) + "\n");
		return;
	}

	const log = (msg) => console.error(msg);

	log("");
	log(chalk.bold("prompt-dump") + chalk.dim("  mode=" + mode + (sectionFilter ? "  filter=" + sectionFilter : "")));
	log(chalk.dim("  cwd      = ") + cwd);
	log(chalk.dim("  agentDir = ") + agentDir);
	log("");

	log(renderDiscovery(discovery, chalk));
	log("");
	log(renderSectionsTable(sections, totalChars, chalk));
	log("");
	log(renderVerification(verification, chalk));

	if (mode === "dry") {
		return;
	}

	// Skills detail (only in full / section mode)
	const skillsRaw = resourceLoader.getSkills ? resourceLoader.getSkills() : null;
	const skillList = Array.isArray(skillsRaw) ? skillsRaw : (skillsRaw?.skills || []);
	if (skillList.length > 0 && (mode === "full" || (sectionFilter && "skills".includes(sectionFilter.toLowerCase())))) {
		log("");
		log(chalk.bold("Skills detail") + chalk.dim(`  (${skillList.length} total)`));
		log("─".repeat(72));
		for (const sk of skillList) {
			const skPath = sk.path || sk.file || "";
			const skName = sk.name || path.basename(skPath, ".md");
			log(`  ${chalk.yellow(skName.padEnd(40))} ${chalk.dim(shortenHome(skPath))}`);
		}
	}

	log("");
	log(renderFullContent(sysPrompt, sections, sectionFilter, chalk));

	log("");
	log(chalk.dim("═".repeat(72)));
	log(chalk.bold("TOTAL") + chalk.dim(`  ${totalChars.toLocaleString()} chars  /  ~${Math.ceil(totalChars / 4).toLocaleString()} tokens`));
}
