export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type When =
  | "always"       // fire unconditionally
  | "hasContent"   // editor has text
  | "isEmpty"      // editor is empty
  | "idle";        // agent not streaming

export type ActionName =
  | "clearEditor"
  | "insertText"
  | "abort"
  | "compact"
  | "setThinkingLevel"
  | "cycleThinking"
  | "fork"
  | "newSession"
  | "tree"
  | "resume"
  | "exec"
  | "shutdown";

export interface Binding {
  /** pi KeyId: "escape", "ctrl+k", "ctrl+shift+n", etc. */
  key: string;
  /** true = requires two presses within windowMs; false = single press consumes the key */
  double: boolean;
  /** Condition under which the binding fires. Default: "always" */
  when?: When;
  action: ActionName;
  /** Action-specific parameters */
  params?: Record<string, unknown>;
  /** Optional label shown in /keybindings */
  description?: string;
}

export interface KeybindingsConfig {
  version: 1;
  /** Double-press detection window in ms. Default: 500 */
  windowMs?: number;
  bindings: Binding[];
}
