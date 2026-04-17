/**
 * kilocode-model-fix — Fix for custom-provider default model resolution at startup.
 *
 * Problem: findInitialModel() runs BEFORE custom provider registrations are
 * applied, so users with defaultProvider set to a custom provider (e.g.
 * "kilocode") silently fall back to the first built-in provider with auth.
 *
 * Additional issue: kilocode registers models with full IDs (e.g.
 * "qwen/qwen3.6-plus") but users often configure defaultModel with the bare
 * ID ("qwen3.6-plus"), which exact-match find() can't resolve.
 *
 * Fix: On session_start (after bindCore processed all provider registrations),
 * check if the active model matches the configured default. If not, find the
 * model by exact or suffix match and switch via pi.setModel().
 *
 * See: https://github.com/sudosubin/pi-frontier/issues/19
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { ExtensionAPI, Model } from "@mariozechner/pi-coding-agent";

function getAgentDir(): string {
  return process.env["PI_CODING_AGENT_DIR"] ?? path.join(os.homedir(), ".pi", "agent");
}

function readDefaultModelConfig(): { provider: string; modelId: string } | null {
  try {
    const settingsPath = path.join(getAgentDir(), "settings.json");
    if (!fs.existsSync(settingsPath)) return null;
    const raw = fs.readFileSync(settingsPath, "utf8");
    const settings = JSON.parse(raw);
    if (settings.defaultProvider && settings.defaultModel) {
      return { provider: settings.defaultProvider, modelId: settings.defaultModel };
    }
  } catch { /* skip */ }
  return null;
}

/**
 * Find a model by provider+id, with fallback to suffix matching.
 * Kilocode models use full IDs like "qwen/qwen3.6-plus" but users may
 * configure "qwen3.6-plus" as defaultModel. This handles both cases.
 */
function findModel(
  models: Model<any>[],
  provider: string,
  modelId: string,
): Model<any> | undefined {
  // 1. Exact match
  const exact = models.find(m => m.provider === provider && m.id === modelId);
  if (exact) return exact;

  // 2. Suffix match — model ID ends with "/<configuredId>"
  //    e.g. "qwen3.6-plus" matches "qwen/qwen3.6-plus"
  const suffix = "/" + modelId;
  const candidates = models.filter(
    m => m.provider === provider && m.id.endsWith(suffix),
  );
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];

  // 3. Multiple suffix matches — prefer one without a colon-variant suffix
  //    e.g. prefer "qwen/qwen3.6-plus" over "qwen/qwen3.6-plus:thinking"
  const baseMatch = candidates.find(m => {
    const idx = m.id.lastIndexOf(suffix);
    return idx < 0 || idx + suffix.length >= m.id.length; // no variant after suffix
  });
  return baseMatch ?? candidates[0];
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    const config = readDefaultModelConfig();
    if (!config) return;

    // Already using the configured default — nothing to do.
    if (
      ctx.model &&
      ctx.model.provider === config.provider &&
      ctx.model.id === config.modelId
    ) {
      return;
    }

    const allModels = ctx.modelRegistry.getAll();
    const resolved = findModel(allModels, config.provider, config.modelId);
    if (!resolved) return; // provider not registered or model not found
    if (!ctx.modelRegistry.hasConfiguredAuth(resolved)) return;

    await pi.setModel(resolved);
  });
}
