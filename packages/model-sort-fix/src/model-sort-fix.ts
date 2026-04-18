/**
 * model-sort-fix — Runtime patch for PR#2958: :variant sort order bug.
 *
 * Upstream: https://github.com/badlogic/pi-mono/pull/2958 (auto-closed)
 *
 * Problem: In tryMatchModel(), `aliases.sort((a, b) => b.id.localeCompare(a.id))`
 * makes longer strings win over shorter prefixes. So `model:free` beats `model`,
 * and `qwen/qwen3.6-plus:free` (deprecated) is silently selected over the base.
 *
 * Fix: At extension load time, patch the installed model-resolver.js on disk
 * so models WITHOUT a `:` suffix sort above those WITH one. Also adds a
 * session_start safety net to correct the model in the current session.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { ExtensionAPI, Model } from "@mariozechner/pi-coding-agent";

// ---------------------------------------------------------------------------
// File patching (applied synchronously at extension load)
// ---------------------------------------------------------------------------

function findPiDistDir(): string | null {
  const candidates = [
    "/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/dist",
    "/usr/local/lib/node_modules/@mariozechner/pi-coding-agent/dist",
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "core", "model-resolver.js"))) return c;
  }
  // Fallback: walk up from __dirname
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, "node_modules", "@mariozechner", "pi-coding-agent", "dist");
    if (fs.existsSync(path.join(candidate, "core", "model-resolver.js"))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Patch model-resolver.js: replace the buggy sort with one that prefers
 * base models (no colon) over :variant suffixes. Idempotent.
 *
 * Before:  aliases.sort((a, b) => b.id.localeCompare(a.id));
 * After:   aliases.sort((a, b) => { const ah=a.id.includes(":"); const bh=b.id.includes(":"); if (ah!==bh) return ah?1:-1; return b.id.localeCompare(a.id); });
 *
 * Applied to both the aliases[] and datedVersions[] sort calls.
 */
function patchModelResolver(distDir: string): "patched" | "already" | "failed" {
  const filePath = path.join(distDir, "core", "model-resolver.js");
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return "failed";
  }

  // Already patched?
  if (content.includes("a.id.includes(\":\")")) return "already";

  // Replace both occurrences: aliases.sort and datedVersions.sort
  const buggy = `(a, b) => b.id.localeCompare(a.id)`;
  const fixed = `(a, b) => { const ah = a.id.includes(":"); const bh = b.id.includes(":"); if (ah !== bh) return ah ? 1 : -1; return b.id.localeCompare(a.id); }`;

  let patched = content;
  let count = 0;
  while (patched.includes(buggy) && count < 2) {
    patched = patched.replace(buggy, fixed);
    count++;
  }

  if (count === 0) return "failed";

  try {
    fs.writeFileSync(filePath, patched, "utf8");
    return "patched";
  } catch {
    return "failed";
  }
}

// ---------------------------------------------------------------------------
// Session-time safety net (fixes current session)
// ---------------------------------------------------------------------------

/**
 * If the active model has a :variant suffix but a base model (without the
 * suffix) also exists, and the user didn't explicitly request the variant,
 * switch to the base model.
 *
 * This handles the case where model resolution already ran before this
 * extension loaded. The file patch above fixes all future sessions.
 */
async function fixVariantModelIfWrong(pi: ExtensionAPI, ctx: any) {
  const model: Model<any> | undefined = ctx.model;
  if (!model?.id.includes(":")) return;

  // Derive base model ID: strip everything from the first colon onward.
  const colonIdx = model.id.indexOf(":");
  const baseId = model.id.substring(0, colonIdx);

  const allModels = ctx.modelRegistry.getAll();
  const baseModel = allModels.find(
    (m: Model<any>) => m.provider === model.provider && m.id === baseId,
  );
  if (!baseModel) return; // no base model exists

  // Did the user explicitly request a variant? Check settings.json.
  const agentDir = process.env["PI_CODING_AGENT_DIR"]
    ?? path.join(os.homedir(), ".pi", "agent");
  const settingsPath = path.join(agentDir, "settings.json");
  try {
    const raw = fs.readFileSync(settingsPath, "utf8");
    const settings = JSON.parse(raw);
    const requested = settings.defaultModel ?? "";
    // If the user explicitly configured this variant, respect it.
    if (requested === model.id || requested === `${model.provider}/${model.id}`) return;
  } catch { /* no settings — treat as unintentional variant */ }

  // Switch to base model if auth is configured.
  if (ctx.modelRegistry.hasConfiguredAuth?.(baseModel)) {
    await pi.setModel(baseModel);
  }
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  // 1. Patch model-resolver.js on disk (persisted across restarts).
  const distDir = findPiDistDir();
  if (distDir) {
    const result = patchModelResolver(distDir);
    // "patched" = fixed this load; "already" = previously fixed;
    // "failed" = couldn't patch (no write access, unexpected format, etc.)
  }

  // 2. Safety net: correct wrong model in the current session.
  pi.on("session_start", async (_event, ctx) => {
    await fixVariantModelIfWrong(pi, ctx);
  });
}
