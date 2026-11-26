import { describe, expect, it, vi } from "vitest";
import { conflictAnswer, type ConflictType, type MoveDeps, offerMove, runsFromCopy, shouldOfferMove } from "./move-to-applications.js";

function deps(overrides: Partial<MoveDeps> = {}) {
  const moveToApplicationsFolder = vi.fn<MoveDeps["moveToApplicationsFolder"]>(() => true);
  const showErrorBox = vi.fn<MoveDeps["showErrorBox"]>();
  const all: MoveDeps = { ask: async () => 0, askSync: () => 0, moveToApplicationsFolder, showErrorBox, itemsRunningInApplications: async () => 0, ...overrides };
  return { all, moveToApplicationsFolder, showErrorBox };
}

describe("runsFromCopy", () => {
  it("is true for a command inside the copy in Applications, and only for that", () => {
    expect(runsFromCopy("/Applications/Tokama.app/Contents/Resources/engine/tokama-engine /Applications/Tokama.app/Contents/Resources/engine/dist/main.js --dir /x")).toBe(true);
    expect(runsFromCopy("/Applications/Tokama.app.old/Contents/Resources/engine/tokama-engine")).toBe(false);
    expect(runsFromCopy("/usr/local/bin/node /src/apps/engine/dist/main.js --dir /x")).toBe(false);
  });
});

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

  it("refuses to replace the copy in Applications while its engine runs items, and says how many", async () => {
    const { all, moveToApplicationsFolder, showErrorBox } = deps({ itemsRunningInApplications: async () => 2 });
    await offerMove(all);
    expect(moveToApplicationsFolder).not.toHaveBeenCalled();
    expect(showErrorBox).toHaveBeenCalledWith("Could not replace Tokama", expect.stringContaining("still has 2 unfinished items"));
  });

  it("refuses when it cannot tell whether the copy in Applications runs items", async () => {
    for (const itemsRunningInApplications of [async () => undefined, async () => Promise.reject(new Error("no engine answer"))]) {
      const { all, moveToApplicationsFolder, showErrorBox } = deps({ itemsRunningInApplications });
      await offerMove(all);
      expect(moveToApplicationsFolder).not.toHaveBeenCalled();
      expect(showErrorBox).toHaveBeenCalledWith("Could not replace Tokama", expect.stringContaining("could not check"));
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
