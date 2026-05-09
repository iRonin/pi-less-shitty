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
import type { ExtensionAPI, Model } from "@earendil-works/pi-coding-agent";
import { findPiCodingAgentDistFromCaller } from "../../pi-resolve/src/index.ts";

// ---------------------------------------------------------------------------
// File patching (applied synchronously at extension load)
// ---------------------------------------------------------------------------

function findPiDistDir(override?: string): string | null {
  const res = findPiCodingAgentDistFromCaller(import.meta.url, "core/model-registry.js", override);
  return res?.distDir ?? null;
}

/**
 * Patch #3043: validateConfig() apiKey check.
 *
 * Before: if (!providerConfig.apiKey) { throw ... }
 * After:  if (!providerConfig.apiKey && !this.authStorage.hasAuth(providerName)) { throw ... }
 */
export function patchValidateConfig(content: string): [string, number] {
  // Idempotency: skip if our fix marker is already present.
  if (content.includes("this.authStorage.hasAuth(providerName)")) return [content, 0];

  // Matches the buggy guard:
  //     if (!providerConfig.apiKey) {
  //         throw new Error(`Provider ${providerName}: "apiKey" is required when defining custom models.`);
  // Tolerant of indentation drift between the `if` and the `throw` line.
  const buggyRe =
    /if \(!providerConfig\.apiKey\) \{\s*\n(?<indent>[ \t]+)throw new Error\(`Provider \$\{providerName\}: "apiKey" is required when defining custom models\.`\);/;

  const m = content.match(buggyRe);
  if (!m) return [content, 0];
  const indent = m.groups?.["indent"] ?? "                    ";
  const fixed =
    'if (!providerConfig.apiKey && !this.authStorage.hasAuth(providerName)) {\n' +
    indent +
    'throw new Error(`Provider ${providerName}: "apiKey" is required when defining custom models (or authenticate via /login).`);';
  return [content.replace(buggyRe, fixed), 1];
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
export function patchApplyProviderConfig(content: string): [string, number] {
  // Idempotency: skip if our fix marker is already present.
  if (content.includes("const _savedJson = this.models.filter")) return [content, 0];

  // Matches the line that wipes provider models:
  //     this.models = this.models.filter((m) => m.provider !== providerName);
  // with whatever leading whitespace the compiler produced.
  const filterRe =
    /^(?<indent>[ \t]+)this\.models = this\.models\.filter\(\(m\) => m\.provider !== providerName\);$/m;

  const filterMatch = content.match(filterRe);
  if (!filterMatch) return [content, 0];
  const indent = filterMatch.groups?.["indent"] ?? "            ";

  // Insert _savedJson capture immediately before the filter line, preserving its indent.
  const filterLine = filterMatch[0];
  const savedLine =
    indent +
    "const _savedJson = this.models.filter((m) => m.provider === providerName);\n" +
    filterLine;
  let patched = content.replace(filterRe, savedLine);

  // Matches the closing brace of the `if (config.models …)` block followed by
  // `else if (config.baseUrl || config.headers)` on the next line:
  //         }
  //         else if (config.baseUrl || config.headers) {
  // Tolerant of indentation drift on either line.
  const restoreTargetRe =
    /^(?<closeIndent>[ \t]+)\}\n(?<elseIndent>[ \t]+)else if \(config\.baseUrl \|\| config\.headers\)/m;

  const restoreMatch = patched.match(restoreTargetRe);
  if (!restoreMatch) return [content, 0];
  const closeIndent = restoreMatch.groups?.["closeIndent"] ?? "        ";
  const elseIndent = restoreMatch.groups?.["elseIndent"] ?? "        ";
  const innerIndent = indent; // re-use the deeper indent level from the filter line
  const innerInnerIndent = innerIndent + (innerIndent.match(/[ \t]+$/)?.[0].slice(0, 4) ?? "    ");

  const restoreCode =
    innerIndent +
    "for (const _s of _savedJson) {\n" +
    innerInnerIndent +
    "if (!this.models.some((m) => m.id === _s.id)) this.models.push(_s);\n" +
    innerIndent +
    "}";
  const restoreRepl =
    restoreCode +
    "\n" +
    closeIndent +
    "}\n" +
    elseIndent +
    "else if (config.baseUrl || config.headers)";

  patched = patched.replace(restoreTargetRe, restoreRepl);
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
    // Re-patch using ctx.piInstallDir if available
    const sessionDistDir = findPiDistDir(ctx.piInstallDir);
    if (sessionDistDir) {
      patchModelRegistry(sessionDistDir);
    }
    await restoreModelsJsonCustom(pi, ctx);
  });
}
