/**
 * LLM judge tests.
 *
 * Coverage:
 *   - Disabled config            → "confirm", source "none"
 *   - allow / confirm / block parsed from strict JSON
 *   - response_format-ignored servers: regex JSON extraction works + warning
 *   - HTTP error                  → fail-closed "confirm"
 *   - Network error               → fail-closed "confirm"
 *   - Timeout                     → fail-closed "confirm"
 *   - Bad verdict value           → fail-closed "confirm"
 *   - Rate-limit                  → fail-closed "confirm"
 *   - Fallback used when primary fails
 *   - Both fail                   → fail-closed "confirm"
 *   - Audit log appended
 *   - Audit log failure non-fatal
 *
 * All "fail-closed" cases must produce `verdict: "confirm"`. The judge can
 * NEVER weaken the existing notify_user flow.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { judgeCommand, _resetLimiter, type JudgeRequest } from "../src/llm-judge.js";
import type { JudgeConfig } from "../src/judge-config.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmpDir: string;
let logPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "judge-"));
  logPath = path.join(tmpDir, "judge.log");
  _resetLimiter();
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

function cfg(over: Partial<JudgeConfig> = {}): JudgeConfig {
  return {
    enabled: true,
    endpoint: "http://localhost:1234/v1",
    model: "test-model",
    apiKey: "test-key",
    timeoutMs: 1000,
    maxCallsPerMinute: 60,
    fallback: null,
    logPath,
    ...over,
  };
}

function req(over: Partial<JudgeRequest> = {}): JudgeRequest {
  return {
    command: "kill 9850",
    cwd: "/Users/x/proj",
    policyText: "",
    routingReason: "kill <pid>",
    ...over,
  };
}

function mockFetch(impl: (url: string, init: RequestInit) => Promise<Response>): typeof fetch {
  return impl as unknown as typeof fetch;
}

function chatResponse(content: string, status = 200): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function rawResponse(body: string, status = 200, contentType = "application/json"): Response {
  return new Response(body, { status, headers: { "Content-Type": contentType } });
}

// ---------------------------------------------------------------------------
// Disabled
// ---------------------------------------------------------------------------

describe("judgeCommand — disabled", () => {
  it("returns confirm/none without contacting the endpoint", async () => {
    let called = false;
    const fetchImpl = mockFetch(async () => {
      called = true;
      return chatResponse('{"verdict":"allow","reason":"x"}');
    });

    const result = await judgeCommand(req(), cfg({ enabled: false }), fetchImpl);
    expect(result.verdict).toBe("confirm");
    expect(result.source).toBe("none");
    expect(result.reason).toMatch(/disabled/);
    expect(called).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Parsing — happy path
// ---------------------------------------------------------------------------

describe("judgeCommand — verdict parsing", () => {
  it("parses allow from strict JSON", async () => {
    const fetchImpl = mockFetch(async () =>
      chatResponse('{"verdict":"allow","reason":"routine kill"}'),
    );
    const result = await judgeCommand(req(), cfg(), fetchImpl);
    expect(result.verdict).toBe("allow");
    expect(result.reason).toBe("routine kill");
    expect(result.source).toBe("primary");
  });

  it("parses confirm from strict JSON", async () => {
    const fetchImpl = mockFetch(async () =>
      chatResponse('{"verdict":"confirm","reason":"ambiguous"}'),
    );
    const result = await judgeCommand(req(), cfg(), fetchImpl);
    expect(result.verdict).toBe("confirm");
  });

  it("parses block from strict JSON", async () => {
    const fetchImpl = mockFetch(async () =>
      chatResponse('{"verdict":"block","reason":"unjustified"}'),
    );
    const result = await judgeCommand(req(), cfg(), fetchImpl);
    expect(result.verdict).toBe("block");
  });

  it("extracts JSON from prose responses (response_format ignored) with warning", async () => {
    const fetchImpl = mockFetch(async () =>
      chatResponse('Sure. Here is the verdict:\n```json\n{"verdict":"allow","reason":"ok"}\n```'),
    );
    const result = await judgeCommand(req(), cfg(), fetchImpl);
    expect(result.verdict).toBe("allow");
    expect(result.warnings.some((w) => w.includes("response_format ignored"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fail-closed paths — every one must produce "confirm"
// ---------------------------------------------------------------------------

describe("judgeCommand — fail-closed", () => {
  it("HTTP 5xx → confirm", async () => {
    const fetchImpl = mockFetch(async () =>
      rawResponse("upstream gone", 502, "text/plain"),
    );
    const result = await judgeCommand(req(), cfg(), fetchImpl);
    expect(result.verdict).toBe("confirm");
    expect(result.source).toBe("none");
    expect(result.warnings.some((w) => w.includes("HTTP 502"))).toBe(true);
  });

  it("network error → confirm", async () => {
    const fetchImpl = mockFetch(async () => { throw new Error("ECONNREFUSED"); });
    const result = await judgeCommand(req(), cfg(), fetchImpl);
    expect(result.verdict).toBe("confirm");
    expect(result.warnings.some((w) => w.includes("ECONNREFUSED"))).toBe(true);
  });

  it("timeout → confirm", async () => {
    const fetchImpl = mockFetch(async (_url, init) => {
      return await new Promise<Response>((_resolve, reject) => {
        (init.signal as AbortSignal).addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    });
    const result = await judgeCommand(req(), cfg({ timeoutMs: 50 }), fetchImpl);
    expect(result.verdict).toBe("confirm");
  });

  it("invalid verdict value → confirm", async () => {
    const fetchImpl = mockFetch(async () =>
      chatResponse('{"verdict":"approve","reason":"x"}'),
    );
    const result = await judgeCommand(req(), cfg(), fetchImpl);
    expect(result.verdict).toBe("confirm");
    expect(result.warnings.some((w) => w.includes("invalid verdict"))).toBe(true);
  });

  it("non-JSON body → confirm", async () => {
    const fetchImpl = mockFetch(async () => rawResponse("not json", 200));
    const result = await judgeCommand(req(), cfg(), fetchImpl);
    expect(result.verdict).toBe("confirm");
  });

  it("empty content → confirm", async () => {
    const fetchImpl = mockFetch(async () => chatResponse(""));
    const result = await judgeCommand(req(), cfg(), fetchImpl);
    expect(result.verdict).toBe("confirm");
  });

  it("unparseable content (no JSON inside) → confirm", async () => {
    const fetchImpl = mockFetch(async () => chatResponse("totally not json"));
    const result = await judgeCommand(req(), cfg(), fetchImpl);
    expect(result.verdict).toBe("confirm");
  });
});

// ---------------------------------------------------------------------------
// Rate-limit
// ---------------------------------------------------------------------------

describe("judgeCommand — rate limit", () => {
  it("blocks further calls in the same minute → confirm", async () => {
    const fetchImpl = mockFetch(async () =>
      chatResponse('{"verdict":"allow","reason":"ok"}'),
    );
    const c = cfg({ maxCallsPerMinute: 2 });
    const a = await judgeCommand(req(), c, fetchImpl);
    const b = await judgeCommand(req(), c, fetchImpl);
    const denied = await judgeCommand(req(), c, fetchImpl);
    expect(a.verdict).toBe("allow");
    expect(b.verdict).toBe("allow");
    expect(denied.verdict).toBe("confirm");
    expect(denied.source).toBe("none");
    expect(denied.warnings.some((w) => w.includes("rate-limited") || w.includes("calls/min"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fallback
// ---------------------------------------------------------------------------

describe("judgeCommand — fallback", () => {
  it("uses fallback when primary fails", async () => {
    let call = 0;
    const fetchImpl = mockFetch(async (url) => {
      call++;
      if (call === 1) throw new Error("primary down");
      expect(url).toContain("fallback");
      return chatResponse('{"verdict":"allow","reason":"via fallback"}');
    });

    const c = cfg({
      fallback: {
        endpoint: "http://fallback.local/v1",
        model: "fallback-model",
        apiKey: null,
      },
    });
    const result = await judgeCommand(req(), c, fetchImpl);
    expect(result.verdict).toBe("allow");
    expect(result.source).toBe("fallback");
    expect(result.warnings.some((w) => w.includes("primary failed"))).toBe(true);
  });

  it("primary + fallback both fail → confirm", async () => {
    const fetchImpl = mockFetch(async () => { throw new Error("dead"); });
    const c = cfg({
      fallback: {
        endpoint: "http://fallback.local/v1",
        model: "fallback-model",
        apiKey: null,
      },
    });
    const result = await judgeCommand(req(), c, fetchImpl);
    expect(result.verdict).toBe("confirm");
    expect(result.source).toBe("none");
    expect(result.warnings.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

describe("judgeCommand — audit log", () => {
  it("appends a JSONL entry per call", async () => {
    const fetchImpl = mockFetch(async () =>
      chatResponse('{"verdict":"allow","reason":"ok"}'),
    );
    await judgeCommand(req({ command: "kill 100" }), cfg(), fetchImpl);
    await judgeCommand(req({ command: "kill 200" }), cfg(), fetchImpl);

    const lines = fs.readFileSync(logPath, "utf-8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
    const a = JSON.parse(lines[0]);
    const b = JSON.parse(lines[1]);
    expect(a.command).toBe("kill 100");
    expect(b.command).toBe("kill 200");
    expect(a.verdict).toBe("allow");
    expect(a.source).toBe("primary");
    expect(typeof a.ts).toBe("string");
    expect(typeof a.latencyMs).toBe("number");
  });

  it("logs fail-closed verdicts too", async () => {
    const fetchImpl = mockFetch(async () => { throw new Error("nope"); });
    await judgeCommand(req(), cfg(), fetchImpl);
    const lines = fs.readFileSync(logPath, "utf-8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]);
    expect(entry.verdict).toBe("confirm");
    expect(entry.source).toBe("none");
  });

  it("log write failure is non-fatal", async () => {
    const fetchImpl = mockFetch(async () =>
      chatResponse('{"verdict":"allow","reason":"ok"}'),
    );
    // Point logPath into a non-existent directory under a regular file so
    // mkdirSync fails (regular file as parent prefix).
    const badParent = path.join(tmpDir, "blocker");
    fs.writeFileSync(badParent, "x", "utf-8");
    const badLog = path.join(badParent, "subdir", "judge.log");

    const result = await judgeCommand(req(), cfg({ logPath: badLog }), fetchImpl);
    expect(result.verdict).toBe("allow"); // still produces the verdict
  });
});
