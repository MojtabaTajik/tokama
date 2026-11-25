import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openableAttemptPath, openAttemptFile } from "./attempt-file.js";

const ITEM = "item_0b9f3c1e-6a2d-4f7b-9c1a-2e3d4f5a6b7c";
const OTHER = "item_0b9f3c1e-6a2d-4f7b-9c1a-2e3d4f5a6b7d";

let root: string;
let home: string;
let itemDir: string;
let log: string;

beforeEach(() => {
  // realpath: on macOS the temp folder is behind the /var -> /private/var link.
  root = realpathSync(mkdtempSync(join(tmpdir(), "tk-attempt-open-")));
  home = join(root, ".tokama");
  itemDir = join(home, "items", ITEM);
  mkdirSync(join(itemDir, "attempts", "fix-1"), { recursive: true });
  log = join(itemDir, "attempts", "fix-1", "check-1.log");
  writeFileSync(log, "ok\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const write = (path: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "x\n");
  return path;
};

describe("openableAttemptPath", () => {
  it("allows a .log or .txt file in the item's folder", () => {
    expect(openableAttemptPath(log, itemDir)).toEqual({ ok: true, path: log });
    const transcript = write(join(itemDir, "attempts", "fix-1", "transcript.txt"));
    expect(openableAttemptPath(transcript, itemDir)).toEqual({ ok: true, path: transcript });
  });

  it.each([
    ["a relative path", () => "attempts/fix-1/check-1.log", "plain full path"],
    ["a path with ..", () => `${itemDir}/attempts/../../${OTHER}/a.log`, "plain full path"],
    ["a wrong extension", () => write(join(itemDir, "attempts", "fix-1", "call.json")), "only saved logs"],
    ["a script", () => write(join(itemDir, "run.sh")), "only saved logs"],
    ["a file of another item", () => write(join(home, "items", OTHER, "attempts", "fix-1", "check-1.log")), "not in the item's folder"],
    ["a file outside the Tokama home", () => write(join(root, "elsewhere.log")), "not in the item's folder"],
    ["a missing file", () => join(itemDir, "attempts", "fix-1", "gone.log"), "does not exist"],
    ["a folder named .log", () => (mkdirSync(join(itemDir, "dir.log")), join(itemDir, "dir.log")), "not a file"],
  ])("refuses %s", (_case, path, why) => {
    const result = openableAttemptPath(path(), itemDir);
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining(why) });
  });

  it("refuses a link, even to a log in the item's folder, and a log behind a linked folder outside it", () => {
    const link = join(itemDir, "attempts", "fix-1", "check-2.log");
    symlinkSync(log, link);
    expect(openableAttemptPath(link, itemDir)).toMatchObject({ ok: false, message: expect.stringContaining("it is a link") });
    write(join(root, "outside", "secret.log"));
    symlinkSync(join(root, "outside"), join(itemDir, "attempts", "linked"));
    expect(openableAttemptPath(join(itemDir, "attempts", "linked", "secret.log"), itemDir)).toMatchObject({ ok: false, message: expect.stringContaining("not in the item's folder") });
  });

  it("refuses a non-regular file such as a FIFO", async () => {
    const { createProcessRunner } = await import("@tokama/core");
    const fifo = join(itemDir, "pipe.log");
    const made = await createProcessRunner().run({ command: { argv: ["mkfifo", fifo] }, cwd: itemDir, timeoutMs: 5_000 });
    expect(made.exitCode).toBe(0);
    expect(openableAttemptPath(fifo, itemDir)).toMatchObject({ ok: false, message: expect.stringContaining("not a file") });
  });
});

describe("openAttemptFile", () => {
  const engine = (data: unknown, ok = true) => vi.fn(async (_input: unknown) => (ok ? { ok: true as const, data } : { ok: false as const, error: { code: "not_found", message: "Attempt 1 has no saved transcript." } })) as never;

  it("asks the engine for the path of the named file and opens the checked file", async () => {
    const query = vi.fn(async (_input: unknown) => ({ ok: true as const, data: { path: log } }));
    const openPath = vi.fn(async () => "");
    expect(await openAttemptFile({ itemId: ITEM, stepIndex: 0, attempt: 1, file: 1, path: "/bin/sh" }, { query: query as never, tokamaHome: home, openPath })).toEqual({ ok: true });
    expect(query).toHaveBeenCalledWith({ type: "attempt_file", itemId: ITEM, stepIndex: 0, attempt: 1, file: 1 });
    expect(openPath).toHaveBeenCalledWith(log);
  });

  it("opens nothing for a bad name, an engine refusal, or a path the guard refuses", async () => {
    const openPath = vi.fn(async () => "");
    const deps = (query: never) => ({ query, tokamaHome: home, openPath });
    expect(await openAttemptFile({ itemId: "../../etc", stepIndex: 0, attempt: 1, file: 1 }, deps(engine({ path: log })))).toEqual({ ok: false, message: "No file was named." });
    expect(await openAttemptFile({ itemId: ITEM, stepIndex: 0, attempt: 1, file: "call.json" }, deps(engine({ path: log })))).toEqual({ ok: false, message: "No file was named." });
    expect(await openAttemptFile("transcript", deps(engine({ path: log })))).toEqual({ ok: false, message: "No file was named." });
    expect(await openAttemptFile({ itemId: ITEM, stepIndex: 0, attempt: 1, file: "transcript" }, deps(engine(null, false)))).toEqual({ ok: false, message: "Attempt 1 has no saved transcript." });
    expect(await openAttemptFile({ itemId: ITEM, stepIndex: 0, attempt: 1, file: 1 }, deps(engine({ path: "/bin/sh" })))).toMatchObject({ ok: false, message: expect.stringContaining("only saved logs") });
    // The folder is the named item's: another item's log is refused.
    const other = write(join(home, "items", OTHER, "attempts", "fix-1", "check-1.log"));
    expect(await openAttemptFile({ itemId: ITEM, stepIndex: 0, attempt: 1, file: 1 }, deps(engine({ path: other })))).toMatchObject({ ok: false, message: expect.stringContaining("not in the item's folder") });
    expect(openPath).not.toHaveBeenCalled();
  });

  it("passes on the system's error", async () => {
    expect(await openAttemptFile({ itemId: ITEM, stepIndex: 0, attempt: 1, file: 1 }, { query: engine({ path: log }), tokamaHome: home, openPath: async () => "no app for .log" })).toEqual({ ok: false, message: "The file did not open: no app for .log" });
  });
});
