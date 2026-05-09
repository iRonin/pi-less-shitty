// Test-only stub for `@earendil-works/pi-coding-agent`. The hooks package
// only references a couple of types and one event-type guard, none of
// which the security tests exercise.

export type ExtensionAPI = unknown;

export function isToolCallEventType(_kind: string, _event: unknown): boolean {
  return false;
}
