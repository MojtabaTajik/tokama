import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_DESKTOP_STATE, type DesktopState } from "../shared/desktop-state.js";
import { desktopStore, readDesktopState, writeDesktopState } from "./desktop-store.js";

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pr-102-store-"));
  path = join(dir, ".tokama", "desktop.json");
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

const wide: DesktopState = { ...DEFAULT_DESKTOP_STATE, sidebar: { width: 300, collapsed: true }, drawer: { width: 500 }, lastRepoFolder: "/code/orders-api" };

describe("writeDesktopState", () => {
  it("creates the folder, writes the state with mode 0600 and reads it back", () => {
    writeDesktopState(path, wide);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readDesktopState(path)).toEqual(wide);
  });

  it("leaves no temp file, and replaces an older file whole", () => {
    writeDesktopState(path, wide);
    writeDesktopState(path, DEFAULT_DESKTOP_STATE);
    expect(readdirSync(join(dir, ".tokama"))).toEqual(["desktop.json"]);
    expect(readDesktopState(path)).toEqual(DEFAULT_DESKTOP_STATE);
  });

  it("never follows a link left at a guessable temp name, and never touches its target", () => {
    const victim = join(dir, "victim.txt");
    writeFileSync(victim, "keep me", { mode: 0o644 });
    mkdirSync(join(dir, ".tokama"), { recursive: true });
    symlinkSync(victim, `${path}.${process.pid}.tmp`);
    writeDesktopState(path, wide);
    expect(readFileSync(victim, "utf8")).toBe("keep me");
    expect(statSync(victim).mode & 0o777).toBe(0o644);
    expect(readDesktopState(path)).toEqual(wide);
  });

  it("keeps the old file and removes the temp file when the write fails", () => {
    writeDesktopState(path, wide);
    const unwritable = { ...wide, toJSON: undefined } as unknown as DesktopState;
    (unwritable as { window: unknown }).window = 1n;
    expect(() => writeDesktopState(path, unwritable)).toThrow();
    expect(readDesktopState(path)).toEqual(wide);
    expect(readdirSync(join(dir, ".tokama"))).toEqual(["desktop.json"]);
  });
});

describe("readDesktopState", () => {
  const writeRaw = (text: string) => {
    writeDesktopState(path, DEFAULT_DESKTOP_STATE);
    writeFileSync(path, text);
  };

  it("gives the defaults for a missing file", () => {
    expect(readDesktopState(path)).toEqual(DEFAULT_DESKTOP_STATE);
  });

  it("gives the defaults for a file that is not JSON, is empty, or is not an object", () => {
    for (const text of ["{broken", "", "null", "[1,2]", '"text"', "42"]) {
      writeRaw(text);
      expect(readDesktopState(path)).toEqual(DEFAULT_DESKTOP_STATE);
    }
  });

  it("gives the defaults for a file that is far too large", () => {
    writeRaw(JSON.stringify({ ...wide, junk: "x".repeat(70_000) }));
    expect(readDesktopState(path)).toEqual(DEFAULT_DESKTOP_STATE);
  });

  it("gives the defaults for a link, and does not wait on a pipe", () => {
    mkdirSync(join(dir, ".tokama"), { recursive: true });
    const real = join(dir, "real.json");
    writeFileSync(real, JSON.stringify(wide));
    symlinkSync(real, path);
    expect(readDesktopState(path)).toEqual(DEFAULT_DESKTOP_STATE);
    rmSync(path);
    execFileSync("mkfifo", [path]);
    expect(readDesktopState(path)).toEqual(DEFAULT_DESKTOP_STATE);
  });

  it("keeps the valid fields and defaults the bad ones", () => {
    writeRaw(JSON.stringify({ sidebar: { width: "wide", collapsed: true }, drawer: { width: 500 }, lastView: { kind: "repo" }, lastRepoFolder: 5 }));
    expect(readDesktopState(path)).toEqual({ ...DEFAULT_DESKTOP_STATE, sidebar: { width: 264, collapsed: true }, drawer: { width: 500 } });
  });

  it("reads a file from before the checklist as not done, and keeps a saved checklist state", () => {
    writeRaw(JSON.stringify({ drawer: { width: 500 } }));
    expect(readDesktopState(path).getStarted).toEqual({ done: false, lineClosed: false });
    writeRaw(JSON.stringify({ getStarted: { done: true, lineClosed: true, firstItemId: "item_9" } }));
    expect(readDesktopState(path).getStarted).toEqual({ done: true, lineClosed: true, firstItemId: "item_9" });
  });

  it("clamps widths that are outside the limits, and drops unknown fields", () => {
    writeRaw(JSON.stringify({ sidebar: { width: 9999 }, drawer: { width: 10 }, extra: { evil: true } }));
    const state = readDesktopState(path);
    expect([state.sidebar.width, state.drawer.width]).toEqual([360, 340]);
    expect(Object.keys(state)).not.toContain("extra");
  });
});

describe("desktopStore", () => {
  it("writes once after a burst of changes, with the last one", () => {
    vi.useFakeTimers();
    const store = desktopStore(path, { delayMs: 100 });
    store.update((state) => ({ ...state, drawer: { width: 400 } }));
    store.update((state) => ({ ...state, drawer: { width: 450 } }));
    expect(existsSync(path)).toBe(false);
    vi.advanceTimersByTime(100);
    expect(JSON.parse(readFileSync(path, "utf8")).drawer).toEqual({ width: 450 });
  });

  it("flush writes a pending change at once, and does nothing when none is pending", () => {
    const store = desktopStore(path, { delayMs: 60_000 });
    store.flush();
    expect(existsSync(path)).toBe(false);
    store.update((state) => ({ ...state, sidebar: { width: 320, collapsed: false } }));
    store.flush();
    expect(readDesktopState(path).sidebar.width).toBe(320);
    store.flush();
  });

  it("starts from the file and reports a failed write without throwing", () => {
    writeDesktopState(path, wide);
    const onError = vi.fn();
    const store = desktopStore(join(path, "inside-a-file", "desktop.json"), { delayMs: 60_000, onError });
    expect(store.get()).toEqual(DEFAULT_DESKTOP_STATE);
    store.update((state) => state);
    store.flush();
    expect(onError).toHaveBeenCalledOnce();
    expect(desktopStore(path).get()).toEqual(wide);
  });
});
