/**
 * HOOKS-POLICY.md cascade loader tests.
 *
 * Invariants we lock down:
 *   - Cascade order is ROOT → LEAF so the closest policy gets the last word.
 *   - Walk is bounded by `boundary`; never escapes upward past it.
 *   - When startDir is outside boundary, no traversal happens (single-dir read).
 *   - Per-file size cap truncates oversize files and emits a warning.
 *   - Aggregate cascade cap clips and emits a warning; no silent loss.
 *   - Missing files are non-fatal (no warning for ENOENT — only real errors).
 *   - Symlink loops do not cause re-reads; same realpath wins once.
 *   - Non-file entries (dir named HOOKS-POLICY.md) are skipped with a warning.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  loadPolicyCascade,
  hasPolicy,
  POLICY_FILENAME,
  MAX_FILE_BYTES,
  MAX_CASCADE_BYTES,
} from "../src/policy-loader.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

let fixtureRoot: string;

beforeEach(() => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "policy-loader-"));
});

afterEach(() => {
  try {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  } catch {}
});

function mkdir(rel: string): string {
  const abs = path.join(fixtureRoot, rel);
  fs.mkdirSync(abs, { recursive: true });
  return abs;
}

function writePolicy(dir: string, body: string): string {
  const p = path.join(dir, POLICY_FILENAME);
  fs.writeFileSync(p, body, "utf-8");
  return p;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("loadPolicyCascade — basic", () => {
  it("returns empty cascade when no policy files exist", () => {
    const leaf = mkdir("a/b/c");
    const result = loadPolicyCascade(leaf, { boundary: fixtureRoot });
    expect(result.files).toEqual([]);
    expect(result.text).toBe("");
    expect(result.bytes).toBe(0);
    expect(result.truncated).toBe(false);
    expect(result.warnings).toEqual([]);
    expect(hasPolicy(result)).toBe(false);
  });

  it("loads a single policy at cwd", () => {
    const leaf = mkdir("a/b/c");
    writePolicy(leaf, "leaf policy");
    const result = loadPolicyCascade(leaf, { boundary: fixtureRoot });
    expect(result.files).toHaveLength(1);
    expect(result.text).toContain("leaf policy");
    expect(hasPolicy(result)).toBe(true);
  });

  it("cascades root → leaf so closest dir is LAST", () => {
    const leaf = mkdir("a/b/c");
    writePolicy(fixtureRoot, "ROOT");
    writePolicy(path.join(fixtureRoot, "a"), "A");
    writePolicy(path.join(fixtureRoot, "a", "b"), "B");
    writePolicy(leaf, "LEAF");

    const result = loadPolicyCascade(leaf, { boundary: fixtureRoot });
    expect(result.files.map((f) => path.basename(path.dirname(f.path)))).toEqual([
      path.basename(fixtureRoot), // root
      "a",
      "b",
      "c",
    ]);

    const rootIdx = result.text.indexOf("ROOT");
    const aIdx = result.text.indexOf("\nA\n");
    const bIdx = result.text.indexOf("\nB\n");
    const leafIdx = result.text.indexOf("LEAF");
    expect(rootIdx).toBeGreaterThan(-1);
    expect(aIdx).toBeGreaterThan(rootIdx);
    expect(bIdx).toBeGreaterThan(aIdx);
    expect(leafIdx).toBeGreaterThan(bIdx);
  });

  it("does NOT walk past boundary", () => {
    // boundary at /a; policy exists at fixtureRoot (above boundary).
    // It must be ignored.
    writePolicy(fixtureRoot, "ABOVE BOUNDARY");
    const a = mkdir("a");
    writePolicy(a, "AT BOUNDARY");
    const leaf = mkdir("a/b/c");
    writePolicy(leaf, "LEAF");

    const result = loadPolicyCascade(leaf, { boundary: a });
    expect(result.text).not.toContain("ABOVE BOUNDARY");
    expect(result.text).toContain("AT BOUNDARY");
    expect(result.text).toContain("LEAF");
    expect(result.files).toHaveLength(2);
  });

  it("includes the boundary directory itself", () => {
    const a = mkdir("a");
    writePolicy(a, "BOUNDARY POLICY");
    const result = loadPolicyCascade(a, { boundary: a });
    expect(result.files).toHaveLength(1);
    expect(result.text).toContain("BOUNDARY POLICY");
  });
});

describe("loadPolicyCascade — boundary safety", () => {
  it("does NOT walk up when startDir is outside boundary", () => {
    // Boundary is /a; startDir is /b/c (sibling tree). Must read /b/c only,
    // never escape upward to fixtureRoot.
    const boundary = mkdir("a");
    writePolicy(boundary, "BOUNDARY");
    writePolicy(fixtureRoot, "ROOT");
    const outsideStart = mkdir("b/c");
    writePolicy(outsideStart, "OUTSIDE");

    const result = loadPolicyCascade(outsideStart, { boundary });
    expect(result.text).not.toContain("BOUNDARY");
    expect(result.text).not.toContain("ROOT");
    expect(result.text).toContain("OUTSIDE");
    expect(result.files).toHaveLength(1);
  });

  it("returns no files when neither start nor boundary has policy", () => {
    const outside = mkdir("b/c");
    const boundary = mkdir("a");
    const result = loadPolicyCascade(outside, { boundary });
    expect(result.files).toEqual([]);
  });
});

describe("loadPolicyCascade — size caps", () => {
  it("truncates a single oversize file and warns", () => {
    const leaf = mkdir("a/b");
    const big = "x".repeat(MAX_FILE_BYTES + 1024);
    writePolicy(leaf, big);

    const result = loadPolicyCascade(leaf, { boundary: fixtureRoot });
    expect(result.files).toHaveLength(1);
    expect(result.files[0].truncated).toBe(true);
    expect(result.files[0].bytes).toBe(MAX_FILE_BYTES);
    expect(result.warnings.some((w) => w.includes("truncating"))).toBe(true);
    expect(result.text).toContain("[…truncated…]");
  });

  it("clips aggregate cascade and warns when total exceeds cap", () => {
    // Three files near MAX_FILE_BYTES each = > MAX_CASCADE_BYTES total.
    const a = mkdir("a");
    const b = mkdir("a/b");
    const c = mkdir("a/b/c");
    const chunk = "y".repeat(MAX_FILE_BYTES - 64);
    writePolicy(a, chunk);
    writePolicy(b, chunk);
    writePolicy(c, chunk);

    const result = loadPolicyCascade(c, { boundary: fixtureRoot });
    expect(result.truncated).toBe(true);
    expect(result.bytes).toBeLessThanOrEqual(MAX_CASCADE_BYTES);
    expect(result.warnings.some((w) => w.includes("cascade clipped"))).toBe(true);
  });
});

describe("loadPolicyCascade — error resilience", () => {
  it("skips a non-regular HOOKS-POLICY.md (e.g. directory) and warns", () => {
    const leaf = mkdir("a/b");
    // Create HOOKS-POLICY.md as a directory.
    fs.mkdirSync(path.join(leaf, POLICY_FILENAME));

    const result = loadPolicyCascade(leaf, { boundary: fixtureRoot });
    expect(result.files).toEqual([]);
    expect(result.warnings.some((w) => w.includes("not a regular file"))).toBe(true);
  });

  it("ENOENT is silent (no warning) — only real stat errors warn", () => {
    const leaf = mkdir("a/b");
    const result = loadPolicyCascade(leaf, { boundary: fixtureRoot });
    expect(result.warnings).toEqual([]);
  });

  it("dedupes by realpath so symlink loops are safe", () => {
    const a = mkdir("a");
    const b = mkdir("a/b");
    writePolicy(a, "REAL A");
    // Symlink: a/b/HOOKS-POLICY.md → ../HOOKS-POLICY.md (same realpath as a/HOOKS-POLICY.md)
    fs.symlinkSync(path.join(a, POLICY_FILENAME), path.join(b, POLICY_FILENAME));

    const result = loadPolicyCascade(b, { boundary: fixtureRoot });
    // Both lookups resolve to the same realpath, so we count it once.
    expect(result.files).toHaveLength(1);
    expect(result.text.match(/REAL A/g)?.length).toBe(1);
  });
});

describe("loadPolicyCascade — defaults", () => {
  it("defaults boundary to homedir()", () => {
    const leaf = mkdir("a/b/c");
    writePolicy(leaf, "LEAF");
    // Inject a fake home that does NOT contain leaf, so leaf is outside
    // boundary and the walk should read only leaf.
    const result = loadPolicyCascade(leaf, {
      homedir: () => path.join(fixtureRoot, "nope"),
    });
    expect(result.files).toHaveLength(1);
    expect(result.text).toContain("LEAF");
  });
});
