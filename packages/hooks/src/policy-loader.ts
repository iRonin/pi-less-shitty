/**
 * HOOKS-POLICY.md cascade loader.
 *
 * Walks from `startDir` upward to (and including) the user's home directory,
 * collecting any `HOOKS-POLICY.md` file along the way. Returns the
 * concatenated markdown in root → leaf order so the innermost (closest to
 * cwd) policy gets the last word when the LLM reads it.
 *
 * Properties enforced:
 *   - Pure cascading. No globs, no symlink-following, no parent-of-home
 *     traversal. Bounded by `boundary` (default = $HOME).
 *   - Hard byte-cap on the *aggregated* output. Oversized cascades return
 *     truncated text with an explicit warning so the LLM never sees a
 *     silently clipped policy.
 *   - Hard size-cap on individual files to keep one malicious / runaway
 *     file from saturating the budget.
 *   - Symlink-loop safe via realpath set; ENOENT / EACCES on any file is
 *     non-fatal — that file is simply skipped and recorded under `errors`.
 *   - Pure / side-effect-free. Callers cache as they wish.
 *
 * This loader does NOT enforce anything. It only produces text that other
 * components inject into the agent system prompt and the LLM judge prompt.
 * Hard safety rules live in `index.ts` (Tier 1 invariants) and
 * `.pi-hooks.json` (deterministic Tier 2). See HOOKS-POLICY.md design doc.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ============================================================================
// Constants
// ============================================================================

export const POLICY_FILENAME = "HOOKS-POLICY.md";

/** Max bytes for any single file before it's truncated and flagged. */
export const MAX_FILE_BYTES = 16 * 1024;

/** Max bytes for the aggregated cascade output (sum of all files + headers). */
export const MAX_CASCADE_BYTES = 32 * 1024;

/** Hard ceiling on directories walked, defence-in-depth against weird FS. */
export const MAX_DIRS_WALKED = 32;

// ============================================================================
// Types
// ============================================================================

export interface PolicyFile {
  /** Absolute, realpath-resolved path. */
  path: string;
  /** Raw bytes read (post-truncation if applicable). */
  bytes: number;
  /** True if file exceeded MAX_FILE_BYTES and was truncated. */
  truncated: boolean;
}

export interface PolicyCascade {
  /** Concatenated markdown in root → leaf order with per-file headers. */
  text: string;
  /** Files actually included, in cascade order (root first, leaf last). */
  files: PolicyFile[];
  /** Total bytes of concatenated `text`. */
  bytes: number;
  /** True if cascade was clipped at MAX_CASCADE_BYTES. */
  truncated: boolean;
  /** Non-fatal warnings (file read errors, oversize files, etc.). */
  warnings: string[];
}

export interface LoadOptions {
  /** Directory to stop walking AT (inclusive). Default: os.homedir(). */
  boundary?: string;
  /** Filesystem implementation, for tests. */
  fs?: Pick<typeof fs, "readFileSync" | "statSync" | "realpathSync">;
  /** Override home directory, for tests. */
  homedir?: () => string;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Walk from `startDir` upward, collecting HOOKS-POLICY.md files.
 *
 * Boundary semantics: walk continues *through* boundary and stops AFTER
 * processing boundary. So `~/Work/Pi-Agent/pkg/foo` with boundary=`~`
 * inspects: …/foo, …/pkg, …/Pi-Agent, …/Work, ~. Then stops.
 *
 * If startDir is OUTSIDE boundary (e.g. `/tmp` when boundary=`~`), we walk
 * `/tmp` and stop — no traversal up to `/`. This prevents the loader from
 * sneaking into the user's home from an unrelated cwd.
 */
export function loadPolicyCascade(startDir: string, opts: LoadOptions = {}): PolicyCascade {
  const fsImpl = opts.fs ?? fs;
  const home = opts.homedir ? opts.homedir() : os.homedir();
  const boundary = path.resolve(opts.boundary ?? home);

  const warnings: string[] = [];

  // Resolve startDir; on failure return empty cascade with a warning.
  let cwd: string;
  try {
    cwd = path.resolve(startDir);
  } catch (err) {
    return {
      text: "",
      files: [],
      bytes: 0,
      truncated: false,
      warnings: [`policy-loader: cannot resolve startDir: ${(err as Error).message}`],
    };
  }

  const startInsideBoundary = isWithin(cwd, boundary);
  const seenReal = new Set<string>();

  // Walk dirs from cwd up. Collected in leaf → root order; reversed at end.
  const collected: PolicyFile[] = [];
  let dir = cwd;
  let dirsWalked = 0;

  while (true) {
    dirsWalked++;
    if (dirsWalked > MAX_DIRS_WALKED) {
      warnings.push(`policy-loader: dir walk exceeded ${MAX_DIRS_WALKED}, stopping`);
      break;
    }

    const filePath = path.join(dir, POLICY_FILENAME);
    const file = tryReadPolicyFile(filePath, fsImpl, seenReal, warnings);
    if (file) collected.push(file);

    // Stop conditions: we just processed boundary, or we hit the filesystem
    // root, or (when startDir is outside boundary) we've moved up one level.
    if (dir === boundary) break;
    if (!startInsideBoundary) break;

    const parent = path.dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }

  // Reverse to root → leaf order.
  collected.reverse();

  // Concatenate with size cap.
  const parts: string[] = [];
  const included: PolicyFile[] = [];
  let total = 0;
  let cascadeTruncated = false;

  for (const f of collected) {
    let content: string;
    try {
      const raw = fsImpl.readFileSync(f.path, "utf-8");
      content = f.truncated ? raw.slice(0, MAX_FILE_BYTES) + "\n\n[…truncated…]\n" : raw;
    } catch (err) {
      warnings.push(`policy-loader: read failed for ${f.path}: ${(err as Error).message}`);
      continue;
    }

    const header = `\n<!-- ${f.path} -->\n`;
    const block = header + content + (content.endsWith("\n") ? "" : "\n");

    if (total + block.length > MAX_CASCADE_BYTES) {
      const CLIP_MARKER = "\n[…cascade clipped…]\n";
      const markerBytes = Buffer.byteLength(CLIP_MARKER, "utf-8");
      const room = MAX_CASCADE_BYTES - total;
      if (room > header.length + markerBytes) {
        const bodyRoom = room - header.length - markerBytes;
        const truncatedBlock = header + content.slice(0, bodyRoom) + CLIP_MARKER;
        parts.push(truncatedBlock);
        total += Buffer.byteLength(truncatedBlock, "utf-8");
      }
      cascadeTruncated = true;
      warnings.push(`policy-loader: cascade clipped at ${MAX_CASCADE_BYTES} bytes`);
      included.push(f);
      break;
    }

    parts.push(block);
    total += block.length;
    included.push(f);
  }

  const text = parts.join("");

  return {
    text,
    files: included,
    bytes: Buffer.byteLength(text, "utf-8"),
    truncated: cascadeTruncated,
    warnings,
  };
}

/**
 * Convenience: returns true if the cascade has any policy files.
 */
export function hasPolicy(cascade: PolicyCascade): boolean {
  return cascade.files.length > 0;
}

// ============================================================================
// Internals
// ============================================================================

function isWithin(child: string, ancestor: string): boolean {
  const rel = path.relative(ancestor, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function tryReadPolicyFile(
  filePath: string,
  fsImpl: Pick<typeof fs, "readFileSync" | "statSync" | "realpathSync">,
  seenReal: Set<string>,
  warnings: string[],
): PolicyFile | null {
  let stat: fs.Stats;
  try {
    stat = fsImpl.statSync(filePath);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== "ENOENT") {
      warnings.push(`policy-loader: stat failed for ${filePath}: ${e.message}`);
    }
    return null;
  }

  if (!stat.isFile()) {
    warnings.push(`policy-loader: ${filePath} exists but is not a regular file, skipping`);
    return null;
  }

  // Resolve realpath to dedupe symlinks. If realpath fails, fall back to
  // the lexical path — better to maybe-include than to drop policy silently.
  let realPath: string;
  try {
    realPath = fsImpl.realpathSync(filePath);
  } catch {
    realPath = filePath;
  }

  if (seenReal.has(realPath)) return null;
  seenReal.add(realPath);

  const truncated = stat.size > MAX_FILE_BYTES;
  if (truncated) {
    warnings.push(`policy-loader: ${filePath} (${stat.size}B) exceeds ${MAX_FILE_BYTES}B, truncating`);
  }

  return {
    path: realPath,
    bytes: Math.min(stat.size, MAX_FILE_BYTES),
    truncated,
  };
}
