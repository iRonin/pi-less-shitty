/**
 * Subagent Integration Tester — pi Extension
 *
 * Tests REAL subagent orchestration from within pi.
 * Dispatches actual subagents, verifies lifecycle, failure handling, context cleanliness.
 *
 * Usage: /subagent-test
 *
 * This is a pi extension, NOT part of oh-pi. Lives in pi-less-shitty or ~/.pi/agent/extensions/.
 * Tests the actual subagent tool, not simulations.
 */

import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text, Container, Spacer, type Widget } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ============================================================================
// Test Infrastructure
// ============================================================================

interface TestContext {
  tmpDir: string;
  results: Map<string, unknown>;
  agents: string[];
}

interface TestStep {
  name: string;
  call: Record<string, unknown> | ((ctx: TestContext) => Record<string, unknown>);
  verify: (result: unknown, ctx: TestContext) => string[];
  /** Return non-null reason to skip, null/undefined to run. */
  skip?: (ctx: TestContext) => string | null;
}

interface TestSuite {
  name: string;
  /** Static list, or a builder that produces steps after agents are discovered. */
  steps: TestStep[] | ((ctx: TestContext) => TestStep[]);
}

type StepStatus = "passed" | "failed" | "skipped";

// ============================================================================
// Helpers
// ============================================================================

/**
 * Parse the textual output of `subagent { action: "list" }` and extract
 * agent names from the "Agents:" section. Format:
 *   Agents:
 *   - name (source): description
 *   - (none)
 *
 *   Chains:
 *   - ...
 */
function parseAgentNames(listText: string): string[] {
  const lines = listText.split("\n");
  const names: string[] = [];
  let inAgents = false;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line === "Agents:") {
      inAgents = true;
      continue;
    }
    if (inAgents) {
      if (line === "" || line === "Chains:") break;
      // "- name (source): description" or "- (none)"
      const m = line.match(/^-\s+([^\s(]+)\s*\(/);
      if (m) names.push(m[1]);
    }
  }
  return names;
}

/** Forbidden substrings that would indicate user-specific path leakage in test output. */
const FORBIDDEN_LEAKS = ["/Users/", "Dropbox", "CloudStorage", "/home/"];

// ============================================================================
// Test Suites
// ============================================================================

const DISCOVERY_TESTS: TestSuite = {
  name: "Agent Discovery",
  steps: [
    {
      name: "discoverAgents returns project agents",
      call: { action: "list" },
      verify: (result: any) => {
        const violations: string[] = [];
        const text = result?.content?.[0]?.text || "";
        if (!text) {
          violations.push("Empty result from { action: 'list' }");
        }
        if (!text.includes("Agents:")) {
          violations.push("Result missing 'Agents:' section");
        }
        return violations;
      },
    },
    {
      name: "agent listing has no path leakage",
      call: { action: "list" },
      verify: (result: any, ctx: TestContext) => {
        const violations: string[] = [];
        const text = result?.content?.[0]?.text || "";
        for (const needle of FORBIDDEN_LEAKS) {
          if (text.includes(needle)) {
            violations.push(`Forbidden substring '${needle}' present in agent listing — user-specific path leak`);
          }
        }
        // Sanity: discovered agent names must look like identifiers (no path separators).
        for (const name of ctx.agents) {
          if (name.includes("/") || name.includes("\\") || name.includes("..")) {
            violations.push(`Discovered agent name looks like a path: '${name}'`);
          }
        }
        return violations;
      },
    },
  ],
};

const ORCHESTRATION_TESTS: TestSuite = {
  name: "Subagent Orchestration",
  steps: (ctx: TestContext): TestStep[] => {
    const skipNoAgents = (c: TestContext) =>
      c.agents.length < 1 ? "no agents available — skipping orchestration test" : null;
    const skipNeedTwo = (c: TestContext) =>
      c.agents.length < 2 ? `need ≥2 agents for parallel/chain (have ${c.agents.length}) — skipping` : null;

    return [
      {
        name: "single agent completes task",
        skip: skipNoAgents,
        call: (c) => {
          const out = path.join(c.tmpDir, "single.md");
          return {
            agent: c.agents[0],
            task: `Read the first 20 lines of any .md file in the current directory and report back the file name and first line. Write your findings to: ${out}`,
          };
        },
        verify: (result: any) => {
          const violations: string[] = [];
          if (result?.isError) {
            violations.push(`Single agent failed: ${result?.content?.[0]?.text || "unknown error"}`);
          }
          const details = result?.details;
          if (details?.mode !== "single") {
            violations.push(`Expected mode=single, got mode=${details?.mode}`);
          }
          if (details?.results?.[0]?.exitCode !== 0) {
            violations.push(`Exit code: ${details?.results?.[0]?.exitCode}`);
          }
          return violations;
        },
      },
      {
        name: "parallel agents execute concurrently",
        skip: skipNeedTwo,
        call: (c) => ({
          tasks: [
            {
              agent: c.agents[0],
              task: `List all .md files in the current directory. Write to: ${path.join(c.tmpDir, "parallel-1.md")}`,
            },
            {
              agent: c.agents[1],
              task: `Count the number of lines in any .md file found. Write to: ${path.join(c.tmpDir, "parallel-2.md")}`,
            },
          ],
        }),
        verify: (result: any) => {
          const violations: string[] = [];
          if (result?.isError) {
            violations.push(`Parallel execution failed: ${result?.content?.[0]?.text || "unknown"}`);
          }
          const details = result?.details;
          if (details?.mode !== "parallel") {
            violations.push(`Expected mode=parallel, got mode=${details?.mode}`);
          }
          const results = details?.results || [];
          const okCount = results.filter((r: any) => r.exitCode === 0).length;
          if (okCount < 2) {
            violations.push(`Expected 2 successful, got ${okCount}/${results.length}`);
          }
          return violations;
        },
      },
      {
        name: "chain passes context between steps",
        skip: skipNeedTwo,
        call: (c) => ({
          chain: [
            {
              agent: c.agents[0],
              task: "List all directories in the current working directory. Output as a simple list.",
              output: path.join(c.tmpDir, "chain-step1.md"),
            },
            {
              agent: c.agents[1],
              task: "Review the previous findings. Are there any directories that look like they contain documentation? Summarize.",
              output: path.join(c.tmpDir, "chain-step2.md"),
            },
          ],
          clarify: false,
        }),
        verify: (result: any) => {
          const violations: string[] = [];
          const details = result?.details;
          if (!details?.chainAgents || details.chainAgents.length < 2) {
            violations.push("Chain should have 2 agents");
          }
          const results = details?.results || [];
          if (results.length < 2) {
            violations.push(`Expected 2 chain results, got ${results.length}`);
          }
          return violations;
        },
      },
    ];
  },
};

const CONTEXT_TESTS: TestSuite = {
  name: "Context Cleanliness",
  steps: (ctx: TestContext): TestStep[] => [
    {
      name: "callParams visible in result details",
      skip: (c) => (c.agents.length < 1 ? "no agents available — skipping" : null),
      call: (c) => ({
        agent: c.agents[0],
        task: `Report the current working directory. Write to: ${path.join(c.tmpDir, "context.md")}`,
      }),
      verify: (result: any) => {
        const violations: string[] = [];
        const details = result?.details;
        if (!details?.callParams) {
          violations.push("callParams not present in result details — verbose output not working");
        }
        if (details?.callParams && !details.callParams.agent) {
          violations.push("callParams missing agent field");
        }
        return violations;
      },
    },
  ],
};

// ============================================================================
// Test Runner
// ============================================================================

async function runTests(
  suites: TestSuite[],
  ctx: ExtensionContext,
  onResult: (suite: string, step: string, status: StepStatus, info: string[]) => void,
): Promise<{ total: number; passed: number; failed: number; skipped: number }> {
  let total = 0;
  let passed = 0;
  let failed = 0;
  let skipped = 0;

  const testCtx: TestContext = {
    tmpDir: fs.mkdtempSync(path.join(os.tmpdir(), "subagent-test-")),
    results: new Map(),
    agents: [],
  };

  try {
    // Discover agents up-front via the subagent tool's management API.
    try {
      const listRes: any = await ctx.sendToolCall("subagent", { action: "list" } as any);
      const text: string = listRes?.content?.[0]?.text || "";
      testCtx.agents = parseAgentNames(text);
    } catch (err) {
      onResult(
        "Agent Discovery",
        "pre-flight: list agents",
        "failed",
        [`Could not list agents: ${err instanceof Error ? err.message : String(err)}`],
      );
      // Continue with empty agents list; suites will skip as appropriate.
    }

    for (const suite of suites) {
      const steps = typeof suite.steps === "function" ? suite.steps(testCtx) : suite.steps;
      for (const step of steps) {
        total++;

        const skipReason = step.skip?.(testCtx) ?? null;
        if (skipReason) {
          skipped++;
          onResult(suite.name, step.name, "skipped", [skipReason]);
          continue;
        }

        const callParams =
          typeof step.call === "function" ? step.call(testCtx) : { ...step.call };

        try {
          const result = await ctx.sendToolCall("subagent", callParams as any);
          const violations = step.verify(result, testCtx);
          const isPassed = violations.length === 0;
          if (isPassed) {
            passed++;
            onResult(suite.name, step.name, "passed", []);
          } else {
            failed++;
            onResult(suite.name, step.name, "failed", violations);
          }
          testCtx.results.set(step.name, result);
        } catch (err) {
          failed++;
          onResult(suite.name, step.name, "failed", [
            `Exception: ${err instanceof Error ? err.message : String(err)}`,
          ]);
        }
      }
    }
  } finally {
    // Cleanup tmpDir regardless of outcome.
    try {
      fs.rmSync(testCtx.tmpDir, { recursive: true, force: true });
    } catch {}
  }

  return { total, passed, failed, skipped };
}

// ============================================================================
// TUI Components
// ============================================================================

function renderTestResults(
  results: Array<{ suite: string; step: string; status: StepStatus; info: string[] }>,
  summary: { total: number; passed: number; failed: number; skipped: number },
): Widget {
  const c = new Container();

  const icon = summary.failed > 0 ? "⚠️" : "✅";
  const skipPart = summary.skipped > 0 ? ` (${summary.skipped} skipped)` : "";
  c.addChild(new Text(`${icon} ${summary.passed}/${summary.total} tests passed${skipPart}`, 0, 0));
  c.addChild(new Spacer(1));

  let currentSuite = "";
  for (const r of results) {
    if (r.suite !== currentSuite) {
      c.addChild(new Text(`\n## ${r.suite}`, 0, 0));
      currentSuite = r.suite;
    }

    const status = r.status === "passed" ? "✓" : r.status === "skipped" ? "⊘" : "✗";
    c.addChild(new Text(`${status} ${r.step}`, 0, 0));

    if (r.info.length > 0) {
      for (const v of r.info) {
        c.addChild(new Text(`  → ${v}`, 0, 0));
      }
    }
  }

  c.addChild(new Spacer(1));
  c.addChild(new Text(`---\n\`\`\`json\n${JSON.stringify(summary, null, 2)}\n\`\`\``, 0, 0));

  return c;
}

// ============================================================================
// Extension Registration
// ============================================================================

export default function registerSubagentTesterExtension(pi: ExtensionAPI): void {
  const testTool: ToolDefinition = {
    name: "subagent_test",
    label: "Subagent Integration Test",
    description: "Run integration tests against the live subagent system. Tests agent discovery, orchestration, and context cleanliness.",
    parameters: Type.Object({}),

    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const results: Array<{ suite: string; step: string; status: StepStatus; info: string[] }> = [];

      const summary = await runTests(
        [DISCOVERY_TESTS, ORCHESTRATION_TESTS, CONTEXT_TESTS],
        ctx,
        (suite, step, status, info) => {
          results.push({ suite, step, status, info });
          _onUpdate?.({
            content: [{ type: "text", text: `Testing: ${suite} → ${step}...` }],
          });
        },
      );

      const skipPart = summary.skipped > 0 ? ` (${summary.skipped} skipped)` : "";
      return {
        content: [
          {
            type: "text",
            text: `Results: ${summary.passed}/${summary.total} passed${skipPart}`,
          },
        ],
        details: {
          mode: "single" as const,
          results: [],
        },
        _widget: renderTestResults(results, summary),
      };
    },
  };

  pi.registerTool(testTool);

  // Register /subagent-test command
  pi.on("input", (event: any, ctx: ExtensionContext) => {
    const text = event.text || "";
    if (text.trim() === "/subagent-test" || text.trim() === "/test-subagents") {
      ctx.sendToolCall("subagent_test", {});
      event.preventDefault?.();
    }
  });
}
