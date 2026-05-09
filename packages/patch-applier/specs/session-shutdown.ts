import type { PatchSpec } from "../src/types.js";

/**
 * session-shutdown — default event object guard in pi's extensions runner.
 *
 * When pi's extension runner emits `session_shutdown`, the event object may
 * be `undefined` if the session ended without a clean shutdown handler (e.g.
 * Ctrl+C during streaming). Downstream extensions that read `event.foo` will
 * crash on undefined. This patch ensures the event is always at least an
 * empty object.
 *
 * The fix is in the `emitSessionShutdownEvent` function inside
 * `core/extensions/runner.js`. The function receives an `event` parameter,
 * and we introduce a local variable (commonly named `shutdownEvent`) that
 * defaults to `{ type: "session_shutdown" }` when the parameter is undefined.
 * All subsequent uses of the event must reference the guarded variable.
 */
export const spec: PatchSpec = {
	id: "session-shutdown",
	target: "core/extensions/runner.js",
	intent:
		"In the emitSessionShutdownEvent function, ensure the event parameter is never undefined when passed to downstream handlers. Introduce a local variable (commonly named shutdownEvent) that applies a null-coalescing operator: `event ?? { type: 'session_shutdown' }`. All references to the event inside the function body must use the guarded variable instead of the original parameter.",
	hint: `Find the function shaped like:
  export async function emitSessionShutdownEvent(extensionRunner, event) {
    if (extensionRunner.hasHandlers("session_shutdown")) {
      ...
    }
    await extensionRunner.emit(event);
  }

Insert a guarded local variable at the top of the function:
  const shutdownEvent = event ?? { type: "session_shutdown" };

Then replace all uses of \`event\` in the function body with \`shutdownEvent\`.

Preserve the parameter name (it may vary), and preserve all surrounding code.`,
	marker: "shutdownEvent = event ??",

	verify(content: string) {
		const failures: string[] = [];

		// 1. A guarded variable assignment must be present
		const hasNullishCoalescing = /\w+\s*=\s*event\s*\?\?\s*\{/.test(content);
		const hasLogicalOr = /\w+\s*=\s*event\s*\|\|\s*\{/.test(content);
		const hasDestructuringDefault = /const\s*\{[^}]+\}\s*=\s*event\s*\?\?/.test(content);

		if (!hasNullishCoalescing && !hasLogicalOr && !hasDestructuringDefault) {
			failures.push(
				"Missing null guard for event parameter — expected `<var> = event ?? {...}` or similar",
			);
		}

		// 2. The original direct emit call `await extensionRunner.emit(event)`
		//    must NOT be present — it should be replaced with the guarded variable.
		//    If any .emit(event) call exists, it means the guard (if present) is
		//    dead code or only partially applied.
		const directEmitOfEvent = /extensionRunner\.emit\(event\s*\)/.test(content);
		if (directEmitOfEvent) {
			failures.push(
				"Function still emits the raw event parameter without guard — expected emit(shutdownEvent) or similar",
			);
		}

		return failures.length === 0 ? { ok: true } : { ok: false, failures };
	},
};
