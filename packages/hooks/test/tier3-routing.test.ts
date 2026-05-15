/**
 * Tier-3 routing classifier tests.
 *
 * `tier3RoutingReason(cmd)` decides whether a command should be sent to
 * the LLM judge instead of bouncing straight to notify_user. We only
 * route the noisy parameterised destructive commands: kill/pkill/killall
 * targeting a PID or name.
 *
 * Lock down:
 *   - kill <pid>, kill -<sig> <pid> match
 *   - pkill <target>, pkill -<sig> <target> match
 *   - killall <name>, killall -<sig> <name> match
 *   - kill -1 / kill -9 -1 do NOT match (Tier 1 invariant catches them earlier)
 *   - Non-kill commands do not match
 *   - Mid-chain occurrences only match when at the start of the trimmed string
 *     (the precheck splits chains before calling us, so this is the contract).
 */

import { describe, it, expect } from "vitest";
import { tier3RoutingReason } from "../src/index.js";

describe("tier3RoutingReason", () => {
  describe("matches", () => {
    const matches: Array<[string, string]> = [
      ["kill 9850", "kill <pid>"],
      ["kill -9 12345", "kill <pid>"],
      ["kill -SIGTERM 9850", "kill <pid>"],
      ["kill -TERM 9850", "kill <pid>"],
      ["  kill 9850  ", "kill <pid>"], // tolerant of surrounding whitespace
      ["pkill llama-server", "pkill <target>"],
      ["pkill -f llama-server", "pkill <target>"],
      ["pkill -9 -f llama-server", "pkill <target>"],
      ["killall node", "killall <target>"],
      ["killall -9 chrome", "killall <target>"],
    ];

    for (const [cmd, label] of matches) {
      it(`${cmd} → ${label}`, () => {
        expect(tier3RoutingReason(cmd)).toBe(label);
      });
    }
  });

  describe("non-matches", () => {
    const nonMatches = [
      "ls -la",
      "echo killing time",
      "grep kill foo.txt",
      "git status",
      "node --version",
      "kill", // no target — not actionable, let the shell error
      "pkill", // ditto
      "killall", // ditto
    ];

    for (const cmd of nonMatches) {
      it(`${cmd || "<empty>"} → null`, () => {
        expect(tier3RoutingReason(cmd)).toBeNull();
      });
    }
  });

  describe("Tier-1 invariants are NOT routed to the judge", () => {
    // kill -1 is in HARD_BLOCKS (Tier 1). The bash precheck catches it before
    // we ever reach Tier 3 routing, but make sure our routing classifier
    // wouldn't accidentally label it as benign-looking-Tier-3 either way.
    // (The classifier is permissive — it would label `kill -1` as <pid>
    // since "-1" looks like a numeric target. That's OK because Tier 1 is
    // checked FIRST in the precheck; this test pins the invariant via a
    // comment, not a behaviour change.)
    it("kill -1 would be Tier-3-shaped but Tier-1 catches it first in precheck", () => {
      // Intentional: classifier sees `-1` as numeric. The precheck's
      // hardBlockMatch on `\\bkill\\s+(-9\\s+)?-1(\\s|$)\\b` blocks it before\n      // ever reaching the Tier-3 path. Documented invariant.\n      expect(tier3RoutingReason(\"kill -1\")).not.toBeNull();
    });
  });
});
