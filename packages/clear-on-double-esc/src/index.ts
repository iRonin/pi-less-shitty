/**
 * Double-Esc to clear the pi editor input.
 *
 * Press Esc twice within 500 ms while the editor has content to clear it.
 * The first Esc passes through normally so autocomplete dismissal still works.
 * Only the second Esc within the window is consumed.
 *
 * Works with both legacy terminals (\x1b) and the Kitty keyboard protocol
 * (\x1b[27;1:1u), and ignores key-release events sent by Kitty.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isKeyRelease, matchesKey } from "@mariozechner/pi-tui";

const DOUBLE_ESC_WINDOW_MS = 500;

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;

    let lastEscAt = 0;

    // Reset the double-press window between agent runs to avoid
    // a stale first-Esc timestamp accidentally triggering a clear.
    pi.on("agent_start", () => {
      lastEscAt = 0;
    });

    ctx.ui.onTerminalInput((data) => {
      // Ignore key-release events (Kitty protocol sends both press and release).
      if (isKeyRelease(data)) return undefined;
      if (!matchesKey(data, "escape")) return undefined;

      const now = Date.now();
      const text = ctx.ui.getEditorText();

      if (text.length > 0 && now - lastEscAt < DOUBLE_ESC_WINDOW_MS) {
        lastEscAt = 0;
        ctx.ui.setEditorText("");
        return { consume: true };
      }

      lastEscAt = now;
      return undefined; // first Esc passes through normally
    });
  });
}
