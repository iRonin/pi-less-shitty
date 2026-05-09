import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  checkPermission,
  findGitPermissions,
  splitChainedCommands,
  tokenize,
  unwrapCommand,
} from "../src/policy.js";

// ---------------------------------------------------------------------------
// tokenize
// ---------------------------------------------------------------------------

describe("tokenize", () => {
  it("splits simple commands", () => {
    expect(tokenize("git push origin main")).toEqual([
      "git",
      "push",
      "origin",
      "main",
    ]);
  });

  it("preserves single-quoted args", () => {
    expect(tokenize("bash -c 'git push --force'")).toEqual([
      "bash",
      "-c",
      "git push --force",
    ]);
  });

  it("preserves double-quoted args with escapes", () => {
    expect(tokenize('bash -c "git commit -m \\"x\\""')).toEqual([
      "bash",
      "-c",
      'git commit -m "x"',
    ]);
  });

  it("returns null on unbalanced single quote", () => {
    expect(tokenize("bash -c 'git push")).toBeNull();
  });

  it("returns null on unbalanced double quote", () => {
    expect(tokenize('bash -c "git push')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// unwrapCommand
// ---------------------------------------------------------------------------

describe("unwrapCommand", () => {
  it("returns plain git command unchanged", () => {
    const r = unwrapCommand("git push origin main");
    expect(r.failed).toBeFalsy();
    expect(r.command).toBe("git push origin main");
  });

  it("unwraps bash -c '<str>'", () => {
    const r = unwrapCommand("bash -c 'git push --force'");
    expect(r.failed).toBeFalsy();
    expect(r.command).toBe("git push --force");
  });

  it('unwraps bash -c "<str>"', () => {
    const r = unwrapCommand('bash -c "git push --force"');
    expect(r.failed).toBeFalsy();
    expect(r.command).toBe("git push --force");
  });

  it("unwraps sh -c", () => {
    const r = unwrapCommand("sh -c 'git reset --hard'");
    expect(r.failed).toBeFalsy();
    expect(r.command).toBe("git reset --hard");
  });

  it("unwraps zsh -c", () => {
    const r = unwrapCommand("zsh -c 'git status'");
    expect(r.failed).toBeFalsy();
    expect(r.command).toBe("git status");
  });

  it("unwraps eval", () => {
    const r = unwrapCommand("eval 'git pull'");
    expect(r.failed).toBeFalsy();
    expect(r.command).toBe("git pull");
  });

  it("unwraps eval with multiple args (joined with space)", () => {
    const r = unwrapCommand("eval git push");
    expect(r.failed).toBeFalsy();
    expect(r.command).toBe("git push");
  });

  it("unwraps xargs <cmd>", () => {
    const r = unwrapCommand("xargs git rebase");
    expect(r.failed).toBeFalsy();
    expect(r.command).toBe("git rebase");
  });

  it("unwraps xargs with flags", () => {
    const r = unwrapCommand("xargs -n1 -I{} git checkout {}");
    expect(r.failed).toBeFalsy();
    expect(r.command).toBe("git checkout {}");
  });

  it("unwraps xargs with --replace=", () => {
    const r = unwrapCommand("xargs --replace=X git rm X");
    expect(r.failed).toBeFalsy();
    // --replace=X is treated as flag-with-value (single token).
    expect(r.command).toBe("git rm X");
  });

  it("unwraps env KEY=VAL <cmd>", () => {
    const r = unwrapCommand("env FOO=bar git push");
    expect(r.failed).toBeFalsy();
    expect(r.command).toBe("git push");
  });

  it("unwraps env with multiple assignments", () => {
    const r = unwrapCommand("env A=1 B=2 git push --force");
    expect(r.failed).toBeFalsy();
    expect(r.command).toBe("git push --force");
  });

  it("unwraps env with -u flag", () => {
    const r = unwrapCommand("env -u GIT_DIR FOO=bar git status");
    expect(r.failed).toBeFalsy();
    expect(r.command).toBe("git status");
  });

  it("fails closed on bash -c with unbalanced quotes", () => {
    const r = unwrapCommand("bash -c 'git push --force");
    expect(r.failed).toBe(true);
  });

  it("fails closed on bash -c with no payload", () => {
    const r = unwrapCommand("bash -c");
    expect(r.failed).toBe(true);
  });

  it("does NOT fail closed on tokenize-failure for non-wrapper", () => {
    const r = unwrapCommand("echo 'hello");
    // Non-wrapper, tokenize fails → leave command as-is, no failed flag.
    expect(r.failed).toBeFalsy();
  });

  it("does not double-recurse (one level only)", () => {
    // Outer wrapper unwraps to inner wrapper string; we do NOT recurse further.
    const r = unwrapCommand("bash -c 'bash -c \"git push\"'");
    expect(r.failed).toBeFalsy();
    expect(r.command).toBe('bash -c "git push"');
  });
});

// ---------------------------------------------------------------------------
// checkPermission integration: wrapper commands hit rule that would deny
// the underlying git command.
// ---------------------------------------------------------------------------

describe("wrapper command policy enforcement", () => {
  // Simulates the loop in the tool_call handler.
  function simulate(
    rawCommand: string,
    rules: ReturnType<typeof buildRules>
  ): { decision: "allow" | "deny" | "ask" | "fail-closed"; effective?: string } {
    const subcommands = splitChainedCommands(rawCommand);
    for (const sub of subcommands) {
      const u = unwrapCommand(sub.trim());
      if (u.failed) return { decision: "fail-closed" };
      const eff = u.command.trim();
      if (!eff || !/^\s*git\s/.test(eff)) continue;
      const perm = checkPermission(eff, rules);
      if (perm === null) return { decision: "deny", effective: eff };
      if (perm === "deny") return { decision: "deny", effective: eff };
      if (perm === "ask") return { decision: "ask", effective: eff };
    }
    return { decision: "allow" };
  }

  function buildRules(specs: Array<[string, string]>) {
    return specs.map(([action, pattern]) => ({
      action: action as "allow" | "deny" | "ask",
      pattern: new RegExp(pattern),
      rawPattern: pattern,
    }));
  }

  const rules = buildRules([
    ["deny", "^git\\s+push.*--force"],
    ["deny", "^git\\s+reset\\s+--hard"],
    ["allow", "^git\\s+(status|log|diff|push)"],
    ["allow", "^git\\s+rebase"],
    ["allow", "^git\\s+rm"],
    ["allow", "^git\\s+checkout"],
    ["allow", "^git\\s+pull"],
    ["allow", "^git\\s+commit"],
  ]);

  it("denies bash -c 'git push --force' when bare form would be denied", () => {
    expect(simulate("git push --force", rules).decision).toBe("deny");
    expect(simulate("bash -c 'git push --force'", rules).decision).toBe("deny");
    expect(simulate('bash -c "git push --force"', rules).decision).toBe("deny");
  });

  it("denies sh -c '<denied>'", () => {
    expect(simulate("sh -c 'git reset --hard'", rules).decision).toBe("deny");
  });

  it("denies env FOO=bar git push --force", () => {
    expect(simulate("env FOO=bar git push --force", rules).decision).toBe(
      "deny"
    );
  });

  it("xargs git rebase recursion works (allowed by rule)", () => {
    expect(simulate("xargs git rebase", rules).decision).toBe("allow");
  });

  it("xargs -n1 git push --force is denied", () => {
    expect(simulate("xargs -n1 git push --force", rules).decision).toBe("deny");
  });

  it("eval 'git reset --hard' is denied", () => {
    expect(simulate("eval 'git reset --hard'", rules).decision).toBe("deny");
  });

  it("bash -c with unbalanced quotes returns fail-closed", () => {
    expect(simulate("bash -c 'git push", rules).decision).toBe("fail-closed");
  });

  it("plain allowed git command still allowed via wrapper", () => {
    expect(simulate("bash -c 'git status'", rules).decision).toBe("allow");
  });

  it("non-git wrapper payload is ignored (e.g. echo)", () => {
    expect(simulate("bash -c 'echo hello'", rules).decision).toBe("allow");
  });

  it("chained: allowed && denied → deny", () => {
    expect(
      simulate("git status && bash -c 'git push --force'", rules).decision
    ).toBe("deny");
  });
});

// ---------------------------------------------------------------------------
// findGitPermissions filesystem walk
// ---------------------------------------------------------------------------

describe("findGitPermissions", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gp-test-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {}
  });

  it("returns null when cwd is outside homedir (no upward walk)", () => {
    // Place a poisoned .git-permissions at tmpRoot — must NOT be picked up
    // because tmpRoot is outside the simulated home.
    const poisoned = path.join(tmpRoot, ".git-permissions");
    fs.writeFileSync(poisoned, "allow ^git\\s+push\n");

    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "gp-home-"));
    try {
      // cwd is tmpRoot (outside fakeHome)
      const result = findGitPermissions(tmpRoot, fakeHome);
      expect(result).toBeNull();
    } finally {
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("does not walk above homedir", () => {
    // Layout:
    //   tmpRoot/                       <-- has .git-permissions (must be IGNORED)
    //   tmpRoot/home/                  <-- simulated $HOME
    //   tmpRoot/home/project/sub/      <-- cwd
    fs.writeFileSync(
      path.join(tmpRoot, ".git-permissions"),
      "allow .*\n" // would allow anything if found
    );
    const home = path.join(tmpRoot, "home");
    const cwd = path.join(home, "project", "sub");
    fs.mkdirSync(cwd, { recursive: true });

    const result = findGitPermissions(cwd, home);
    expect(result).toBeNull();
  });

  it("finds .git-permissions at homedir itself", () => {
    const home = path.join(tmpRoot, "home");
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(
      path.join(home, ".git-permissions"),
      "allow ^git\\s+status\n"
    );
    const cwd = path.join(home, "project");
    fs.mkdirSync(cwd, { recursive: true });

    const result = findGitPermissions(cwd, home);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(1);
    expect(result![0].action).toBe("allow");
  });

  it("finds nearest .git-permissions (deepest wins)", () => {
    const home = path.join(tmpRoot, "home");
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(
      path.join(home, ".git-permissions"),
      "allow ^git\\s+log\n"
    );
    const project = path.join(home, "project");
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(
      path.join(project, ".git-permissions"),
      "deny ^git\\s+push\n"
    );

    const result = findGitPermissions(project, home);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(1);
    expect(result![0].action).toBe("deny");
    expect(result![0].rawPattern).toBe("^git\\s+push");
  });

  it("refuses to use a symlink as .git-permissions", () => {
    const home = path.join(tmpRoot, "home");
    const project = path.join(home, "project");
    fs.mkdirSync(project, { recursive: true });

    // Real attacker-controlled file
    const evil = path.join(tmpRoot, "evil-permissions");
    fs.writeFileSync(evil, "allow .*\n");

    // Symlink at project/.git-permissions → evil file
    const link = path.join(project, ".git-permissions");
    fs.symlinkSync(evil, link);

    const result = findGitPermissions(project, home);
    // Symlink must be skipped → no permissions found in project, walk
    // continues up to home (which has nothing) → null.
    expect(result).toBeNull();
  });

  it("symlink at intermediate dir is skipped, walk continues", () => {
    const home = path.join(tmpRoot, "home");
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(
      path.join(home, ".git-permissions"),
      "allow ^git\\s+pull\n"
    );
    const project = path.join(home, "project");
    fs.mkdirSync(project, { recursive: true });
    // symlink at project/.git-permissions
    const evil = path.join(tmpRoot, "evil2");
    fs.writeFileSync(evil, "deny .*\n");
    fs.symlinkSync(evil, path.join(project, ".git-permissions"));

    const result = findGitPermissions(project, home);
    // Symlink in project skipped, walk continues to home, finds real file.
    expect(result).not.toBeNull();
    expect(result![0].rawPattern).toBe("^git\\s+pull");
  });

  it("logs invalid regex with file:line and continues", () => {
    const home = path.join(tmpRoot, "home");
    fs.mkdirSync(home, { recursive: true });
    const file = path.join(home, ".git-permissions");
    fs.writeFileSync(
      file,
      [
        "# comment",
        "allow ^git\\s+status",
        "deny [unclosed",
        "allow ^git\\s+log",
      ].join("\n") + "\n"
    );

    const errors: string[] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };
    try {
      const result = findGitPermissions(home, home);
      expect(result).not.toBeNull();
      expect(result!.length).toBe(2); // two valid rules survived
      expect(errors.length).toBe(1);
      expect(errors[0]).toMatch(/invalid pattern in .*\.git-permissions:3:/);
    } finally {
      console.error = orig;
    }
  });
});
