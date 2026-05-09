/**
 * Tests for bootstrap.ts — verifies resilience to corrupt JSONL.
 * Run: node --experimental-strip-types --test test/bootstrap.test.ts
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { parsePiSession } from "../bootstrap.ts";

describe("parsePiSession — FIX 4: corrupt-line resilience", () => {
  test("a single corrupt JSONL line does not drop the rest of the session", () => {
    const dir = mkdtempSync(join(tmpdir(), "hindsight-bootstrap-"));
    try {
      const sessionFile = join(dir, "session-corrupt.jsonl");

      // Header (line 1), corrupt blob (line 2), three valid messages.
      const lines = [
        JSON.stringify({ id: "sess-corrupt", cwd: "/tmp/x", timestamp: "2025-01-01T00:00:00Z" }),
        "{this is not valid json,,,",
        JSON.stringify({ type: "message", message: { role: "user", content: "hello there friend" } }),
        JSON.stringify({ type: "message", message: { role: "assistant", content: "hi back" } }),
        JSON.stringify({ type: "message", message: { role: "user", content: "and another question" } }),
      ];
      writeFileSync(sessionFile, lines.join("\n"));

      const session = parsePiSession(sessionFile);
      assert.ok(session, "session should still parse despite corrupt line");
      assert.equal(session!.id, "sess-corrupt");
      // Two user turns survived (assistant gets attached to first turn).
      assert.equal(session!.turns.length, 2, "both user turns should survive corrupt line");
      assert.equal(session!.turns[0].user, "hello there friend");
      assert.equal(session!.turns[0].assistant, "hi back");
      assert.equal(session!.turns[1].user, "and another question");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("multiple corrupt lines scattered through a session are skipped", () => {
    const dir = mkdtempSync(join(tmpdir(), "hindsight-bootstrap-"));
    try {
      const sessionFile = join(dir, "session-multi-corrupt.jsonl");
      const lines = [
        JSON.stringify({ id: "sess-multi", cwd: "/tmp/y", timestamp: "2025-01-01T00:00:00Z" }),
        JSON.stringify({ type: "message", message: { role: "user", content: "first prompt question" } }),
        "garbage line one",
        JSON.stringify({ type: "message", message: { role: "assistant", content: "first reply" } }),
        "{partial json",
        JSON.stringify({ type: "message", message: { role: "user", content: "second prompt question" } }),
        "}}}}",
        JSON.stringify({ type: "message", message: { role: "assistant", content: "second reply" } }),
      ];
      writeFileSync(sessionFile, lines.join("\n"));

      const session = parsePiSession(sessionFile);
      assert.ok(session, "session should parse with multiple corrupt lines");
      assert.equal(session!.turns.length, 2);
      assert.equal(session!.turns[0].user, "first prompt question");
      assert.equal(session!.turns[0].assistant, "first reply");
      assert.equal(session!.turns[1].user, "second prompt question");
      assert.equal(session!.turns[1].assistant, "second reply");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("corrupt header line still returns null gracefully", () => {
    const dir = mkdtempSync(join(tmpdir(), "hindsight-bootstrap-"));
    try {
      const sessionFile = join(dir, "session-bad-header.jsonl");
      const lines = [
        "this is not json at all",
        JSON.stringify({ type: "message", message: { role: "user", content: "valid user line" } }),
        JSON.stringify({ type: "message", message: { role: "assistant", content: "valid reply" } }),
      ];
      writeFileSync(sessionFile, lines.join("\n"));

      const session = parsePiSession(sessionFile);
      assert.equal(session, null, "should return null on corrupt header, not throw");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("a fully clean JSONL session still parses normally", () => {
    const dir = mkdtempSync(join(tmpdir(), "hindsight-bootstrap-"));
    try {
      const sessionFile = join(dir, "session-clean.jsonl");
      const lines = [
        JSON.stringify({ id: "sess-clean", cwd: "/tmp/z", timestamp: "2025-01-01T00:00:00Z" }),
        JSON.stringify({ type: "model_change", modelId: "anthropic/claude-3-5-sonnet" }),
        JSON.stringify({ type: "message", message: { role: "user", content: "what is the answer?" } }),
        JSON.stringify({ type: "message", message: { role: "assistant", content: "42" } }),
      ];
      writeFileSync(sessionFile, lines.join("\n"));

      const session = parsePiSession(sessionFile);
      assert.ok(session);
      assert.equal(session!.model, "anthropic/claude-3-5-sonnet");
      assert.equal(session!.turns.length, 1);
      assert.equal(session!.turns[0].user, "what is the answer?");
      assert.equal(session!.turns[0].assistant, "42");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
