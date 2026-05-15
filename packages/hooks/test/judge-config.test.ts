/**
 * judge-config loader tests.
 *
 * Invariants:
 *   - Missing file → disabled config, no warnings, defaults populated.
 *   - Malformed JSON → disabled config (never throws).
 *   - Out-of-range numeric values → fall back to defaults (e.g. timeoutMs=0).
 *   - enabled requires explicit true (any other truthy value stays false).
 *   - Fallback with missing endpoint/model is dropped.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { loadJudgeConfig } from "../src/judge-config.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "judge-cfg-"));
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

function write(content: string): string {
  const p = path.join(tmpDir, "llm-judge.json");
  fs.writeFileSync(p, content, "utf-8");
  return p;
}

describe("loadJudgeConfig", () => {
  it("returns disabled defaults when file missing", () => {
    const cfg = loadJudgeConfig({ configPath: path.join(tmpDir, "absent.json"), homedir: () => tmpDir });
    expect(cfg.enabled).toBe(false);
    expect(cfg.endpoint).toContain("localhost");
    expect(cfg.timeoutMs).toBeGreaterThan(0);
    expect(cfg.fallback).toBeNull();
  });

  it("loads enabled config from valid JSON", () => {
    const p = write(JSON.stringify({
      enabled: true,
      endpoint: "http://x:1/v1",
      model: "m",
      apiKey: "k",
      timeoutMs: 5000,
      maxCallsPerMinute: 30,
    }));
    const cfg = loadJudgeConfig({ configPath: p, homedir: () => tmpDir });
    expect(cfg.enabled).toBe(true);
    expect(cfg.endpoint).toBe("http://x:1/v1");
    expect(cfg.model).toBe("m");
    expect(cfg.apiKey).toBe("k");
    expect(cfg.timeoutMs).toBe(5000);
    expect(cfg.maxCallsPerMinute).toBe(30);
  });

  it("disables on malformed JSON without throwing", () => {
    const p = write("{not valid json");
    const cfg = loadJudgeConfig({ configPath: p, homedir: () => tmpDir });
    expect(cfg.enabled).toBe(false);
  });

  it("disables when root is an array", () => {
    const p = write("[]");
    const cfg = loadJudgeConfig({ configPath: p, homedir: () => tmpDir });
    expect(cfg.enabled).toBe(false);
  });

  it("clamps invalid timeoutMs back to default", () => {
    const p = write(JSON.stringify({ enabled: true, timeoutMs: 0 }));
    const cfg = loadJudgeConfig({ configPath: p, homedir: () => tmpDir });
    expect(cfg.timeoutMs).toBeGreaterThanOrEqual(100);
  });

  it("clamps invalid maxCallsPerMinute back to default", () => {
    const p = write(JSON.stringify({ enabled: true, maxCallsPerMinute: 999_999 }));
    const cfg = loadJudgeConfig({ configPath: p, homedir: () => tmpDir });
    expect(cfg.maxCallsPerMinute).toBeLessThanOrEqual(600);
  });

  it("requires enabled === true (truthy strings stay disabled)", () => {
    const p = write(JSON.stringify({ enabled: "yes" }));
    const cfg = loadJudgeConfig({ configPath: p, homedir: () => tmpDir });
    expect(cfg.enabled).toBe(false);
  });

  it("drops fallback when endpoint missing", () => {
    const p = write(JSON.stringify({
      enabled: true,
      fallback: { model: "m" },
    }));
    const cfg = loadJudgeConfig({ configPath: p, homedir: () => tmpDir });
    expect(cfg.fallback).toBeNull();
  });

  it("keeps valid fallback", () => {
    const p = write(JSON.stringify({
      enabled: true,
      fallback: { endpoint: "http://f/v1", model: "fm", apiKey: "fk" },
    }));
    const cfg = loadJudgeConfig({ configPath: p, homedir: () => tmpDir });
    expect(cfg.fallback).toEqual({ endpoint: "http://f/v1", model: "fm", apiKey: "fk" });
  });
});
