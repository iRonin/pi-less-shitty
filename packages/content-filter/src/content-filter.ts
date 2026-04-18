/**
 * Content Filter Extension for Pi
 *
 * Sanitizes profanity and unwanted content from:
 *   - User prompts (input event)
 *   - Tool results like hindsight recall (tool_result event)
 *   - System prompt injection (before_agent_start event, optional)
 *
 * Patterns use glob-style wildcards:
 *   *  — zero or more characters (f*ck → fuck, fck, fuuck)
 *   ?  — exactly one character (sh?t → shit, shat, sht)
 *
 * Per-pattern replacements via config:
 *   "WTF": "why"
 *   "dumb f*ck": "idiot"
 *   null → uses defaultReplacement (default: "[filtered]")
 *
 * Config: ~/.pi/agent/content-filter.json (global)
 *         <cwd>/.content-filter (project-level, appends to global)
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  InputEvent,
  InputEventResult,
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ToolResultEvent,
} from "@mariozechner/pi-coding-agent";
import { compileFilter, sanitize, detectMatches, type CompiledFilter } from "./filter.js";
import { loadConfig, toFilterConfig, type ContentFilterConfig } from "./config.js";

// ── Extension ────────────────────────────────────────────────────────────────

export default function contentFilterExtension(pi: ExtensionAPI) {
  let config: ContentFilterConfig | null = null;
  let filter: CompiledFilter | null = null;

  /** Lazy-load config + compiled filter. */
  function ensure(cwd: string): boolean {
    if (config && filter) return config.enabled;
    config = loadConfig(cwd);
    if (!config.enabled) return false;
    filter = compileFilter(toFilterConfig(config));
    return true;
  }

  // ── session_start: reset config cache (allows runtime reload) ────────

  pi.on("session_start", async (_event, ctx) => {
    config = null;
    filter = null;
  });

  // ── input: sanitize user prompts before processing ───────────────────

  pi.on("input", async (event: InputEvent, ctx: ExtensionContext): Promise<InputEventResult | void> => {
    if (!ensure(ctx.cwd)) return;
    if (!config!.events.input) return;

    const sanitized = sanitize(event.text, filter!);
    if (sanitized === event.text) return; // no matches

    if (config!.logMatches) {
      const matched = detectMatches(event.text, filter!);
      console.log(`[content-filter] input: ${matched.length} pattern(s) hit: ${matched.join(", ")}`);
    }

    return { action: "transform", text: sanitized, images: event.images };
  });

  // ── tool_result: filter hindsight recall, file reads, etc. ────────────

  pi.on("tool_result", async (event: ToolResultEvent, ctx: ExtensionContext) => {
    if (!ensure(ctx.cwd)) return;
    if (!config!.events.toolResult) return;

    // Only filter text content
    if (!Array.isArray(event.content)) return;

    let modified = false;
    const newContent = event.content.map((part) => {
      if (part.type !== "text" || typeof part.text !== "string") return part;
      const sanitized = sanitize(part.text, filter!);
      if (sanitized !== part.text) {
        modified = true;
        return { ...part, text: sanitized };
      }
      return part;
    });

    if (!modified) return;

    if (config!.logMatches) {
      const fullText = event.content
        .filter((c) => c.type === "text")
        .map((c) => (c as any).text ?? "")
        .join("\n");
      const matched = detectMatches(fullText, filter!);
      if (matched.length > 0) {
        console.log(
          `[content-filter] tool_result(${event.toolName}): ${matched.length} pattern(s) hit: ${matched.join(", ")}`
        );
      }
    }

    return { content: newContent, isError: event.isError };
  });

  // ── before_agent_start: inject sanitization instruction ──────────────

  pi.on(
    "before_agent_start",
    async (event: BeforeAgentStartEvent, ctx: ExtensionContext): Promise<BeforeAgentStartEventResult | void> => {
      if (!ensure(ctx.cwd)) return;
      if (!config!.events.beforeAgentStart) return;

      return {
        systemPrompt:
          event.systemPrompt +
          "\n\n[Content Filter Active]\n" +
          "If any prior conversation content or tool results contain text matching filtered patterns, " +
          "treat those sections as redacted and do not reproduce or reference them. " +
          "The user's input has already been sanitized — respond naturally.\n",
      };
    }
  );
}
