/**
 * Scope-aware resolver for the live `pi-coding-agent` install.
 *
 * Survives the upstream package rename from `@mariozechner/pi-coding-agent`
 * to `@earendil-works/pi-coding-agent` (pi v0.74.0+, May 2026) and any future
 * scope change. Consumers should never hardcode the package name or install
 * path; instead, call `findPiCodingAgentDist({ probe: <relative-file> })` and
 * gate behavior on the returned `distDir`.
 *
 * Resolution order (each candidate is gated on `existsSync(probe)` when set):
 *   1. opts.override
 *   2. createRequire(...).resolve("@earendil-works/pi-coding-agent/package.json")
 *   3. createRequire(...).resolve("@mariozechner/pi-coding-agent/package.json")
 *   4. Walk up from opts.startDir looking for node_modules/<scope>/pi-coding-agent/dist
 *   5. Literal candidates under /opt/homebrew/, /usr/local/, ~/.npm-global/, common nvm paths
 *
 * The walk-up is done before literal candidates because monorepo / nvm / pnpm
 * layouts often have a closer-than-system-prefix install that the user expects
 * to win.
 *
 * Returns `null` when nothing matches. Callers MUST handle null gracefully —
 * never throw at module load time over a missing dist (the user might be
 * running with a partial install).
 */

import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// ───────────────────────────────────────────────────────────────────────────
// Constants
// ───────────────────────────────────────────────────────────────────────────

export const PI_NEW_PKG_NAME = "@earendil-works/pi-coding-agent";
export const PI_OLD_PKG_NAME = "@mariozechner/pi-coding-agent";

export const PI_NEW_REPO_URL = "https://github.com/earendil-works/pi-mono.git";
export const PI_OLD_REPO_URL = "https://github.com/badlogic/pi-mono.git";

/** Candidate package names, ordered from new (preferred) to old (legacy). */
export const PI_PKG_CANDIDATES = [PI_NEW_PKG_NAME, PI_OLD_PKG_NAME] as const;

/** Companion pi-tui package candidates. */
export const PI_TUI_PKG_CANDIDATES = [
	"@earendil-works/pi-tui",
	"@mariozechner/pi-tui",
] as const;

// ───────────────────────────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────────────────────────

export type PiScope = "@earendil-works" | "@mariozechner" | "unknown";

export interface PiResolveOptions {
	/**
	 * Probe file (relative to dist) that must exist for a candidate to be
	 * accepted. e.g. "core/model-registry.js" or
	 * "modes/interactive/interactive-mode.js". When omitted, only `<dist>/`
	 * itself is checked for existence.
	 */
	probe?: string;
	/**
	 * Explicit override (e.g. CLI --dist or env var). Returned as-is when the
	 * directory exists and probe (if any) succeeds.
	 */
	override?: string;
	/**
	 * Walk-up start dir. When omitted, walk-up is skipped. Callers should pass
	 * `path.dirname(fileURLToPath(import.meta.url))` to walk up from their
	 * own location. NOT `process.cwd()` — that would make resolution
	 * non-deterministic across subagent invocations from arbitrary cwds.
	 */
	startDir?: string;
	/** Walk-up budget. Default 10. */
	maxDepth?: number;
	/**
	 * Extra literal candidates probed BEFORE the built-in defaults. User-
	 * supplied paths win over system-prefix discovery, which is what callers
	 * usually want (env var override, ctx.piInstallDir, etc.).
	 */
	extraCandidates?: string[];
	/** Skip require.resolve attempt (testing only). */
	skipRequireResolve?: boolean;
	/** Skip walk-up attempt (testing only). */
	skipWalkUp?: boolean;
	/** Skip literal candidates (testing only). */
	skipLiterals?: boolean;
}

export interface PiResolveResult {
	/** Absolute path to `<pi-coding-agent>/dist`. */
	distDir: string;
	/** Absolute path to the package root (parent of `dist`). */
	pkgDir: string;
	/** Detected scope. */
	scope: PiScope;
	/** Full package name with scope, e.g. `@earendil-works/pi-coding-agent`. */
	pkgName: string;
	/** How resolution succeeded — useful for diagnostics. */
	via: "override" | "require.resolve" | "walkup" | "literal";
}

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

function probeOk(distDir: string, probe?: string): boolean {
	if (!fs.existsSync(distDir)) return false;
	if (!probe) return true;
	return fs.existsSync(path.join(distDir, probe));
}

/**
 * Given an absolute `<...>/pi-coding-agent/dist` path, derive the scope and
 * package name. Falls back to reading `package.json` if the parent directory
 * doesn't look like a known scope.
 */
function detectScope(distDir: string): { scope: PiScope; pkgName: string } {
	const pkgDir = path.dirname(distDir);
	const scopeDir = path.dirname(pkgDir);
	const scopeName = path.basename(scopeDir);
	if (scopeName === "@earendil-works") {
		return { scope: "@earendil-works", pkgName: PI_NEW_PKG_NAME };
	}
	if (scopeName === "@mariozechner") {
		return { scope: "@mariozechner", pkgName: PI_OLD_PKG_NAME };
	}
	// Unknown scope — try reading the package.json
	try {
		const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf-8")) as {
			name?: string;
		};
		return { scope: "unknown", pkgName: pkg.name ?? "pi-coding-agent" };
	} catch {
		return { scope: "unknown", pkgName: "pi-coding-agent" };
	}
}

/** Default literal install prefixes, ordered by likelihood on macOS/Linux. */
function defaultPrefixDirs(): string[] {
	const home = os.homedir();
	return [
		"/opt/homebrew/lib/node_modules",
		"/usr/local/lib/node_modules",
		path.join(home, ".npm-global", "lib", "node_modules"),
		path.join(home, ".nvm", "versions", "node"), // expanded below
	];
}

/** Expand nvm root into per-version node_modules dirs that actually exist. */
function expandNvmCandidates(nvmRoot: string): string[] {
	if (!fs.existsSync(nvmRoot)) return [];
	try {
		return fs
			.readdirSync(nvmRoot)
			.filter((v) => v.startsWith("v"))
			.map((v) => path.join(nvmRoot, v, "lib", "node_modules"))
			.filter((p) => fs.existsSync(p));
	} catch {
		return [];
	}
}

/** All literal candidate dist directories, ordered. */
function buildLiteralCandidates(): string[] {
	const prefixes: string[] = [];
	for (const p of defaultPrefixDirs()) {
		if (p.endsWith("/.nvm/versions/node")) {
			prefixes.push(...expandNvmCandidates(p));
		} else {
			prefixes.push(p);
		}
	}

	const candidates: string[] = [];
	for (const prefix of prefixes) {
		for (const pkgName of PI_PKG_CANDIDATES) {
			candidates.push(path.join(prefix, pkgName, "dist"));
		}
	}
	return candidates;
}

// ───────────────────────────────────────────────────────────────────────────
// Public API
// ───────────────────────────────────────────────────────────────────────────

/**
 * Find the live `pi-coding-agent/dist` directory.
 *
 * @returns Resolution result, or `null` if no candidate satisfies the probe.
 */
export function findPiCodingAgentDist(opts: PiResolveOptions = {}): PiResolveResult | null {
	const {
		probe,
		override,
		startDir,
		maxDepth = 10,
		extraCandidates = [],
		skipRequireResolve,
		skipWalkUp,
		skipLiterals,
	} = opts;

	// 1. Override (CLI flag, env var, ctx.piInstallDir, etc.)
	if (override) {
		// Accept either a dist dir or a package root with `dist/` inside.
		let distDir = override;
		if (!path.basename(distDir).startsWith("dist")) {
			const candidate = path.join(override, "dist");
			if (fs.existsSync(candidate)) distDir = candidate;
		}
		if (probeOk(distDir, probe)) {
			const detected = detectScope(distDir);
			return {
				distDir,
				pkgDir: path.dirname(distDir),
				...detected,
				via: "override",
			};
		}
	}

	// 2. require.resolve — preferred at runtime since it understands the actual
	// node module resolution chain (symlinks, monorepo hoisting, etc.)
	if (!skipRequireResolve) {
		const req = createRequire(import.meta.url);
		for (const pkgName of PI_PKG_CANDIDATES) {
			try {
				const pkgJsonPath = req.resolve(`${pkgName}/package.json`);
				const pkgDir = path.dirname(pkgJsonPath);
				const distDir = path.join(pkgDir, "dist");
				if (probeOk(distDir, probe)) {
					return {
						distDir,
						pkgDir,
						scope: pkgName.split("/")[0] as PiScope,
						pkgName,
						via: "require.resolve",
					};
				}
			} catch {
				// not installed under this name; try next
			}
		}
	}

	// 3. Walk up from caller's startDir looking for nested node_modules
	if (!skipWalkUp && startDir) {
		let dir = path.resolve(startDir);
		for (let i = 0; i < maxDepth; i++) {
			const nodeModules = path.join(dir, "node_modules");
			if (fs.existsSync(nodeModules)) {
				for (const pkgName of PI_PKG_CANDIDATES) {
					const distDir = path.join(nodeModules, pkgName, "dist");
					if (probeOk(distDir, probe)) {
						return {
							distDir,
							pkgDir: path.join(nodeModules, pkgName),
							scope: pkgName.split("/")[0] as PiScope,
							pkgName,
							via: "walkup",
						};
					}
				}
			}
			const parent = path.dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
	}

	// 4. Literal candidates — last resort. extraCandidates probed first so
	//    callers can supply overrides that beat the built-in system-prefix list.
	if (!skipLiterals) {
		const literals = [...extraCandidates, ...buildLiteralCandidates()];
		for (const distDir of literals) {
			if (probeOk(distDir, probe)) {
				const detected = detectScope(distDir);
				return {
					distDir,
					pkgDir: path.dirname(distDir),
					...detected,
					via: "literal",
				};
			}
		}
	}

	return null;
}

export interface PiTuiResolveOptions {
	/** Probe file relative to pi-tui dist. */
	probe?: string;
}

/**
 * Find the live `pi-tui/dist` directory associated with a resolved
 * `pi-coding-agent` install. Handles two layouts:
 *
 *   1. Nested (post-`npm pack` canonical): `<pi-coding-agent>/node_modules/@<scope>/pi-tui/dist`
 *   2. Hoisted sibling: `<scope-dir>/pi-tui/dist`
 *
 * @param piCodingAgentDistDir Result of `findPiCodingAgentDist()`.distDir
 */
export function findPiTuiDist(
	piCodingAgentDistDir: string,
	opts: PiTuiResolveOptions = {},
): string | null {
	const pkgDir = path.dirname(piCodingAgentDistDir);
	const scopeDir = path.dirname(pkgDir);
	const prefixDir = path.dirname(scopeDir);

	const candidates: string[] = [];
	// 1. Nested (canonical)
	for (const pkgName of PI_TUI_PKG_CANDIDATES) {
		candidates.push(path.join(pkgDir, "node_modules", pkgName, "dist"));
	}
	// 2. Hoisted under same scope dir
	candidates.push(path.join(scopeDir, "pi-tui", "dist"));
	// 3. Hoisted under each known scope dir at same prefix level
	for (const scope of ["@earendil-works", "@mariozechner"]) {
		candidates.push(path.join(prefixDir, scope, "pi-tui", "dist"));
	}

	for (const c of candidates) {
		if (fs.existsSync(c) && (!opts.probe || fs.existsSync(path.join(c, opts.probe)))) {
			return c;
		}
	}
	return null;
}

/**
 * Convenience: resolve dist using the caller's own `import.meta.url`.
 * Eliminates the boilerplate of `path.dirname(fileURLToPath(import.meta.url))`.
 *
 * Usage:
 *   const res = findPiCodingAgentDistFromCaller(import.meta.url, { probe: "..." });
 */
export function findPiCodingAgentDistFromCaller(
	callerUrl: string,
	opts: Omit<PiResolveOptions, "startDir"> = {},
): PiResolveResult | null {
	const startDir = path.dirname(fileURLToPath(callerUrl));
	return findPiCodingAgentDist({ ...opts, startDir });
}
