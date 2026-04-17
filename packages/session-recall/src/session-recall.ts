/**
 * Session Recall Extension
 *
 * Prints session ID on exit for easy copy-paste resume.
 * Registers /q (quit), /resume-last, /sessions.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { basename } from "node:path";

function formatTimestamp(ms: number): string {
	const d = new Date(ms);
	return d.toLocaleString("en-GB", {
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	});
}

export default function (pi: ExtensionAPI) {
	// Capture session info on shutdown
	pi.on("session_shutdown", async (_event, ctx) => {
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (!sessionFile) return;

		const sessionId = basename(sessionFile).replace(/\.jsonl$/, "");
		const sessionName = pi.getSessionName();
		const endedAt = formatTimestamp(Date.now());

		// Write to stderr via console.error — pi's TUI teardown doesn't intercept stderr
		console.error(
			`\n📝 Session: ${sessionId}${sessionName ? ` | ${sessionName}` : ""}`,
		);
		console.error(
			`   Ended: ${endedAt}`,
		);
		console.error(
			`   pi --session "${sessionFile}"`,
		);
		console.error(
			`   pi --resume-last`,
		);
	});

	// /q — quick quit
	pi.registerCommand("q", {
		description: "Exit pi",
		handler: async (_args, ctx) => {
			ctx.shutdown();
		},
	});

	// /resume-last — resume the most recent session in this folder
	pi.registerCommand("resume-last", {
		description: "Resume the most recently used pi session in this folder",
		handler: async (_args, ctx) => {
			const sessions = await SessionManager.list(ctx.cwd);

			if (sessions.length === 0) {
				ctx.ui.notify("No sessions found for this folder", "warn");
				return;
			}

			sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());

			const currentSession = ctx.sessionManager.getSessionFile();
			let target = sessions[0];

			if (target.path === currentSession && sessions.length > 1) {
				target = sessions[1];
			} else if (target.path === currentSession) {
				ctx.ui.notify("This is the only session in this folder", "warn");
				return;
			}

			const sessionId = basename(target.path).replace(/\.jsonl$/, "");
			const nameLine = target.name ? ` — ${target.name}` : "";
			const modifiedAt = formatTimestamp(target.modified.getTime());

			const confirmed = await ctx.ui.confirm(
				`Resume session?`,
				`${sessionId}${nameLine}\n   Last active: ${modifiedAt}`,
			);

			if (!confirmed) return;

			await ctx.switchSession(target.path);
		},
	});

	// /sessions — list recent sessions in this folder
	pi.registerCommand("sessions", {
		description: "List recent sessions in this folder and optionally resume one",
		handler: async (args, ctx) => {
			const sessions = await SessionManager.list(ctx.cwd);

			if (sessions.length === 0) {
				ctx.ui.notify("No sessions found for this folder", "warn");
				return;
			}

			sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());

			const limit = Math.min(sessions.length, 15);
			const currentSession = ctx.sessionManager.getSessionFile();

			const lines = sessions.slice(0, limit).map((s, i) => {
				const id = basename(s.path).replace(/\.jsonl$/, "");
				const name = s.name ? ` — ${s.name}` : "";
				const current = s.path === currentSession ? " (current)" : "";
				const modified = formatTimestamp(s.modified.getTime());
				return `${i + 1}. ${id}${name}  (${modified})${current}`;
			});

			const choice = await ctx.ui.select(
				"Recent sessions:",
				lines,
			);

			if (!choice) return;

			const idx = parseInt(choice, 10) - 1;
			if (isNaN(idx) || idx < 0 || idx >= limit) return;

			const target = sessions[idx];
			if (target.path === currentSession) {
				ctx.ui.notify("Already in this session", "info");
				return;
			}

			await ctx.switchSession(target.path);
		},
	});
}
