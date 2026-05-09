/**
 * Double-Esc to clear the pi editor input.
 *
 * Press Esc twice within 500 ms while the editor has content to clear it.
 * The first Esc passes through normally so autocomplete dismissal still works.
 * Only the second Esc within the window is consumed.
 *
 * Works with both legacy terminals (\x1b) and the Kitty keyboard protocol
 * (\x1b[27;1:1u), and ignores key-release events sent by Kitty.
 *
 * Handler-leak fix: previously `pi.on("agent_start")` and
 * `ctx.ui.onTerminalInput()` were registered inside the session_start
 * callback. After N session_starts, handlers stacked and double-Esc fired
 * N+1 times. Now both handlers are installed once at extension load
 * (agent_start) and on the first session_start with a UI (onTerminalInput);
 * subsequent session_starts only reset state.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, matchesKey } from "@earendil-works/pi-tui";

const DOUBLE_ESC_WINDOW_MS = 500;

export default function (pi: ExtensionAPI) {
  // Module-scope state shared by both lifecycle hooks.
  let lastEscAt = 0;
  let activeCtx: any = null;
  let inputHandlerInstalled = false;

  // Reset the double-press window between agent runs to avoid a stale
  // first-Esc timestamp accidentally triggering a clear.
  pi.on("agent_start", () => {
    lastEscAt = 0;
  });

  pi.on("session_start", (_event, ctx) => {
    // Always reset state on a new session.
    lastEscAt = 0;

    if (!ctx.hasUI) return;
    activeCtx = ctx;

    if (inputHandlerInstalled) return;
    inputHandlerInstalled = true;

    ctx.ui.onTerminalInput((data: string) => {
      // Ignore key-release events (Kitty protocol sends both press and release).
      if (isKeyRelease(data)) return undefined;
      if (!matchesKey(data, "escape")) return undefined;
      if (!activeCtx) return undefined;

      const now = Date.now();
      const text = activeCtx.ui.getEditorText();

      if (text.length > 0 && now - lastEscAt < DOUBLE_ESC_WINDOW_MS) {
        lastEscAt = 0;
        activeCtx.ui.setEditorText("");
        return { consume: true };
      }

      lastEscAt = now;
      return undefined; // first Esc passes through normally
    });
  });
}
