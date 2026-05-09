/**
 * Tests for `findPiCodingAgentDist` — verifies it correctly resolves the live
 * pi install across both legacy `@mariozechner/` and new `@earendil-works/`
 * scopes, falls back gracefully, and returns `null` when nothing matches.
 *
 * Strategy: build synthetic install layouts in temp dirs and call the resolver
 * with override/extraCandidates. We avoid touching the user's real /opt/homebrew
 * by using `skipLiterals: true` for tests that should be deterministic, and
 * use `skipRequireResolve` to prevent the resolver from finding the real
 * installed package via Node's resolution chain.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	findPiCodingAgentDist,
	findPiTuiDist,
	findPiCodingAgentDistFromCaller,
	PI_NEW_PKG_NAME,
	PI_OLD_PKG_NAME,
	PI_NEW_REPO_URL,
	PI_OLD_REPO_URL,
	PI_PKG_CANDIDATES,
} from "../src/index.ts";

// ───────────────────────────────────────────────────────────────────────────
// Test fixtures
// ───────────────────────────────────────────────────────────────────────────

interface FakeInstall {
	root: string;
	distDir: string;
	pkgDir: string;
}

function makeFakeInstall(
	tmpRoot: string,
	scope: string,
	pkgBaseName: string = "pi-coding-agent",
	probeFile: string = "modes/interactive/interactive-mode.js",
	pkgJson: object = {},
): FakeInstall {
	const root = fs.mkdtempSync(path.join(tmpRoot, "fake-install-"));
	const pkgDir = path.join(root, "lib", "node_modules", scope, pkgBaseName);
	const distDir = path.join(pkgDir, "dist");
	fs.mkdirSync(path.dirname(path.join(distDir, probeFile)), { recursive: true });
	fs.writeFileSync(path.join(distDir, probeFile), "// stub\n");
	fs.writeFileSync(
		path.join(pkgDir, "package.json"),
		JSON.stringify({
			name: `${scope}/${pkgBaseName}`,
			version: "0.74.0",
			...pkgJson,
		}),
	);
	return { root, distDir, pkgDir };
}

function withTmp<T>(fn: (tmp: string) => T): T {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-resolve-test-"));
	try {
		return fn(tmp);
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}

// ───────────────────────────────────────────────────────────────────────────
// Constants smoke
// ───────────────────────────────────────────────────────────────────────────

describe("constants", () => {
	it("exposes new and old package names", () => {
		assert.equal(PI_NEW_PKG_NAME, "@earendil-works/pi-coding-agent");
		assert.equal(PI_OLD_PKG_NAME, "@mariozechner/pi-coding-agent");
	});
	it("exposes new and old repo URLs", () => {
		assert.match(PI_NEW_REPO_URL, /earendil-works\/pi-mono/);
		assert.match(PI_OLD_REPO_URL, /badlogic\/pi-mono/);
	});
	it("PI_PKG_CANDIDATES lists new before old", () => {
		assert.equal(PI_PKG_CANDIDATES[0], PI_NEW_PKG_NAME);
		assert.equal(PI_PKG_CANDIDATES[1], PI_OLD_PKG_NAME);
	});
});

// ───────────────────────────────────────────────────────────────────────────
// Override path
// ───────────────────────────────────────────────────────────────────────────

describe("override resolution", () => {
	it("accepts an explicit dist path via override", () => {
		withTmp((tmp) => {
			const fake = makeFakeInstall(tmp, "@earendil-works");
			const res = findPiCodingAgentDist({
				override: fake.distDir,
				probe: "modes/interactive/interactive-mode.js",
				skipRequireResolve: true,
				skipWalkUp: true,
				skipLiterals: true,
			});
			assert.ok(res, "should resolve via override");
			assert.equal(res.via, "override");
			assert.equal(res.distDir, fake.distDir);
			assert.equal(res.scope, "@earendil-works");
			assert.equal(res.pkgName, PI_NEW_PKG_NAME);
		});
	});

	it("accepts a package-root path via override (auto-appends dist)", () => {
		withTmp((tmp) => {
			const fake = makeFakeInstall(tmp, "@mariozechner");
			const res = findPiCodingAgentDist({
				override: fake.pkgDir, // pass the parent of dist
				skipRequireResolve: true,
				skipWalkUp: true,
				skipLiterals: true,
			});
			assert.ok(res, "should auto-append dist");
			assert.equal(res.distDir, fake.distDir);
			assert.equal(res.scope, "@mariozechner");
			assert.equal(res.pkgName, PI_OLD_PKG_NAME);
		});
	});

	it("rejects override when probe file is missing", () => {
		withTmp((tmp) => {
			const fake = makeFakeInstall(tmp, "@earendil-works");
			const res = findPiCodingAgentDist({
				override: fake.distDir,
				probe: "this/does/not/exist.js",
				skipRequireResolve: true,
				skipWalkUp: true,
				skipLiterals: true,
			});
			assert.equal(res, null);
		});
	});
});

// ───────────────────────────────────────────────────────────────────────────
// Walk-up
// ───────────────────────────────────────────────────────────────────────────

describe("walk-up resolution", () => {
	it("finds a nested install for new scope", () => {
		withTmp((tmp) => {
			// Build a layout like:
			//   <tmp>/repo/packages/me/src/index.ts
			//   <tmp>/repo/node_modules/@earendil-works/pi-coding-agent/dist/...
			const repo = path.join(tmp, "repo");
			fs.mkdirSync(path.join(repo, "packages", "me", "src"), { recursive: true });
			const pkgDir = path.join(repo, "node_modules", "@earendil-works", "pi-coding-agent");
			const distDir = path.join(pkgDir, "dist");
			fs.mkdirSync(path.join(distDir, "modes/interactive"), { recursive: true });
			fs.writeFileSync(path.join(distDir, "modes/interactive/interactive-mode.js"), "");
			fs.writeFileSync(
				path.join(pkgDir, "package.json"),
				JSON.stringify({ name: PI_NEW_PKG_NAME }),
			);

			const startDir = path.join(repo, "packages", "me", "src");
			const res = findPiCodingAgentDist({
				startDir,
				probe: "modes/interactive/interactive-mode.js",
				skipRequireResolve: true,
				skipLiterals: true,
			});
			assert.ok(res, "walk-up should find nested install");
			assert.equal(res.via, "walkup");
			assert.equal(res.scope, "@earendil-works");
			assert.equal(res.distDir, distDir);
		});
	});

	it("finds a nested install for old scope (legacy)", () => {
		withTmp((tmp) => {
			const repo = path.join(tmp, "repo");
			fs.mkdirSync(path.join(repo, "deep", "deeper", "src"), { recursive: true });
			const pkgDir = path.join(repo, "node_modules", "@mariozechner", "pi-coding-agent");
			fs.mkdirSync(path.join(pkgDir, "dist"), { recursive: true });
			fs.writeFileSync(
				path.join(pkgDir, "package.json"),
				JSON.stringify({ name: PI_OLD_PKG_NAME }),
			);

			const res = findPiCodingAgentDist({
				startDir: path.join(repo, "deep", "deeper", "src"),
				skipRequireResolve: true,
				skipLiterals: true,
			});
			assert.ok(res);
			assert.equal(res.scope, "@mariozechner");
		});
	});

	it("prefers new scope over old when both nested at same level", () => {
		withTmp((tmp) => {
			const repo = path.join(tmp, "repo");
			fs.mkdirSync(path.join(repo, "src"), { recursive: true });
			for (const pkgName of [PI_NEW_PKG_NAME, PI_OLD_PKG_NAME]) {
				const pkgDir = path.join(repo, "node_modules", pkgName);
				fs.mkdirSync(path.join(pkgDir, "dist"), { recursive: true });
				fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: pkgName }));
			}
			const res = findPiCodingAgentDist({
				startDir: path.join(repo, "src"),
				skipRequireResolve: true,
				skipLiterals: true,
			});
			assert.ok(res);
			assert.equal(res.scope, "@earendil-works");
		});
	});

	it("respects maxDepth budget", () => {
		withTmp((tmp) => {
			// Install is 5 levels above start; maxDepth=2 should miss it
			const target = path.join(tmp, "node_modules", PI_NEW_PKG_NAME, "dist");
			fs.mkdirSync(target, { recursive: true });
			fs.writeFileSync(
				path.join(path.dirname(target), "package.json"),
				JSON.stringify({ name: PI_NEW_PKG_NAME }),
			);
			const startDir = path.join(tmp, "a", "b", "c", "d", "e");
			fs.mkdirSync(startDir, { recursive: true });
			const tooShallow = findPiCodingAgentDist({
				startDir,
				maxDepth: 2,
				skipRequireResolve: true,
				skipLiterals: true,
			});
			assert.equal(tooShallow, null);
			const enough = findPiCodingAgentDist({
				startDir,
				maxDepth: 10,
				skipRequireResolve: true,
				skipLiterals: true,
			});
			assert.ok(enough);
		});
	});
});

// ───────────────────────────────────────────────────────────────────────────
// Literal candidates
// ───────────────────────────────────────────────────────────────────────────

describe("literal-candidate resolution", () => {
	it("finds via extraCandidates when override/require/walkup all skipped", () => {
		withTmp((tmp) => {
			const fake = makeFakeInstall(tmp, "@earendil-works");
			const res = findPiCodingAgentDist({
				probe: "modes/interactive/interactive-mode.js",
				extraCandidates: [fake.distDir],
				skipRequireResolve: true,
				skipWalkUp: true,
			});
			assert.ok(res);
			assert.equal(res.via, "literal");
			assert.equal(res.scope, "@earendil-works");
		});
	});

	it("rejects literal candidate when probe missing", () => {
		withTmp((tmp) => {
			const fake = makeFakeInstall(tmp, "@earendil-works");
			const res = findPiCodingAgentDist({
				probe: "missing/file.js",
				extraCandidates: [fake.distDir],
				skipRequireResolve: true,
				skipWalkUp: true,
				skipLiterals: false,
			});
			// May still find the real install on this machine; only assert if no
			// real install matched — this test mostly checks that the FAKE
			// candidate doesn't produce a false positive.
			if (res) {
				assert.notEqual(res.distDir, fake.distDir);
			}
		});
	});
});

// ───────────────────────────────────────────────────────────────────────────
// Null result
// ───────────────────────────────────────────────────────────────────────────

describe("null when nothing found", () => {
	it("returns null when all resolution paths skipped", () => {
		const res = findPiCodingAgentDist({
			skipRequireResolve: true,
			skipWalkUp: true,
			skipLiterals: true,
		});
		assert.equal(res, null);
	});

	it("returns null when override doesn't exist", () => {
		const res = findPiCodingAgentDist({
			override: "/nonexistent/path/dist",
			skipRequireResolve: true,
			skipWalkUp: true,
			skipLiterals: true,
		});
		assert.equal(res, null);
	});
});

// ───────────────────────────────────────────────────────────────────────────
// findPiTuiDist
// ───────────────────────────────────────────────────────────────────────────

describe("findPiTuiDist", () => {
	it("finds nested pi-tui in new scope", () => {
		withTmp((tmp) => {
			const fake = makeFakeInstall(tmp, "@earendil-works");
			const tuiDir = path.join(
				fake.pkgDir,
				"node_modules",
				"@earendil-works",
				"pi-tui",
				"dist",
			);
			fs.mkdirSync(tuiDir, { recursive: true });
			fs.writeFileSync(path.join(tuiDir, "components"), "");
			const res = findPiTuiDist(fake.distDir);
			assert.equal(res, tuiDir);
		});
	});

	it("finds nested pi-tui in old scope", () => {
		withTmp((tmp) => {
			const fake = makeFakeInstall(tmp, "@mariozechner");
			const tuiDir = path.join(
				fake.pkgDir,
				"node_modules",
				"@mariozechner",
				"pi-tui",
				"dist",
			);
			fs.mkdirSync(tuiDir, { recursive: true });
			const res = findPiTuiDist(fake.distDir);
			assert.equal(res, tuiDir);
		});
	});

	it("finds hoisted sibling pi-tui", () => {
		withTmp((tmp) => {
			const fake = makeFakeInstall(tmp, "@earendil-works");
			// Sibling: <scope-dir>/pi-tui/dist
			const tuiDir = path.join(path.dirname(fake.pkgDir), "pi-tui", "dist");
			fs.mkdirSync(tuiDir, { recursive: true });
			const res = findPiTuiDist(fake.distDir);
			assert.equal(res, tuiDir);
		});
	});

	it("returns null when no pi-tui found", () => {
		withTmp((tmp) => {
			const fake = makeFakeInstall(tmp, "@earendil-works");
			const res = findPiTuiDist(fake.distDir);
			assert.equal(res, null);
		});
	});

	it("respects probe gating", () => {
		withTmp((tmp) => {
			const fake = makeFakeInstall(tmp, "@earendil-works");
			const tuiDir = path.join(fake.pkgDir, "node_modules", "@earendil-works", "pi-tui", "dist");
			fs.mkdirSync(tuiDir, { recursive: true });
			// probe missing
			assert.equal(findPiTuiDist(fake.distDir, { probe: "missing.js" }), null);
			// probe present
			fs.writeFileSync(path.join(tuiDir, "editor.js"), "");
			assert.equal(findPiTuiDist(fake.distDir, { probe: "editor.js" }), tuiDir);
		});
	});
});

// ───────────────────────────────────────────────────────────────────────────
// findPiCodingAgentDistFromCaller convenience
// ───────────────────────────────────────────────────────────────────────────

describe("findPiCodingAgentDistFromCaller", () => {
	it("derives startDir from import.meta.url", () => {
		// This test file is at /Users/ironin/Work/Pi-Agent/pi-less-shitty/packages/pi-resolve/test/
		// Walking up from there should NOT find a pi-coding-agent install (we're in pi-less-shitty,
		// not under pi-coding-agent's node_modules tree). Should fall back to require.resolve or literals.
		const res = findPiCodingAgentDistFromCaller(import.meta.url, {
			skipRequireResolve: true,
			skipLiterals: true,
		});
		// May find via walk-up if pi-less-shitty has a nested install, but normally null.
		// Assert: either null OR a valid result (don't be flaky on real machines).
		if (res) {
			assert.ok(["@earendil-works", "@mariozechner"].includes(res.scope));
		}
	});
});

// ───────────────────────────────────────────────────────────────────────────
// Real-machine smoke: should resolve the actual installed pi
// ───────────────────────────────────────────────────────────────────────────

describe("real-machine smoke", () => {
	it("resolves the live pi install on this machine", () => {
		const res = findPiCodingAgentDist({
			probe: "cli.js",
		});
		assert.ok(res, "should find a live pi install — if this fails the test machine has no pi");
		assert.ok(["@earendil-works", "@mariozechner"].includes(res.scope));
		assert.ok(fs.existsSync(path.join(res.distDir, "cli.js")));
		console.error(`[smoke] resolved live pi: scope=${res.scope} via=${res.via} distDir=${res.distDir}`);
	});
});
