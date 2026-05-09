/**
 * AI-driven patch applier.
 *
 * For each spec:
 *   1. Read the current dist file
 *   2. Run the spec's verify() — if ok, mark applied, done
 *   3. Else: dispatch a fresh subagent with { spec, current_file_content,
 *      verify failure messages } and ask it to produce minimal find/replace
 *      edits (each `find` must be unique within the file)
 *   4. Validate the edits (each `find` appears exactly once), apply in order
 *   5. Re-run verify
 *   6. If ok → write the patched file; if still failing → revert in-memory,
 *      log the failure, leave dist untouched
 *
 * The agent never sees a regex — it only sees the spec's plain-language intent
 * + the actual current file content. That's why this approach survives
 * upstream refactors: the spec is the durable artifact, the edits are derived
 * fresh each run.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ApplyResult, PatchSpec, VerifyResult } from "./types.js";

export interface ApplierOptions {
	/** Path to pi-coding-agent dist directory. */
	distDir: string;
	/** Where to write logs / state. Defaults to `<extension cache dir>/patch-applier/`. */
	stateDir?: string;
	/** Override pi binary path (mostly for tests). */
	piBin?: string;
	/** Per-patch agent dispatch timeout (ms). */
	timeoutMs?: number;
	/** Optional override of the agent dispatcher (for tests). */
	deriveEdits?: (spec: PatchSpec, fileContent: string, failures: string[]) => Promise<Edit[]>;
}

export interface Edit {
	find: string;
	replace: string;
}

const DEFAULT_TIMEOUT_MS = Number(process.env.PI_PATCH_TIMEOUT_MS) || 120_000;

/**
 * Apply all specs against the dist directory. Returns one ApplyResult per
 * spec. Never throws — failures are reported in the result objects.
 */
export async function applyAll(specs: PatchSpec[], opts: ApplierOptions): Promise<ApplyResult[]> {
	const results: ApplyResult[] = [];
	for (const spec of specs) {
		try {
			const r = await applyOne(spec, opts);
			results.push(r);
		} catch (e: any) {
			results.push({
				specId: spec.id,
				target: spec.target,
				status: "failed",
				message: `applier crashed: ${e?.message ?? String(e)}`,
			});
		}
	}
	return results;
}

export async function applyOne(spec: PatchSpec, opts: ApplierOptions): Promise<ApplyResult> {
	const filePath = path.join(opts.distDir, spec.target);
	let content: string;
	try {
		content = fs.readFileSync(filePath, "utf8");
	} catch (e: any) {
		return {
			specId: spec.id,
			target: spec.target,
			status: "failed",
			message: `cannot read target: ${e?.message ?? String(e)}`,
		};
	}

	// Fast path — verify already passes
	if (spec.marker && content.includes(spec.marker)) {
		const v = spec.verify(content);
		if (v.ok) {
			return { specId: spec.id, target: spec.target, status: "already" };
		}
		// marker present but verify failed — fall through to re-derive (partial state)
	} else {
		const v = spec.verify(content);
		if (v.ok) {
			return { specId: spec.id, target: spec.target, status: "already" };
		}
	}

	// Derive edits via subagent
	const failures =
		(spec.verify(content) as { ok: false; failures: string[] }).failures ?? [
			"verify failed (no specific failures returned)",
		];

	const derive = opts.deriveEdits ?? defaultDeriveEdits(opts);
	const edits = await derive(spec, content, failures);

	if (!edits || edits.length === 0) {
		return {
			specId: spec.id,
			target: spec.target,
			status: "failed",
			message: "agent produced no edits",
		};
	}

	// Validate: each `find` must appear exactly once in the file (otherwise the
	// edit is ambiguous and we refuse to apply rather than risk corruption).
	for (const e of edits) {
		const occurrences = countOccurrences(content, e.find);
		if (occurrences === 0) {
			return {
				specId: spec.id,
				target: spec.target,
				status: "failed",
				message: `edit's find string not present in file: ${preview(e.find)}`,
				edits,
			};
		}
		if (occurrences > 1) {
			return {
				specId: spec.id,
				target: spec.target,
				status: "failed",
				message: `edit's find string is ambiguous (${occurrences} matches): ${preview(e.find)}`,
				edits,
			};
		}
	}

	// Apply in order
	let next = content;
	for (const e of edits) {
		// Re-check uniqueness after each step (an earlier edit could have created
		// a second match for a later `find`).
		const n = countOccurrences(next, e.find);
		if (n !== 1) {
			return {
				specId: spec.id,
				target: spec.target,
				status: "failed",
				message: `intermediate state: edit's find string has ${n} matches after a prior edit: ${preview(e.find)}`,
				edits,
			};
		}
		next = next.replace(e.find, () => e.replace);
	}

	// Re-verify
	const v2 = spec.verify(next);
	if (!v2.ok) {
		return {
			specId: spec.id,
			target: spec.target,
			status: "failed",
			message: `verify still failing after applying edits: ${v2.failures.join("; ")}`,
			edits,
		};
	}

	try {
		fs.writeFileSync(filePath, next, "utf8");
	} catch (e: any) {
		return {
			specId: spec.id,
			target: spec.target,
			status: "failed",
			message: `write failed: ${e?.message ?? String(e)}`,
			edits,
		};
	}

	return { specId: spec.id, target: spec.target, status: "applied", edits };
}

// ---------------------------------------------------------------------------

function countOccurrences(haystack: string, needle: string): number {
	if (!needle) return 0;
	let count = 0;
	let i = 0;
	while ((i = haystack.indexOf(needle, i)) !== -1) {
		count++;
		i += needle.length;
	}
	return count;
}

function preview(s: string, max = 80): string {
	const oneLine = s.replace(/\n/g, "\\n");
	return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

// ---------------------------------------------------------------------------
// Default agent dispatcher — uses the `pi` CLI in JSON mode to run a focused
// one-shot agent. Returns parsed Edit[] or throws on protocol error.

function defaultDeriveEdits(opts: ApplierOptions) {
	const piBin = opts.piBin ?? "pi";
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	return async function deriveEdits(
		spec: PatchSpec,
		fileContent: string,
		failures: string[],
	): Promise<Edit[]> {
		const prompt = buildPrompt(spec, fileContent, failures);
		const stdout = await spawnPi(piBin, prompt, timeoutMs);
		return parseEditsResponse(stdout);
	};
}

export function buildPrompt(spec: PatchSpec, fileContent: string, failures: string[]): string {
	return `You are a runtime patcher for the pi CLI. Read the JS file content below
and produce the minimal text edits needed to satisfy the SPEC.

# SPEC

${spec.intent}

${spec.hint ? `\n## Hint\n${spec.hint}\n` : ""}

# CURRENT VERIFICATION FAILURES

${failures.map((f) => `- ${f}`).join("\n")}

# CONSTRAINTS

- Output ONLY a JSON object on a single line: {"replacements":[{"find":"...","replace":"..."}, ...]}
- Each "find" string MUST appear EXACTLY ONCE in the file content. If you cannot find a unique short
  anchor, include enough surrounding context to make it unique (but keep it as small as possible).
- Do NOT include unrelated changes. Touch only what's needed.
- Preserve all existing template-literal syntax, indentation, and surrounding code.
- If the file already satisfies the spec, return {"replacements":[]}.

# FILE CONTENT (target: ${spec.target})

\`\`\`js
${fileContent}
\`\`\`

Respond with the JSON object only. No prose.`;
}

export function parseEditsResponse(raw: string): Edit[] {
	// Tolerate code-fenced JSON, leading/trailing prose, and extra whitespace.
	const stripped = raw.trim();

	// Try direct parse first
	const direct = tryParseObject(stripped);
	if (direct) return validateEditsShape(direct);

	// Try fenced code block
	const fenceMatch = stripped.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
	if (fenceMatch?.[1]) {
		const fenced = tryParseObject(fenceMatch[1]);
		if (fenced) return validateEditsShape(fenced);
	}

	// Try to find a JSON object with "replacements" inside arbitrary text
	const objMatch = stripped.match(/\{[\s\S]*"replacements"[\s\S]*\}/);
	if (objMatch?.[0]) {
		const found = tryParseObject(objMatch[0]);
		if (found) return validateEditsShape(found);
	}

	throw new Error(`agent response did not contain a parseable replacements object: ${preview(stripped, 200)}`);
}

function tryParseObject(s: string): unknown {
	try {
		return JSON.parse(s);
	} catch {
		return null;
	}
}

function validateEditsShape(parsed: unknown): Edit[] {
	if (!parsed || typeof parsed !== "object") {
		throw new Error("response is not an object");
	}
	const reps = (parsed as any).replacements;
	if (!Array.isArray(reps)) {
		throw new Error("response.replacements is not an array");
	}
	const edits: Edit[] = [];
	for (let i = 0; i < reps.length; i++) {
		const r = reps[i];
		if (!r || typeof r !== "object") throw new Error(`replacements[${i}] is not an object`);
		if (typeof r.find !== "string") throw new Error(`replacements[${i}].find is not a string`);
		if (typeof r.replace !== "string") throw new Error(`replacements[${i}].replace is not a string`);
		edits.push({ find: r.find, replace: r.replace });
	}
	return edits;
}

// ---------------------------------------------------------------------------

function spawnPi(piBin: string, prompt: string, timeoutMs: number): Promise<string> {
	return new Promise((resolve, reject) => {
		const args = ["--mode", "json", "-p", prompt, "--no-session", "--no-extensions", "--no-skills"];
		const child = spawn(piBin, args, { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`agent timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		child.stdout.on("data", (b) => (stdout += b.toString("utf8")));
		child.stderr.on("data", (b) => (stderr += b.toString("utf8")));
		child.on("error", (e) => {
			clearTimeout(timer);
			reject(e);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (code !== 0) {
				reject(new Error(`pi exited ${code}: ${stderr.slice(-2000)}`));
				return;
			}
			// pi --mode json wraps assistant text in JSON events; extract the final
			// assistant message text by scanning for it.
			resolve(extractAssistantText(stdout));
		});
	});
}

export function extractAssistantText(jsonStream: string): string {
	const lines = jsonStream.split(/\r?\n/).filter(Boolean);
	let lastText = "";
	for (const line of lines) {
		try {
			const o = JSON.parse(line);
			// pi --mode json emits various event shapes; we want the final
			// assistant message content.
			if (typeof o === "object" && o !== null) {
				const text = pickAssistantText(o);
				if (text) lastText = text;
			}
		} catch {
			// not JSON — could be the raw final response if pi falls back to plain
			// text. Append.
			lastText = lastText ? `${lastText}\n${line}` : line;
		}
	}
	return lastText;
}

function pickAssistantText(o: any): string | null {
	// Try common shapes:
	//   { type: "message", role: "assistant", content: [{ type: "text", text: "..." }] }
	//   { role: "assistant", text: "..." }
	//   { event: "assistant_message", text: "..." }
	if (o.role === "assistant" && typeof o.text === "string") return o.text;
	if (typeof o.text === "string" && (o.type === "text" || o.event?.includes?.("assistant"))) {
		return o.text;
	}
	if (Array.isArray(o.content)) {
		const texts = o.content
			.filter((c: any) => c && c.type === "text" && typeof c.text === "string")
			.map((c: any) => c.text);
		if (texts.length) return texts.join("\n");
	}
	if (Array.isArray(o.message?.content)) {
		const texts = o.message.content
			.filter((c: any) => c && c.type === "text" && typeof c.text === "string")
			.map((c: any) => c.text);
		if (texts.length) return texts.join("\n");
	}
	return null;
}
