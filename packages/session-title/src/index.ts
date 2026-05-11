/**
 * pi-session-title — Shows session name in the iTerm/terminal title bar.
 *
 * Updates the terminal title on session start and after each agent turn
 * (when the LLM generates a session name from the first prompt).
 *
 * Format: "session-name — cwd"  (or just cwd when no name is set yet)
 */

import type { ExtensionAPI, AgentEndEvent, ExtensionContext, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { basename } from "node:path";

export default function (pi: ExtensionAPI) {
	function updateTitle(ctx: ExtensionContext): void {
		// agent_end is queued asynchronously inside the agent session and can be
		// processed after the runtime has invalidated the ctx on exit (notably
		// `pi -p "..."` single-shot mode, where disposeRuntime() runs as soon as
		// session.prompt() resolves — possibly before the agent_end handler is
		// dequeued). Once invalidated, every pi/ctx API throws the
		// "stale after session replacement or reload" error. Title updates are
		// cosmetic — swallow that specific race and rethrow anything else.
		try {
			const name = pi.getSessionName();
			const dirName = basename(ctx.cwd);

			if (name) {
				ctx.ui.setTitle(`${name} — ${dirName}`);
			} else {
				ctx.ui.setTitle(dirName);
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (!msg.includes("stale after session replacement or reload")) {
				throw err;
			}
		}
	}

	// Set title immediately on session start (shows cwd, name will update after first turn)
	pi.on("session_start", (_: SessionStartEvent, ctx) => {
		updateTitle(ctx);
	});

	// Update title after each agent turn — catches when the LLM generates the session name
	pi.on("agent_end", (_: AgentEndEvent, ctx) => {
		updateTitle(ctx);
	});
}
