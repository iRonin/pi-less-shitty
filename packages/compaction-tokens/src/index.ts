/**
 * compaction-tokens — Runtime patch: show result token count in compaction UI.
 *
 * Patches `compaction-summary-message.js` to display both before and after
 * token counts: "Compacted from 264,779 → 12,345 tokens".
 */
import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

function findPiDistDir(): string | null {
  const candidates = [
    "/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/dist",
    "/usr/local/lib/node_modules/@mariozechner/pi-coding-agent/dist",
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "modes", "interactive", "interactive-mode.js"))) return c;
  }
  return null;
}

const MARKER = "→ ${afterStr} tokens";

function patchCompactionSummary(distDir: string): "patched" | "already" | "failed" {
  const filePath = path.join(distDir, "modes", "interactive", "components", "compaction-summary-message.js");
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return "failed";
  }

  if (content.includes(MARKER)) return "already";

  const patchPath = path.join(__dirname, "..", "patches", "compaction-summary-message.js");
  if (fs.existsSync(patchPath)) {
    try {
      fs.copyFileSync(patchPath, filePath);
      return "patched";
    } catch {
      return "failed";
    }
  }

  return "failed";
}

export default function (pi: ExtensionAPI) {
  const distDir = findPiDistDir();
  if (distDir) {
    const result = patchCompactionSummary(distDir);
    if (result === "patched") console.error("[compaction-tokens] patched compaction-summary-message.js");
    else if (result === "already") console.error("[compaction-tokens] already patched");
    else console.error("[compaction-tokens] failed to patch");
  }

  pi.on("session_start", async (_event, ctx) => {
    const d = ctx.piInstallDir ?? findPiDistDir();
    if (d) patchCompactionSummary(d);
  });
}
