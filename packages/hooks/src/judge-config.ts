/**
 * LLM judge configuration.
 *
 * Loaded from $HOME/.pi/agent/llm-judge.json (or the path supplied to the
 * loader for tests). Missing file = judge disabled. Malformed file = judge
 * disabled with a warning printed to stderr; we explicitly do NOT throw,
 * because a broken config must never block bash execution.
 *
 * The config is intentionally minimal. Adding more knobs (per-category
 * model selection, fallback endpoints, etc.) belongs in a follow-up so
 * this initial surface stays auditable.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ============================================================================
// Types
// ============================================================================

export interface JudgeConfig {
  enabled: boolean;
  endpoint: string;
  model: string;
  apiKey: string | null;
  timeoutMs: number;
  maxCallsPerMinute: number;
  /** Optional fallback endpoint+model when the primary is slow/unreachable. */
  fallback: {
    endpoint: string;
    model: string;
    apiKey: string | null;
  } | null;
  /** Absolute path to the JSONL audit log. */
  logPath: string;
}

export interface RawJudgeConfig {
  enabled?: boolean;
  endpoint?: string;
  model?: string;
  apiKey?: string | null;
  timeoutMs?: number;
  maxCallsPerMinute?: number;
  logPath?: string;
  fallback?: {
    endpoint?: string;
    model?: string;
    apiKey?: string | null;
  };
}

// ============================================================================
// Defaults
// ============================================================================

const DEFAULTS = {
  enabled: false,
  endpoint: "http://localhost:1234/v1",
  model: "qwen/qwen3.6-35b-a3b-mlx",
  apiKey: "lm-studio",
  timeoutMs: 3000,
  maxCallsPerMinute: 20,
} as const;

// ============================================================================
// Paths
// ============================================================================

export function defaultConfigPath(homedir = os.homedir()): string {
  return path.join(homedir, ".pi", "agent", "llm-judge.json");
}

export function defaultLogPath(homedir = os.homedir()): string {
  return path.join(homedir, ".pi", "agent", "llm-judge.log");
}

// ============================================================================
// Loader
// ============================================================================

/**
 * Load and normalise the judge config. Returns a fully-populated config
 * with safe defaults. `enabled` defaults to FALSE so the judge is opt-in.
 *
 * Failure modes (all fail-closed → judge disabled, never throws):
 *   - file missing               → disabled config
 *   - malformed JSON             → disabled config + stderr warning
 *   - non-object root            → disabled config + stderr warning
 */
export function loadJudgeConfig(opts: { configPath?: string; homedir?: () => string } = {}): JudgeConfig {
  const home = opts.homedir ? opts.homedir() : os.homedir();
  const configPath = opts.configPath ?? defaultConfigPath(home);
  const logPath = defaultLogPath(home);

  let raw: RawJudgeConfig | null = null;

  if (fs.existsSync(configPath)) {
    try {
      const text = fs.readFileSync(configPath, "utf-8");
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        raw = parsed as RawJudgeConfig;
      } else {
        console.warn(`[pi-hooks/judge] ignoring ${configPath}: not a JSON object`);
      }
    } catch (err) {
      console.warn(`[pi-hooks/judge] ignoring malformed ${configPath}: ${(err as Error).message}`);
    }
  }

  if (!raw) {
    return {
      enabled: false,
      endpoint: DEFAULTS.endpoint,
      model: DEFAULTS.model,
      apiKey: DEFAULTS.apiKey,
      timeoutMs: DEFAULTS.timeoutMs,
      maxCallsPerMinute: DEFAULTS.maxCallsPerMinute,
      fallback: null,
      logPath,
    };
  }

  // Normalise with bounds checks. Out-of-range values fall back to defaults
  // rather than passing through \u2014 a 0ms timeout would deadlock.
  const timeoutMs =
    typeof raw.timeoutMs === "number" && raw.timeoutMs >= 100 && raw.timeoutMs <= 30000
      ? raw.timeoutMs
      : DEFAULTS.timeoutMs;
  const maxCallsPerMinute =
    typeof raw.maxCallsPerMinute === "number" && raw.maxCallsPerMinute >= 1 && raw.maxCallsPerMinute <= 600
      ? raw.maxCallsPerMinute
      : DEFAULTS.maxCallsPerMinute;

  const fallback = raw.fallback && typeof raw.fallback === "object"
    ? {
        endpoint: typeof raw.fallback.endpoint === "string" ? raw.fallback.endpoint : "",
        model: typeof raw.fallback.model === "string" ? raw.fallback.model : "",
        apiKey: typeof raw.fallback.apiKey === "string" ? raw.fallback.apiKey : null,
      }
    : null;

  // Strip an obviously-broken fallback (no endpoint or model) so the judge
  // doesn't loop into garbage on primary failure.
  const validFallback = fallback && fallback.endpoint && fallback.model ? fallback : null;

  return {
    enabled: raw.enabled === true,
    endpoint: typeof raw.endpoint === "string" && raw.endpoint ? raw.endpoint : DEFAULTS.endpoint,
    model: typeof raw.model === "string" && raw.model ? raw.model : DEFAULTS.model,
    apiKey: typeof raw.apiKey === "string" ? raw.apiKey : DEFAULTS.apiKey,
    timeoutMs,
    maxCallsPerMinute,
    fallback: validFallback,
    logPath: typeof raw.logPath === "string" && raw.logPath ? raw.logPath : logPath,
  };
}
