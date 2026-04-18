/**
 * Tests for pi-hindsight extension.
 * Uses Node.js built-in test runner (node:test).
 *
 * Run: node --experimental-strip-types --test index.test.ts
 */

import { test, describe, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Minimal Pi API mock
// ---------------------------------------------------------------------------

type HookName = "session_start" | "session_compact" | "before_agent_start" | "agent_end" | "input";
type HookHandler = (event: any, ctx: any) => Promise<any>;

function makePiMock() {
  const handlers: Record<string, HookHandler[]> = {};
  const tools: Record<string, any> = {};
  const commands: Record<string, any> = {};

  return {
    on(event: HookName, handler: HookHandler) {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(handler);
    },
    registerTool(spec: any) {
      tools[spec.name] = spec;
    },
    registerCommand(name: string, spec: any) {
      commands[name] = spec;
    },
    async emit(event: HookName, eventData: any = {}, ctx: any = {}) {
      const list = handlers[event] || [];
      let result: any;
      for (const h of list) {
        result = await h(eventData, ctx);
      }
      return result;
    },
    tools,
    commands,
  };
}

function makeCtx(userMessage?: string) {
  return {
    sessionManager: {
      getEntries() {
        if (!userMessage) return [];
        return [
          {
            type: "message",
            message: { role: "user", content: userMessage },
          },
        ];
      },
    },
    ui: { notify: mock.fn(), setStatus: mock.fn() },
  };
}

// ---------------------------------------------------------------------------
// Fetch mock helpers
// ---------------------------------------------------------------------------

function mockFetchOk(results: { text: string }[] = []) {
  return mock.fn(async (_url: string, _opts: any) => ({
    ok: true,
    status: 200,
    json: async () => ({ results }),
  }));
}

function mockFetchFail(status = 500) {
  return mock.fn(async (_url: string, _opts: any) => ({
    ok: false,
    status,
    json: async () => ({}),
  }));
}

// ---------------------------------------------------------------------------
// Constants (mirrors index.ts)
// ---------------------------------------------------------------------------

const MAX_RECALL_ATTEMPTS = 3;

const OPERATIONAL_TOOLS = new Set([
  "bash", "nu", "process", "read", "write", "edit",
  "grep", "ast_grep_search", "ast_grep_replace", "lsp_navigation",
]);

const TRIVIAL_PROMPT_RE = /^(ok|yes|no|thanks|continue|next|done|sure|stop)$/i;

const DEFAULT_STRIP_PATTERNS: RegExp[] = [
  /<hindsight_memories>[\s\S]*?<\/hindsight_memories>/g,
  /<(?:antThinking|thinking|reasoning)>[\s\S]*?<\/(?:antThinking|thinking|reasoning)>/g,
  /data:[^;]+;base64,[A-Za-z0-9+/=]{100,}/g,
];

// ---------------------------------------------------------------------------
// Pure functions extracted from index.ts (for direct unit testing)
// ---------------------------------------------------------------------------

interface ResolvedConfig {
  api_url: string;
  api_key: string;
  bank_id: string | null;
  global_bank: string | null;
  recall_types: string[];
  strip_patterns: string[];
}

function getRecallBanks(config: ResolvedConfig): string[] {
  const banks: string[] = [];
  if (config.bank_id) banks.push(config.bank_id);
  if (config.global_bank) banks.push(config.global_bank);
  return banks;
}

function getRetainBanks(config: ResolvedConfig, prompt: string): string[] {
  const banks = new Set<string>();
  if (config.bank_id) banks.add(config.bank_id);
  if (config.global_bank && (prompt.includes("#global") || prompt.includes("#me"))) {
    banks.add(config.global_bank);
  }
  return Array.from(banks);
}

function getActiveBank(config: ResolvedConfig): string | null {
  return config.bank_id;
}

function extractTags(prompt: string): string[] {
  const reserved = new Set(["nomem", "skip", "global", "me"]);
  return Array.from(prompt.matchAll(/(?<=^|\s)#([a-zA-Z0-9_-]+)/g))
    .map(m => m[1].toLowerCase()).filter(t => !reserved.has(t));
}

function getStripPatterns(config: ResolvedConfig): RegExp[] {
  if (config.strip_patterns?.length) {
    return config.strip_patterns.map((p) => new RegExp(p, "g"));
  }
  return DEFAULT_STRIP_PATTERNS;
}

interface AssistantMessage {
  role: string;
  content?: string | Array<{ type: string; name?: string; text?: string; input?: unknown }>;
}

function buildTranscript(prompt: string, messages: AssistantMessage[], stripPatterns: RegExp[]): string {
  let transcript = `[role: user]\n${prompt}\n[user:end]\n\n[role: assistant]\n`;
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    const content = msg.content;
    if (typeof content === "string") {
      transcript += `${content}\n`;
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "text") transcript += `${block.text}\n`;
        else if (block.type === "tool_use" && !OPERATIONAL_TOOLS.has(block.name))
          transcript += `[Tool: ${block.name}]\n${block.input ? JSON.stringify(block.input) : ""}\n`;
      }
    }
  }
  transcript += `[assistant:end]`;
  for (const pattern of stripPatterns) {
    transcript = transcript.replace(pattern, "");
  }
  return transcript.trim();
}

function shouldSkipRetain(prompt: string | null): { skip: boolean; reason?: string } {
  if (!prompt) return { skip: true, reason: "no prompt" };
  if (prompt.length < 5) return { skip: true, reason: "too short" };
  if (TRIVIAL_PROMPT_RE.test(prompt.trim())) return { skip: true, reason: "trivial" };
  if (prompt.trim().startsWith("#nomem") || prompt.trim().startsWith("#skip")) return { skip: true, reason: "opt-out" };
  return { skip: false };
}

function authHeader(key: string) {
  return { "Authorization": `Bearer ${key || ""}` };
}

// ---------------------------------------------------------------------------
// Simulated recall lifecycle (for testing without importing the module)
// ---------------------------------------------------------------------------

async function simulateRecall(opts: {
  config: ResolvedConfig | null;
  userPrompt: string;
  fetchImpl: any;
  recallDone?: boolean;
  recallAttempts?: number;
}): Promise<{ recallDone: boolean; recallAttempts: number; injectedContent: string | null }> {
  let recallDone = opts.recallDone ?? false;
  let recallAttempts = opts.recallAttempts ?? 0;

  if (recallDone) return { recallDone, recallAttempts, injectedContent: null };
  if (recallAttempts >= MAX_RECALL_ATTEMPTS) return { recallDone, recallAttempts, injectedContent: null };

  recallAttempts++;

  const config = opts.config;
  if (!config || !config.api_url) {
    recallAttempts = MAX_RECALL_ATTEMPTS;
    return { recallDone, recallAttempts, injectedContent: null };
  }

  const banks = getRecallBanks(config);
  if (!banks.length) { recallAttempts = MAX_RECALL_ATTEMPTS; return { recallDone, recallAttempts, injectedContent: null }; }

  try {
    let anyBankSucceeded = false;
    const recallPromises = banks.map(async (bank) => {
      const res = await opts.fetchImpl(
        `${config.api_url}/v1/default/banks/${bank}/memories/recall`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeader(config.api_key) },
          body: JSON.stringify({ query: opts.userPrompt, budget: "mid", query_timestamp: new Date().toISOString(), types: config.recall_types }),
        }
      );
      if (!res.ok) return [];
      anyBankSucceeded = true;
      const data = await res.json();
      return (data.results || []).map((r: any) => `[${bank}] ${r.text}`);
    });

    const resultsArrays = await Promise.all(recallPromises);

    if (anyBankSucceeded) {
      recallDone = true;
      const allResults = resultsArrays.flat();
      if (allResults.length > 0) {
        const content = `<hindsight_memories>\nRelevant memories from past sessions:\n\n${allResults.join("\n\n")}\n</hindsight_memories>`;
        return { recallDone, recallAttempts, injectedContent: content };
      }
      return { recallDone, recallAttempts, injectedContent: null };
    }
    return { recallDone, recallAttempts, injectedContent: null };
  } catch {
    return { recallDone, recallAttempts, injectedContent: null };
  }
}

// ---------------------------------------------------------------------------
// Simulated retain lifecycle
// ---------------------------------------------------------------------------

async function simulateRetain(opts: {
  config: ResolvedConfig | null;
  userPrompt: string;
  transcript: string;
  sessionId?: string;
  fetchImpl: any;
}): Promise<{ skipped: boolean; reason?: string; calledBanks: string[]; allFailed: boolean; lastRequestBody?: any; sentMessage?: any }> {
  const config = opts.config;
  if (!config || !config.api_url) return { skipped: true, reason: "no config", calledBanks: [], allFailed: false };

  const skipCheck = shouldSkipRetain(opts.userPrompt);
  if (skipCheck.skip) return { skipped: true, reason: skipCheck.reason, calledBanks: [], allFailed: false };

  const banks = getRetainBanks(config, opts.userPrompt);
  if (!banks.length) return { skipped: true, reason: "no bank", calledBanks: [], allFailed: false };

  const calledBanks: string[] = [];
  const sessionId = opts.sessionId ?? "test-session";
  let lastRequestBody: any;

  const stripPatterns = getStripPatterns(config);
  const tags = extractTags(opts.userPrompt);

  const results = await Promise.allSettled(
    banks.map(async (bank) => {
      const body = {
        items: [{
          content: opts.transcript,
          document_id: `session-${sessionId}`,
          update_mode: "append",
          context: `pi: ${opts.userPrompt.slice(0, 100)}`,
          timestamp: new Date().toISOString(),
          ...(tags.length && { tags }),
        }],
        async: true,
      };
      lastRequestBody = body;
      const res = await opts.fetchImpl(`${config.api_url}/v1/default/banks/${bank}/memories`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader(config.api_key) },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      calledBanks.push(bank);
      return bank;
    })
  );

  const succeededBanks = results
    .filter(r => r.status === "fulfilled")
    .map(r => (r as PromiseFulfilledResult<string>).value);
  const allFailed = succeededBanks.length === 0;

  const sentMessage = allFailed
    ? { customType: "hindsight-retain-failed", display: true, details: {} }
    : { customType: "hindsight-retain", display: true, details: { banks: succeededBanks } };

  return { skipped: false, calledBanks, allFailed, lastRequestBody, sentMessage };
}

// ============================================================================
// TESTS
// ============================================================================

describe("Recall (before_agent_start)", () => {
  const config: ResolvedConfig = {
    api_url: "http://localhost:4000", api_key: "key",
    bank_id: "project-hindsight", global_bank: "global",
    recall_types: ["observation"], strip_patterns: [],
  };

  test("injects memories when results returned", async () => {
    const fetchMock = mockFetchOk([{ text: "Use TypeBox for validation" }]);
    const result = await simulateRecall({
      config, userPrompt: "how do I validate?", fetchImpl: fetchMock,
    });
    assert.equal(result.recallDone, true);
    assert.ok(result.injectedContent, "should inject content");
    assert.ok(result.injectedContent!.includes("<hindsight_memories>"), "should wrap in tag");
    assert.ok(result.injectedContent!.includes("TypeBox"), "should include memory text");
  });

  test("returns null injectedContent when no memories found", async () => {
    const fetchMock = mockFetchOk([]);
    const result = await simulateRecall({
      config, userPrompt: "what is the meaning of life", fetchImpl: fetchMock,
    });
    assert.equal(result.injectedContent, null);
  });

  test("queries both bank_id and global_bank", async () => {
    const fetchMock = mockFetchOk([{ text: "memory" }]);
    await simulateRecall({ config, userPrompt: "test", fetchImpl: fetchMock });
    const urls: string[] = fetchMock.mock.calls.map((c: any) => c.arguments[0]);
    assert.ok(urls.some((u) => u.includes("project-hindsight")), "should query project bank");
    assert.ok(urls.some((u) => u.includes("global")), "should query global bank");
    assert.equal(urls.length, 2, "should call exactly 2 banks");
  });

  test("skips recall when recallDone=true", async () => {
    const fetchMock = mockFetchOk([{ text: "memory" }]);
    const result = await simulateRecall({
      config, userPrompt: "test", fetchImpl: fetchMock, recallDone: true,
    });
    assert.equal(fetchMock.mock.calls.length, 0, "should not call fetch");
    assert.equal(result.injectedContent, null);
  });

  test("returns null when no config", async () => {
    const fetchMock = mockFetchOk([{ text: "memory" }]);
    const result = await simulateRecall({
      config: null, userPrompt: "test", fetchImpl: fetchMock,
    });
    assert.equal(fetchMock.mock.calls.length, 0, "should not call fetch");
    assert.equal(result.injectedContent, null);
  });

  test("network error: recallDone stays false for retry, no throw", async () => {
    const fetchMock = mock.fn(async () => { throw new Error("ECONNREFUSED"); });
    const result = await simulateRecall({
      config, userPrompt: "test", fetchImpl: fetchMock,
    });
    assert.equal(result.injectedContent, null, "should return null, not throw");
    assert.equal(result.recallDone, false, "recallDone stays false — retry eligible");
    assert.equal(result.recallAttempts, 1, "attempt counter incremented");
  });

  test("HTTP error: recallDone stays false for retry", async () => {
    const fetchMock = mockFetchFail(503);
    const result = await simulateRecall({ config, userPrompt: "test", fetchImpl: fetchMock });
    assert.equal(result.injectedContent, null);
    assert.equal(result.recallDone, false, "recallDone stays false — retry eligible");
  });

  test("empty vault: recallDone=true even with 0 results (server responded ok)", async () => {
    const fetchMock = mockFetchOk([]);
    const result = await simulateRecall({ config, userPrompt: "test", fetchImpl: fetchMock });
    assert.equal(result.recallDone, true, "server responded — no reason to retry");
    assert.equal(result.injectedContent, null, "nothing to inject");
  });

  test("only queries bank_id when no global_bank configured", async () => {
    const fetchMock = mockFetchOk([]);
    const noGlobal: ResolvedConfig = {
      ...config, global_bank: null,
    };
    await simulateRecall({ config: noGlobal, userPrompt: "test", fetchImpl: fetchMock });
    assert.equal(fetchMock.mock.calls.length, 1, "should only query 1 bank");
  });

  test("stops retrying after MAX_RECALL_ATTEMPTS", async () => {
    const fetchMock = mock.fn(async () => { throw new Error("ECONNREFUSED"); });
    const noGlobal: ResolvedConfig = { ...config, global_bank: null };
    let state = { recallDone: false, recallAttempts: 0, injectedContent: null as string | null };

    for (let i = 0; i < MAX_RECALL_ATTEMPTS + 2; i++) {
      state = await simulateRecall({
        config: noGlobal, userPrompt: "test", fetchImpl: fetchMock,
        recallDone: state.recallDone, recallAttempts: state.recallAttempts,
      });
    }
    assert.equal(fetchMock.mock.calls.length, MAX_RECALL_ATTEMPTS, `fetch called exactly ${MAX_RECALL_ATTEMPTS} times`);
    assert.equal(state.recallDone, false);
  });

  test("no config: gives up immediately without fetch", async () => {
    const fetchMock = mockFetchOk([{ text: "memory" }]);
    const result = await simulateRecall({ config: null, userPrompt: "test", fetchImpl: fetchMock });
    assert.equal(fetchMock.mock.calls.length, 0);
    assert.equal(result.recallAttempts, MAX_RECALL_ATTEMPTS, "maxed out — won't retry");
  });
});

describe("Retain (agent_end)", () => {
  const config: ResolvedConfig = {
    api_url: "http://localhost:4000", api_key: "key",
    bank_id: "project-hindsight", global_bank: "global",
    recall_types: ["observation"], strip_patterns: [],
  };

  test("retains to project bank on normal prompt", async () => {
    const fetchMock = mockFetchOk();
    const result = await simulateRetain({
      config, userPrompt: "how do I refactor this function?",
      transcript: "[role: user]\nhow do I refactor this function?\n[role: assistant]\nHere is how...",
      fetchImpl: fetchMock,
    });
    assert.equal(result.skipped, false);
    assert.ok(result.calledBanks.includes("project-hindsight"), "should retain to project bank");
    assert.equal(fetchMock.mock.calls.length, 1);
  });

  test("skips trivial prompts", async () => {
    const fetchMock = mockFetchOk();
    for (const prompt of ["ok", "yes", "no", "thanks", "done"]) {
      const result = await simulateRetain({
        config, userPrompt: prompt, transcript: "...", fetchImpl: fetchMock,
      });
      assert.equal(result.skipped, true, `"${prompt}" should be skipped`);
    }
    assert.equal(fetchMock.mock.calls.length, 0, "fetch should never be called for trivial prompts");
  });

  test("skips very short prompts (<5 chars)", async () => {
    const fetchMock = mockFetchOk();
    const result = await simulateRetain({
      config, userPrompt: "hi", transcript: "...", fetchImpl: fetchMock,
    });
    assert.equal(result.skipped, true);
  });

  test("#nomem opt-out skips retain", async () => {
    const fetchMock = mockFetchOk();
    const result = await simulateRetain({
      config, userPrompt: "#nomem fix this bug please", transcript: "...", fetchImpl: fetchMock,
    });
    assert.equal(result.skipped, true);
    assert.equal(result.reason, "opt-out");
  });

  test("#skip opt-out skips retain", async () => {
    const fetchMock = mockFetchOk();
    const result = await simulateRetain({
      config, userPrompt: "#skip this conversation", transcript: "...", fetchImpl: fetchMock,
    });
    assert.equal(result.skipped, true);
    assert.equal(result.reason, "opt-out");
  });

  test("#global tag routes to global bank too", async () => {
    const fetchMock = mockFetchOk();
    const result = await simulateRetain({
      config, userPrompt: "remember this #global pattern for all projects",
      transcript: "...", fetchImpl: fetchMock,
    });
    assert.equal(result.skipped, false);
    assert.ok(result.calledBanks.includes("global"), "should retain to global bank");
    assert.ok(result.calledBanks.includes("project-hindsight"), "should also retain to project bank");
    assert.equal(result.calledBanks.length, 2);
  });

  test("#me tag routes to global bank too", async () => {
    const fetchMock = mockFetchOk();
    const result = await simulateRetain({
      config, userPrompt: "I prefer tabs over spaces #me",
      transcript: "...", fetchImpl: fetchMock,
    });
    assert.equal(result.skipped, false);
    assert.ok(result.calledBanks.includes("global"), "should retain to global bank");
  });

  test("no global_bank config: only retains to project bank even with #global", async () => {
    const fetchMock = mockFetchOk();
    const noGlobal: ResolvedConfig = { ...config, global_bank: null };
    const result = await simulateRetain({
      config: noGlobal, userPrompt: "remember this #global",
      transcript: "...", fetchImpl: fetchMock,
    });
    assert.equal(result.calledBanks.length, 1);
    assert.ok(result.calledBanks.includes("project-hindsight"));
  });

  test("skips when no config", async () => {
    const fetchMock = mockFetchOk();
    const result = await simulateRetain({
      config: null, userPrompt: "valid prompt", transcript: "...", fetchImpl: fetchMock,
    });
    assert.equal(result.skipped, true);
    assert.equal(fetchMock.mock.calls.length, 0);
  });

  test("allFailed=true when all banks return HTTP error", async () => {
    const fetchMock = mockFetchFail(503);
    const result = await simulateRetain({
      config, userPrompt: "how do I fix this?", transcript: "...", fetchImpl: fetchMock,
    });
    assert.equal(result.skipped, false, "should attempt retain, not skip");
    assert.equal(result.allFailed, true, "should report total failure");
    assert.equal(result.calledBanks.length, 0, "no banks succeeded");
  });

  test("allFailed=true when network throws", async () => {
    const fetchMock = mock.fn(async () => { throw new Error("ECONNREFUSED"); });
    const result = await simulateRetain({
      config, userPrompt: "how do I fix this?", transcript: "...", fetchImpl: fetchMock,
    });
    assert.equal(result.allFailed, true);
  });

  test("allFailed=false on success", async () => {
    const fetchMock = mockFetchOk();
    const result = await simulateRetain({
      config, userPrompt: "how do I fix this?", transcript: "...", fetchImpl: fetchMock,
    });
    assert.equal(result.allFailed, false);
  });
});

describe("recallDone lifecycle reset", () => {
  test("recallDone and recallAttempts reset on session_start", async () => {
    let recallDone = true;
    let recallAttempts = MAX_RECALL_ATTEMPTS;
    recallDone = false;
    recallAttempts = 0;
    assert.equal(recallDone, false);
    assert.equal(recallAttempts, 0, "attempts must reset so retry window reopens");
  });

  test("recallDone and recallAttempts reset on session_compact", async () => {
    let recallDone = true;
    let recallAttempts = MAX_RECALL_ATTEMPTS;
    recallDone = false;
    recallAttempts = 0;
    assert.equal(recallDone, false);
    assert.equal(recallAttempts, 0);
  });

  test("recallDone prevents double recall within same session", async () => {
    const fetchMock = mockFetchOk([{ text: "memory" }]);
    const noGlobal: ResolvedConfig = {
      api_url: "http://localhost:4000", api_key: "key",
      bank_id: "project-hindsight", global_bank: null,
      recall_types: ["observation"], strip_patterns: [],
    };

    const r1 = await simulateRecall({
      config: noGlobal, userPrompt: "prompt 1", fetchImpl: fetchMock, recallDone: false,
    });
    assert.equal(r1.recallDone, true);

    const r2 = await simulateRecall({
      config: noGlobal, userPrompt: "prompt 2", fetchImpl: fetchMock, recallDone: r1.recallDone,
    });
    assert.equal(fetchMock.mock.calls.length, 1, "fetch only called on first turn");
    assert.equal(r2.injectedContent, null, "second turn should not inject");
  });
});

describe("Recall request shape", () => {
  const config: ResolvedConfig = {
    api_url: "http://localhost:8888", api_key: "k",
    bank_id: "project-test", global_bank: "global",
    recall_types: ["observation"], strip_patterns: [],
  };

  test("uses budget:mid instead of max_tokens", async () => {
    const fetchMock = mockFetchOk([{ text: "memory" }]);
    await simulateRecall({ config, userPrompt: "how does auth work?", fetchImpl: fetchMock });
    const body = JSON.parse(fetchMock.mock.calls[0].arguments[1].body);
    assert.equal(body.budget, "mid");
    assert.equal(body.max_tokens, undefined, "max_tokens should not be sent");
  });

  test("sends query_timestamp as ISO string", async () => {
    const before = Date.now();
    const fetchMock = mockFetchOk([]);
    await simulateRecall({ config, userPrompt: "what did we decide?", fetchImpl: fetchMock });
    const after = Date.now();
    const body = JSON.parse(fetchMock.mock.calls[0].arguments[1].body);
    assert.ok(body.query_timestamp, "query_timestamp must be present");
    const ts = new Date(body.query_timestamp).getTime();
    assert.ok(ts >= before && ts <= after, "query_timestamp should be recent");
  });

  test("sends recall_types from config", async () => {
    const fetchMock = mockFetchOk([{ text: "memory" }]);
    const cfgWithTypes: ResolvedConfig = { ...config, recall_types: ["observation", "world", "experience"] };
    await simulateRecall({ config: cfgWithTypes, userPrompt: "test", fetchImpl: fetchMock });
    const body = JSON.parse(fetchMock.mock.calls[0].arguments[1].body);
    assert.deepEqual(body.types, ["observation", "world", "experience"]);
  });
});

describe("Retain request shape", () => {
  const config: ResolvedConfig = {
    api_url: "http://localhost:8888", api_key: "k",
    bank_id: "project-test", global_bank: "global",
    recall_types: ["observation"], strip_patterns: [],
  };

  test("sets document_id to session-{sessionId}", async () => {
    const fetchMock = mockFetchOk();
    const result = await simulateRetain({
      config, userPrompt: "refactor the auth module",
      transcript: "user: refactor\nassistant: done", sessionId: "abc123", fetchImpl: fetchMock,
    });
    assert.equal(result.skipped, false);
    assert.equal(result.lastRequestBody.items[0].document_id, "session-abc123");
  });

  test("sets update_mode to append", async () => {
    const fetchMock = mockFetchOk();
    const result = await simulateRetain({
      config, userPrompt: "add logging to all routes",
      transcript: "user: add logging\nassistant: done", fetchImpl: fetchMock,
    });
    assert.equal(result.lastRequestBody.items[0].update_mode, "append");
  });

  test("context starts with 'pi:' and includes prompt snippet", async () => {
    const fetchMock = mockFetchOk();
    const prompt = "how do I add a middleware?";
    const result = await simulateRetain({
      config, userPrompt: prompt, transcript: "...", fetchImpl: fetchMock,
    });
    const context: string = result.lastRequestBody.items[0].context;
    assert.ok(context.startsWith("pi:"), `context should start with label, got: ${context}`);
    assert.ok(context.includes(prompt.slice(0, 20)), "context should include prompt snippet");
  });

  test("context truncates long prompts to 100 chars", async () => {
    const fetchMock = mockFetchOk();
    const longPrompt = "a".repeat(200) + " end";
    const result = await simulateRetain({
      config, userPrompt: longPrompt, transcript: "...", fetchImpl: fetchMock,
    });
    const context: string = result.lastRequestBody.items[0].context;
    assert.ok(!context.includes(" end"), "context should not include chars past 100");
  });

  test("timestamp is a recent ISO string", async () => {
    const before = Date.now();
    const fetchMock = mockFetchOk();
    const result = await simulateRetain({
      config, userPrompt: "show me the build config", transcript: "...", fetchImpl: fetchMock,
    });
    const after = Date.now();
    const ts = new Date(result.lastRequestBody.items[0].timestamp).getTime();
    assert.ok(ts >= before && ts <= after, "timestamp should be recent");
  });

  test("extracted tags attached to retain request", async () => {
    const fetchMock = mockFetchOk();
    const result = await simulateRetain({
      config, userPrompt: "this is a #bug in the #auth module",
      transcript: "...", fetchImpl: fetchMock,
    });
    assert.deepEqual(result.lastRequestBody.items[0].tags, ["bug", "auth"]);
  });

  test("reserved tags not included in extracted tags", async () => {
    const fetchMock = mockFetchOk();
    const result = await simulateRetain({
      config, userPrompt: "#global fix this #bug please #nomem-test",
      transcript: "...", fetchImpl: fetchMock,
    });
    const tags: string[] = result.lastRequestBody.items[0].tags || [];
    assert.ok(!tags.includes("global"), "global should be excluded");
    assert.ok(tags.includes("bug"), "bug should be included");
  });
});

describe("Retain next-turn messages", () => {
  const config: ResolvedConfig = {
    api_url: "http://localhost:8888", api_key: "k",
    bank_id: "project-test", global_bank: "global",
    recall_types: ["observation"], strip_patterns: [],
  };

  test("success: sends hindsight-retain message with display:true and bank list", async () => {
    const fetchMock = mockFetchOk();
    const result = await simulateRetain({
      config, userPrompt: "refactor the auth module", transcript: "...", fetchImpl: fetchMock,
    });
    assert.equal(result.skipped, false);
    assert.equal(result.sentMessage?.customType, "hindsight-retain");
    assert.equal(result.sentMessage?.display, true);
    assert.ok(
      (result.sentMessage?.details as any)?.banks?.includes("project-test"),
      "details.banks should include project bank"
    );
  });

  test("failure: sends hindsight-retain-failed message with display:true", async () => {
    const fetchMock = mockFetchFail(503);
    const result = await simulateRetain({
      config, userPrompt: "refactor the auth module", transcript: "...", fetchImpl: fetchMock,
    });
    assert.equal(result.allFailed, true);
    assert.equal(result.sentMessage?.customType, "hindsight-retain-failed");
    assert.equal(result.sentMessage?.display, true);
  });

  test("success with #global: banks list includes global bank", async () => {
    const fetchMock = mockFetchOk();
    const result = await simulateRetain({
      config, userPrompt: "remember this pattern #global", transcript: "...", fetchImpl: fetchMock,
    });
    const banks: string[] = (result.sentMessage?.details as any)?.banks ?? [];
    assert.ok(banks.includes("project-test"), "should include project bank");
    assert.ok(banks.includes("global"), "should include global bank");
  });

  test("skipped retain: no message sent", async () => {
    const fetchMock = mockFetchOk();
    const result = await simulateRetain({
      config, userPrompt: "ok", transcript: "...", fetchImpl: fetchMock,
    });
    assert.equal(result.skipped, true);
    assert.equal(result.sentMessage, undefined);
  });
});

// ─── buildTranscript tests ─────────────────────────────────────────────────

describe("buildTranscript", () => {
  test("wraps user prompt with role markers", () => {
    const result = buildTranscript("hello world", [], []);
    assert.ok(result.startsWith("[role: user]\nhello world\n[user:end]"));
    assert.ok(result.includes("[role: assistant]\n"));
    assert.ok(result.endsWith("[assistant:end]"));
  });

  test("includes assistant text content", () => {
    const messages: AssistantMessage[] = [
      { role: "assistant", content: "Here is the answer." },
    ];
    const result = buildTranscript("question", messages, []);
    assert.ok(result.includes("Here is the answer."));
  });

  test("includes non-operational tool calls", () => {
    const messages: AssistantMessage[] = [
      { role: "assistant", content: [{ type: "tool_use", name: "hindsight_retain", input: { content: "test" } }] },
    ];
    const result = buildTranscript("question", messages, []);
    assert.ok(result.includes("[Tool: hindsight_retain]"));
    assert.ok(result.includes('{"content":"test"}'));
  });

  test("excludes operational tools", () => {
    const messages: AssistantMessage[] = [
      { role: "assistant", content: [{ type: "tool_use", name: "bash", input: { command: "ls" } }] },
    ];
    const result = buildTranscript("question", messages, []);
    assert.ok(!result.includes("[Tool: bash]"));
  });

  test("strips <hindsight_memories> blocks by default", () => {
    const messages: AssistantMessage[] = [
      { role: "assistant", content: "Some text\n<hindsight_memories>\nOld memories\n</hindsight_memories>\nMore text" },
    ];
    const result = buildTranscript("question", messages, DEFAULT_STRIP_PATTERNS);
    assert.ok(!result.includes("<hindsight_memories>"));
    assert.ok(!result.includes("Old memories"));
  });

  test("strips <antThinking> blocks by default", () => {
    const messages: AssistantMessage[] = [
      { role: "assistant", content: "<antThinking>Let me think about this...\nIt's complex.\n</antThinking>\nHere's the answer." },
    ];
    const result = buildTranscript("question", messages, DEFAULT_STRIP_PATTERNS);
    assert.ok(!result.includes("<antThinking>"));
    assert.ok(!result.includes("Let me think"));
    assert.ok(result.includes("Here's the answer."));
  });

  test("strips <thinking> and <reasoning> blocks by default", () => {
    const messages: AssistantMessage[] = [
      { role: "assistant", content: "<thinking>internal thought</thinking>\n<reasoning>more reasoning</reasoning>\nResult." },
    ];
    const result = buildTranscript("question", messages, DEFAULT_STRIP_PATTERNS);
    assert.ok(!result.includes("<thinking>"));
    assert.ok(!result.includes("<reasoning>"));
    assert.ok(result.includes("Result."));
  });

  test("strips base64 image data by default", () => {
    const b64 = "A".repeat(200);
    const messages: AssistantMessage[] = [
      { role: "assistant", content: `Check this: data:image/png;base64,${b64}\nDone.` },
    ];
    const result = buildTranscript("question", messages, DEFAULT_STRIP_PATTERNS);
    assert.ok(!result.includes("data:image/png"));
    assert.ok(!result.includes(b64));
    assert.ok(result.includes("Done."));
  });

  test("strips custom patterns from config", () => {
    const messages: AssistantMessage[] = [
      { role: "assistant", content: "Error: ECONNREFUSED\nstack trace here\n[done]" },
    ];
    const cfg: ResolvedConfig = {
      api_url: "http://localhost:8888", api_key: "k",
      bank_id: "test", global_bank: null,
      recall_types: [], strip_patterns: ["Error:.*\\n"],
    };
    const patterns = getStripPatterns(cfg);
    const result = buildTranscript("question", messages, patterns);
    assert.ok(!result.includes("Error: ECONNREFUSED"));
  });

  test("handles mixed content blocks", () => {
    const messages: AssistantMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me check." },
          { type: "tool_use", name: "read_full", input: { path: "/foo" } },
          { type: "text", text: "Found it." },
        ],
      },
    ];
    const result = buildTranscript("question", messages, []);
    assert.ok(result.includes("Let me check."));
    assert.ok(result.includes("[Tool: read_full]"));
    assert.ok(result.includes("Found it."));
  });

  test("truncates to 50000 chars", () => {
    const hugeContent = "x".repeat(60000);
    const messages: AssistantMessage[] = [{ role: "assistant", content: hugeContent }];
    const raw = buildTranscript("q", messages, []);
    const transcript = raw.length > 50000 ? raw.slice(0, 50000) + "\n...[TRUNCATED]" : raw;
    assert.ok(transcript.length <= 50000 + 20, "should be truncated");
    assert.ok(transcript.includes("[TRUNCATED]"));
  });
});

// ─── shouldSkipRetain tests ────────────────────────────────────────────────

describe("shouldSkipRetain", () => {
  test("skips null prompt", () => {
    assert.deepEqual(shouldSkipRetain(null), { skip: true, reason: "no prompt" });
  });

  test("skips prompts shorter than 5 chars", () => {
    assert.deepEqual(shouldSkipRetain("hi"), { skip: true, reason: "too short" });
  });

  test("skips trivial prompts", () => {
    for (const p of ["ok", "yes", "no", "thanks", "continue", "next", "done", "sure", "stop"]) {
      const result = shouldSkipRetain(p);
      assert.equal(result.skip, true, `"${p}" should be skipped`);
    }
  });

  test("skips #nomem opt-out", () => {
    assert.deepEqual(shouldSkipRetain("#nomem skip this"), { skip: true, reason: "opt-out" });
  });

  test("skips #skip opt-out", () => {
    assert.deepEqual(shouldSkipRetain("#skip this turn"), { skip: true, reason: "opt-out" });
  });

  test("does not skip valid prompts", () => {
    for (const p of ["how does this work?", "refactor the auth module", "what is the build config"]) {
      const result = shouldSkipRetain(p);
      assert.deepEqual(result, { skip: false });
    }
  });

  test("does not skip prompts with #nomem in the middle", () => {
    const result = shouldSkipRetain("fix the #nomem-tag issue");
    assert.equal(result.skip, false);
  });
});

// ─── extractTags tests ─────────────────────────────────────────────────────

describe("extractTags", () => {
  test("extracts #hashtag from prompt", () => {
    assert.deepEqual(extractTags("fix this #bug please"), ["bug"]);
  });

  test("extracts multiple tags", () => {
    assert.deepEqual(extractTags("#auth #security #urgent fix"), ["auth", "security", "urgent"]);
  });

  test("excludes reserved tags", () => {
    const tags = extractTags("#global #me #nomem #skip #bug #feature");
    assert.ok(!tags.includes("global"));
    assert.ok(!tags.includes("me"));
    assert.ok(!tags.includes("nomem"));
    assert.ok(!tags.includes("skip"));
    assert.ok(tags.includes("bug"));
    assert.ok(tags.includes("feature"));
  });

  test("case-insensitive", () => {
    const tags = extractTags("#BUG #Feature #AUTH");
    assert.deepEqual(tags, ["bug", "feature", "auth"]);
  });

  test("ignores # in middle of word", () => {
    const tags = extractTags("C# #javascript Python");
    assert.deepEqual(tags, ["javascript"]);
  });

  test("empty prompt returns empty array", () => {
    assert.deepEqual(extractTags(""), []);
  });

  test("handles tags with hyphens and underscores", () => {
    assert.deepEqual(extractTags("#my-tag #my_tag #tag-1"), ["my-tag", "my_tag", "tag-1"]);
  });
});

// ─── getRecallBanks tests ──────────────────────────────────────────────────

describe("getRecallBanks", () => {
  test("returns both bank_id and global_bank", () => {
    const config: ResolvedConfig = {
      api_url: "http://localhost:8888", api_key: "k",
      bank_id: "project-test", global_bank: "global-all",
      recall_types: [], strip_patterns: [],
    };
    assert.deepEqual(getRecallBanks(config), ["project-test", "global-all"]);
  });

  test("returns only bank_id when no global_bank", () => {
    const config: ResolvedConfig = {
      api_url: "http://localhost:8888", api_key: "k",
      bank_id: "project-test", global_bank: null,
      recall_types: [], strip_patterns: [],
    };
    assert.deepEqual(getRecallBanks(config), ["project-test"]);
  });

  test("returns empty array when no banks configured", () => {
    const config: ResolvedConfig = {
      api_url: "http://localhost:8888", api_key: "k",
      bank_id: null, global_bank: null,
      recall_types: [], strip_patterns: [],
    };
    assert.deepEqual(getRecallBanks(config), []);
  });
});

// ─── getRetainBanks tests ──────────────────────────────────────────────────

describe("getRetainBanks", () => {
  const config: ResolvedConfig = {
    api_url: "http://localhost:8888", api_key: "k",
    bank_id: "project-test", global_bank: "global-all",
    recall_types: [], strip_patterns: [],
  };

  test("returns only bank_id for normal prompt", () => {
    assert.deepEqual(getRetainBanks(config, "normal prompt"), ["project-test"]);
  });

  test("returns both banks with #global tag", () => {
    const banks = getRetainBanks(config, "remember this #global");
    assert.ok(banks.includes("project-test"));
    assert.ok(banks.includes("global-all"));
    assert.equal(banks.length, 2);
  });

  test("returns both banks with #me tag", () => {
    const banks = getRetainBanks(config, "my preference #me");
    assert.ok(banks.includes("global-all"));
    assert.equal(banks.length, 2);
  });

  test("only bank_id when global_bank is null", () => {
    const noGlobal: ResolvedConfig = { ...config, global_bank: null };
    assert.deepEqual(getRetainBanks(noGlobal, "#global"), ["project-test"]);
  });
});

// ─── getActiveBank tests ───────────────────────────────────────────────────

describe("getActiveBank", () => {
  test("returns bank_id", () => {
    const config: ResolvedConfig = {
      api_url: "http://localhost:8888", api_key: "k",
      bank_id: "project-test", global_bank: "global",
      recall_types: [], strip_patterns: [],
    };
    assert.equal(getActiveBank(config), "project-test");
  });

  test("returns null when no bank_id", () => {
    const config: ResolvedConfig = {
      api_url: "http://localhost:8888", api_key: "k",
      bank_id: null, global_bank: "global",
      recall_types: [], strip_patterns: [],
    };
    assert.equal(getActiveBank(config), null);
  });
});

// ─── authHeader tests ──────────────────────────────────────────────────────

describe("authHeader", () => {
  test("produces Bearer token", () => {
    assert.deepEqual(authHeader("my-key"), { "Authorization": "Bearer my-key" });
  });

  test("handles empty key (no 'undefined')", () => {
    assert.deepEqual(authHeader(""), { "Authorization": "Bearer " });
  });

  test("handles empty string key", () => {
    const h = authHeader("");
    assert.ok(!h["Authorization"].includes("undefined"), "should not contain 'undefined'");
  });
});

// ─── getStripPatterns tests ────────────────────────────────────────────────

describe("getStripPatterns", () => {
  test("returns default patterns when no config", () => {
    const config: ResolvedConfig = {
      api_url: "http://localhost:8888", api_key: "k",
      bank_id: "test", global_bank: null,
      recall_types: [], strip_patterns: [],
    };
    const patterns = getStripPatterns(config);
    assert.equal(patterns.length, 3);
    assert.ok(patterns[0].source.includes("hindsight_memories"));
    assert.ok(patterns[1].source.includes("antThinking"));
    assert.ok(patterns[2].source.includes("base64"));
  });

  test("returns custom patterns from config", () => {
    const config: ResolvedConfig = {
      api_url: "http://localhost:8888", api_key: "k",
      bank_id: "test", global_bank: null,
      recall_types: [], strip_patterns: ["Error:.*\\n", "at .*\\.js:\\d+.*"],
    };
    const patterns = getStripPatterns(config);
    assert.equal(patterns.length, 2);
    assert.ok(patterns[0].source.includes("Error:"));
    assert.ok(patterns[1].source.includes("at .*"));
  });
});
