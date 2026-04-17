import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { isKeyRelease, parseKey, type KeyId } from "@mariozechner/pi-tui";
import { ACTIONS } from "./actions.ts";
import { addBinding, loadConfig, removeBinding } from "./config.ts";
import type { ActionName, Binding, When } from "./types.ts";

const CAPTURE_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Key capture
// ---------------------------------------------------------------------------

/**
 * Wait for the next non-modifier key press and return its KeyId string.
 * Returns null on timeout or if the user presses Escape to cancel.
 */
export function captureNextKey(
  ctx: ExtensionCommandContext,
  onCapturing: () => void,
): Promise<string | null> {
  return new Promise((resolve) => {
    onCapturing();

    const timer = setTimeout(() => {
      unsubscribe();
      resolve(null);
    }, CAPTURE_TIMEOUT_MS);

    const unsubscribe = ctx.ui.onTerminalInput((data) => {
      if (isKeyRelease(data)) return undefined;

      const key = parseKey(data);
      if (!key) return undefined;

      // Skip bare modifier keys — they're not bindable on their own.
      const bare = key.replace(/^(ctrl\+|shift\+|alt\+|meta\+)+/, "");
      if (
        bare === "ctrl" ||
        bare === "shift" ||
        bare === "alt" ||
        bare === "meta"
      ) {
        return undefined;
      }

      clearTimeout(timer);
      unsubscribe();

      if (key === "escape") {
        resolve(null); // treat bare Escape as cancel
      } else {
        resolve(key);
      }

      return { consume: true };
    });
  });
}

// ---------------------------------------------------------------------------
// Add binding wizard
// ---------------------------------------------------------------------------

export async function runAddWizard(
  _pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  setCaptureMode: (on: boolean) => void,
): Promise<void> {
  // 1. Capture key
  setCaptureMode(true);
  const key = await captureNextKey(ctx, () => {
    ctx.ui.notify(
      "Press the key you want to bind (Esc to cancel, 10 s timeout)…",
      "info",
    );
  });
  setCaptureMode(false);

  if (!key) {
    ctx.ui.notify("Cancelled — no key captured.", "info");
    return;
  }

  // 2. Press type
  const pressType = await ctx.ui.select(
    `Binding for [${key}] — press type`,
    ["Double press (first press passes through)", "Single press (key is consumed)"],
  );
  if (!pressType) return;
  const double = pressType.startsWith("Double");

  // 3. When condition
  const whenLabels: Record<string, When> = {
    "Always": "always",
    "When editor has content": "hasContent",
    "When editor is empty": "isEmpty",
    "When agent is idle": "idle",
  };
  const whenChoice = await ctx.ui.select(
    "Fire when?",
    Object.keys(whenLabels),
  );
  if (!whenChoice) return;
  const when = whenLabels[whenChoice] ?? "always";

  // 4. Action
  const actionEntries = Object.entries(ACTIONS) as [ActionName, (typeof ACTIONS)[ActionName]][];
  const actionLabels = actionEntries.map(([, meta]) => `${meta.label} — ${meta.description}`);
  const actionChoice = await ctx.ui.select("Action", actionLabels);
  if (!actionChoice) return;

  const actionIndex = actionLabels.indexOf(actionChoice);
  const [actionName, actionMeta] = actionEntries[actionIndex]!;

  // 5. Collect params
  const params: Record<string, unknown> = {};
  for (const field of actionMeta.paramFields) {
    if (field.type === "select" && field.options) {
      const choice = await ctx.ui.select(field.label, field.options);
      if (!choice) return;
      params[field.name] = choice;
    } else {
      const value = await ctx.ui.input(field.label, field.name);
      if (value === undefined) return;
      params[field.name] = value;
    }
  }

  // 6. Optional description
  const rawDesc = await ctx.ui.input(
    "Description (optional, shown in /keybindings)",
    "e.g. clear editor on double Esc",
  );
  const description = rawDesc?.trim() || undefined;

  // 7. Confirm
  const pressLabel = double ? "double" : "single";
  const summary = `[${pressLabel} ${key}] when ${when} → ${actionMeta.label}`;
  const confirmed = await ctx.ui.confirm("Save binding?", summary);
  if (!confirmed) {
    ctx.ui.notify("Cancelled.", "info");
    return;
  }

  const binding: Binding = {
    key,
    double,
    when,
    action: actionName,
    params: Object.keys(params).length ? params : undefined,
    description,
  };

  await addBinding(binding);
  ctx.ui.notify(`Saved: ${summary}`, "info");
}

// ---------------------------------------------------------------------------
// Remove binding wizard
// ---------------------------------------------------------------------------

export async function runRemoveWizard(
  ctx: ExtensionCommandContext,
): Promise<void> {
  const config = await loadConfig();

  if (!config.bindings.length) {
    ctx.ui.notify("No bindings configured.", "info");
    return;
  }

  const labels = config.bindings.map((b, i) => formatBinding(b, i));
  const choice = await ctx.ui.select("Remove which binding?", labels);
  if (!choice) return;

  const index = labels.indexOf(choice);
  if (index === -1) return;

  const confirmed = await ctx.ui.confirm(
    "Remove binding?",
    formatBinding(config.bindings[index]!, index),
  );
  if (!confirmed) return;

  await removeBinding(index);
  ctx.ui.notify(`Removed binding ${index + 1}.`, "info");
}

// ---------------------------------------------------------------------------
// Format helpers
// ---------------------------------------------------------------------------

export function formatBinding(b: Binding, index: number): string {
  const pressLabel = b.double ? "double" : "single";
  const whenLabel = b.when && b.when !== "always" ? ` (${b.when})` : "";
  const paramsStr = formatParams(b);
  const desc = b.description ? ` — ${b.description}` : "";
  return `${index + 1}. [${pressLabel} ${b.key}]${whenLabel} → ${b.action}${paramsStr}${desc}`;
}

function formatParams(b: Binding): string {
  if (!b.params || !Object.keys(b.params).length) return "";
  const pairs = Object.entries(b.params)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(", ");
  return ` (${pairs})`;
}
