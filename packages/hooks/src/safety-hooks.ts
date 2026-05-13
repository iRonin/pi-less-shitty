/**
 * Safety Hooks — Specialized Guards
 *
 * Handles guards that are NOT part of the main hooks permission system:
 *   1. PDF Guard — block large PDF reads (context window protection)
 *   2. PDFenv Guard — force PDF scripts to use /tmp/pdfenv venv
 *   3. Trailing Spaces Guard — warn on lost markdown double-spaces after edits
 *
 * The main bash permission system (hard blocks, rm→trash rewrite,
 * destructive command analysis) lives in index.ts.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { agentDoneSound } from "./permission-ui.js";

/**
 * Read a PDF's page count via `pdfinfo` without invoking a shell.
 * Returns null when pdfinfo is unavailable, the file is unreadable,
 * or the output cannot be parsed. Path is passed as an argv entry,
 * so shell metacharacters in the file path are inert.
 */
export function getPdfPageCount(filePath: string): number | null {
  let result;
  try {
    result = spawnSync("pdfinfo", [filePath], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    });
  } catch {
    return null;
  }
  if (result.status !== 0 || !result.stdout) return null;
  const m = result.stdout.match(/^Pages:\s+(\d+)/m);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

export default function (pi: ExtensionAPI) {
  // ─────────────────────────────────────────────────────────────
  // 1. BASH SAFETY — PDFenv guard
  // ─────────────────────────────────────────────────────────────

  pi.on("tool_call", async (event, _ctx) => {
    if (!isToolCallEventType("bash", event)) return undefined;

    const command = event.input.command;
    if (!command) return undefined;

    // PDFENV GUARD — PDF scripts must use /tmp/pdfenv/bin/python3
    const PDF_SCRIPTS =
      /reformat-letter\.py|first-pages\.py|fix-double-ocr\.py|pdf2md\.py|auto-highlight\.py|manual-highlight\.py|collate-exhibits\.py|highlight-preview\.py|toc-pages\.py|verify-citations\.py/;

    if (PDF_SCRIPTS.test(command)) {
      if (!/\/tmp\/pdfenv\/bin\/python3/.test(command) && /(^|\s|;|&&|\|\|)(python3?)\s/.test(command)) {
        const scriptMatch = command.match(PDF_SCRIPTS);
        return {
          block: true,
          reason: `PDF script '${scriptMatch?.[0]}' must use /tmp/pdfenv/bin/python3 (not system python3). PyMuPDF and other dependencies are only installed in the venv. Rewrite command to use: /tmp/pdfenv/bin/python3 TOOLS/PDF/${scriptMatch?.[0]}`,
        };
      }
    }

    return undefined;
  });

  // ─────────────────────────────────────────────────────────────
  // 2. PDF GUARD — block large PDF reads
  // ─────────────────────────────────────────────────────────────

  pi.on("tool_call", async (event, _ctx) => {
    if (!isToolCallEventType("read", event)) return undefined;

    const filePath = event.input.path;
    if (!filePath) return undefined;

    // Only care about PDFs
    if (!/\.pdf$/i.test(filePath)) return undefined;

    // If offset/limit is set, this is a targeted read — allow
    if (event.input.offset || event.input.limit) return undefined;

    // Check file exists
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return undefined;
    }

    const fileSize = stat.size;

    // Get page count via pdfinfo if available. We invoke pdfinfo directly
    // via spawnSync (no shell) so that agent-controlled file paths cannot
    // be interpreted as shell metacharacters.
    const pageCount: number | null = getPdfPageCount(filePath);

    // Thresholds
    const WARN_SIZE = 2_000_000; // 2MB
    const BLOCK_SIZE = 10_000_000; // 10MB
    const WARN_PAGES = 10;
    const BLOCK_PAGES = 30;

    const humanSize =
      fileSize > 1_000_000
        ? `${Math.floor(fileSize / 1_000_000)}MB`
        : fileSize > 1_000
          ? `${Math.floor(fileSize / 1_000)}KB`
          : `${fileSize}B`;

    // Check for .md version
    const mdVersion = filePath.replace(/\.pdf$/i, ".md");
    const mdHint = fs.existsSync(mdVersion)
      ? ` An .md version exists at ${path.basename(mdVersion)} — prefer reading that instead.`
      : "";

    const delegateMsg =
      "Do NOT read this PDF in the main context. Instead: (1) Use pdfgrep or MCP pdf_search_text to find specific content, (2) Use Read with offset/limit parameters for targeted extraction, or (3) Spawn a background agent to read and summarise the PDF, preserving the main context window.";

    let reason: string | null = null;

    if (pageCount !== null && pageCount > BLOCK_PAGES) {
      reason = `BLOCKED: PDF has ${pageCount} pages (${humanSize}). ${delegateMsg}${mdHint}`;
    } else if (fileSize > BLOCK_SIZE) {
      reason = `BLOCKED: PDF is ${humanSize}. ${delegateMsg}${mdHint}`;
    } else if (pageCount !== null && pageCount > WARN_PAGES) {
      reason = `BLOCKED: PDF has ${pageCount} pages (${humanSize}). ${delegateMsg}${mdHint}`;
    } else if (fileSize > WARN_SIZE) {
      reason = `BLOCKED: PDF is ${humanSize}. ${delegateMsg}${mdHint}`;
    }

    if (reason) {
      return { block: true, reason };
    }

    return undefined;
  });

  // ─────────────────────────────────────────────────────────────
  // 3. TRAILING SPACES GUARD — warn on lost markdown formatting
  // ─────────────────────────────────────────────────────────────

  pi.on("tool_result", async (event, ctx) => {
    if (event.tool !== "edit") return undefined;

    const filePath = event.input?.path;
    if (!filePath) return undefined;

    // Only care about markdown files
    if (!/\.md$/i.test(filePath)) return undefined;

    // Read the current file content
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      return undefined;
    }

    // Count lines ending with two or more trailing spaces
    const lines = content.split("\n");
    let lost = 0;
    for (const line of lines) {
      if (line.endsWith("  ") && !line.endsWith("   ")) {
        lost++;
      }
    }

    if (lost > 0) {
      const warningText = `⚠️ WARNING: Edit removed ${lost} trailing double-space(s) from markdown. These are intentional line breaks. Re-read the edited section and restore any lost '  ' (two spaces) at line endings where the original had them.`;

      // Sound + notification
      try {
        const child = spawn(
          "/usr/bin/afplay",
          ["/System/Library/Sounds/Ping.aiff"],
          { detached: true, stdio: "ignore" }
        );
        child.unref();
      } catch {}
      process.stdout.write("\x07");

      ctx.ui.notify(warningText, "warning");
    }

    return undefined;
  });

  // Agent done sound — REMOVED.
  // Was firing on EVERY LLM turn completion (duplicated with index.ts).
  // Sound is now played directly in oh-pi's notify.ts on subagent:complete.
  // (kept import for agentDoneSound in case other modules need it)

  // Notify on session start
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify(
      "Safety hooks active: pdf-guard, pdfenv-guard, trailing-spaces, git-checkout-block",
      "info"
    );
  });
}
