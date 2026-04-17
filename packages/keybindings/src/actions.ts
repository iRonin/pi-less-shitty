import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { ActionName, Binding, ThinkingLevel, When } from "./types.ts";

// ---------------------------------------------------------------------------
// Action metadata (used by wizard to build selector)
// ---------------------------------------------------------------------------

export interface ActionMeta {
  label: string;
  description: string;
  /** Names of params the wizard should prompt for */
  paramFields: ParamField[];
}

export interface ParamField {
  name: string;
  label: string;
  type: "text" | "select";
  options?: string[]; // for select
}

export const ACTIONS: Record<ActionName, ActionMeta> = {
  clearEditor: {
    label: "Clear editor",
    description: "Erase all text in the input editor",
    paramFields: [],
  },
  insertText: {
    label: "Insert text",
    description: "Set editor to a preset text snippet",
    paramFields: [{ name: "text", label: "Text to insert", type: "text" }],
  },
  abort: {
    label: "Abort",
    description: "Abort the currently running agent operation",
    paramFields: [],
  },
  compact: {
    label: "Compact context",
    description: "Trigger context compaction",
    paramFields: [],
  },
  setThinkingLevel: {
    label: "Set thinking level",
    description: "Switch to a fixed thinking level",
    paramFields: [
      {
        name: "level",
        label: "Thinking level",
        type: "select",
        options: ["off", "minimal", "low", "medium", "high", "xhigh"],
      },
    ],
  },
  cycleThinking: {
    label: "Cycle thinking level",
    description: "Step thinking level up or down",
    paramFields: [
      {
        name: "direction",
        label: "Direction",
        type: "select",
        options: ["up", "down"],
      },
    ],
  },
  fork: {
    label: "Fork session",
    description: "Fork the current session",
    paramFields: [],
  },
  newSession: {
    label: "New session",
    description: "Start a new session",
    paramFields: [],
  },
  tree: {
    label: "Show tree",
    description: "Open the session tree selector",
    paramFields: [],
  },
  resume: {
    label: "Resume session",
    description: "Open the session resume selector",
    paramFields: [],
  },
  exec: {
    label: "Run slash command",
    description: "Inject and submit a slash command",
    paramFields: [{ name: "command", label: "Command (e.g. /compact)", type: "text" }],
  },
  shutdown: {
    label: "Shutdown pi",
    description: "Gracefully shut down pi",
    paramFields: [],
  },
};

// ---------------------------------------------------------------------------
// When condition
// ---------------------------------------------------------------------------

export function checkWhen(when: When | undefined, ctx: ExtensionContext): boolean {
  switch (when ?? "always") {
    case "always":    return true;
    case "hasContent": return ctx.ui.getEditorText().length > 0;
    case "isEmpty":   return ctx.ui.getEditorText().trim().length === 0;
    case "idle":      return ctx.isIdle();
  }
}

// ---------------------------------------------------------------------------
// Action executor
// Must be synchronous — called from TerminalInputHandler.
// Returns what the input handler should return to the TUI.
// ---------------------------------------------------------------------------

export interface ActionResult {
  /** Consume the key press entirely */
  consume: boolean;
  /** Replace the key data (used to inject Enter for slash-command actions) */
  data?: string;
}

const THINKING_LEVELS: ThinkingLevel[] = [
  "off", "minimal", "low", "medium", "high", "xhigh",
];

export function executeAction(
  binding: Binding,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): ActionResult {
  const p = (binding.params ?? {}) as Record<string, unknown>;

  switch (binding.action) {
    case "clearEditor":
      ctx.ui.setEditorText("");
      return { consume: true };

    case "insertText":
      ctx.ui.setEditorText(String(p["text"] ?? ""));
      return { consume: true };

    case "abort":
      ctx.abort();
      return { consume: true };

    case "compact":
      ctx.compact();
      return { consume: true };

    case "shutdown":
      ctx.shutdown();
      return { consume: true };

    case "setThinkingLevel": {
      const level = String(p["level"] ?? "medium") as ThinkingLevel;
      pi.setThinkingLevel(level);
      ctx.ui.notify(`Thinking: ${level}`, "info");
      return { consume: true };
    }

    case "cycleThinking": {
      const dir = p["direction"] === "down" ? -1 : 1;
      const current = pi.getThinkingLevel() as ThinkingLevel;
      const idx = THINKING_LEVELS.indexOf(current);
      const next = THINKING_LEVELS[Math.max(0, Math.min(THINKING_LEVELS.length - 1, idx + dir))];
      if (next) {
        pi.setThinkingLevel(next);
        ctx.ui.notify(`Thinking: ${next}`, "info");
      }
      return { consume: true };
    }

    // Injection-based: set editor text to a slash command, return "\r" so
    // the TUI processes it as Enter and submits the command.
    case "fork":      return inject("/fork");
    case "newSession": return inject("/new");
    case "tree":      return inject("/tree");
    case "resume":    return inject("/resume");
    case "exec":      return inject(String(p["command"] ?? ""));

    default:
      return { consume: true };
  }
}

function inject(command: string): ActionResult {
  // Setting the editor text is synchronous; returning { data: "\r" } causes
  // the TUI to process "\r" (Enter) against the editor which now holds
  // the command — submitting it as if the user typed and pressed Enter.
  return { consume: false, data: "\r" };
}

// We need to set editor text before returning — but this function is called
// from within the input handler closure which has ctx. Wrap inject to accept ctx.
export function executeActionWithCtx(
  binding: Binding,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): ActionResult {
  const p = (binding.params ?? {}) as Record<string, unknown>;

  if (
    binding.action === "fork" ||
    binding.action === "newSession" ||
    binding.action === "tree" ||
    binding.action === "resume" ||
    binding.action === "exec"
  ) {
    const commands: Record<string, string> = {
      fork: "/fork",
      newSession: "/new",
      tree: "/tree",
      resume: "/resume",
      exec: String(p["command"] ?? ""),
    };
    ctx.ui.setEditorText(commands[binding.action] ?? "");
    return { consume: false, data: "\r" };
  }

  return executeAction(binding, pi, ctx);
}
