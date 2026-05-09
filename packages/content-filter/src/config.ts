/**
 * Configuration loader for content-filter.
 *
 * Config files (global first, then project-level merges):
 *   ~/.pi/agent/content-filter.json  — global config
 *   <cwd>/.content-filter[.json]     — project-level overrides/additions
 *
 * Schema:
 *   {
 *     "enabled": boolean,                // default: true
 *     "defaultReplacement": string,      // default: "[filtered]"
 *     "replacements": {                  // pattern → replacement
 *       "fuck": null,                    // null = use defaultReplacement
 *       "WTF": "why",
 *       "dumb f*ck": "idiot"
 *     },
 *     "caseSensitive": boolean,          // default: false
 *     "events": {
 *       "input": boolean,                // filter user prompts (default: true)
 *       "toolResult": boolean,           // filter tool outputs (default: true)
 *       "beforeAgentStart": boolean      // add filter instruction to system prompt (default: false)
 *     },
 *     "logMatches": boolean              // log pattern matches to console (default: false)
 *   }
 */

import type { FilterConfig } from "./filter.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface EventsConfig {
  input: boolean;
  toolResult: boolean;
  beforeAgentStart: boolean;
}

/** Each entry: [pattern, replacement|null] */
export type ReplacementEntry = [string, string | null];

export interface ContentFilterConfig {
  enabled: boolean;
  replacements: ReplacementEntry[];
  defaultReplacement: string;
  caseSensitive: boolean;
  events: EventsConfig;
  logMatches: boolean;
}

/**
 * Default replacements — common profanity with wildcard typo coverage.
 * null = use defaultReplacement.
 */
const DEFAULT_REPLACEMENTS: ReplacementEntry[] = [
  ["fuck", null],
  ["f*ck", null],
  ["fucking", null],
  ["f*cking", null],
  ["sh?t", null],
  ["b?tch", null],
  ["a**", null],
  ["c?nt", null],
  ["d*mn", null],
  ["h*ll", null],
  ["n*gger", null],
  ["p*ssy", null],
  ["m?therf*cker", null],
];

const DEFAULT_REPLACEMENT = "[filtered]";

function parseJSON(path: string): Record<string, unknown> | null {
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null) {
      return parsed;
    }
  } catch {
    // File missing or invalid — skip
  }
  return null;
}

/**
 * Deep-merge events config with defaults.
 */
function mergeEvents(raw: Record<string, unknown>): EventsConfig {
  const def: EventsConfig = { input: true, toolResult: true, beforeAgentStart: false };
  return {
    input: typeof raw["input"] === "boolean" ? raw["input"] : def.input,
    toolResult: typeof raw["toolResult"] === "boolean" ? raw["toolResult"] : def.toolResult,
    beforeAgentStart:
      typeof raw["beforeAgentStart"] === "boolean" ? raw["beforeAgentStart"] : def.beforeAgentStart,
  };
}

/**
 * Parse the replacements object from config.
 * Returns array of [pattern, replacement|null] entries.
 */
function parseReplacements(raw: Record<string, unknown>): ReplacementEntry[] | null {
  const obj = raw["replacements"];
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return null;

  const entries: ReplacementEntry[] = [];
  for (const [pattern, value] of Object.entries(obj)) {
    if (value === null || value === undefined || value === "default") {
      entries.push([pattern, null]);
    } else if (typeof value === "string") {
      entries.push([pattern, value]);
    }
  }
  return entries.length > 0 ? entries : null;
}

/**
 * Merge a raw JSON object into the config.
 * Replacements are APPENDED so project-level adds to global.
 */
function mergeInto(
  base: ContentFilterConfig,
  raw: Record<string, unknown>
): void {
  if (typeof raw["enabled"] === "boolean") base.enabled = raw["enabled"];
  if (typeof raw["defaultReplacement"] === "string") base.defaultReplacement = raw["defaultReplacement"];
  if (typeof raw["caseSensitive"] === "boolean") base.caseSensitive = raw["caseSensitive"];
  if (typeof raw["logMatches"] === "boolean") base.logMatches = raw["logMatches"];

  const parsed = parseReplacements(raw);
  if (parsed) {
    base.replacements.push(...parsed);
  }

  if (typeof raw["events"] === "object" && raw["events"] !== null) {
    base.events = mergeEvents(raw["events"]);
  }
}

/**
 * Load and merge global + project-level config.
 */
export function loadConfig(cwd: string): ContentFilterConfig {
  const config: ContentFilterConfig = {
    enabled: true,
    replacements: [...DEFAULT_REPLACEMENTS],
    defaultReplacement: DEFAULT_REPLACEMENT,
    caseSensitive: false,
    events: { input: true, toolResult: true, beforeAgentStart: false },
    logMatches: false,
  };

  // 1. Global config
  const globalPath = join(homedir(), ".pi", "agent", "content-filter.json");
  const globalRaw = parseJSON(globalPath);
  if (globalRaw) {
    // When global config has explicit replacements, they REPLACE defaults
    const parsed = parseReplacements(globalRaw);
    if (parsed) {
      config.replacements = parsed;
    }
    mergeInto(config, globalRaw);
  }

  // 2. Project-level config (adds to global)
  const projectPath = join(cwd, ".content-filter");
  const projectPathJson = join(cwd, ".content-filter.json");
  const projectRaw = parseJSON(projectPath) ?? parseJSON(projectPathJson);
  if (projectRaw) {
    mergeInto(config, projectRaw);
  }

  return config;
}

/**
 * Convert runtime config to filter engine config.
 */
export function toFilterConfig(config: ContentFilterConfig): FilterConfig {
  const replacements: Record<string, string | null> = {};
  for (const [pattern, value] of config.replacements) {
    replacements[pattern] = value;
  }
  return {
    replacements,
    defaultReplacement: config.defaultReplacement,
    caseSensitive: config.caseSensitive,
  };
}
