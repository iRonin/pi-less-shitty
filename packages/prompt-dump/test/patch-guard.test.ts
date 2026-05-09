import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * FIX B verification: patchMainJs must not write the file or report success
 * when the anchor `listBlock` is missing from main.js. The original bug was
 * that `c.replace(listBlock, ...)` returned the unchanged string, then the
 * function wrote it back unchanged and returned `true` (false-positive).
 *
 * This test exercises the real code by pointing it at a temp dist tree
 * containing a stub main.js without the anchor.
 */

describe("prompt-dump patchMainJs guard (FIX B)", () => {
  let tmpDir: string;
  let distDir: string;
  let mainPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-dump-test-"));
    distDir = path.join(tmpDir, "dist");
    fs.mkdirSync(path.join(distDir, "cli"), { recursive: true });
    mainPath = path.join(distDir, "main.js");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function loadPatchMainJs() {
    // Re-import fresh each time so module-scope state doesn't leak.
    vi.resetModules();
    const mod = await import("../src/index.ts");
    return mod;
  }

  it("returns without writing when listBlock anchor is missing", async () => {
    // main.js without the listModels block — no anchor present.
    const original = `// stub main.js — no listModels block here\nconsole.log("hello");\n`;
    fs.writeFileSync(mainPath, original, "utf8");

    // Stub args.js so patchArgsJs short-circuits via the "already patched" branch.
    fs.writeFileSync(
      path.join(distDir, "cli", "args.js"),
      'const x = "--prompt-dump";\n',
      "utf8",
    );

    // Build a fake pi extension API and invoke the entry point so the
    // load-time patch attempt runs against our temp dist.
    const mod = await loadPatchMainJs();

    // The default export is the extension entry. We can't easily redirect
    // DIST_DIR after the fix without env or arg, so we monkey-patch the
    // module's findPiDistDir result by overriding via a temp symlink farm:
    // simpler — just call the entry and inspect that the temp main.js
    // wasn't modified after pointing PATH/HOME via the walk-up fallback.
    //
    // Easiest deterministic check: invoke the extension with a stub pi that
    // captures session_start, then trigger session_start with ctx.piInstallDir
    // pointing at our temp dist.
    let sessionHandler: any;
    const fakePi: any = {
      on: (evt: string, cb: any) => {
        if (evt === "session_start") sessionHandler = cb;
      },
    };
    mod.default(fakePi);
    expect(sessionHandler).toBeTypeOf("function");

    const before = fs.readFileSync(mainPath, "utf8");
    await sessionHandler({}, { piInstallDir: distDir });
    const after = fs.readFileSync(mainPath, "utf8");

    // File must not be modified — guard short-circuited.
    expect(after).toBe(before);
    expect(after).toBe(original);
  });

  it("writes the file when the anchor IS present (positive control)", async () => {
    const original =
      'console.log("pre");\n' +
      '    if (parsed.listModels !== undefined) {\n' +
      '        const searchPattern = typeof parsed.listModels === "string" ? parsed.listModels : undefined;\n' +
      "        await listModels(modelRegistry, searchPattern);\n" +
      "        process.exit(0);\n" +
      "    }\n" +
      "    // Read piped stdin content\n" +
      'console.log("post");\n';
    fs.writeFileSync(mainPath, original, "utf8");
    fs.writeFileSync(
      path.join(distDir, "cli", "args.js"),
      'const x = "--prompt-dump";\n',
      "utf8",
    );

    const mod = await loadPatchMainJs();
    let sessionHandler: any;
    const fakePi: any = {
      on: (evt: string, cb: any) => {
        if (evt === "session_start") sessionHandler = cb;
      },
    };
    mod.default(fakePi);
    await sessionHandler({}, { piInstallDir: distDir });

    const after = fs.readFileSync(mainPath, "utf8");
    expect(after).toContain("--- prompt-dump handler ---");
    expect(after.length).toBeGreaterThan(original.length);
  });
});
