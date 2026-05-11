import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Import the runtime — pure JS, importable directly
// @ts-expect-error — runtime.js is plain JS
import { discoverContext, splitSections, buildVerification, runPromptDump, detectCascadeAppendActive, grepSections } from "../src/runtime.js";

function tmpdir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "prompt-dump-runtime-"));
}

describe("discoverContext", () => {
	let root: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		root = tmpdir();
		cwd = path.join(root, "work", "project");
		agentDir = path.join(root, "agent");
		fs.mkdirSync(cwd, { recursive: true });
		fs.mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("returns empty discovery on bare filesystem", () => {
		const d = discoverContext({ cwd, agentDir });
		expect(d.systemMdLoaded).toBeNull();
		expect(d.appendMdLoaded).toBeNull();
		expect(d.contextFiles).toEqual([]);
	});

	it("project SYSTEM.md wins over global, global is shadowed but reported", () => {
		fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
		fs.writeFileSync(path.join(cwd, ".pi", "SYSTEM.md"), "project sys", "utf8");
		fs.writeFileSync(path.join(agentDir, "SYSTEM.md"), "global sys", "utf8");
		const d = discoverContext({ cwd, agentDir });
		expect(d.systemMdLoaded).toBe(path.join(cwd, ".pi", "SYSTEM.md"));
		expect(d.systemMdCandidates).toHaveLength(2);
		expect(d.systemMdCandidates[0].label).toBe("project");
		expect(d.systemMdCandidates[1].label).toBe("global");
	});

	it("falls back to global APPEND_SYSTEM.md when project absent", () => {
		fs.writeFileSync(path.join(agentDir, "APPEND_SYSTEM.md"), "global append", "utf8");
		const d = discoverContext({ cwd, agentDir });
		expect(d.appendMdLoaded).toBe(path.join(agentDir, "APPEND_SYSTEM.md"));
		expect(d.appendMdLoadedAll).toEqual([path.join(agentDir, "APPEND_SYSTEM.md")]);
	});

	it("discovers APPEND_SYSTEM.md cascade across agentDir + cwd ancestors", () => {
		fs.writeFileSync(path.join(agentDir, "APPEND_SYSTEM.md"), "agent", "utf8");
		fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
		fs.writeFileSync(path.join(cwd, ".pi", "APPEND_SYSTEM.md"), "project", "utf8");
		fs.mkdirSync(path.join(cwd, "..", ".pi"), { recursive: true });
		fs.writeFileSync(path.join(cwd, "..", ".pi", "APPEND_SYSTEM.md"), "intermediate", "utf8");

		const d = discoverContext({ cwd, agentDir });
		// agentDir first, then root → cwd order
		expect(d.appendMdLoadedAll[0]).toBe(path.join(agentDir, "APPEND_SYSTEM.md"));
		expect(d.appendMdLoadedAll[d.appendMdLoadedAll.length - 1]).toBe(
			path.join(cwd, ".pi", "APPEND_SYSTEM.md"),
		);
		expect(d.appendMdLoadedAll).toContain(path.join(cwd, "..", ".pi", "APPEND_SYSTEM.md"));
		expect(d.appendMdLoadedAll).toHaveLength(3);
	});

	it("cascades CLAUDE.md/AGENTS.md from agentDir + cwd → root, root-first", () => {
		// agentDir CLAUDE.md
		fs.writeFileSync(path.join(agentDir, "CLAUDE.md"), "agent ctx", "utf8");
		// /tmp/.../work/project/CLAUDE.md  (cwd)
		fs.writeFileSync(path.join(cwd, "CLAUDE.md"), "project ctx", "utf8");
		// /tmp/.../work/CLAUDE.md  (intermediate)
		fs.writeFileSync(path.join(cwd, "..", "CLAUDE.md"), "work ctx", "utf8");

		const d = discoverContext({ cwd, agentDir });
		const paths = d.contextFiles.map((c: any) => c.path);

		// pi's order: agentDir entry first, then ancestors root→cwd
		expect(paths[0]).toBe(path.join(agentDir, "CLAUDE.md"));
		// last entry must be cwd's own context file
		expect(paths[paths.length - 1]).toBe(path.join(cwd, "CLAUDE.md"));
		// intermediate ancestor present somewhere in between
		expect(paths).toContain(path.join(cwd, "..", "CLAUDE.md"));
	});

	it("prefers AGENTS.md over CLAUDE.md in the same directory", () => {
		fs.writeFileSync(path.join(cwd, "AGENTS.md"), "agents", "utf8");
		fs.writeFileSync(path.join(cwd, "CLAUDE.md"), "claude", "utf8");
		const d = discoverContext({ cwd, agentDir });
		const cwdEntry = d.contextFiles.find((c: any) => c.origin === "cwd");
		expect(cwdEntry?.path).toBe(path.join(cwd, "AGENTS.md"));
	});

	it("dedupes when agentDir equals cwd", () => {
		// pathological but real: cwd == agentDir
		fs.writeFileSync(path.join(cwd, "CLAUDE.md"), "ctx", "utf8");
		const d = discoverContext({ cwd, agentDir: cwd });
		expect(d.contextFiles).toHaveLength(1);
		expect(d.contextFiles[0].path).toBe(path.join(cwd, "CLAUDE.md"));
	});
});

describe("splitSections", () => {
	it("splits a built-in base + context + footer prompt correctly", () => {
		const sys =
			"You are an expert coding assistant operating inside pi…\n\n" +
			"# Project Context\n\nProject-specific instructions and guidelines:\n\n" +
			"## /tmp/CLAUDE.md\n\nGlobal rules.\n\n" +
			"## /tmp/work/CLAUDE.md\n\nWork rules.\n\n" +
			"\nCurrent date: 2026-05-11\nCurrent working directory: /tmp/work";

		const { sections } = splitSections({
			sysPrompt: sys,
			appendArr: [],
			systemMdLoaded: null,
			appendMdLoaded: null,
		});

		const kinds = sections.map((s: any) => s.kind);
		expect(kinds).toEqual(["base", "context", "context", "footer"]);

		const sources = sections.map((s: any) => s.source);
		expect(sources[0]).toBe("<built-in>");
		expect(sources[1]).toBe("/tmp/CLAUDE.md");
		expect(sources[2]).toBe("/tmp/work/CLAUDE.md");

		// content recoverable from offsets
		const reassembled = sections.map((s: any) => sys.slice(s.start, s.end)).join("");
		expect(reassembled).toBe(sys);
	});

	it("locates the append section by content match", () => {
		const appendText = "ENV TOKEN expansion happens here";
		const sys =
			"BASE PROMPT\n\n" + appendText + "\n\n" +
			"# Project Context\n\nProject-specific instructions and guidelines:\n\n" +
			"## /a/CLAUDE.md\n\nx\n\n" +
			"\nCurrent date: 2026-05-11\nCurrent working directory: /tmp";

		const { sections } = splitSections({
			sysPrompt: sys,
			appendArr: [appendText],
			systemMdLoaded: null,
			appendMdLoaded: "/some/APPEND_SYSTEM.md",
		});
		const kinds = sections.map((s: any) => s.kind);
		expect(kinds).toEqual(["base", "append", "context", "footer"]);
		const appendSection = sections.find((s: any) => s.kind === "append");
		expect(sys.slice(appendSection.start, appendSection.end)).toContain(appendText);
		expect(appendSection.source).toBe("/some/APPEND_SYSTEM.md");
	});

	it("handles a skills block", () => {
		const sys =
			"BASE\n\n" +
			"\nThe following skills provide specialized instructions for specific tasks.\n" +
			"<available_skills>\n  <skill>x</skill>\n</available_skills>\n" +
			"\nCurrent date: 2026-05-11\nCurrent working directory: /tmp";

		const { sections } = splitSections({
			sysPrompt: sys,
			appendArr: [],
			systemMdLoaded: null,
			appendMdLoaded: null,
		});
		const kinds = sections.map((s: any) => s.kind);
		expect(kinds).toContain("skills");
		expect(kinds[kinds.length - 1]).toBe("footer");
	});

	it("base source reflects custom SYSTEM.md when provided", () => {
		const sys = "CUSTOM\n\nCurrent date: 2026-05-11\nCurrent working directory: /tmp";
		const { sections } = splitSections({
			sysPrompt: sys,
			appendArr: [],
			systemMdLoaded: "/proj/.pi/SYSTEM.md",
			appendMdLoaded: null,
		});
		expect(sections[0].kind).toBe("base");
		expect(sections[0].source).toBe("/proj/.pi/SYSTEM.md");
	});

	it("sums all section chars to total prompt length", () => {
		const sys =
			"BASE\n\n" +
			"# Project Context\n\nProject-specific instructions and guidelines:\n\n" +
			"## /a/CLAUDE.md\n\naaa\n\n" +
			"## /b/CLAUDE.md\n\nbbb\n\n" +
			"\nCurrent date: 2026-05-11\nCurrent working directory: /tmp";

		const { sections, anchors } = splitSections({
			sysPrompt: sys,
			appendArr: [],
			systemMdLoaded: null,
			appendMdLoaded: null,
		});
		const sum = sections.reduce((acc: number, s: any) => acc + s.chars, 0);
		expect(sum).toBe(sys.length);
		expect(anchors.total).toBe(sys.length);
	});
});

describe("buildVerification", () => {
	it("flags discovered-but-not-loaded context files", () => {
		const discovery = {
			contextFiles: [{ path: "/a/CLAUDE.md", origin: "agentDir", size: 10 }, { path: "/b/CLAUDE.md", origin: "cwd", size: 10 }],
			systemMdLoaded: null,
			appendMdLoaded: null,
			systemMdCandidates: [],
			appendMdCandidates: [],
		};
		const sections = [
			{ kind: "base", source: "<built-in>" },
			{ kind: "context", source: "/a/CLAUDE.md" },
			// /b/CLAUDE.md NOT in sections — drift!
			{ kind: "footer", source: "<date+cwd>" },
		];
		const v = buildVerification({ discovery, sections, loadedAppendPresent: false, loaderSystemPrompt: undefined });
		const bMissing = v.find((x: any) => x.msg.includes("/b/CLAUDE.md"));
		expect(bMissing.ok).toBe(false);
	});

	it("flags single-match drift when cascade extension is not active", () => {
		const discovery = {
			contextFiles: [],
			systemMdLoaded: null,
			appendMdLoaded: "/a/.pi/APPEND_SYSTEM.md",
			appendMdLoadedAll: ["/a/.pi/APPEND_SYSTEM.md", "/b/.pi/APPEND_SYSTEM.md"],
			systemMdCandidates: [],
			appendMdCandidates: [],
		};
		const v = buildVerification({
			discovery,
			sections: [],
			loadedAppendPresent: true,
			loadedAppendArr: ["only one loaded"],
			loaderSystemPrompt: undefined,
		});
		const appendCheck = v.find((x: any) => x.msg.includes("APPEND_SYSTEM.md"));
		expect(appendCheck.ok).toBe(false);
		expect(appendCheck.msg).toContain("1/2 loaded");
		expect(appendCheck.msg).toContain("cascading-append-system");
	});

	it("passes when cascade count matches discovery count", () => {
		const discovery = {
			contextFiles: [],
			systemMdLoaded: null,
			appendMdLoaded: "/a/.pi/APPEND_SYSTEM.md",
			appendMdLoadedAll: ["/a/.pi/APPEND_SYSTEM.md", "/b/.pi/APPEND_SYSTEM.md"],
			systemMdCandidates: [],
			appendMdCandidates: [],
		};
		const v = buildVerification({
			discovery,
			sections: [],
			loadedAppendPresent: true,
			loadedAppendArr: ["first", "second"],
			loaderSystemPrompt: undefined,
		});
		const appendCheck = v.find((x: any) => x.msg.includes("APPEND_SYSTEM.md"));
		expect(appendCheck.ok).toBe(true);
		expect(appendCheck.msg).toContain("2/2 loaded");
	});

	it("flags SYSTEM.md drift (discovered but loader has no custom prompt)", () => {
		const discovery = {
			contextFiles: [],
			systemMdLoaded: "/proj/.pi/SYSTEM.md",
			appendMdLoaded: null,
			systemMdCandidates: [],
			appendMdCandidates: [],
		};
		const v = buildVerification({ discovery, sections: [], loadedAppendPresent: false, loaderSystemPrompt: undefined });
		const sysCheck = v.find((x: any) => x.msg.includes("SYSTEM.md"));
		expect(sysCheck.ok).toBe(false);
	});

	it("passes when nothing on disk and nothing loaded", () => {
		const discovery = {
			contextFiles: [],
			systemMdLoaded: null,
			appendMdLoaded: null,
			systemMdCandidates: [],
			appendMdCandidates: [],
		};
		const v = buildVerification({ discovery, sections: [], loadedAppendPresent: false, loaderSystemPrompt: undefined });
		expect(v.every((x: any) => x.ok)).toBe(true);
	});
});

describe("detectCascadeAppendActive", () => {
	it("returns null when piDistDir is missing or unreadable", () => {
		expect(detectCascadeAppendActive({})).toBeNull();
		expect(detectCascadeAppendActive({ piDistDir: "/nonexistent/dist" })).toBeNull();
	});

	it("returns true when the marker is present", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-detect-"));
		try {
			fs.mkdirSync(path.join(tmp, "core"));
			fs.writeFileSync(
				path.join(tmp, "core", "resource-loader.js"),
				'discoverAppendSystemPromptFile() { /* PATCHED by @ironin/pi-cascading-append-system */ }',
				"utf8",
			);
			expect(detectCascadeAppendActive({ piDistDir: tmp })).toBe(true);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("returns false when resource-loader.js exists without the marker", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-detect-neg-"));
		try {
			fs.mkdirSync(path.join(tmp, "core"));
			fs.writeFileSync(
				path.join(tmp, "core", "resource-loader.js"),
				"// stock pi resource loader\n",
				"utf8",
			);
			expect(detectCascadeAppendActive({ piDistDir: tmp })).toBe(false);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
});

describe("grepSections", () => {
	const sys =
		"BASE LINE ONE\n" +
		"base line two with banana\n\n" +
		"# Project Context\n\nProject-specific instructions and guidelines:\n\n" +
		"## /a/CLAUDE.md\n\nfirst context with Banana fruit\nplain line\n\n" +
		"## /b/CLAUDE.md\n\nbanana again\n\n" +
		"\nCurrent date: 2026-05-11\nCurrent working directory: /tmp";
	const built = splitSections({
		sysPrompt: sys,
		appendArr: [],
		systemMdLoaded: null,
		appendMdLoaded: null,
	});

	it("attributes matches to their section kind and source", () => {
		// `[Bb]anana` to match both uppercase BANANA and lowercase banana
		// across all three sections (base, /a context, /b context).
		const { matches } = grepSections({ sysPrompt: sys, sections: built.sections, pattern: "[Bb]anana" });
		const kinds = matches.map((m: any) => m.kind);
		const sources = matches.map((m: any) => m.source);
		expect(kinds).toContain("base");
		expect(kinds).toContain("context");
		expect(sources).toContain("/a/CLAUDE.md");
		expect(sources).toContain("/b/CLAUDE.md");
	});

	it("is case-sensitive by default", () => {
		const { matches } = grepSections({
			sysPrompt: sys,
			sections: built.sections,
			pattern: "Banana",
		});
		// Only the line containing capital-B Banana in the first context entry.
		expect(matches).toHaveLength(1);
		expect(matches[0].kind).toBe("context");
		expect(matches[0].source).toBe("/a/CLAUDE.md");
	});

	it("honours ignoreCase", () => {
		const { matches } = grepSections({
			sysPrompt: sys,
			sections: built.sections,
			pattern: "banana",
			ignoreCase: true,
		});
		// All three banana/Banana occurrences (one base, two context entries).
		expect(matches.length).toBeGreaterThanOrEqual(3);
	});

	it("returns an error object for invalid regexes", () => {
		const { error, matches } = grepSections({
			sysPrompt: sys,
			sections: built.sections,
			pattern: "[unterminated",
		});
		expect(error).toMatch(/invalid regex/);
		expect(matches).toHaveLength(0);
	});

	it("line numbers are 1-indexed within the section", () => {
		const { matches } = grepSections({
			sysPrompt: sys,
			sections: built.sections,
			pattern: "plain line",
		});
		expect(matches).toHaveLength(1);
		expect(matches[0].lineNumber).toBeGreaterThanOrEqual(1);
	});
});

describe("runPromptDump (json mode integration)", () => {
	it("emits a structured JSON object covering all sections", async () => {
		const sys =
			"BASE\n\n" +
			"# Project Context\n\nProject-specific instructions and guidelines:\n\n" +
			"## /a/CLAUDE.md\n\naaa\n\n" +
			"\nCurrent date: 2026-05-11\nCurrent working directory: /tmp";

		const fakeSession = { systemPrompt: sys };
		const fakeLoader = {
			appendSystemPrompt: [],
			systemPrompt: undefined,
			getSkills: () => [],
		};
		const tmp = tmpdir();
		try {
			const chunks: string[] = [];
			const orig = process.stdout.write.bind(process.stdout);
			(process.stdout.write as any) = (s: any) => {
				chunks.push(String(s));
				return true;
			};
			await runPromptDump({
				cwd: tmp,
				agentDir: tmp,
				session: fakeSession,
				resourceLoader: fakeLoader,
				parsed: { promptDumpJson: true },
			});
			(process.stdout.write as any) = orig;

			const json = JSON.parse(chunks.join(""));
			expect(json.mode).toBe("json");
			expect(json.sections.map((s: any) => s.kind)).toEqual(["base", "context", "footer"]);
			expect(json.totals.chars).toBe(sys.length);
			expect(Array.isArray(json.verification)).toBe(true);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
});
