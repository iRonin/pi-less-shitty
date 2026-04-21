/**
 * Name collision detector — warns when agents and skills share the same name.
 *
 * When an agent (`.pi/agents/<name>.md`) and a skill (`.pi/skills/<name>/SKILL.md`)
 * have the same name, pi's resource loading can silently shadow one or cause
 * confusing resolution behavior in subagent skill injection.
 *
 * This extension checks at session_start and logs warnings for every collision.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { loadSkills } from "@mariozechner/pi-coding-agent";

interface NamedResource {
	name: string;
	source: string;
	path: string;
}

/**
 * Discover all agent names from a directory of .md files.
 */
function discoverAgentNames(dir: string): NamedResource[] {
	if (!fs.existsSync(dir)) return [];
	const agents: NamedResource[] = [];
	try {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			if (entry.isFile() && entry.name.endsWith(".md")) {
				agents.push({
					name: entry.name.replace(/\.md$/, ""),
					source: "agent",
					path: path.join(dir, entry.name),
				});
			}
		}
	} catch {
		// Directory unreadable — skip silently
	}
	return agents;
}

/**
 * Discover all skill names from a directory using pi-core's loader.
 */
function discoverSkillNames(dir: string, cwd: string): NamedResource[] {
	if (!fs.existsSync(dir)) return [];
	try {
		const result = loadSkills({ cwd, skillPaths: [dir], includeDefaults: false });
		return result.skills.map((s) => ({
			name: s.name,
			source: "skill",
			path: s.filePath,
		}));
	} catch {
		return [];
	}
}

/**
 * Check for name collisions between agents and skills across all scopes.
 */
function checkCollisions(cwd: string): { agentName: string; agentPath: string; skillPath: string }[] {
	const CONFIG_DIR = ".pi";
	const agentDir = getAgentDir();

	// Collect agents from all scopes
	const allAgents: NamedResource[] = [
		...discoverAgentNames(path.join(agentDir, "agents")),             // ~/.pi/agent/agents/
		...discoverAgentNames(path.join(cwd, CONFIG_DIR, "agents")),      // cwd/.pi/agents/
	];

	// Collect skills from all scopes
	const allSkills: NamedResource[] = [
		...discoverSkillNames(path.join(agentDir, "skills"), cwd),        // ~/.pi/agent/skills/
		...discoverSkillNames(path.join(cwd, CONFIG_DIR, "skills"), cwd), // cwd/.pi/skills/
	];

	// Build a set of skill names
	const skillNames = new Map<string, string>();
	for (const skill of allSkills) {
		skillNames.set(skill.name.toLowerCase(), skill.path);
	}

	// Find collisions
	const collisions: { agentName: string; agentPath: string; skillPath: string }[] = [];
	for (const agent of allAgents) {
		const skillPath = skillNames.get(agent.name.toLowerCase());
		if (skillPath) {
			collisions.push({
				agentName: agent.name,
				agentPath: agent.path,
				skillPath,
			});
		}
	}

	return collisions;
}

export function register(pi: any) {
	pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
		const cwd = ctx.cwd || process.cwd();
		const collisions = checkCollisions(cwd);

		if (collisions.length === 0) return;

		const warnLines = [
			`⚠️ Agent/skill name collision detected (${collisions.length}):`,
			"",
			...collisions.map((c) =>
				`  • "${c.agentName}" is both an agent and a skill:\n` +
				`    Agent: ${c.agentPath}\n` +
				`    Skill: ${c.skillPath}`
			),
			"",
			"Rename one to avoid resolution conflicts.",
		];

		console.error(`[name-collision] ${warnLines.join("\n")}`);

		if (ctx.hasUI && ctx.ui.setStatus) {
			ctx.ui.setStatus("name-collision", `⚠️ ${collisions.length} agent/skill name collision(s)`);
		}
	});

	// Clear status on shutdown
	pi.on("session_shutdown", () => {
		// Status auto-cleared when pi exits
	});
}
