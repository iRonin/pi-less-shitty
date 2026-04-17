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

	// ── 1. Prepend prefix to user messages at display time ──────────────────
	//
	// Hook message_start to add the prefix for TUI rendering only. The prefix
	// is never stored in the session and never sent to the LLM.

	pi.on("message_start", (event) => {
		if (!cfg.enabled) return;
		if (event.message.role !== "user") return;

		const { prefix } = cfg;
		const msg = event.message;

		if (typeof msg.content === "string") {
			if (msg.content.trimStart().startsWith("/")) return;
			if (!msg.content.trim()) return;
			msg.content = `${prefix}${msg.content}`;
		} else if (Array.isArray(msg.content)) {
			// Find the first text block
			for (const block of msg.content) {
				if (block.type === "text" && typeof block.text === "string") {
					if (block.text.trimStart().startsWith("/")) return;
					if (!block.text.trim()) return;
					block.text = `${prefix}${block.text}`;
					return;
				}
			}
		}
	});

	// ── 2. Strip prefix before persistence ──────────────────────────────────
	//
	// Revert the display-only prefix so the session file stays clean.
	// The TUI has already rendered the prefixed version by this point.

	pi.on("message_end", (event) => {
		if (!cfg.enabled) return;
		if (event.message.role !== "user") return;

		const { prefix } = cfg;
		const msg = event.message;

		if (typeof msg.content === "string") {
			if (msg.content.startsWith(prefix)) {
				msg.content = msg.content.slice(prefix.length);
			}
		} else if (Array.isArray(msg.content)) {
			for (const block of msg.content) {
				if (block.type === "text" && typeof block.text === "string" && block.text.startsWith(prefix)) {
					block.text = block.text.slice(prefix.length);
					return;
				}
			}
		}
	});

	// ── 3. Strip prefix from stored messages on session reload ──────────────
	//
	// When a session is reloaded, old messages that were stored with the prefix
	// (before the message_start/message_end approach) need to be cleaned up
	// before being sent to the LLM.

	pi.on("context", (event) => {
		if (!cfg.enabled) return;

		const { prefix } = cfg;

		const messages = event.messages.map((msg) => {
			if (msg.role !== "user") return msg;

			if (typeof msg.content === "string") {
				if (!msg.content.startsWith(prefix)) return msg;
				return { ...msg, content: msg.content.slice(prefix.length) };
			}

			if (!Array.isArray(msg.content)) return msg;

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

	// ── 4. /prompt-prefix command ────────────────────────────────────────────

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
