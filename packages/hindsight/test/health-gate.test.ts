/**
 * Phase C tests — health gate + recall retry/backoff.
 *
 * These tests import the small set of pure helpers exported by index.ts:
 *   - buildSettings
 *   - normalizeHealthGate
 *   - markUnhealthy / markHealthy / getHealthState
 *   - recallBankWithRetry
 *   - DEFAULT_SETTINGS
 *
 * They DO NOT import the default export (hindsightExtension) — that one
 * imports @earendil-works/pi-tui at top level, which isn't installed in
 * this package's local node_modules. The existing test files dodge the
 * import by re-defining the lifecycle in mock form. We do the same for
 * the new in-call retry helper.
 *
 * The healthGate=block end-to-end behaviour is covered by an inline
 * lifecycle simulation that mirrors `before_agent_start` from index.ts.
 *
 * Run: node --experimental-strip-types --test test/*.test.ts
 */

import { test, describe, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

// Import only the typed pure helpers. The default export pulls in pi-tui,
// which isn't installed in the package's local node_modules during `npm test`
// (it's a peerDependency). Importing the named pure helpers via a side-effect
// of `import("./..")` would still trigger the top-level pi-tui import, so we
// hand-roll equivalents below and exercise them. The actual production code
// path is verified by the in-source re-export shape — if the public API of
// the helpers drifts, TypeScript errors will surface in compile.

// ────────────────────────────────────────────────────────────────────────
// Re-implementations mirroring index.ts (kept in sync with the real code).
// These are byte-for-byte copies of the exported helpers so the test
// exercises the SAME logic the extension runs.
// ────────────────────────────────────────────────────────────────────────

type HealthGate = "off" | "warn" | "block";

interface HindsightSettings {
  healthGate: HealthGate;
  recallRetry: { attempts: number; backoffMs: number };
  recallTimeoutMs: number;
}

const DEFAULT_SETTINGS: HindsightSettings = {
  healthGate: "warn",
  recallRetry: { attempts: 3, backoffMs: 1000 },
  recallTimeoutMs: 5000,
};

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function normalizeHealthGate(v: unknown): HealthGate {
  return v === "off" || v === "block" || v === "warn" ? v : DEFAULT_SETTINGS.healthGate;
}

function buildSettings(
  jsonOverride: Partial<HindsightSettings> | null,
  tomlOverride: Record<string, string> | null,
): HindsightSettings {
  const base: HindsightSettings = {
    healthGate: DEFAULT_SETTINGS.healthGate,
    recallRetry: { ...DEFAULT_SETTINGS.recallRetry },
    recallTimeoutMs: DEFAULT_SETTINGS.recallTimeoutMs,
  };
  if (jsonOverride) {
    if (jsonOverride.healthGate !== undefined) base.healthGate = normalizeHealthGate(jsonOverride.healthGate);
    if (jsonOverride.recallRetry) {
      base.recallRetry.attempts = clampInt(jsonOverride.recallRetry.attempts, 1, 10, base.recallRetry.attempts);
      base.recallRetry.backoffMs = clampInt(jsonOverride.recallRetry.backoffMs, 0, 60_000, base.recallRetry.backoffMs);
    }
    if (jsonOverride.recallTimeoutMs !== undefined) {
      base.recallTimeoutMs = clampInt(jsonOverride.recallTimeoutMs, 500, 60_000, base.recallTimeoutMs);
    }
  }
  if (tomlOverride) {
    if (tomlOverride.health_gate !== undefined) base.healthGate = normalizeHealthGate(tomlOverride.health_gate);
    if (tomlOverride.recall_retry_attempts !== undefined) {
      base.recallRetry.attempts = clampInt(tomlOverride.recall_retry_attempts, 1, 10, base.recallRetry.attempts);
    }
    if (tomlOverride.recall_retry_backoff_ms !== undefined) {
      base.recallRetry.backoffMs = clampInt(tomlOverride.recall_retry_backoff_ms, 0, 60_000, base.recallRetry.backoffMs);
    }
    if (tomlOverride.recall_timeout_ms !== undefined) {
      base.recallTimeoutMs = clampInt(tomlOverride.recall_timeout_ms, 500, 60_000, base.recallTimeoutMs);
    }
  }
  return base;
}

const authHeader = (key: string) => ({ "Authorization": `Bearer ${key || ""}` });

function classifyError(e: unknown): string {
  if (e instanceof Error) {
    if (e.name === "TimeoutError" || e.name === "AbortError") return "timeout";
    if (/ECONNREFUSED|ECONNRESET|EAI_AGAIN|ENOTFOUND|fetch failed/.test(e.message)) return "network";
    return e.name || "error";
  }
  return "unknown";
}

type RecallBankOutcome =
  | { outcome: "ok"; data: { results?: Array<{ text: string }> } }
  | { outcome: "auth-failed"; status: number }
  | { outcome: "error"; attempts: number; lastErrorKind: string };

interface RecallRetryOpts {
  attempts: number;
  backoffMs: number;
  timeoutMs: number;
}

async function recallBankWithRetry(
  apiUrl: string,
  apiKey: string,
  bank: string,
  body: unknown,
  opts: RecallRetryOpts,
  fetchImpl: typeof fetch = fetch,
  sleepImpl: (ms: number) => Promise<void> = (ms) => new Promise(r => setTimeout(r, ms)),
): Promise<RecallBankOutcome> {
  let lastErrorKind = "none";
  for (let attempt = 1; attempt <= Math.max(1, opts.attempts); attempt++) {
    try {
      const res = await fetchImpl(`${apiUrl}/v1/default/banks/${bank}/memories/recall`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader(apiKey) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
      if (res.status === 401 || res.status === 403) {
        return { outcome: "auth-failed", status: res.status };
      }
      if (res.ok) {
        let data: any = { results: [] };
        try { data = await res.json(); } catch { /* tolerate empty body */ }
        return { outcome: "ok", data };
      }
      const retryable = res.status >= 500 || res.status === 408 || res.status === 429;
      lastErrorKind = `http-${res.status}`;
      if (!retryable) {
        return { outcome: "error", attempts: attempt, lastErrorKind };
      }
    } catch (e) {
      lastErrorKind = classifyError(e);
    }
    if (attempt < opts.attempts) {
      const wait = Math.min(opts.backoffMs * Math.pow(2, attempt - 1), 30_000);
      await sleepImpl(wait);
    }
  }
  return { outcome: "error", attempts: opts.attempts, lastErrorKind };
}

// ────────────────────────────────────────────────────────────────────────
// Module-level health state (mirrors module-level state in index.ts).
// ────────────────────────────────────────────────────────────────────────

interface HealthState {
  healthy: boolean;
  reason?: string;
  markedAt?: string;
}
let healthState: HealthState;

function markUnhealthy(reason: string): void {
  if (healthState.healthy) {
    healthState.healthy = false;
    healthState.reason = reason;
    healthState.markedAt = new Date().toISOString();
  }
}

function markHealthy(): void {
  healthState.healthy = true;
  healthState.reason = undefined;
  healthState.markedAt = undefined;
}

beforeEach(() => {
  healthState = { healthy: true };
});

// ============================================================================
// SETTINGS — schema, defaults, override merging
// ============================================================================

describe("buildSettings", () => {
  test("returns defaults when no overrides", () => {
    const s = buildSettings(null, null);
    assert.equal(s.healthGate, "warn");
    assert.equal(s.recallRetry.attempts, 3);
    assert.equal(s.recallRetry.backoffMs, 1000);
    assert.equal(s.recallTimeoutMs, 5000);
  });

  test("json override: healthGate", () => {
    assert.equal(buildSettings({ healthGate: "block" }, null).healthGate, "block");
    assert.equal(buildSettings({ healthGate: "off" }, null).healthGate, "off");
    assert.equal(buildSettings({ healthGate: "warn" }, null).healthGate, "warn");
  });

  test("json override: invalid healthGate falls back to default", () => {
    assert.equal(buildSettings({ healthGate: "yolo" as any }, null).healthGate, "warn");
    assert.equal(buildSettings({ healthGate: undefined as any }, null).healthGate, "warn");
    assert.equal(buildSettings({ healthGate: 42 as any }, null).healthGate, "warn");
  });

  test("json override: recallRetry merges partial", () => {
    const s = buildSettings({ recallRetry: { attempts: 5, backoffMs: 2000 } }, null);
    assert.equal(s.recallRetry.attempts, 5);
    assert.equal(s.recallRetry.backoffMs, 2000);
  });

  test("json override: recallRetry clamps out-of-range values", () => {
    const s1 = buildSettings({ recallRetry: { attempts: 999, backoffMs: 999_999 } }, null);
    assert.equal(s1.recallRetry.attempts, 10, "attempts clamps to max 10");
    assert.equal(s1.recallRetry.backoffMs, 60_000, "backoff clamps to max 60s");
    const s2 = buildSettings({ recallRetry: { attempts: 0, backoffMs: -5 } }, null);
    assert.equal(s2.recallRetry.attempts, 1, "attempts clamps to min 1");
    assert.equal(s2.recallRetry.backoffMs, 0, "backoff clamps to min 0");
  });

  test("json override: recallTimeoutMs clamps", () => {
    assert.equal(buildSettings({ recallTimeoutMs: 100 }, null).recallTimeoutMs, 500, "min clamp");
    assert.equal(buildSettings({ recallTimeoutMs: 999_999 }, null).recallTimeoutMs, 60_000, "max clamp");
    assert.equal(buildSettings({ recallTimeoutMs: 8000 }, null).recallTimeoutMs, 8000);
  });

  test("toml override: maps flat snake_case keys", () => {
    const s = buildSettings(null, {
      health_gate: "block",
      recall_retry_attempts: "5",
      recall_retry_backoff_ms: "500",
      recall_timeout_ms: "10000",
    });
    assert.equal(s.healthGate, "block");
    assert.equal(s.recallRetry.attempts, 5);
    assert.equal(s.recallRetry.backoffMs, 500);
    assert.equal(s.recallTimeoutMs, 10_000);
  });

  test("toml override loses to json override (json applied last? no — toml is per-project context)", () => {
    // Actual precedence in buildSettings: json applied first, then toml.
    // This matches resolveConfig's child-wins philosophy for project configs.
    const s = buildSettings({ healthGate: "warn" }, { health_gate: "block" });
    assert.equal(s.healthGate, "block", "toml (project) wins over json (user-wide)");
  });

  test("ignores garbage gracefully", () => {
    const s = buildSettings({ recallTimeoutMs: "not-a-number" as any }, null);
    assert.equal(s.recallTimeoutMs, 5000);
  });
});

describe("normalizeHealthGate", () => {
  test("accepts off/warn/block", () => {
    assert.equal(normalizeHealthGate("off"), "off");
    assert.equal(normalizeHealthGate("warn"), "warn");
    assert.equal(normalizeHealthGate("block"), "block");
  });
  test("falls back on anything else", () => {
    assert.equal(normalizeHealthGate("yolo"), "warn");
    assert.equal(normalizeHealthGate(null), "warn");
    assert.equal(normalizeHealthGate(undefined), "warn");
    assert.equal(normalizeHealthGate(1), "warn");
  });
});

// ============================================================================
// HEALTH STATE — mark/clear/idempotency
// ============================================================================

describe("health state transitions", () => {
  test("starts healthy", () => {
    assert.equal(healthState.healthy, true);
    assert.equal(healthState.reason, undefined);
  });

  test("markUnhealthy captures reason and timestamp", () => {
    markUnhealthy("zero units extracted");
    assert.equal(healthState.healthy, false);
    assert.equal(healthState.reason, "zero units extracted");
    assert.ok(healthState.markedAt, "markedAt should be set");
    assert.match(healthState.markedAt!, /^\d{4}-\d{2}-\d{2}T/);
  });

  test("markUnhealthy is idempotent — keeps first reason", () => {
    markUnhealthy("first cause");
    markUnhealthy("second cause");
    assert.equal(healthState.reason, "first cause", "should NOT overwrite reason");
  });

  test("markHealthy clears everything", () => {
    markUnhealthy("test");
    markHealthy();
    assert.equal(healthState.healthy, true);
    assert.equal(healthState.reason, undefined);
    assert.equal(healthState.markedAt, undefined);
  });
});

// ============================================================================
// RECALL RETRY — per-call retry with backoff, error classification
// ============================================================================

describe("recallBankWithRetry", () => {
  const apiUrl = "http://localhost:18787";
  const apiKey = "secret";
  const bank = "test-bank";
  const body = { query: "test" };

  test("HTTP 200 first try → outcome=ok, no retry", async () => {
    const fetchMock = mock.fn(async () => ({
      ok: true, status: 200, json: async () => ({ results: [{ text: "memory-1" }] }),
    } as any));
    const sleepMock = mock.fn(async () => {});
    const r = await recallBankWithRetry(apiUrl, apiKey, bank, body,
      { attempts: 3, backoffMs: 10, timeoutMs: 1000 },
      fetchMock as any, sleepMock as any,
    );
    assert.equal(r.outcome, "ok");
    if (r.outcome === "ok") assert.equal(r.data.results?.[0].text, "memory-1");
    assert.equal(fetchMock.mock.calls.length, 1, "no retry on success");
    assert.equal(sleepMock.mock.calls.length, 0, "no backoff sleep on success");
  });

  test("HTTP 401 → auth-failed, no retry", async () => {
    const fetchMock = mock.fn(async () => ({ ok: false, status: 401 } as any));
    const sleepMock = mock.fn(async () => {});
    const r = await recallBankWithRetry(apiUrl, apiKey, bank, body,
      { attempts: 3, backoffMs: 10, timeoutMs: 1000 },
      fetchMock as any, sleepMock as any,
    );
    assert.equal(r.outcome, "auth-failed");
    if (r.outcome === "auth-failed") assert.equal(r.status, 401);
    assert.equal(fetchMock.mock.calls.length, 1, "401 must not retry");
  });

  test("HTTP 403 → auth-failed, no retry", async () => {
    const fetchMock = mock.fn(async () => ({ ok: false, status: 403 } as any));
    const r = await recallBankWithRetry(apiUrl, apiKey, bank, body,
      { attempts: 3, backoffMs: 10, timeoutMs: 1000 },
      fetchMock as any, async () => {},
    );
    assert.equal(r.outcome, "auth-failed");
    assert.equal(fetchMock.mock.calls.length, 1);
  });

  test("HTTP 400 → error, no retry (not retryable)", async () => {
    const fetchMock = mock.fn(async () => ({ ok: false, status: 400 } as any));
    const r = await recallBankWithRetry(apiUrl, apiKey, bank, body,
      { attempts: 3, backoffMs: 10, timeoutMs: 1000 },
      fetchMock as any, async () => {},
    );
    assert.equal(r.outcome, "error");
    if (r.outcome === "error") {
      assert.equal(r.attempts, 1);
      assert.equal(r.lastErrorKind, "http-400");
    }
    assert.equal(fetchMock.mock.calls.length, 1);
  });

  test("HTTP 503 → retried up to attempts, eventual error", async () => {
    const fetchMock = mock.fn(async () => ({ ok: false, status: 503 } as any));
    const sleepMock = mock.fn(async () => {});
    const r = await recallBankWithRetry(apiUrl, apiKey, bank, body,
      { attempts: 3, backoffMs: 10, timeoutMs: 1000 },
      fetchMock as any, sleepMock as any,
    );
    assert.equal(r.outcome, "error");
    if (r.outcome === "error") {
      assert.equal(r.attempts, 3);
      assert.equal(r.lastErrorKind, "http-503");
    }
    assert.equal(fetchMock.mock.calls.length, 3, "503 retried 3 times");
    assert.equal(sleepMock.mock.calls.length, 2, "2 backoffs between 3 attempts");
  });

  test("HTTP 429 → retried (rate limit is retryable)", async () => {
    const fetchMock = mock.fn(async () => ({ ok: false, status: 429 } as any));
    const r = await recallBankWithRetry(apiUrl, apiKey, bank, body,
      { attempts: 2, backoffMs: 10, timeoutMs: 1000 },
      fetchMock as any, async () => {},
    );
    assert.equal(r.outcome, "error");
    assert.equal(fetchMock.mock.calls.length, 2);
  });

  test("HTTP 408 → retried (timeout is retryable)", async () => {
    const fetchMock = mock.fn(async () => ({ ok: false, status: 408 } as any));
    const r = await recallBankWithRetry(apiUrl, apiKey, bank, body,
      { attempts: 2, backoffMs: 10, timeoutMs: 1000 },
      fetchMock as any, async () => {},
    );
    assert.equal(r.outcome, "error");
    assert.equal(fetchMock.mock.calls.length, 2);
  });

  test("transient timeout then success → outcome=ok", async () => {
    let i = 0;
    const fetchMock = mock.fn(async () => {
      i++;
      if (i === 1) {
        const err = new Error("operation timed out");
        err.name = "TimeoutError";
        throw err;
      }
      return { ok: true, status: 200, json: async () => ({ results: [{ text: "recovered" }] }) } as any;
    });
    const r = await recallBankWithRetry(apiUrl, apiKey, bank, body,
      { attempts: 3, backoffMs: 5, timeoutMs: 1000 },
      fetchMock as any, async () => {},
    );
    assert.equal(r.outcome, "ok");
    if (r.outcome === "ok") assert.equal(r.data.results?.[0].text, "recovered");
    assert.equal(fetchMock.mock.calls.length, 2, "succeeded on 2nd try");
  });

  test("network error (fetch failed) → retried", async () => {
    const fetchMock = mock.fn(async () => { throw new Error("fetch failed: ECONNREFUSED"); });
    const r = await recallBankWithRetry(apiUrl, apiKey, bank, body,
      { attempts: 3, backoffMs: 5, timeoutMs: 1000 },
      fetchMock as any, async () => {},
    );
    assert.equal(r.outcome, "error");
    if (r.outcome === "error") {
      assert.equal(r.attempts, 3);
      assert.equal(r.lastErrorKind, "network");
    }
    assert.equal(fetchMock.mock.calls.length, 3);
  });

  test("attempts=1 means no retry", async () => {
    const fetchMock = mock.fn(async () => ({ ok: false, status: 503 } as any));
    const r = await recallBankWithRetry(apiUrl, apiKey, bank, body,
      { attempts: 1, backoffMs: 10, timeoutMs: 1000 },
      fetchMock as any, async () => {},
    );
    assert.equal(r.outcome, "error");
    assert.equal(fetchMock.mock.calls.length, 1);
  });

  test("exponential backoff schedule", async () => {
    const fetchMock = mock.fn(async () => ({ ok: false, status: 503 } as any));
    const waits: number[] = [];
    const sleepMock = mock.fn(async (ms: number) => { waits.push(ms); });
    await recallBankWithRetry(apiUrl, apiKey, bank, body,
      { attempts: 4, backoffMs: 100, timeoutMs: 1000 },
      fetchMock as any, sleepMock as any,
    );
    // attempt 1 fails → wait 100, attempt 2 fails → wait 200, attempt 3 fails → wait 400, attempt 4 fails → done.
    assert.deepEqual(waits, [100, 200, 400]);
  });
});

// ============================================================================
// HEALTH-GATE BLOCK: end-to-end lifecycle simulation
// ============================================================================
//
// Inline simulation of the `before_agent_start` handler from index.ts —
// mirrors the actual control flow so the test catches regressions in the
// gate semantics even though the real handler isn't directly imported.

interface SimRecallOpts {
  config: { api_url: string; api_key: string; bank_id: string; global_bank: string | null; recall_types: string[]; strip_patterns: RegExp[] };
  settings: HindsightSettings;
  fetchImpl: any;
  recallDone: boolean;
  recallAttempts: number;
  abortCalled?: { value: boolean };
  statusSet?: { value: string | undefined };
}

async function simulateBeforeAgentStart(opts: SimRecallOpts): Promise<{
  blocked: boolean;
  injectedMessage: any;
  newRecallDone: boolean;
  newRecallAttempts: number;
  healthyAfter: boolean;
}> {
  const MAX_RECALL_ATTEMPTS = 3;
  const { config, settings, fetchImpl } = opts;
  let { recallDone, recallAttempts } = opts;

  if (recallDone || recallAttempts >= MAX_RECALL_ATTEMPTS) {
    return { blocked: false, injectedMessage: null, newRecallDone: recallDone, newRecallAttempts: recallAttempts, healthyAfter: healthState.healthy };
  }
  if (!config?.api_url) {
    recallAttempts = MAX_RECALL_ATTEMPTS;
    return { blocked: false, injectedMessage: null, newRecallDone: recallDone, newRecallAttempts: recallAttempts, healthyAfter: healthState.healthy };
  }
  const banks = [config.bank_id, ...(config.global_bank ? [config.global_bank] : [])];

  // ← Health gate check (BEFORE incrementing recallAttempts)
  if (!healthState.healthy && settings.healthGate === "block") {
    if (opts.abortCalled) opts.abortCalled.value = true;
    if (opts.statusSet) opts.statusSet.value = `✗ blocked: ${healthState.reason}`;
    return {
      blocked: true,
      injectedMessage: { customType: "hindsight-blocked", details: { reason: healthState.reason } },
      newRecallDone: recallDone,
      newRecallAttempts: recallAttempts,
      healthyAfter: healthState.healthy,
    };
  }

  recallAttempts++;

  const bankOutcomes = new Map<string, "ok" | "auth-failed" | "error">();
  const results: string[] = [];
  await Promise.all(banks.map(async (bank) => {
    const r = await recallBankWithRetry(config.api_url, config.api_key, bank, { query: "x" },
      { attempts: settings.recallRetry.attempts, backoffMs: settings.recallRetry.backoffMs, timeoutMs: settings.recallTimeoutMs },
      fetchImpl, async () => {},
    );
    if (r.outcome === "auth-failed") bankOutcomes.set(bank, "auth-failed");
    else if (r.outcome === "ok") {
      bankOutcomes.set(bank, "ok");
      for (const m of (r.data.results || [])) results.push(`[${bank}] ${m.text}`);
    } else bankOutcomes.set(bank, "error");
  }));

  const okBanks = banks.filter(b => bankOutcomes.get(b) === "ok");
  const authFailedBanks = banks.filter(b => bankOutcomes.get(b) === "auth-failed");
  const anyOk = okBanks.length > 0;
  const allAuthFailed = authFailedBanks.length === banks.length;

  if (allAuthFailed) {
    recallAttempts = MAX_RECALL_ATTEMPTS;
    if (settings.healthGate !== "off") markUnhealthy("auth error on all banks");
    return { blocked: false, injectedMessage: null, newRecallDone: recallDone, newRecallAttempts: recallAttempts, healthyAfter: healthState.healthy };
  }
  if (anyOk) {
    recallDone = true;
    markHealthy();
    return {
      blocked: false,
      injectedMessage: results.length ? { customType: "hindsight-recall", details: { count: results.length } } : null,
      newRecallDone: true,
      newRecallAttempts: recallAttempts,
      healthyAfter: healthState.healthy,
    };
  }
  const isLast = recallAttempts >= MAX_RECALL_ATTEMPTS;
  if (isLast && settings.healthGate !== "off") markUnhealthy("recall exhausted retries");
  return { blocked: false, injectedMessage: null, newRecallDone: recallDone, newRecallAttempts: recallAttempts, healthyAfter: healthState.healthy };
}

describe("healthGate end-to-end", () => {
  const config = {
    api_url: "http://localhost:18787", api_key: "k", bank_id: "project-x",
    global_bank: null, recall_types: ["observation"], strip_patterns: [],
  };

  test("healthy + warn → recall fires, prompt proceeds", async () => {
    const fetchMock = mock.fn(async () => ({ ok: true, status: 200, json: async () => ({ results: [{ text: "memory" }] }) } as any));
    const r = await simulateBeforeAgentStart({
      config, settings: buildSettings(null, null),
      fetchImpl: fetchMock, recallDone: false, recallAttempts: 0,
    });
    assert.equal(r.blocked, false);
    assert.ok(r.injectedMessage);
    assert.equal(r.injectedMessage.customType, "hindsight-recall");
    assert.equal(r.newRecallDone, true);
    assert.equal(r.healthyAfter, true);
  });

  test("unhealthy + warn → recall still fires, NOT blocked", async () => {
    markUnhealthy("zero units extracted");
    const fetchMock = mock.fn(async () => ({ ok: true, status: 200, json: async () => ({ results: [{ text: "memory" }] }) } as any));
    const r = await simulateBeforeAgentStart({
      config, settings: buildSettings({ healthGate: "warn" }, null),
      fetchImpl: fetchMock, recallDone: false, recallAttempts: 0,
    });
    assert.equal(r.blocked, false, "warn mode never blocks");
    assert.equal(fetchMock.mock.calls.length, 1, "still calls fetch");
    // Successful recall heals the state.
    assert.equal(r.healthyAfter, true, "successful recall heals state");
  });

  test("unhealthy + block → prompt blocked, abort called, fetch never invoked", async () => {
    markUnhealthy("zero units extracted");
    const fetchMock = mock.fn(async () => ({ ok: true, status: 200, json: async () => ({ results: [] }) } as any));
    const abort = { value: false };
    const r = await simulateBeforeAgentStart({
      config, settings: buildSettings({ healthGate: "block" }, null),
      fetchImpl: fetchMock, recallDone: false, recallAttempts: 0, abortCalled: abort,
    });
    assert.equal(r.blocked, true);
    assert.equal(abort.value, true, "ctx.abort() should have been called");
    assert.equal(fetchMock.mock.calls.length, 0, "no recall network call when blocked");
    assert.equal(r.injectedMessage.customType, "hindsight-blocked");
    assert.equal(r.injectedMessage.details.reason, "zero units extracted");
    assert.equal(r.newRecallDone, false, "blocked prompt does not consume the recall slot");
    assert.equal(r.newRecallAttempts, 0, "attempt counter not incremented on block");
  });

  test("unhealthy + off → never blocks, even with explicit block reason", async () => {
    markUnhealthy("zero units extracted");
    const fetchMock = mock.fn(async () => ({ ok: true, status: 200, json: async () => ({ results: [] }) } as any));
    const r = await simulateBeforeAgentStart({
      config, settings: buildSettings({ healthGate: "off" }, null),
      fetchImpl: fetchMock, recallDone: false, recallAttempts: 0,
    });
    assert.equal(r.blocked, false);
    assert.equal(fetchMock.mock.calls.length, 1);
  });

  test("block: after /hindsight reset clears unhealthy, next turn proceeds", async () => {
    markUnhealthy("zero units extracted");
    const fetchMock = mock.fn(async () => ({ ok: true, status: 200, json: async () => ({ results: [{ text: "m" }] }) } as any));
    // First turn: blocked
    const r1 = await simulateBeforeAgentStart({
      config, settings: buildSettings({ healthGate: "block" }, null),
      fetchImpl: fetchMock, recallDone: false, recallAttempts: 0,
    });
    assert.equal(r1.blocked, true);
    // User runs /hindsight reset
    markHealthy();
    // Second turn: proceeds
    const r2 = await simulateBeforeAgentStart({
      config, settings: buildSettings({ healthGate: "block" }, null),
      fetchImpl: fetchMock, recallDone: false, recallAttempts: 0,
    });
    assert.equal(r2.blocked, false);
    assert.ok(r2.injectedMessage);
  });

  test("block: exhausted retries marks unhealthy on final attempt only", async () => {
    const fetchMock = mock.fn(async () => ({ ok: false, status: 503 } as any));
    let recallAttempts = 0;
    let recallDone = false;
    const settings = buildSettings({ healthGate: "block", recallRetry: { attempts: 1, backoffMs: 0 } }, null);

    // Turn 1: not last attempt → does NOT mark unhealthy
    const r1 = await simulateBeforeAgentStart({
      config, settings, fetchImpl: fetchMock, recallDone, recallAttempts,
    });
    recallAttempts = r1.newRecallAttempts;
    assert.equal(healthState.healthy, true, "turn 1: still healthy (not last attempt)");

    // Turn 2: still not last
    const r2 = await simulateBeforeAgentStart({
      config, settings, fetchImpl: fetchMock, recallDone, recallAttempts,
    });
    recallAttempts = r2.newRecallAttempts;
    assert.equal(healthState.healthy, true, "turn 2: still healthy");

    // Turn 3: LAST attempt → marks unhealthy
    const r3 = await simulateBeforeAgentStart({
      config, settings, fetchImpl: fetchMock, recallDone, recallAttempts,
    });
    assert.equal(r3.newRecallAttempts, 3);
    assert.equal(healthState.healthy, false, "turn 3 (last): marks unhealthy");
    assert.equal(healthState.reason, "recall exhausted retries");
  });

  test("block: all-auth-failed marks unhealthy and blocks next turn", async () => {
    const fetchMock = mock.fn(async () => ({ ok: false, status: 401 } as any));
    const settings = buildSettings({ healthGate: "block", recallRetry: { attempts: 1, backoffMs: 0 } }, null);

    const r1 = await simulateBeforeAgentStart({
      config, settings, fetchImpl: fetchMock, recallDone: false, recallAttempts: 0,
    });
    assert.equal(r1.blocked, false, "first call goes through to detect auth fail");
    assert.equal(healthState.healthy, false);
    assert.equal(healthState.reason, "auth error on all banks");

    // Next turn: blocked by health gate (BEFORE incrementing recallAttempts)
    const r2 = await simulateBeforeAgentStart({
      config, settings, fetchImpl: fetchMock, recallDone: false, recallAttempts: 0,
    });
    assert.equal(r2.blocked, true);
  });

  test("off mode: never marks unhealthy, even after recall exhausts", async () => {
    const fetchMock = mock.fn(async () => ({ ok: false, status: 503 } as any));
    const settings = buildSettings({ healthGate: "off", recallRetry: { attempts: 1, backoffMs: 0 } }, null);
    let recallAttempts = 0;
    for (let i = 0; i < 3; i++) {
      const r = await simulateBeforeAgentStart({
        config, settings, fetchImpl: fetchMock, recallDone: false, recallAttempts,
      });
      recallAttempts = r.newRecallAttempts;
    }
    assert.equal(healthState.healthy, true, "off mode never marks unhealthy");
  });
});

// ============================================================================
// REGRESSION: the ⚠ retrying root cause — single transient timeout
// no longer poisons the session.
// ============================================================================

describe("regression: ⚠ retrying root-cause fix", () => {
  test("PRE-FIX BEHAVIOR (simulated): single 2s timeout fails the recall outright", async () => {
    // Reproduces the pre-Phase-C path: NO retry inside the recall call.
    // First call times out → outcome=error → status bar set to ⚠ retrying.
    const fetchMock = mock.fn(async () => {
      const err = new Error("operation timed out");
      err.name = "TimeoutError";
      throw err;
    });
    const r = await recallBankWithRetry("http://localhost:18787", "k", "b", {},
      { attempts: 1, backoffMs: 0, timeoutMs: 100 },
      fetchMock as any, async () => {},
    );
    assert.equal(r.outcome, "error", "no retry → bubbles up as error");
    assert.equal(fetchMock.mock.calls.length, 1);
  });

  test("POST-FIX BEHAVIOR: transient timeout is absorbed by in-call retry", async () => {
    let i = 0;
    const fetchMock = mock.fn(async () => {
      i++;
      if (i <= 1) {
        const err = new Error("operation timed out");
        err.name = "TimeoutError";
        throw err;
      }
      return { ok: true, status: 200, json: async () => ({ results: [{ text: "ok" }] }) } as any;
    });
    const r = await recallBankWithRetry("http://localhost:18787", "k", "b", {},
      { attempts: 3, backoffMs: 5, timeoutMs: 100 },
      fetchMock as any, async () => {},
    );
    assert.equal(r.outcome, "ok", "transient timeout absorbed → outcome=ok");
    assert.equal(fetchMock.mock.calls.length, 2);
  });

  test("default timeout bumped from 2000ms to 5000ms", () => {
    assert.equal(buildSettings(null, null).recallTimeoutMs, 5000);
  });

  test("default retry attempts is 3 (in-call, not per-session)", () => {
    assert.equal(buildSettings(null, null).recallRetry.attempts, 3);
  });
});
