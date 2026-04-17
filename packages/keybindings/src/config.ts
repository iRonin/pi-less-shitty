import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Binding, KeybindingsConfig, When, ActionName } from "./types.ts";

const AGENT_DIR =
  process.env["PI_CODING_AGENT_DIR"] ?? path.join(os.homedir(), ".pi", "agent");

export const CONFIG_PATH = path.join(AGENT_DIR, "config", "pi-keybindings.json");

const VALID_ACTIONS = new Set<ActionName>([
  "clearEditor", "insertText", "abort", "compact",
  "setThinkingLevel", "cycleThinking",
  "fork", "newSession", "tree", "resume", "exec", "shutdown",
]);

const VALID_WHEN = new Set<When>(["always", "hasContent", "isEmpty", "idle"]);

// ---------------------------------------------------------------------------
// In-memory cache
// ---------------------------------------------------------------------------

let cache: KeybindingsConfig | null = null;

export function clearConfigCache(): void {
  cache = null;
}

export function getCachedConfig(): KeybindingsConfig | null {
  return cache;
}

export async function loadConfig(): Promise<KeybindingsConfig> {
  if (cache) return cache;
  try {
    const raw: unknown = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
    const validated = validateConfig(raw);
    cache = validated;
    return validated;
  } catch {
    const empty: KeybindingsConfig = { version: 1, bindings: [] };
    cache = empty;
    return empty;
  }
}

export async function saveConfig(config: KeybindingsConfig): Promise<void> {
  await mkdir(path.dirname(CONFIG_PATH), { recursive: true });
  await writeFile(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  cache = config;
}

export async function addBinding(binding: Binding): Promise<void> {
  const config = await loadConfig();
  config.bindings.push(binding);
  await saveConfig(config);
}

export async function removeBinding(index: number): Promise<void> {
  const config = await loadConfig();
  config.bindings.splice(index, 1);
  await saveConfig(config);
}

// ---------------------------------------------------------------------------
// Validation (guards against tampered config file)
// ---------------------------------------------------------------------------

function validateConfig(raw: unknown): KeybindingsConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("config must be a JSON object");
  }
  const r = raw as Record<string, unknown>;

  const windowMs =
    r["windowMs"] === undefined
      ? undefined
      : typeof r["windowMs"] === "number" && r["windowMs"] > 0
        ? r["windowMs"]
        : (() => { throw new Error("windowMs must be a positive number"); })();

  if (!Array.isArray(r["bindings"])) {
    throw new Error("bindings must be an array");
  }

  const bindings: Binding[] = r["bindings"].map((b: unknown, i: number) => {
    if (!b || typeof b !== "object" || Array.isArray(b)) {
      throw new Error(`binding[${i}] must be an object`);
    }
    const bk = b as Record<string, unknown>;

    if (typeof bk["key"] !== "string" || !bk["key"]) {
      throw new Error(`binding[${i}].key must be a non-empty string`);
    }
    if (typeof bk["double"] !== "boolean") {
      throw new Error(`binding[${i}].double must be a boolean`);
    }
    if (!VALID_ACTIONS.has(bk["action"] as ActionName)) {
      throw new Error(`binding[${i}].action "${bk["action"]}" is not a valid action`);
    }
    if (bk["when"] !== undefined && !VALID_WHEN.has(bk["when"] as When)) {
      throw new Error(`binding[${i}].when "${bk["when"]}" is not valid`);
    }

    return {
      key: bk["key"] as string,
      double: bk["double"] as boolean,
      action: bk["action"] as ActionName,
      when: (bk["when"] as When | undefined) ?? "always",
      params: (bk["params"] as Record<string, unknown> | undefined),
      description: typeof bk["description"] === "string" ? bk["description"] : undefined,
    };
  });

  return { version: 1, windowMs, bindings };
}
