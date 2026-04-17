/**
 * pi-keybindings
 *
 * Configurable key bindings for pi — bind keys (single or double press)
 * to built-in actions via an interactive wizard.
 *
 * Commands:
 *   /keybindings         — list configured bindings
 *   /keybindings add     — add a binding via interactive wizard
 *   /keybindings remove  — remove a binding
 *   /keybindings config  — show path to config file
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isKeyRelease, matchesKey, type KeyId } from "@mariozechner/pi-tui";
import { ACTIONS, checkWhen, executeActionWithCtx } from "./src/actions.ts";
import {
  CONFIG_PATH,
  clearConfigCache,
  getCachedConfig,
  loadConfig,
} from "./src/config.ts";
import { formatBinding, runAddWizard, runRemoveWizard } from "./src/wizard.ts";

export default function piKeybindings(pi: ExtensionAPI) {
  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  // When true, the main input handler defers so the wizard's one-shot
  // key-capture handler can intercept the next press without triggering an action.
  let captureMode = false;

  const setCaptureMode = (on: boolean) => {
    captureMode = on;
  };

  // Track the last press time per raw data string for double-press detection.
  // Keyed by raw terminal data so different Esc sequences don't cross-contaminate.
  // Cleared on agent_start so a stale first-press doesn't fire on the next message.
  const lastPressAt = new Map<string, number>();

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  pi.on("session_start", (_event, ctx) => {
    lastPressAt.clear();
    clearConfigCache();

    if (!ctx.hasUI) return;

    // Warm the cache now (async) so it's ready for the synchronous input handler.
    void loadConfig().catch(() => {});

    ctx.ui.onTerminalInput((data) => {
      if (captureMode) return undefined;
      if (isKeyRelease(data)) return undefined;

      // getCachedConfig() is synchronous — populated by the warm-up above.
      // If the cache isn't ready yet (very rare race on first session_start),
      // we simply skip — the next key press will hit the warm cache.
      const config = getCachedConfig();
      if (!config?.bindings.length) return undefined;

      const windowMs = config.windowMs ?? 500;
      const now = Date.now();

      // Find all bindings whose key matches this input.
      const candidates = config.bindings.filter((b) => matchesKey(data, b.key as KeyId));
      if (!candidates.length) return undefined;

      const lastAt = lastPressAt.get(data) ?? 0;
      const isDouble = now - lastAt < windowMs;

      // Prefer the double-press binding; fall back to single-press.
      const binding =
        candidates.find((b) => b.double && isDouble && checkWhen(b.when, ctx)) ??
        candidates.find((b) => !b.double && checkWhen(b.when, ctx));

      if (!binding) {
        // No binding fired — still track for double-press on the next press.
        if (candidates.some((b) => b.double)) {
          lastPressAt.set(data, now);
        }
        return undefined;
      }

      if (binding.double && !isDouble) {
        // First press of a potential double — track timestamp, pass through.
        lastPressAt.set(data, now);
        return undefined;
      }

      // Action fires — clear timestamp and execute.
      lastPressAt.delete(data);
      const result = executeActionWithCtx(binding, pi, ctx);
      if (result.data !== undefined) return { data: result.data };
      if (result.consume) return { consume: true };
      return undefined;
    });
  });

  // Clear stale double-press timestamps between agent runs.
  pi.on("agent_start", () => {
    lastPressAt.clear();
  });

  // ---------------------------------------------------------------------------
  // /keybindings command
  // ---------------------------------------------------------------------------

  pi.registerCommand("keybindings", {
    description: "List bindings, or: /keybindings add | remove | config",
    handler: async (args, ctx) => {
      const sub = args?.trim().toLowerCase();

      if (sub === "add") {
        await runAddWizard(pi, ctx, setCaptureMode);
        clearConfigCache();
        void loadConfig().catch(() => {}); // re-warm
        return;
      }

      if (sub === "remove") {
        await runRemoveWizard(ctx);
        clearConfigCache();
        void loadConfig().catch(() => {});
        return;
      }

      if (sub === "config") {
        ctx.ui.notify(`Config file: ${CONFIG_PATH}`, "info");
        return;
      }

      // Default: list all bindings.
      const config = await loadConfig();

      if (!config.bindings.length) {
        ctx.ui.notify(
          [
            "No bindings configured.",
            "Run /keybindings add to create one.",
            `Config: ${CONFIG_PATH}`,
          ].join("\n"),
          "info",
        );
        return;
      }

      const lines = [
        `${config.bindings.length} binding(s)  |  window: ${config.windowMs ?? 500} ms`,
        "",
        ...config.bindings.map((b, i) => formatBinding(b, i)),
        "",
        "Actions: " + Object.keys(ACTIONS).join(", "),
        "Edit: /keybindings add | remove",
      ];

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
