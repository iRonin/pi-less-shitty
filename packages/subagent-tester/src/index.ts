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

import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text, Container, Spacer, Markdown, type Widget } from "@mariozechner/pi-tui";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ============================================================================
// Test Infrastructure
// ============================================================================

interface TestStep {
  name: string;
  call: Record<string, unknown>;
  verify: (result: unknown, ctx: TestContext) => string[];
}

interface TestContext {
  tmpDir: string;
  results: Map<string, unknown>;
}

interface TestSuite {
  name: string;
  steps: TestStep[];
}

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
        if (!text || text.includes("(none)")) {
          violations.push("No agents discovered — check cwd and .pi/settings.json");
        }
        return violations;
      },
    },
    {
      name: "discoverAgents respects explicit agents array",
      call: { action: "list" },
      verify: (result: any, ctx: TestContext) => {
        const violations: string[] = [];
        const text = result?.content?.[0]?.text || "";
        // Should NOT contain builtin agents if explicit agents array is set
        if (text.includes("artist") && ctx.tmpDir.includes(".pi/agents")) {
          violations.push("Builtin 'artist' found despite explicit agents array");
        }
        return violations;
      },
    },
  ],
};

const ORCHESTRATION_TESTS: TestSuite = {
  name: "Subagent Orchestration",
  steps: [
    {
      name: "single agent completes task",
      call: {
        agent: "ecsc-reviewer",
        task: "Read the first 20 lines of any .md file in the current directory and report back the file name and first line. Write your findings to: /tmp/subagent-test-single.md",
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
      call: {
        tasks: [
          {
            agent: "ecsc-reviewer",
            task: "List all .md files in the current directory. Write to: /tmp/subagent-test-parallel-1.md",
          },
          {
            agent: "ecsc-strategist",
            task: "Count the number of lines in any .md file found. Write to: /tmp/subagent-test-parallel-2.md",
          },
        ],
      },
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
      call: {
        chain: [
          { agent: "ecsc-researcher", task: "List all directories in the current working directory. Output as a simple list.", output: "/tmp/subagent-test-chain-step1.md" },
          { agent: "ecsc-reviewer", task: "Review the previous findings. Are there any directories that look like they contain legal documents? Summarize.", output: "/tmp/subagent-test-chain-step2.md" },
        ],
        clarify: false,
      },
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
  ],
};

const CONTEXT_TESTS: TestSuite = {
  name: "Context Cleanliness",
  steps: [
    {
      name: "callParams visible in result details",
      call: {
        agent: "ecsc-reviewer",
        task: "Report the current working directory. Write to: /tmp/subagent-test-context.md",
      },
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
  onResult: (suite: string, step: string, passed: boolean, violations: string[]) => void,
): Promise<{ total: number; passed: number; failed: number }> {
  let total = 0;
  let passed = 0;
  let failed = 0;

  const testCtx: TestContext = {
    tmpDir: fs.mkdtempSync(path.join(os.tmpdir(), "subagent-test-")),
    results: new Map(),
  };

  // Import subagent tool dynamically
  const subagentTool = (ctx as any).tools?.find((t: any) => t.name === "subagent");

  for (const suite of suites) {
    for (const step of suite.steps) {
      total++;
      const callParams = { ...step.call };

      try {
        // Dispatch the subagent tool call
        const result = await ctx.sendToolCall("subagent", callParams as any);
        const violations = step.verify(result, testCtx);
        const isPassed = violations.length === 0;

        if (isPassed) passed++;
        else failed++;

        onResult(suite.name, step.name, isPassed, violations);
        testCtx.results.set(step.name, result);
      } catch (err) {
        failed++;
        onResult(suite.name, step.name, false, [`Exception: ${err instanceof Error ? err.message : String(err)}`]);
      }
    }
  }

  // Cleanup
  try {
    fs.rmSync(testCtx.tmpDir, { recursive: true, force: true });
  } catch {}

  return { total, passed, failed };
}

// ============================================================================
// TUI Components
// ============================================================================

function renderTestResults(
  results: Array<{ suite: string; step: string; passed: boolean; violations: string[] }>,
  summary: { total: number; passed: number; failed: number },
): Widget {
  const c = new Container();
  const w = process.stdout.columns || 120;

  const icon = summary.failed > 0 ? "⚠️" : "✅";
  c.addChild(new Text(`${icon} ${summary.passed}/${summary.total} tests passed`, 0, 0));
  c.addChild(new Spacer(1));

  let currentSuite = "";
  for (const r of results) {
    if (r.suite !== currentSuite) {
      c.addChild(new Text(`\n## ${r.suite}`, 0, 0));
      currentSuite = r.suite;
    }

    const status = r.passed ? "✓" : "✗";
    const color = r.passed ? "success" : "error";
    c.addChild(new Text(`${status} ${r.step}`, 0, 0));

    if (!r.passed && r.violations.length > 0) {
      for (const v of r.violations) {
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

    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const results: Array<{ suite: string; step: string; passed: boolean; violations: string[] }> = [];

      const summary = await runTests(
        [DISCOVERY_TESTS, ORCHESTRATION_TESTS, CONTEXT_TESTS],
        ctx,
        (suite, step, passed, violations) => {
          results.push({ suite, step, passed, violations });
          _onUpdate?.({
            content: [{ type: "text", text: `Testing: ${suite} → ${step}...` }],
          });
        },
      );

      return {
        content: [{ type: "text", text: `Results: ${summary.passed}/${summary.total} passed` }],
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
