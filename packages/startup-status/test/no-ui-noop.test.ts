import { describe, it, expect, vi } from "vitest";

/**
 * FIX D verification: the session_start handler must be a no-op when the
 * session has no UI (subagent / non-interactive mode). Previously
 * buildReport ran in every subagent, polluting parent stderr and wasting
 * CPU per spawn.
 */

describe("startup-status session_start no-op when !ctx.hasUI (FIX D)", () => {
  it("does not call console.error when hasUI is false", async () => {
    vi.resetModules();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const mod = await import("../src/index.ts");
    let sessionHandler: any;
    const fakePi: any = {
      on: (evt: string, cb: any) => {
        if (evt === "session_start") sessionHandler = cb;
      },
      registerCommand: () => {},
    };
    mod.default(fakePi);
    expect(sessionHandler).toBeTypeOf("function");

    // Reset the spy AFTER extension load — load-time stderr (patch-failed
    // warnings) is unrelated to the per-session no-op behavior.
    errSpy.mockClear();

    // Ctx without hasUI / without ui — handler must early-return.
    await sessionHandler({}, { hasUI: false, cwd: "/tmp" });
    expect(errSpy).not.toHaveBeenCalled();

    // Ctx with hasUI=true but no notify fn — also early-return (defensive).
    await sessionHandler({}, { hasUI: true, ui: {}, cwd: "/tmp" });
    expect(errSpy).not.toHaveBeenCalled();

    errSpy.mockRestore();
  });

  it("does call console.error when hasUI is true with valid ui (positive control)", async () => {
    vi.resetModules();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const mod = await import("../src/index.ts");
    let sessionHandler: any;
    const fakePi: any = {
      on: (evt: string, cb: any) => {
        if (evt === "session_start") sessionHandler = cb;
      },
      registerCommand: () => {},
    };
    mod.default(fakePi);
    errSpy.mockClear();

    const fakeCtx = {
      hasUI: true,
      cwd: "/tmp",
      ui: { notify: vi.fn() },
      getAllTools: () => [],
      getActiveTools: () => [],
      getSystemPrompt: () => "",
      getContextUsage: () => ({}),
    };
    await sessionHandler({}, fakeCtx);
    expect(errSpy).toHaveBeenCalled();

    errSpy.mockRestore();
  });
});
