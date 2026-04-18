/**
 * Prompt Stash Extension
 *
 * Ctrl+S — stash/pop toggle: editor has text → stash + clear. Editor empty → pop latest stash.
 * Ctrl+Shift+S — show stash UI (interactive picker).
 * Auto-stash: silently stash every submitted prompt (toggle with /stash auto on/off).
 *
 * Shortcuts:
 *   ctrl+s             → stash if editor has text, pop latest if empty
 *   ctrl+shift+s       → show stash UI (interactive picker)
 *
 * Commands:
 *   /stash              → list all stashes (interactive picker)
 *   /stash <text>       → save text directly as a stash
 *   /stash pop [n]      → pop stash n (default: 1) to editor
 *   /stash drop [n]     → drop stash n without restoring
 *   /stash clear        → clear all stashes
 *   /stash auto on/off  → toggle auto-stash on prompt submit
 *
 * Stashes are scoped to the current working directory — each folder gets its own stash file.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// ─── Data types ───────────────────────────────────────────────────────────────

interface StashEntry {
  id: number;
  text: string;
  timestamp: number;
}

interface StashSettings {
  autoStash: boolean;
}

const SETTINGS_FILE = join(homedir(), ".pi", "agent", "prompt-stash-settings.json");
const PREFIX_CONFIG_FILE = join(homedir(), ".pi", "agent", "prompt-prefix.json");

interface PrefixConfig {
  prefix: string;
  enabled: boolean;
}

function loadPrefixConfig(): PrefixConfig {
  try {
    if (existsSync(PREFIX_CONFIG_FILE)) {
      const raw = JSON.parse(readFileSync(PREFIX_CONFIG_FILE, "utf-8"));
      return {
        prefix: typeof raw.prefix === "string" && raw.prefix.length > 0 ? raw.prefix : "❯ ",
        enabled: typeof raw.enabled === "boolean" ? raw.enabled : true,
      };
    }
  } catch {
    // fall through
  }
  return { prefix: "❯ ", enabled: true };
}

function stripPrefix(text: string, prefixConfig: PrefixConfig): string {
  if (!prefixConfig.enabled) return text;
  if (text.startsWith(prefixConfig.prefix)) {
    return text.slice(prefixConfig.prefix.length);
  }
  return text;
}

function stashFilePath(cwd: string): string {
  // Encode CWD the same way pi encodes session dirs: replace / with -
  const rel = cwd.startsWith(homedir()) ? cwd.slice(homedir().length + 1) : cwd.replace(/^\//, "");
  const encoded = rel.replace(/\//g, "-");
  return join(homedir(), ".pi", "agent", "stashes", `${encoded}.json`);
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

function loadStashes(filePath: string): StashEntry[] {
  try {
    if (existsSync(filePath)) {
      return JSON.parse(readFileSync(filePath, "utf-8"));
    }
  } catch {
    // corrupted or unreadable → start fresh
  }
  return [];
}

function saveStashes(stashes: StashEntry[], filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, JSON.stringify(stashes, null, 2), "utf-8");
}

function loadSettings(): StashSettings {
  try {
    if (existsSync(SETTINGS_FILE)) {
      return JSON.parse(readFileSync(SETTINGS_FILE, "utf-8"));
    }
  } catch {
    // fall through
  }
  return { autoStash: false };
}

function saveSettings(settings: StashSettings): void {
  const dir = dirname(SETTINGS_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), "utf-8");
}

function formatPreview(text: string, maxLen = 60): string {
  const oneLine = text.replace(/\n+/g, "↵ ").trim();
  return oneLine.length > maxLen ? oneLine.slice(0, maxLen) + "…" : oneLine;
}

function formatTime(ts: number, _now = Date.now()): string {
  const d = new Date(ts);
  const diffMs = _now - ts;
  const diffMins = Math.floor(diffMs / 60_000);
  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return d.toLocaleDateString();
}

function nextIdFromStashes(stashes: StashEntry[]): number {
  return stashes.length > 0 ? Math.max(...stashes.map((s) => s.id)) + 1 : 1;
}

function pushStash(
  stashes: StashEntry[],
  nextId: number,
  text: string,
  timestamp = Date.now()
): { entry: StashEntry; stashes: StashEntry[]; nextId: number } {
  const entry: StashEntry = { id: nextId, text, timestamp };
  return { entry, stashes: [entry, ...stashes], nextId: nextId + 1 };
}

type StashAction =
  | { type: "pop"; index: number }
  | { type: "drop"; index: number }
  | { type: "clear" }
  | { type: "save"; text: string }
  | { type: "list" }
  | { type: "error"; message: string };

function parseStashCommand(args: string, stashCount: number): StashAction {
  const trimmed = args.trim();
  const parts = trimmed.split(/\s+/);
  const sub = parts[0];

  if (sub === "pop") {
    const n = parts[1] ? parseInt(parts[1], 10) : 1;
    if (stashCount === 0) return { type: "error", message: "No stashes" };
    if (isNaN(n) || n < 1 || n > stashCount)
      return { type: "error", message: `Index out of range. Have ${stashCount} stash${stashCount !== 1 ? "es" : ""}.` };
    return { type: "pop", index: n - 1 };
  }

  if (sub === "drop") {
    const n = parts[1] ? parseInt(parts[1], 10) : 1;
    if (stashCount === 0) return { type: "error", message: "No stashes" };
    if (isNaN(n) || n < 1 || n > stashCount)
      return { type: "error", message: `Index out of range. Have ${stashCount} stash${stashCount !== 1 ? "es" : ""}.` };
    return { type: "drop", index: n - 1 };
  }

  if (sub === "clear") return { type: "clear" };
  if (trimmed && sub !== "list") return { type: "save", text: trimmed };
  return { type: "list" };
}

// ─── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let cwd = process.cwd();
  let stashes: StashEntry[] = loadStashes(stashFilePath(cwd));
  let nextId = nextIdFromStashes(stashes);
  let settings = loadSettings();
  let prefixConfig = loadPrefixConfig();

  function doPush(text: string): StashEntry {
    const file = stashFilePath(cwd);
    const result = pushStash(stashes, nextId, text);
    stashes = result.stashes;
    nextId = result.nextId;
    saveStashes(stashes, file);
    return result.entry;
  }

  function doSave(): void {
    saveStashes(stashes, stashFilePath(cwd));
  }

  function updateStatus(ctx: ExtensionContext) {
    if (stashes.length === 0) {
      ctx.ui.setStatus("prompt-stash", undefined);
    } else {
      const theme = ctx.ui.theme;
      const count = theme.fg("accent", String(stashes.length));
      const auto = settings.autoStash ? theme.fg("accent", " ⚡") : "";
      ctx.ui.setStatus("prompt-stash", `📫 ${count}${auto}`);
    }
  }

  // ── Show stash picker ──────────────────────────────────────────────────────

  async function showStashPicker(ctx: ExtensionContext) {
    if (stashes.length === 0) {
      ctx.ui.notify("No stashes — ctrl+s to save one", "info");
      return;
    }

    const items = stashes.map((s, i) => {
      const idx = `[${i + 1}]`;
      const when = formatTime(s.timestamp);
      const preview = formatPreview(s.text, 55);
      return `${idx} ${preview}  (${when})`;
    });

    const selected = await ctx.ui.select("Prompt Stashes", items);
    if (!selected) return;

    const idx = items.indexOf(selected);
    if (idx < 0) return;

    const entry = stashes[idx];
    const picked = await ctx.ui.select(`Stash ${idx + 1}: "${formatPreview(entry.text, 40)}"`, [
      "Restore to editor",
      "View full text",
      "Delete",
    ]);

    if (picked === "Restore to editor") {
      stashes.splice(idx, 1);
      doSave();
      updateStatus(ctx);
      ctx.ui.setEditorText(entry.text);
      ctx.ui.notify(`Stash ${idx + 1} restored`, "info");
    } else if (picked === "View full text") {
      await ctx.ui.editor("Stash (edit to update, confirm to save back)", entry.text);
    } else if (picked === "Delete") {
      stashes.splice(idx, 1);
      doSave();
      updateStatus(ctx);
      ctx.ui.notify(`Stash ${idx + 1} deleted`, "info");
    }
  }

  // Reload on session start
  pi.on("session_start", async (_event, ctx) => {
    cwd = ctx.cwd;
    stashes = loadStashes(stashFilePath(cwd));
    nextId = nextIdFromStashes(stashes);
    settings = loadSettings();
    prefixConfig = loadPrefixConfig();
    updateStatus(ctx);
  });

  // Auto-stash: silently stash every submitted prompt
  pi.on("input", (event, _ctx) => {
    if (!settings.autoStash) return;
    const text = event.text?.trim();
    if (!text) return;
    // Skip slash-commands (handled separately, avoids double-stashing /stash)
    if (text.startsWith("/")) return;
    doPush(stripPrefix(text, prefixConfig));
  });

  // ctrl+s → stash current editor text, or pop latest when editor is empty
  pi.registerShortcut("ctrl+s", {
    description: "Stash: save editor text / pop latest when empty",
    handler: (ctx) => {
      const text = ctx.ui.getEditorText();
      if (text?.trim()) {
        // Editor has content → stash it (strip visual prefix first)
        const clean = stripPrefix(text.trim(), prefixConfig);
        const entry = doPush(clean);
        ctx.ui.setEditorText("");
        updateStatus(ctx);
        ctx.ui.notify(
          `Stashed #${entry.id} (${stashes.length} total) — ctrl+shift+s to browse`,
          "info"
        );
      } else if (stashes.length > 0) {
        // Editor is empty → pop latest stash
        const entry = stashes.shift()!;
        doSave();
        updateStatus(ctx);
        ctx.ui.setEditorText(entry.text);
        ctx.ui.notify(
          `Popped stash #${entry.id}: "${formatPreview(entry.text, 40)}"`,
          "info"
        );
      } else {
        ctx.ui.notify("Editor is empty and no stashes available", "warning");
      }
    },
  });

  // ctrl+shift+s → show stash picker
  pi.registerShortcut("ctrl+shift+s", {
    description: "Stash: open stash picker",
    handler: async (ctx) => {
      await showStashPicker(ctx);
    },
  });

  // /stash command with auto on/off
  pi.registerCommand("stash", {
    description: "Manage prompt stashes (list · pop [n] · drop [n] · clear · auto on/off · <text>)",
    getArgumentCompletions: (prefix) => {
      const cmds = ["pop", "drop", "clear", "list", "auto", "on", "off"];
      const filtered = cmds.filter((c) => c.startsWith(prefix));
      return filtered.length > 0 ? filtered.map((c) => ({ value: c, label: c })) : null;
    },
    handler: async (args, ctx) => {
      const trimmed = args.trim();

      // /stash auto [on|off]
      if (trimmed.startsWith("auto ")) {
        const mode = trimmed.slice(5).trim().toLowerCase();
        if (mode === "on") {
          settings.autoStash = true;
          saveSettings(settings);
          updateStatus(ctx);
          ctx.ui.notify("Auto-stash enabled (every submitted prompt is stashed)", "info");
        } else if (mode === "off") {
          settings.autoStash = false;
          saveSettings(settings);
          updateStatus(ctx);
          ctx.ui.notify("Auto-stash disabled", "info");
        } else {
          ctx.ui.notify(`Auto-stash is currently ${settings.autoStash ? "ON ⚡" : "OFF"}. Use /stash auto on or /stash auto off`, "info");
        }
        return;
      }

      const action = parseStashCommand(trimmed, stashes.length);

      if (action.type === "error") {
        ctx.ui.notify(action.message, "warning");
        return;
      }

      if (action.type === "pop") {
        const entry = stashes.splice(action.index, 1)[0];
        doSave();
        updateStatus(ctx);
        ctx.ui.setEditorText(entry.text);
        ctx.ui.notify(`Stash ${action.index + 1} restored to editor`, "info");
        return;
      }

      if (action.type === "drop") {
        const dropped = stashes.splice(action.index, 1)[0];
        doSave();
        updateStatus(ctx);
        ctx.ui.notify(`Dropped stash ${action.index + 1}: "${formatPreview(dropped.text, 40)}"`, "info");
        return;
      }

      if (action.type === "clear") {
        if (stashes.length === 0) {
          ctx.ui.notify("No stashes to clear", "info");
          return;
        }
        const ok = await ctx.ui.confirm("Clear all stashes?", `Delete all ${stashes.length} stash${stashes.length !== 1 ? "es" : ""}?`);
        if (ok) {
          stashes = [];
          doSave();
          updateStatus(ctx);
          ctx.ui.notify("All stashes cleared", "info");
        }
        return;
      }

      if (action.type === "save") {
        const clean = stripPrefix(action.text, prefixConfig);
        const entry = doPush(clean);
        updateStatus(ctx);
        ctx.ui.notify(`Stashed #${entry.id}: "${formatPreview(clean, 40)}" (${stashes.length} total)`, "info");
        return;
      }

      // list → show stash picker
      await showStashPicker(ctx);
    },
  });
}
