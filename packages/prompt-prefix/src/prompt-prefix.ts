/**
 * prompt-prefix — pi extension
 *
 * Prepends a configurable prefix to every prompt as it appears in the chat —
 * so your messages stand out in the scrollback and are easy to grep/search.
 *
 * ⚠️  The prefix is ONLY visual. It is stripped before messages are sent to
 *     the LLM, so it has zero effect on model behaviour or token usage.
 *
 * Commands
 *   /prompt-prefix            — show current setting
 *   /prompt-prefix <text>     — set prefix  (e.g.  /prompt-prefix "ME❯ ")
 *   /prompt-prefix on | off   — enable / disable without changing the text
 *   /prompt-prefix reset      — restore default  ("❯ ")
 *
 * Note: "on", "off", "reset" are reserved and cannot be used as prefix values.
 *
 * Config is saved to ~/.pi/agent/prompt-prefix.json and shared across all
 * sessions / pi instances on the same machine.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ── Config ────────────────────────────────────────────────────────────────────

const DEFAULT_PREFIX = "❯ ";
const MAX_PREFIX_LENGTH = 50;
const CONFIG_DIR = join(homedir(), ".pi", "agent");
const CONFIG_FILE = join(CONFIG_DIR, "prompt-prefix.json");

interface Config {
	prefix: string;
	enabled: boolean;
}

function loadConfig(): Config {
	try {
		if (existsSync(CONFIG_FILE)) {
			const raw = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
			return {
				prefix: typeof raw.prefix === "string" && raw.prefix.length > 0 ? raw.prefix : DEFAULT_PREFIX,
				enabled: typeof raw.enabled === "boolean" ? raw.enabled : true,
			};
		}
	} catch {
		// fall through to default
	}
	return { prefix: DEFAULT_PREFIX, enabled: true };
}

function saveConfig(cfg: Config): boolean {
	try {
		mkdirSync(CONFIG_DIR, { recursive: true });
		writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
		return true;
	} catch {
		return false;
	}
}

// ── Extension ─────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let cfg = loadConfig();

	function persist(ctx: Parameters<Parameters<typeof pi.registerCommand>[1]["handler"]>[1]): void {
		if (!saveConfig(cfg)) {
			ctx.ui.notify(`⚠️  Prefix updated in memory but could not save to ${CONFIG_FILE}`, "warning");
		}
	}

	// ── 1. Prepend prefix to every interactive user prompt ──────────────────
	//
	// The transformed text is what gets stored in the session and shown in the
	// TUI — giving you the visual prefix in the chat history.
	//
	// Skip prefix for queued messages (Alt+Enter while streaming): ctx.isIdle()
	// returns false during streaming, meaning the input is being queued rather
	// than submitted directly. This keeps the follow-up queue clean so Alt+Up
	// dequeue restores text without the prefix.

	pi.on("input", (event, ctx) => {
		if (!cfg.enabled) return { action: "continue" };
		if (event.source !== "interactive") return { action: "continue" };
		// trimStart so leading spaces don't mask commands like "  /cmd"
		if (event.text.trimStart().startsWith("/")) return { action: "continue" };
		// trim catches all whitespace variants for the empty-input guard
		if (!event.text.trim()) return { action: "continue" };
		// Skip prefix for queued messages (Alt+Enter / Alt+Shift+Enter while streaming)
		if (!ctx.isIdle()) return { action: "continue" };

		return { action: "transform", text: `${cfg.prefix}${event.text}` };
	});

	// ── 2. Strip prefix before messages are sent to the LLM ─────────────────
	//
	// The context event fires right before each LLM call. We remove the prefix
	// from every user message in the payload so the model never sees it.
	// This keeps the prefix purely cosmetic with no impact on model behaviour
	// or token usage.

	pi.on("context", (event) => {
		if (!cfg.enabled) return;

		const { prefix } = cfg;

		const messages = event.messages.map((msg) => {
			if (msg.role !== "user") return msg;

			// content can be a plain string or an array of content blocks
			if (typeof msg.content === "string") {
				if (!msg.content.startsWith(prefix)) return msg;
				return { ...msg, content: msg.content.slice(prefix.length) };
			}

			if (!Array.isArray(msg.content)) return msg;

			// Strip from the first text block only (prefix is always at the start)
			let stripped = false;
			const newContent = msg.content.map(
				(block: { type: string; text?: string } & Record<string, unknown>) => {
					if (
						!stripped &&
						block.type === "text" &&
						typeof block.text === "string" &&
						block.text.startsWith(prefix)
					) {
						stripped = true;
						return { ...block, text: block.text.slice(prefix.length) };
					}
					return block;
				},
			);

			return { ...msg, content: newContent };
		});

		return { messages };
	});

	// ── 3. /prompt-prefix command ────────────────────────────────────────────

	pi.registerCommand("prompt-prefix", {
		description:
			"Get/set the displayed prompt prefix (visual only — never sent to the AI). " +
			"Usage: /prompt-prefix [text | on | off | reset]. " +
			"Use _ for spaces (pi trims trailing spaces). " +
			"Note: 'on', 'off', 'reset' are reserved and cannot be used as prefix values.",
		handler: async (args, ctx) => {
			// Pi trims command args, so trailing spaces are lost. Use "_" as a space placeholder.
			const arg = args.replace(/_/g, " "); // "CK❯_" → "CK❯ "
			const cmd = arg.trim();               // trimmed copy for subcommand matching

			// No args → show current state
			if (!cmd) {
				const state = cfg.enabled ? `"${cfg.prefix}"` : `"${cfg.prefix}" (disabled)`;
				ctx.ui.notify(`Prompt prefix: ${state}  [display only — not sent to AI]`, "info");
				return;
			}

			if (cmd === "off") {
				cfg.enabled = false;
				persist(ctx);
				ctx.ui.notify("Prompt prefix disabled", "info");
				return;
			}

			if (cmd === "on") {
				cfg.enabled = true;
				persist(ctx);
				ctx.ui.notify(`Prompt prefix enabled: "${cfg.prefix}"  [display only — not sent to AI]`, "info");
				return;
			}

			if (cmd === "reset") {
				cfg = { prefix: DEFAULT_PREFIX, enabled: true };
				persist(ctx);
				ctx.ui.notify(`Prompt prefix reset to: "${cfg.prefix}"  [display only — not sent to AI]`, "info");
				return;
			}

			// Anything else → set as new prefix (use arg, not cmd, to keep trailing space)
			if (arg.length > MAX_PREFIX_LENGTH) {
				ctx.ui.notify(`Prefix too long (max ${MAX_PREFIX_LENGTH} characters)`, "error");
				return;
			}
			cfg.prefix = arg;
			cfg.enabled = true;
			persist(ctx);
			ctx.ui.notify(`Prompt prefix set to: "${cfg.prefix}"  [display only — not sent to AI]`, "info");
		},
	});
}
