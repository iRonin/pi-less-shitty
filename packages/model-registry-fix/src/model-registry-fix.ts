/**
 * model-registry-fix — Runtime patch for upstream issues #3043 and #3044.
 *
 * #3043: validateConfig() requires apiKey even when authStorage.hasAuth()
 *        is true (user authenticated via /login OAuth).
 * Fix: skip apiKey requirement when authStorage.hasAuth() returns true.
 *
 * #3044: applyProviderConfig() full replacement wipes models.json custom
 *        models for the provider. Extensions call registerProvider() on
 *        every session_start, permanently hiding models.json entries.
 * Fix: save custom models from models.json, restore after replacement.
 *
 * Patches model-registry.js on disk (idempotent, persists across restarts).
 * Also adds a session_start safety net that re-merges models.json entries
 * for dynamically registered providers in the current session.
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
    if (fs.existsSync(path.join(c, "core", "model-registry.js"))) return c;
  }
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, "node_modules", "@mariozechner", "pi-coding-agent", "dist");
    if (fs.existsSync(path.join(candidate, "core", "model-registry.js"))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Patch #3043: validateConfig() apiKey check.
 *
 * Before: if (!providerConfig.apiKey) { throw ... }
 * After:  if (!providerConfig.apiKey && !this.authStorage.hasAuth(providerName)) { throw ... }
 */
function patchValidateConfig(content: string): [string, number] {
  if (content.includes("this.authStorage.hasAuth(providerName)")) return [content, 0];

  const buggy = 'if (!providerConfig.apiKey) {\n                    throw new Error(`Provider ${providerName}: "apiKey" is required when defining custom models.`);';
  const fixed = 'if (!providerConfig.apiKey && !this.authStorage.hasAuth(providerName)) {\n                    throw new Error(`Provider ${providerName}: "apiKey" is required when defining custom models (or authenticate via /login).`);';

  if (!content.includes(buggy)) return [content, 0];
  return [content.replace(buggy, fixed), 1];
}

/**
 * Patch #3044: applyProviderConfig() full replacement.
 *
 * Before:
 *   this.models = this.models.filter((m) => m.provider !== providerName);
 * After:
 *   const _savedJson = this.models.filter((m) => m.provider === providerName);
 *   this.models = this.models.filter((m) => m.provider !== providerName);
 *
 * Then after all new models are pushed + OAuth modifyModels:
 *   for (const _s of _savedJson) {
 *     if (!this.models.some(m => m.id === _s.id)) this.models.push(_s);
 *   }
 */
function patchApplyProviderConfig(content: string): [string, number] {
  if (content.includes("const _savedJson = this.models.filter")) return [content, 0];

  const filterLine = "            this.models = this.models.filter((m) => m.provider !== providerName);";
  const savedLine = "            const _savedJson = this.models.filter((m) => m.provider === providerName);\n" + filterLine;

  if (!content.includes(filterLine)) return [content, 0];

  // Add save before filter
  let patched = content.replace(filterLine, savedLine);

  // The closing } of the if(config.models...) block before else if:
  // Pattern from compiled code (4-space indent):
  //         }
  //         else if (config.baseUrl || config.headers) {
  const restoreCode = "            for (const _s of _savedJson) {\n" +
    "                if (!this.models.some((m) => m.id === _s.id)) this.models.push(_s);\n" +
    "            }";
  const restoreTarget = "        }\n        else if (config.baseUrl || config.headers)";
  const restoreRepl = restoreCode + "\n        }\n        else if (config.baseUrl || config.headers)";

  if (!patched.includes(restoreTarget)) return [content, 0];

  patched = patched.replace(restoreTarget, restoreRepl);
  return [patched, 1];
}

function patchModelRegistry(distDir: string): string[] {
  const filePath = path.join(distDir, "core", "model-registry.js");
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return [];
  }

  const results: string[] = [];
  let patched = content;

  const [p1, c1] = patchValidateConfig(patched);
  patched = p1;
  if (c1 > 0) results.push("#3043 validateConfig apiKey check");

  const [p2, c2] = patchApplyProviderConfig(patched);
  patched = p2;
  if (c2 > 0) results.push("#3044 applyProviderConfig models.json preservation");

  if (results.length === 0) return results;

  try {
    fs.writeFileSync(filePath, patched, "utf8");
  } catch {
    return [];
  }
  return results;
}

// ---------------------------------------------------------------------------
// Session-time safety net for #3044
// ---------------------------------------------------------------------------

function getAgentDir(): string {
  return process.env["PI_CODING_AGENT_DIR"] ?? path.join(os.homedir(), ".pi", "agent");
}

/**
 * Re-merge models.json custom models for dynamically registered providers.
 *
 * If a provider was registered by an extension (present in registeredProviders)
 * and has custom models in models.json, those models may have been wiped by
 * applyProviderConfig(). This triggers a refresh to re-merge them.
 */
async function restoreModelsJsonCustom(pi: ExtensionAPI, ctx: any) {
  const modelsJsonPath = path.join(getAgentDir(), "models.json");
  if (!fs.existsSync(modelsJsonPath)) return;

  let config: any;
  try {
    config = JSON.parse(fs.readFileSync(modelsJsonPath, "utf8"));
  } catch {
    return;
  }

  if (!config.providers) return;

  const allModels = ctx.modelRegistry.getAll();
  const registeredProviders: Map<string, any> | undefined = ctx.modelRegistry.registeredProviders;
  if (!registeredProviders) return;

  for (const [providerName, providerConfig] of Object.entries(config.providers)) {
    if (!registeredProviders.has(providerName)) continue;

    const modelsJsonModels: any[] = providerConfig.models ?? [];
    if (modelsJsonModels.length === 0) continue;

    for (const mDef of modelsJsonModels) {
      const exists = allModels.some(
        (m: Model<any>) => m.provider === providerName && m.id === mDef.id,
      );
      if (!exists) {
        ctx.modelRegistry.refresh();
        return;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  // 1. Patch model-registry.js on disk (persisted across restarts).
  const distDir = findPiDistDir();
  if (distDir) {
    const patched = patchModelRegistry(distDir);
  }

  // 2. Safety net: restore models.json entries for dynamically registered providers.
  pi.on("session_start", async (_event, ctx) => {
    await restoreModelsJsonCustom(pi, ctx);
  });
}
