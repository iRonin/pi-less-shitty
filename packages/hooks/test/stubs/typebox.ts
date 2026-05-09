// Test-only stub for `@sinclair/typebox`. The security tests never
// exercise the registered tool, so the schema returned here can be empty.

const passthrough = (...args: unknown[]) => ({ args });

export const Type = {
  Object: passthrough,
  String: passthrough,
  Optional: passthrough,
  Array: passthrough,
};
