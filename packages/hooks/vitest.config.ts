import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

// The hooks package imports from `@earendil-works/pi-coding-agent` (peer
// dependency, not installed in this monorepo) and `@sinclair/typebox`.
// Tests only need the *security* helpers — they never invoke the
// extension entry-points — so we stub those imports.
export default defineConfig({
  resolve: {
    alias: {
      "@earendil-works/pi-coding-agent": resolve(__dirname, "test/stubs/pi-coding-agent.ts"),
      "@sinclair/typebox": resolve(__dirname, "test/stubs/typebox.ts"),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
  },
});
