import { describe, expect, it, vi } from "vitest";
import type { ConnectError } from "@tokama/client";
import { conflictAnswer, type ConflictType, type ConnectResult, type CopyEngineDeps, itemsRunningIn, type MoveDeps, offerMove, shouldOfferMove } from "./move-to-applications.js";

function deps(overrides: Partial<MoveDeps> = {}) {
  const moveToApplicationsFolder = vi.fn<MoveDeps["moveToApplicationsFolder"]>(() => true);
  const showErrorBox = vi.fn<MoveDeps["showErrorBox"]>();
  const all: MoveDeps = { ask: async () => 0, askSync: () => 0, moveToApplicationsFolder, showErrorBox, itemsRunningInApplications: async () => 0, ...overrides };
  return { all, moveToApplicationsFolder, showErrorBox };
}

describe("shouldOfferMove", () => {
  const base = { platform: "darwin" as const, isPackaged: true, inApplications: () => false };

  it("is true only for a packaged macOS app outside Applications", () => {
    expect(shouldOfferMove(base)).toBe(true);
    expect(shouldOfferMove({ ...base, inApplications: () => true })).toBe(false);
    expect(shouldOfferMove({ ...base, isPackaged: false })).toBe(false);
    expect(shouldOfferMove({ ...base, platform: "linux" })).toBe(false);
    expect(shouldOfferMove({ ...base, platform: "win32" })).toBe(false);
  });

  it("does not ask Electron about Applications on another OS", () => {
    const inApplications = vi.fn(() => false);
    shouldOfferMove({ ...base, platform: "linux", inApplications });
    expect(inApplications).not.toHaveBeenCalled();
  });
});

describe("offerMove", () => {
  it("asks with Move to Applications and Quit", async () => {
    const ask = vi.fn(async () => 1);
    await offerMove(deps({ ask }).all);
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ message: "Move Tokama to your Applications folder?", buttons: ["Move to Applications", "Quit"] }));
  });

  it("moves nothing when the user quits", async () => {
    const { all, moveToApplicationsFolder } = deps({ ask: async () => 1 });
    await offerMove(all);
    expect(moveToApplicationsFolder).not.toHaveBeenCalled();
  });

  it("moves the app when the user agrees", async () => {
    const { all, moveToApplicationsFolder, showErrorBox } = deps();
    await offerMove(all);
    expect(moveToApplicationsFolder).toHaveBeenCalledOnce();
    expect(showErrorBox).not.toHaveBeenCalled();
  });

  it("refuses to replace the copy in Applications while a running engine has items, and says how many", async () => {
    const { all, moveToApplicationsFolder, showErrorBox } = deps({ itemsRunningInApplications: async () => 2 });
    await offerMove(all);
    expect(moveToApplicationsFolder).not.toHaveBeenCalled();
    expect(showErrorBox).toHaveBeenCalledWith("Could not replace Tokama", expect.stringContaining("still has 2 unfinished items"));
  });

  it("refuses when it cannot tell whether a running engine has items", async () => {
    for (const itemsRunningInApplications of [async () => undefined, async () => Promise.reject(new Error("no engine answer"))]) {
      const { all, moveToApplicationsFolder, showErrorBox } = deps({ itemsRunningInApplications });
      await offerMove(all);
      expect(moveToApplicationsFolder).not.toHaveBeenCalled();
      expect(showErrorBox).toHaveBeenCalledWith("Could not replace Tokama", expect.stringContaining("Open Tokama from Applications"));
    }
  });

  it("shows the error when the move throws, and returns so the app quits", async () => {
    const { all, showErrorBox } = deps({
      moveToApplicationsFolder: () => {
        throw new Error("disk full");
      },
    });
    await offerMove(all);
    expect(showErrorBox).toHaveBeenCalledWith("Could not move Tokama", "Error: disk full");
  });

  it("gives the move a conflict handler that asks before an existing copy is replaced", async () => {
    const askSync = vi.fn(() => 0);
    const { all, moveToApplicationsFolder } = deps({ askSync });
    await offerMove(all);
    const handler = moveToApplicationsFolder.mock.calls[0]![0].conflictHandler;
    expect(handler("exists")).toBe(true);
    expect(askSync).toHaveBeenCalledWith(expect.objectContaining({ buttons: ["Replace", "Quit"] }));
  });
});

describe("itemsRunningIn", () => {
  const board = (...states: string[]) => ({ ok: true as const, data: { items: states.map((state) => ({ state })) } });

  /** Deps for a live engine that answers `reply`; each can be overridden. */
  function copyDeps(overrides: Partial<CopyEngineDeps> = {}, reply: () => Promise<ReturnType<typeof board> | { ok: false }> = async () => board()) {
    const close = vi.fn(async () => {});
    const query = vi.fn(reply);
    const connect = vi.fn(async (): Promise<ConnectResult> => ({ ok: true, value: { query, close } }));
    const all: CopyEngineDeps = { connect, ...overrides };
    return { all, close, query, connect };
  }
  const refused = (code: ConnectError["code"], engine?: ConnectError["engine"]): CopyEngineDeps["connect"] => async () => ({ ok: false, error: { code, ...(engine !== undefined && { engine }) } });

  it("is 0 when no engine runs: no lock, or a lock whose socket is dead", async () => {
    expect(await itemsRunningIn(copyDeps({ connect: refused("not_running") }).all)).toBe(0);
  });

  it("counts queued, running and waiting items, not finished ones, and closes the connection", async () => {
    const { all, close } = copyDeps({}, async () => board("queued", "running", "needs_you", "done", "failed", "stopped"));
    expect(await itemsRunningIn(all)).toBe(3);
    expect(close).toHaveBeenCalledOnce();
  });

  it("is undefined when the board answer is not ok, and still closes the connection", async () => {
    const { all, close } = copyDeps({}, async () => ({ ok: false }));
    expect(await itemsRunningIn(all)).toBeUndefined();
    expect(close).toHaveBeenCalledOnce();
  });

  it("rejects when the query rejects, and still closes the connection", async () => {
    const { all, close } = copyDeps({}, async () => Promise.reject(new Error("socket closed")));
    await expect(itemsRunningIn(all)).rejects.toThrow("socket closed");
    expect(close).toHaveBeenCalledOnce();
  });

  it("is undefined when an engine that runs does not answer", async () => {
    expect(await itemsRunningIn(copyDeps({ connect: refused("timeout") }).all)).toBeUndefined();
  });

  it("uses the running items of an engine of another API version", async () => {
    expect(await itemsRunningIn(copyDeps({ connect: refused("unsupported_version", { apiVersion: 1, runningItems: 2 }) }).all)).toBe(2);
    expect(await itemsRunningIn(copyDeps({ connect: refused("unsupported_version", { apiVersion: 1, runningItems: 0 }) }).all)).toBe(0);
  });

  it("is undefined when an engine of another API version does not say how many items run", async () => {
    expect(await itemsRunningIn(copyDeps({ connect: refused("unsupported_version", { apiVersion: 1 }) }).all)).toBeUndefined();
    expect(await itemsRunningIn(copyDeps({ connect: refused("unsupported_version") }).all)).toBeUndefined();
  });
});

describe("conflictAnswer", () => {
  it.each<[ConflictType, number, boolean]>([
    ["exists", 0, true],
    ["exists", 1, false],
    ["existsAndRunning", 1, true],
  ])("%s with answer %i is %s", (type, answer, expected) => {
    expect(conflictAnswer(type, { askSync: () => answer })).toBe(expected);
  });

  it("does not ask when the copy in Applications is running", () => {
    const askSync = vi.fn(() => 1);
    conflictAnswer("existsAndRunning", { askSync });
    expect(askSync).not.toHaveBeenCalled();
  });
});
