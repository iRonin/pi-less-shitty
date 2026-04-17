/**
 * read_full — Read entire files with configurable cap.
 *
 * Unlike the built-in `read` tool (capped at 50KB / 2000 lines),
 * this tool reads files up to a configurable limit (default: 150KB).
 * Files exceeding the limit return a warning header with size info
 * but still deliver full content — the cap is advisory metadata,
 * not a hard enforcement, so the agent decides whether to proceed.
 *
 * Settings: ~/.pi/agent/read-full.json
 *   { "maxBytes": 153600 }  // 150KB default
 *
 * Benchmark: typical legal/technical documents range 100–350KB.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { readFile, access } from "node:fs/promises";
import { constants, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, isAbsolute, dirname, join } from "node:path";
import { homedir } from "node:os";

const DEFAULT_MAX_BYTES = 150 * 1024; // 150KB
const SETTINGS_FILE = join(homedir(), ".pi", "agent", "read-full.json");

interface ReadFullSettings {
  maxBytes: number;
}

function loadSettings(): ReadFullSettings {
  try {
    if (existsSync(SETTINGS_FILE)) {
      return JSON.parse(readFileSync(SETTINGS_FILE, "utf-8"));
    }
  } catch {
    // fall through
  }
  return { maxBytes: DEFAULT_MAX_BYTES };
}

function saveSettings(settings: ReadFullSettings): void {
  const dir = dirname(SETTINGS_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), "utf-8");
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export default function (pi: ExtensionAPI) {
  let settings = loadSettings();

  pi.on("session_start", () => {
    settings = loadSettings();
  });

  pi.registerCommand("read-full", {
    description: "Configure read_full tool (show · set <N> · reset). N in KB (e.g. 200) or with suffix (200KB, 2MB).",
    handler: async (args, ctx) => {
      const trimmed = args.trim().toLowerCase();

      if (!trimmed || trimmed === "show") {
        ctx.ui.notify(`read_full limit: ${formatSize(settings.maxBytes)} (${settings.maxBytes.toLocaleString()} bytes)`, "info");
        return;
      }

      if (trimmed === "reset") {
        settings.maxBytes = DEFAULT_MAX_BYTES;
        saveSettings(settings);
        ctx.ui.notify(`read_full limit reset to default: ${formatSize(DEFAULT_MAX_BYTES)}`, "info");
        return;
      }

      // Parse: "200", "200kb", "2mb"
      const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*(kb|mb|b)?$/);
      if (!match) {
        ctx.ui.notify("Usage: /read-full set <N> [kb|mb] — e.g. /read-full set 200kb", "warning");
        return;
      }
      const value = parseFloat(match[1]);
      const unit = (match[2] || "kb").toLowerCase();
      const multiplier = unit === "mb" ? 1024 * 1024 : unit === "b" ? 1 : 1024;
      settings.maxBytes = Math.round(value * multiplier);
      saveSettings(settings);
      ctx.ui.notify(`read_full limit set to ${formatSize(settings.maxBytes)}`, "info");
    },
  });

  pi.registerTool({
    name: "read_full",
    label: "read_full",
    description: `Read the COMPLETE contents of a file up to ${formatSize(settings.maxBytes)}. The built-in 'read' tool truncates at 50KB/2000 lines — use read_full for larger files. Returns a warning header if the file exceeds the configured ${formatSize(settings.maxBytes)} limit, but still delivers full content. Useful for legal documents, large configs, logs, etc.`,
    promptSnippet: "Read entire file (configurable limit, currently " + formatSize(settings.maxBytes) + ")",
    promptGuidelines: [
      "Use read_full instead of read when you need the complete contents of a large file.",
      "The built-in read tool truncates at 50KB — use read_full to avoid missing content.",
      `Files over ${formatSize(settings.maxBytes)} will show a ⚠️ warning header — the content is still fully delivered.`,
      "Very large files consume significant context window. Consider using an offset-based approach for files > 500KB.",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
    }),
    async execute(_toolCallId, { path: rawPath }, _signal, _onUpdate, ctx) {
      // Resolve path — strip leading @ if present (some models include it)
      let raw = rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
      const absolutePath = isAbsolute(raw) ? raw : resolve(ctx.cwd, raw);

      // Check readability
      try {
        await access(absolutePath, constants.R_OK);
      } catch {
        if (!existsSync(absolutePath)) {
          return {
            content: [{ type: "text", text: `Error: File not found: ${raw}` }],
            details: { error: "ENOENT" },
            isError: true,
          };
        }
        return {
          content: [{ type: "text", text: `Error: Permission denied: ${raw}` }],
          details: { error: "EACCES" },
          isError: true,
        };
      }

      // Stat file size before reading
      const stat = await (await import("node:fs/promises")).stat(absolutePath);
      const fileSizeBytes = stat.size;

      // Read full content
      const content = await readFile(absolutePath, "utf-8");
      const lines = content.split("\n");
      const totalLines = lines.length;
      const totalBytes = Buffer.byteLength(content, "utf-8");

      // Build header
      const overLimit = totalBytes > settings.maxBytes;
      const limitLine = overLimit
        ? `⚠️ EXCEEDS ${formatSize(settings.maxBytes)} limit — full content delivered (use with caution)\n`
        : "";
      const header = `[read_full: ${raw}]\n[Total: ${totalLines.toLocaleString()} lines, ${formatSize(totalBytes)}]${limitLine}${"─".repeat(60)}\n`;

      return {
        content: [{ type: "text", text: header + content }],
        details: {
          path: absolutePath,
          totalLines,
          totalBytes,
          fileSizeBytes,
          limitBytes: settings.maxBytes,
          overLimit,
          truncated: false,
        },
      };
    },
  });
}
