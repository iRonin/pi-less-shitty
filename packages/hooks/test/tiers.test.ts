/**
 * Hard-block tier tests.
 *
 * Locks down the two-tier model:
 *   Tier 1 — UNCONDITIONAL. sudo, dd/mkfs/diskutil, SQL DROP, kill -1,
 *            pipe-to-shell, writes to /dev/sd*, etc. Must never be bypassable.
 *   Tier 2 — PROJECT-OVERRIDABLE. git destructive verbs. .pi-hooks.json allow
 *            rules in the project bypass; otherwise still hard-blocked.
 *
 * We test the pure classifier `blockTier` against every reason string the
 * hard-block layer emits to prove that no Tier-1 reason ever leaks into the
 * project-overridable bucket.
 */

import { describe, it, expect } from "vitest";

import { blockTier, hardBlockMatch } from "../src/index.js";

describe("blockTier — classification", () => {
  describe("Tier 1 (UNCONDITIONAL)", () => {
    const tier1Cases: Array<[string, string]> = [
      ["sudo apt-get install foo", "sudo"],
      ["/usr/bin/sudo rm -rf /", "sudo"],
      ["dd if=/dev/zero of=/dev/sda", "disk"],
      ["mkfs.ext4 /dev/sdb1", "disk"],
      ["diskutil eraseDisk JHFS+ X disk2", "disk"],
      ["cat foo > /dev/sda", "device write"],
      ["cat foo > /dev/disk2", "device write"],
      ["psql -c 'DROP TABLE users'", "SQL"],
      ["mysql -e 'TRUNCATE TABLE x'", "SQL"],
      ["sqlite3 db 'DROP DATABASE prod'", "SQL"],
      ["kill -1", "kill -1"],
      ["kill -9 -1", "kill -9 -1"],
      // Wrapper bypass surfaces — must still resolve to Tier 1.
      ['bash -c "sudo X"', "sudo via bash -c"],
      ["eval 'sudo X'", "sudo via eval"],
      ["xargs sudo X", "sudo via xargs"],
    ];

    for (const [cmd, label] of tier1Cases) {
      it(`${label}: \`${cmd}\` → Tier 1`, () => {
        const reason = hardBlockMatch(cmd);
        expect(reason, `expected hard-block for ${cmd}`).not.toBeNull();
        expect(blockTier(reason!)).toBe(1);
      });
    }
  });

  describe("Tier 2 (PROJECT-OVERRIDABLE)", () => {
    const tier2Cases: Array<[string, string]> = [
      ["git checkout main", "git checkout"],
      ["git checkout -- file.txt", "git checkout file"],
      ["git -C /tmp/repo checkout HEAD", "git -C checkout"],
      ["git --git-dir=/x --work-tree=/y checkout HEAD", "git --git-dir checkout"],
      ["git reset --hard HEAD~3", "git reset"],
      ["git restore --source=HEAD~1 file", "git restore"],
      ["git clean -fd", "git clean"],
      ["git rebase -i HEAD~5", "git rebase"],
      ["git push --force origin main", "git push --force"],
      ["git push -f origin main", "git push -f"],
      ["git push --force-with-lease origin main", "git push --force-with-lease"],
      ["git branch -D feature", "git branch -D"],
      ["git stash drop", "git stash drop"],
      ["git stash clear", "git stash clear"],
      ["git commit --amend -m foo", "git commit --amend"],
      ["git tag -d v1.0", "git tag -d"],
    ];

    for (const [cmd, label] of tier2Cases) {
      it(`${label}: \`${cmd}\` → Tier 2`, () => {
        const reason = hardBlockMatch(cmd);
        expect(reason, `expected hard-block for ${cmd}`).not.toBeNull();
        expect(blockTier(reason!)).toBe(2);
      });
    }
  });

  describe("safety — Tier 1 mis-classification regressions", () => {
    it("a Tier-1 reason masquerading as Tier 2 via a 'git ' substring still classifies as Tier 1", () => {
      // We never want a future refactor to start prefixing sudo blocks with
      // \"BLOCKED: git \" by accident. Smoke-test the predicate independently.
      expect(blockTier("sudo is never allowed")).toBe(1);
      expect(blockTier("Disk operations are never allowed")).toBe(1);
      expect(blockTier("Writing to device files is never allowed")).toBe(1);
      expect(blockTier("Destructive SQL operations are never allowed")).toBe(1);
      expect(blockTier("kill -1 kills all user processes")).toBe(1);
    });

    it("only reason strings beginning with 'BLOCKED: git ' or 'BLOCKED: force-pushing' are Tier 2", () => {
      expect(blockTier("BLOCKED: git checkout can discard uncommitted work")).toBe(2);
      expect(blockTier("BLOCKED: git reset moves HEAD")).toBe(2);
      expect(blockTier("BLOCKED: force-pushing or remote-deleting rewrites remote history")).toBe(2);
      // Arbitrary BLOCKED: reasons that aren't git → still Tier 1.
      expect(blockTier("BLOCKED: something else")).toBe(1);
    });
  });
});
