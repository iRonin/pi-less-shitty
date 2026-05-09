import { describe, it, expect, beforeEach } from "vitest";
import { ToolLoopDetector } from "../src/loop-detector.js";

const defaultConfig = {
  warningThreshold: 3,
  criticalThreshold: 5,
  windowSize: 30,
  mode: "stop" as const,
  validToolNames: new Set(["edit", "read", "bash", "grep", "write"]),
};

function makeCall(toolName: string, args: Record<string, unknown> = {}, result = "", isError = false, reasoning: string | null = null) {
  return { toolName, args, result, isError, reasoning };
}

describe("ToolLoopDetector", () => {
  let detector: ToolLoopDetector;

  beforeEach(() => {
    detector = new ToolLoopDetector(defaultConfig);
  });

  describe("generic_repeat — same (tool, args) N times", () => {
    it("returns none for first call", () => {
      const v = detector.record(makeCall("edit", { path: "foo.md", oldText: "a", newText: "b" }));
      expect(v.severity).toBe("none");
    });

    it("returns warning at threshold", () => {
      const args = { path: "foo.md", oldText: "a", newText: "b" };
      for (let i = 0; i < 2; i++) {
        detector.record(makeCall("edit", args, "ok"));
      }
      const v = detector.record(makeCall("edit", args, "ok"));
      expect(v.severity).toBe("warning");
      expect(v.detector).toBe("generic_repeat");
      expect(v.streak).toBe(3);
    });

    it("returns critical at critical threshold", () => {
      const args = { path: "foo.md", oldText: "a", newText: "b" };
      for (let i = 0; i < 4; i++) {
        detector.record(makeCall("edit", args, "ok"));
      }
      const v = detector.record(makeCall("edit", args, "ok"));
      expect(v.severity).toBe("critical");
      expect(v.streak).toBe(5);
    });

    it("resets when args change", () => {
      detector.record(makeCall("edit", { path: "a.md", oldText: "x", newText: "y" }));
      detector.record(makeCall("edit", { path: "a.md", oldText: "x", newText: "y" }));
      // Different args — streak resets to 1 (just this call)
      const v = detector.record(makeCall("edit", { path: "a.md", oldText: "p", newText: "q" }));
      expect(v.severity).toBe("none");
      expect(v.streak).toBe(1);
    });
  });

  describe("poll_no_progress — same tool, same error pattern", () => {
    it("detects repeated identical errors with different args", () => {
      // Simulates the real-world loop: edit fails with same error each time
      const errorResult = "Could not find the exact text in /path/to/file.md. The old text must match exactly.";

      // Each call has slightly different args but same error
      for (let i = 0; i < 2; i++) {
        detector.record(makeCall("edit", { path: "file.md", oldText: `attempt ${i}`, newText: "fix" }, errorResult, true));
      }
      const v = detector.record(makeCall("edit", { path: "file.md", oldText: "attempt 2", newText: "fix" }, errorResult, true));
      expect(v.severity).toBe("warning");
      expect(v.detector).toBe("poll_no_progress");
      expect(v.streak).toBe(3);
    });

    it("resets when error pattern changes", () => {
      const err1 = "Could not find the exact text in /path/file.md.";
      const err2 = "Permission denied: /path/file.md";

      // Different args so generic_repeat doesn't fire
      detector.record(makeCall("edit", { path: "file.md", oldText: "x" }, err1, true));
      detector.record(makeCall("edit", { path: "file.md", oldText: "y" }, err1, true));
      // Different error — poll_no_progress resets
      const v = detector.record(makeCall("edit", { path: "file.md", oldText: "z" }, err2, true));
      expect(v.severity).toBe("none");
      expect(v.streak).toBe(1);
    });

    it("doesn't fire poll_no_progress for successful results (but generic_repeat still can)", () => {
      // poll_no_progress only fires on errors
      // But generic_repeat still detects if same args are used repeatedly
      for (let i = 0; i < 4; i++) {
        detector.record(makeCall("edit", { path: `file${i}.md` }, "ok", false));
      }
      // Different args each time → no generic_repeat, no poll_no_progress
      const v = detector.record(makeCall("edit", { path: "file4.md" }, "ok", false));
      expect(v.severity).toBe("none");
    });
  });

  describe("ping_pong — A-B-A-B-A-B alternation", () => {
    it("detects alternation after 6 entries", () => {
      const aArgs = { path: "a.md" };
      const bArgs = { path: "b.md" };

      // A-B-A-B-A
      detector.record(makeCall("edit", aArgs));
      detector.record(makeCall("edit", bArgs));
      detector.record(makeCall("edit", aArgs));
      detector.record(makeCall("edit", bArgs));
      detector.record(makeCall("edit", aArgs));

      // B → should trigger ping_pong
      // 3 pairs = 6 events; with test config (warning=3, critical=5) this is critical.
      const v = detector.record(makeCall("edit", bArgs));
      expect(v.severity).toBe("critical");
      expect(v.detector).toBe("ping_pong");
    });

    it("fires (non-'none') with documented default thresholds (5/10) on a 3-pair ping-pong", () => {
      // Regression for BUG 2: previously checkPingPong reported severity(3),
      // which is below both default thresholds and never fired.
      const det = new ToolLoopDetector({
        warningThreshold: 5,
        criticalThreshold: 10,
        windowSize: 30,
        mode: "warn",
        validToolNames: new Set(["edit"]),
      });
      const a = { path: "a.md" };
      const b = { path: "b.md" };
      det.record(makeCall("edit", a));
      det.record(makeCall("edit", b));
      det.record(makeCall("edit", a));
      det.record(makeCall("edit", b));
      det.record(makeCall("edit", a));
      const v = det.record(makeCall("edit", b));
      expect(v.severity).not.toBe("none");
      expect(v.detector).toBe("ping_pong");
    });

    it("doesn't fire for non-alternating pattern", () => {
      detector.record(makeCall("edit", { path: "a.md" }));
      detector.record(makeCall("edit", { path: "b.md" }));
      detector.record(makeCall("edit", { path: "c.md" }));
      detector.record(makeCall("edit", { path: "a.md" }));
      detector.record(makeCall("edit", { path: "b.md" }));
      const v = detector.record(makeCall("edit", { path: "c.md" }));
      expect(v.severity).toBe("none");
    });
  });

  describe("canonicalKey — deep-stable serialization", () => {
    it("distinguishes two edit calls on the same path with different oldText/newText", () => {
      // Regression for BUG 1: JSON.stringify(args, Object.keys(args).sort()) treats
      // the second arg as an allowlist applied at every depth, so nested objects
      // (like edits[].oldText/newText) get stripped and two distinct edit calls
      // collapse to the same canonical key → false-positive generic_repeat.
      const argsA = { path: "/x", edits: [{ oldText: "a", newText: "b" }] };
      const argsB = { path: "/x", edits: [{ oldText: "c", newText: "d" }] };

      // Hammer the same call enough that, if canonical keys collide, generic_repeat
      // would fire. With correct deep stringify they should not.
      detector.record(makeCall("edit", argsA));
      detector.record(makeCall("edit", argsB));
      detector.record(makeCall("edit", argsA));
      detector.record(makeCall("edit", argsB));
      const v = detector.record(makeCall("edit", argsA));
      // Streak should be 1 (last call's args differ from previous), not threshold.
      expect(v.severity).toBe("none");
      expect(v.streak).toBe(1);
    });

    it("still collapses identical args (with nested arrays/objects) to one streak", () => {
      const args = { path: "/x", edits: [{ oldText: "a", newText: "b" }] };
      detector.record(makeCall("edit", args));
      detector.record(makeCall("edit", args));
      const v = detector.record(makeCall("edit", args));
      expect(v.severity).toBe("warning");
      expect(v.detector).toBe("generic_repeat");
      expect(v.streak).toBe(3);
    });
  });

  describe("intended tool extraction", () => {
    it("extracts intended tool from reasoning text", () => {
      const args = { path: "file.md" };
      detector.record(makeCall("edit", args, "", true, "I should use grep to find the text first"));
      detector.record(makeCall("edit", args, "", true, "I should use grep to find the text first"));
      const v = detector.record(makeCall("edit", args, "", true, "I should use grep to find the text first"));

      expect(v.severity).toBe("warning");
      expect((v as any).intendedTool).toBe("grep");
    });

    it("returns null when no other tool is mentioned", () => {
      const args = { path: "file.md" };
      detector.record(makeCall("edit", args, "", true, "Let me try again"));
      detector.record(makeCall("edit", args, "", true, "Let me try again"));
      const v = detector.record(makeCall("edit", args, "", true, "Let me try again"));

      expect(v.severity).toBe("warning");
      expect((v as any).intendedTool).toBeNull();
    });
  });

  describe("reset", () => {
    it("clears all history", () => {
      const args = { path: "file.md" };
      for (let i = 0; i < 4; i++) {
        detector.record(makeCall("edit", args, "", true));
      }

      detector.reset();

      const v = detector.record(makeCall("edit", args, "", true));
      expect(v.severity).toBe("none");
      expect(v.streak).toBe(1);
    });
  });

  describe("window size", () => {
    it("respects window size limit", () => {
      const small = new ToolLoopDetector({ ...defaultConfig, windowSize: 3 });

      // Fill beyond window
      for (let i = 0; i < 5; i++) {
        small.record(makeCall("edit", { path: `file${i}.md` }));
      }

      // Only last 3 should matter
      const v = small.record(makeCall("edit", { path: "file4.md" }));
      expect(v.streak).toBe(2); // file3, file4
    });
  });

  describe("prune prompt", () => {
    it("builds informative prune prompt", () => {
      const prompt = detector.buildPrunePromptAppend("edit", 5, "grep");
      expect(prompt).toContain("edit");
      expect(prompt).toContain("5 times");
      expect(prompt).toContain("grep");
      expect(prompt).toContain("token-anchoring");
    });

    it("works without intended tool", () => {
      const prompt = detector.buildPrunePromptAppend("bash", 3, null);
      expect(prompt).toContain("bash");
      expect(prompt).toContain("3 times");
      expect(prompt).not.toContain("grep");
      expect(prompt).toContain("different approach");
    });
  });
});
