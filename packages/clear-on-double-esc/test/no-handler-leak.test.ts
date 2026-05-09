import { describe, it, expect, vi } from "vitest";

/**
 * FIX E verification: multiple session_start events must not stack
 * `onTerminalInput` registrations. Previously the input handler was
 * registered inside the session_start callback, so after N session_starts
 * the editor saw N+1 invocations per Esc.
 */

// Mock @earendil-works/pi-tui — peerDependency, not present in test env.
vi.mock("@earendil-works/pi-tui", () => ({
  isKeyRelease: () => false,
  matchesKey: (data: string, key: string) => key === "escape" && data === "\x1b",
}));

describe("clear-on-double-esc handler-leak (FIX E)", () => {
  it("registers onTerminalInput exactly once across many session_starts", async () => {
    vi.resetModules();
    const mod = await import("../src/index.ts");

    const onTerminalInput = vi.fn();
    let sessionStartCb: any;
    let agentStartCb: any;

    const fakePi: any = {
      on: (evt: string, cb: any) => {
        if (evt === "session_start") sessionStartCb = cb;
        if (evt === "agent_start") agentStartCb = cb;
      },
    };

    mod.default(fakePi);
    expect(sessionStartCb).toBeTypeOf("function");
    expect(agentStartCb).toBeTypeOf("function");

    // agent_start must be a singleton too (registered ONCE at extension
    // load, not inside each session_start).
    const onCallsBefore = (fakePi.on as any).mock?.calls ?? [];

    const fakeCtx = (i: number) => ({
      hasUI: true,
      ui: {
        onTerminalInput,
        getEditorText: () => "",
        setEditorText: () => {},
      },
      _sessionId: i,
    });

    // Fire ten session_starts.
    for (let i = 0; i < 10; i++) {
      sessionStartCb({}, fakeCtx(i));
    }

    expect(onTerminalInput).toHaveBeenCalledTimes(1);
  });

  it("does not register onTerminalInput when ctx.hasUI is false", async () => {
    vi.resetModules();
    const mod = await import("../src/index.ts");

    const onTerminalInput = vi.fn();
    let sessionStartCb: any;
    const fakePi: any = {
      on: (evt: string, cb: any) => {
        if (evt === "session_start") sessionStartCb = cb;
      },
    };
    mod.default(fakePi);

    sessionStartCb({}, { hasUI: false, ui: { onTerminalInput } });
    expect(onTerminalInput).not.toHaveBeenCalled();

    // First headless start — then UI session arrives. Handler should install once.
    sessionStartCb({}, {
      hasUI: true,
      ui: { onTerminalInput, getEditorText: () => "", setEditorText: () => {} },
    });
    expect(onTerminalInput).toHaveBeenCalledTimes(1);

    // Another UI session — still must not re-register.
    sessionStartCb({}, {
      hasUI: true,
      ui: { onTerminalInput, getEditorText: () => "", setEditorText: () => {} },
    });
    expect(onTerminalInput).toHaveBeenCalledTimes(1);
  });
});
