/**
 * Cascading Skills Extension for pi
 *
 * Walks parent directories from CWD upward, collecting skills from every
 * `.pi/` and `.agents/` level it finds. Solves pi's array-replacement
 * behavior for skills settings.
 *
 * Pi replaces (not merges) array-type settings like `skills`. A project-level
 * skill array completely overrides the global one. This extension bridges
 * that gap by re-discovering skills from every ancestor `.pi/` and `.agents/`
 * at startup/reload and returning them via the `resources_discover` event.
 *
 * All returned paths are deduplicated by realpath and constrained under HOME.
 * Symlink resolution and a 30-level traversal cap prevent misuse.
 *
 * @see https://github.com/iRonin/pi-cascading-skills
 */

import type { ExtensionAPI, ResourcesDiscoverEvent, ResourcesDiscoverResult } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HOME = fs.realpathSync(process.env.HOME ?? "/");
const MAX_TRAVERSE = 30;

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

/** Resolve a path to its canonical form. Returns null if it doesn't exist. */
function safeRealpath(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/** Check whether `candidate` is inside (or equal to) `root`. */
function isUnder(candidate: string, root: string): boolean {
  return candidate === root || (candidate + "/").startsWith(root + "/");
}

/** Read and parse a JSON file. Returns undefined on any error. */
function readJson(filePath: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Parent-directory traversal
// ---------------------------------------------------------------------------

/**
 * Yield parent directories from `start` upward, stopping at HOME.
 * All results are realpath'd. Yields nothing if `start` is outside HOME.
 */
function* walkParents(start: string): Generator<string> {
  let dir = path.resolve(start);
  if (dir !== HOME && !isUnder(dir, HOME)) return;

  for (let i = 0; i < MAX_TRAVERSE; i++) {
    const canon = safeRealpath(dir);
    if (canon) yield canon;

    const parent = path.dirname(dir);
    if (parent === dir || parent === HOME) break;
    dir = parent;
  }
}

// ---------------------------------------------------------------------------
// Skill-directory scanning
// ---------------------------------------------------------------------------

/**
 * Scan a skills directory for skill sub-directories.
 *
 * Pi's loader expects *directory* paths, not SKILL.md file paths.
 * Two layouts are supported:
 *   - Sub-directory: `$dir/<name>/SKILL.md` → returns `$dir/<name>`
 *   - Flat:          `$dir/SKILL.md`        → returns `$dir`
 */
function collectSkillsDir(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const results: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory() || entry.isSymbolicLink()) {
      const subPath = path.join(dir, entry.name);
      const realSub = safeRealpath(subPath);
      if (realSub && isUnder(realSub, HOME) && fs.existsSync(path.join(realSub, "SKILL.md"))) {
        results.push(realSub);
      }
      continue;
    }

    // Flat layout: SKILL.md lives directly in $dir
    if (entry.name === "SKILL.md" && entry.isFile()) {
      const canon = safeRealpath(dir);
      if (canon) results.push(canon);
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Settings-array resolution
// ---------------------------------------------------------------------------

/**
 * Take the raw `skills` array from a settings.json and return realpath'd
 * absolute paths that lie under HOME.
 *
 * Relative entries are resolved against the `.pi` / `.agents` dir that owns
 * the settings file. `~` entries expand against the captured HOME constant.
 */
function resolveSkillArray(skills: unknown, baseDir: string): string[] {
  if (!Array.isArray(skills)) return [];

  const out: string[] = [];
  for (const entry of skills) {
    if (typeof entry !== "string") continue;
    let p = entry === "~" ? HOME : entry.startsWith("~/") ? path.join(HOME, entry.slice(2)) : entry;

    if (!path.isAbsolute(p)) p = path.resolve(baseDir, p);

    const canon = safeRealpath(p);
    if (canon && isUnder(canon, HOME)) out.push(canon);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Skill-entry processing
// ---------------------------------------------------------------------------

function addUnique(p: string, seen: Set<string>, out: string[]): void {
  if (seen.has(p)) return;
  seen.add(p);
  out.push(p);
}

/**
 * Classify a resolved path:
 *   - Contains SKILL.md → add it directly
 *   - Otherwise         → scan it as a skill container
 */
function processEntry(p: string, seen: Set<string>, out: string[]): void {
  try {
    if (!fs.statSync(p).isDirectory()) return;

    if (fs.existsSync(path.join(p, "SKILL.md"))) {
      const canon = safeRealpath(p);
      if (canon) addUnique(canon, seen, out);
      return;
    }

    for (const skill of collectSkillsDir(p)) {
      addUnique(skill, seen, out);
    }
  } catch {
    // disappeared between resolve and stat — skip
  }
}

// ---------------------------------------------------------------------------
// Main discovery
// ---------------------------------------------------------------------------

/** Collect all cascading skill directories for a given CWD. */
function discoverSkills(cwd: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  // — Global sources —

  // 1. ~/.pi/agent/skills/  (pi's built-in global skill directory)
  for (const s of collectSkillsDir(path.join(HOME, ".pi", "agent", "skills"))) {
    addUnique(s, seen, out);
  }

  // 2. ~/.pi/agent/settings.json → skills array
  const globalSettings = readJson(path.join(HOME, ".pi", "agent", "settings.json"));
  if (globalSettings?.skills) {
    for (const p of resolveSkillArray(globalSettings.skills, path.join(HOME, ".pi", "agent"))) {
      processEntry(p, seen, out);
    }
  }

  // 3. ~/.agents/skills/  (shared Agent Skills standard directory)
  for (const s of collectSkillsDir(path.join(HOME, ".agents", "skills"))) {
    addUnique(s, seen, out);
  }

  // — Per-ancestor sources (walk up from CWD to HOME) —

  for (const parentDir of walkParents(cwd)) {
    // .pi/skills/  and  .pi/settings.json → skills
    const piDir = path.join(parentDir, ".pi");
    if (fs.existsSync(piDir) && fs.statSync(piDir).isDirectory()) {
      for (const s of collectSkillsDir(path.join(piDir, "skills"))) {
        addUnique(s, seen, out);
      }
      const settings = readJson(path.join(piDir, "settings.json"));
      if (settings?.skills) {
        for (const p of resolveSkillArray(settings.skills, piDir)) {
          processEntry(p, seen, out);
        }
      }
    }

    // .agents/skills/  (shared Agent Skills standard directory)
    const agentsSkills = path.join(parentDir, ".agents", "skills");
    for (const s of collectSkillsDir(agentsSkills)) {
      addUnique(s, seen, out);
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  pi.on("resources_discover", async (event: ResourcesDiscoverEvent): Promise<ResourcesDiscoverResult> => {
    return { skillPaths: discoverSkills(event.cwd) };
  });
}
