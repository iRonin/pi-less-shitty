/**
 * judge-context buffer tests.
 *
 * Lock down:
 *   - recordUserPrompt truncates to ≤ 1500 + sentinel
 *   - recordBashCommand coalesces contiguous duplicates
 *   - recordBashCommand evicts FIFO at the 10-command cap
 *   - clearJudgeContext fully resets state
 *   - empty inputs are no-ops
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  recordUserPrompt,
  recordBashCommand,
  getJudgeContext,
  clearJudgeContext,
} from "../src/judge-context.js";

beforeEach(() => {
  clearJudgeContext();
});

describe("recordUserPrompt", () => {
  it("stores short prompts verbatim", () => {
    recordUserPrompt("kill the old llama-server");
    expect(getJudgeContext().lastUserPrompt).toBe("kill the old llama-server");
  });

  it("truncates oversize prompts and marks them", () => {
    recordUserPrompt("x".repeat(2000));
    const stored = getJudgeContext().lastUserPrompt!;
    expect(stored.length).toBeLessThan(2000);
    expect(stored.endsWith("[truncated]")).toBe(true);
  });

  it("ignores empty strings", () => {
    recordUserPrompt("");
    expect(getJudgeContext().lastUserPrompt).toBeNull();
  });

  it("replaces previous prompt on each call", () => {
    recordUserPrompt("first");
    recordUserPrompt("second");
    expect(getJudgeContext().lastUserPrompt).toBe("second");
  });
});

describe("recordBashCommand", () => {
  it("appends commands in order", () => {
    recordBashCommand("ls -la");
    recordBashCommand("pwd");
    expect(getJudgeContext().recentBash).toEqual(["ls -la", "pwd"]);
  });

  it("coalesces contiguous duplicates", () => {
    recordBashCommand("ls");
    recordBashCommand("ls");
    recordBashCommand("ls");
    expect(getJudgeContext().recentBash).toEqual(["ls"]);
  });

  it("does NOT coalesce non-contiguous duplicates", () => {
    recordBashCommand("ls");
    recordBashCommand("pwd");
    recordBashCommand("ls");
    expect(getJudgeContext().recentBash).toEqual(["ls", "pwd", "ls"]);
  });

  it("evicts FIFO at the cap (keeps last 10)", () => {
    for (let i = 0; i < 15; i++) recordBashCommand(`cmd-${i}`);
    const bash = getJudgeContext().recentBash;
    expect(bash).toHaveLength(10);
    expect(bash[0]).toBe("cmd-5");
    expect(bash[9]).toBe("cmd-14");
  });

  it("ignores empty strings", () => {
    recordBashCommand("");
    expect(getJudgeContext().recentBash).toEqual([]);
  });
});

describe("clearJudgeContext", () => {
  it("fully resets state", () => {
    recordUserPrompt("hello");
    recordBashCommand("ls");
    clearJudgeContext();
    expect(getJudgeContext()).toEqual({ lastUserPrompt: null, recentBash: [] });
  });
});

describe("getJudgeContext", () => {
  it("returns a snapshot — mutating the array does not affect internal state", () => {
    recordBashCommand("a");
    const snap = getJudgeContext().recentBash;
    snap.push("rogue");
    expect(getJudgeContext().recentBash).toEqual(["a"]);
  });
});
