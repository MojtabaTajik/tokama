import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_DESKTOP_STATE, type DesktopState } from "../shared/desktop-state.js";
import { type Note, parseNote } from "../shared/whats-new.js";
import { dueAfterStart, loadNotes, MAX_NOTES, notesDir, pathExists, whatsNewService } from "./whats-new.js";

const note = (version: string, kind: "highlights" | "fixes" | "security" = "highlights"): string =>
  `---\nversion: ${version}\ndate: 2026-12-03\n${kind === "security" ? "security: true\n" : ""}---\n\n${kind === "highlights" ? "## Sounds\n\nA soft chirp.\n\n" : ""}${kind === "fixes" ? "+ 2 smaller fixes\n" : ""}`;
const parsed = (version: string, kind: "highlights" | "fixes" | "security" = "highlights"): Note => {
  const result = parseNote(note(version, kind));
  if (!result.ok) throw new Error(result.problems.join("; "));
  return result.note;
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tk-notes-240-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});
const put = (name: string, text: string) => writeFileSync(join(dir, name), text);

describe("notesDir", () => {
  const base = { resourcesPath: "/r", appPath: "/a/apps/desktop" };

  it("is Resources/whats-new when packaged and the checkout's whats-new in development", () => {
    expect(notesDir({ ...base, packaged: true, e2e: undefined, override: undefined })).toBe(join("/r", "whats-new"));
    expect(notesDir({ ...base, packaged: false, e2e: undefined, override: undefined })).toBe(join("/a", "whats-new"));
  });

  it("takes the test override only under the test flag in an app that is not packaged", () => {
    expect(notesDir({ ...base, packaged: false, e2e: "1", override: "/fixtures/a" })).toBe("/fixtures/a");
    expect(notesDir({ ...base, packaged: false, e2e: undefined, override: "/fixtures/a" })).toBe(join("/a", "whats-new"));
    expect(notesDir({ ...base, packaged: false, e2e: "0", override: "/fixtures/a" })).toBe(join("/a", "whats-new"));
    expect(notesDir({ ...base, packaged: true, e2e: "1", override: "/fixtures/a" })).toBe(join("/r", "whats-new"));
    expect(notesDir({ ...base, packaged: false, e2e: "1", override: "" })).toBe(join("/a", "whats-new"));
  });
});

describe("pathExists", () => {
  it("is true for a file and for a link whose target is gone, false for nothing", () => {
    put("a.json", "{}");
    symlinkSync(join(dir, "gone"), join(dir, "dangling"));
    expect([pathExists(join(dir, "a.json")), pathExists(join(dir, "dangling")), pathExists(join(dir, "none"))]).toEqual([true, true, false]);
  });
});

describe("loadNotes", () => {
  it("loads the notes up to the app's version, newest first", async () => {
    for (const version of ["0.0.9", "0.0.10", "0.1.0", "0.3.0"]) put(`${version}.md`, note(version));
    expect((await loadNotes(dir, "0.1.0", () => undefined)).map((loaded) => loaded.version)).toEqual(["0.1.0", "0.0.10", "0.0.9"]);
  });

  it("ignores files that are not named for a version", async () => {
    put("README.md", "# Notes");
    put("0.2.0.txt", note("0.2.0"));
    put("v0.2.0.md", note("0.2.0"));
    put("0.2.md", note("0.2.0"));
    put("0.2.0.md", note("0.2.0"));
    mkdirSync(join(dir, "0.1.0.md"));
    const log = vi.fn();
    expect((await loadNotes(dir, "0.2.0", log)).map((loaded) => loaded.version)).toEqual(["0.2.0"]);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("skips a note that does not parse, or names another version, and says why; the others load", async () => {
    put("0.1.0.md", note("0.1.0"));
    put("0.2.0.md", "---\nversion: 0.2.0\ndate: 2026-02-30\n---\n\n+ 1 smaller fix\n");
    put("0.3.0.md", note("0.2.9"));
    const log = vi.fn();
    expect((await loadNotes(dir, "0.3.0", log)).map((loaded) => loaded.version)).toEqual(["0.1.0"]);
    expect(log.mock.calls.map(([message]) => message)).toEqual(['whats-new/0.3.0.md: version 0.2.9 does not match the file name 0.3.0.md', 'whats-new/0.2.0.md: date "2026-02-30" is not a real YYYY-MM-DD day']);
  });

  it("does not follow a link, and skips a file over 8 KiB", async () => {
    put("real.txt", note("0.1.0"));
    symlinkSync(join(dir, "real.txt"), join(dir, "0.1.0.md"));
    put("0.2.0.md", `${note("0.2.0")}${" ".repeat(9000)}`);
    put("0.3.0.md", note("0.3.0"));
    const log = vi.fn();
    expect((await loadNotes(dir, "0.3.0", log)).map((loaded) => loaded.version)).toEqual(["0.3.0"]);
    expect(log.mock.calls.map(([message]) => message)).toEqual(["whats-new/0.2.0.md: larger than 8192 bytes", "whats-new/0.1.0.md: path is a symlink"]);
  });

  it("reads at most the newest MAX_NOTES", async () => {
    for (let patch = 0; patch < MAX_NOTES + 5; patch++) put(`0.0.${patch}.md`, note(`0.0.${patch}`));
    const loaded = await loadNotes(dir, "0.0.999", () => undefined);
    expect(loaded).toHaveLength(MAX_NOTES);
    expect(loaded[0]?.version).toBe(`0.0.${MAX_NOTES + 4}`);
  });

  it("finds no notes in a missing folder, or in a path that is a file, and none for a version it cannot read", async () => {
    expect(await loadNotes(join(dir, "missing"), "0.1.0", () => undefined)).toEqual([]);
    put("file", "x");
    expect(await loadNotes(join(dir, "file"), "0.1.0", () => undefined)).toEqual([]);
    put("0.1.0.md", note("0.1.0"));
    expect(await loadNotes(dir, "dev", () => undefined)).toEqual([]);
  });

  it.skipIf(process.getuid?.() === 0)("throws when the folder cannot be listed", async () => {
    mkdirSync(join(dir, "locked"));
    chmodSync(join(dir, "locked"), 0o000);
    try {
      await expect(loadNotes(join(dir, "locked"), "0.1.0", () => undefined)).rejects.toThrow(/EACCES/);
    } finally {
      chmodSync(join(dir, "locked"), 0o700);
    }
  });
});

describe("dueAfterStart", () => {
  const highlights = parsed("0.2.0");
  const fixes = parsed("0.2.1", "fixes");
  const security = parsed("0.2.2", "security");
  const run = (overrides: Partial<Parameters<typeof dueAfterStart>[0]>) => dueAfterStart({ fileExisted: true, lastRunVersion: "0.1.0", appVersion: "0.2.0", notes: [highlights], pending: undefined, ...overrides });

  it("shows a card for an update to a version with highlights", () => {
    expect(run({})).toEqual({ card: "0.2.0" });
  });

  it("shows a chip for an update to a fixes-only or a security-only version", () => {
    expect(run({ appVersion: "0.2.1", notes: [fixes] })).toEqual({ chip: "0.2.1" });
    expect(run({ appVersion: "0.2.2", notes: [security] })).toEqual({ chip: "0.2.2" });
  });

  it("shows nothing on a first install: no desktop.json", () => {
    expect(run({ fileExisted: false, lastRunVersion: undefined })).toBeUndefined();
  });

  it("treats a file with no recorded version as an update from an older version", () => {
    expect(run({ lastRunVersion: undefined })).toEqual({ card: "0.2.0" });
  });

  it("shows nothing for the same version, but keeps what is still due", () => {
    expect(run({ lastRunVersion: "0.2.0" })).toBeUndefined();
    expect(run({ lastRunVersion: "0.2.0", pending: { card: "0.2.0" } })).toEqual({ card: "0.2.0" });
  });

  it("shows nothing after a downgrade, and keeps what is still due for the return", () => {
    expect(run({ lastRunVersion: "0.3.0" })).toBeUndefined();
    expect(run({ lastRunVersion: "0.3.0", pending: { card: "0.3.0" } })).toEqual({ card: "0.3.0" });
  });

  it("counts only the note of the version just installed, over skipped versions", () => {
    // From 0.1.0 straight to 0.2.1: 0.2.0 had highlights, 0.2.1 has only fixes.
    expect(run({ appVersion: "0.2.1", notes: [fixes, highlights] })).toEqual({ chip: "0.2.1" });
  });

  it("shows nothing when the new version has no note, even though older notes exist", () => {
    expect(run({ appVersion: "0.2.5", notes: [fixes, highlights] })).toBeUndefined();
    expect(run({ lastRunVersion: undefined, appVersion: "0.2.5", notes: [fixes, highlights] })).toBeUndefined();
    expect(run({ notes: [] })).toBeUndefined();
  });

  it("drops a card not yet closed when a newer version starts", () => {    expect(run({ appVersion: "0.2.5", notes: [highlights], pending: { card: "0.2.0" }, lastRunVersion: "0.2.0" })).toBeUndefined();
  });
});

describe("whatsNewService", () => {
  const fakeStore = (initial: Partial<DesktopState> = {}) => {
    let state: DesktopState = { ...DEFAULT_DESKTOP_STATE, ...initial };
    return { get: () => state, update: (change: (state: DesktopState) => DesktopState) => void (state = change(state)) };
  };
  const service = (store: ReturnType<typeof fakeStore>, options: { appVersion?: string; fileExisted?: boolean; folder?: string; log?: (message: string) => void } = {}) =>
    whatsNewService({ store, dir: options.folder ?? dir, appVersion: options.appVersion ?? "0.2.0", fileExisted: options.fileExisted ?? true, log: options.log ?? (() => undefined) });

  it("after an update with highlights: due card, notes, and the version recorded", async () => {
    put("0.2.0.md", note("0.2.0"));
    put("0.1.0.md", note("0.1.0", "fixes"));
    const store = fakeStore({ lastRunVersion: "0.1.0" });
    const info = await service(store).info();
    expect(info.appVersion).toBe("0.2.0");
    expect(info.notes.map((loaded) => loaded.version)).toEqual(["0.2.0", "0.1.0"]);
    expect(info.due).toEqual({ card: "0.2.0" });
    expect(store.get().lastRunVersion).toBe("0.2.0");
    expect(store.get().whatsNewDue).toEqual({ card: "0.2.0" });
  });

  it("after a fixes-only or security update: due chip with its kind", async () => {
    put("0.2.1.md", note("0.2.1", "fixes"));
    expect((await service(fakeStore({ lastRunVersion: "0.2.0" }), { appVersion: "0.2.1" }).info()).due).toEqual({ chip: { version: "0.2.1", kind: "fixes" } });
    put("0.2.2.md", note("0.2.2", "security"));
    expect((await service(fakeStore({ lastRunVersion: "0.2.1" }), { appVersion: "0.2.2" }).info()).due).toEqual({ chip: { version: "0.2.2", kind: "security" } });
  });

  it("a first install records the version and shows nothing", async () => {
    put("0.2.0.md", note("0.2.0"));
    const store = fakeStore();
    const info = await service(store, { fileExisted: false }).info();
    expect(info.due).toBeUndefined();
    expect(info.notes).toHaveLength(1);
    expect(store.get().lastRunVersion).toBe("0.2.0");
  });

  it("a card left open at quit is due again at the next start, once", async () => {
    put("0.2.0.md", note("0.2.0"));
    const store = fakeStore({ lastRunVersion: "0.1.0" });
    await service(store).info();
    const again = service(store);
    expect((await again.info()).due).toEqual({ card: "0.2.0" });
    again.close("0.2.0", "card");
    expect((await again.info()).due).toBeUndefined();
    expect((await service(store).info()).due).toBeUndefined();
    expect(store.get().whatsNewDue).toBeUndefined();
  });

  it("closing the card keeps a due chip, and closing the chip keeps a due card", async () => {
    put("0.2.0.md", note("0.2.0"));
    const store = fakeStore({ lastRunVersion: "0.2.0", whatsNewDue: { card: "0.2.0", chip: "0.2.0" } });
    const svc = service(store);
    svc.close("0.2.0", "card");
    expect(store.get().whatsNewDue).toEqual({ chip: "0.2.0" });
    svc.close("0.2.0", "chip");
    expect(store.get()).not.toHaveProperty("whatsNewDue");
  });

  it("ignores a close for another version, another kind or a value that is not text", async () => {
    put("0.2.0.md", note("0.2.0"));
    const store = fakeStore({ lastRunVersion: "0.1.0" });
    const svc = service(store);
    await svc.info();
    for (const [version, what] of [["0.1.0", "card"], ["0.2.0", "chip"], ["0.2.0", "both"], [{ toString: () => "0.2.0" }, "card"], [undefined, "card"], ["0.2.0", undefined], ["", "card"]] as const) svc.close(version, what);
    expect(store.get().whatsNewDue).toEqual({ card: "0.2.0" });
  });

  it("shows a due card only when its note is still there with highlights", async () => {
    const store = fakeStore({ lastRunVersion: "0.2.0", whatsNewDue: { card: "0.2.0", chip: "0.2.0" } });
    expect((await service(store).info()).due).toBeUndefined();
    put("0.2.0.md", note("0.2.0", "fixes"));
    expect((await service(store).info()).due).toEqual({ chip: { version: "0.2.0", kind: "fixes" } });
  });

  it("a downgrade and an update again never show a closed card twice, and still show one never seen", async () => {
    put("0.2.0.md", note("0.2.0"));
    put("0.3.0.md", note("0.3.0"));
    // 0.2.0 -> 0.3.0: the card shows and is closed.
    const store = fakeStore({ lastRunVersion: "0.2.0" });
    const first = service(store, { appVersion: "0.3.0" });
    expect((await first.info()).due).toEqual({ card: "0.3.0" });
    first.close("0.3.0", "card");
    // 0.3.0 -> 0.2.0: nothing shows, and the newest version stays 0.3.0.
    expect((await service(store, { appVersion: "0.2.0" }).info()).due).toBeUndefined();
    expect(store.get().lastRunVersion).toBe("0.3.0");
    // 0.2.0 -> 0.3.0 again: the card does not come back.
    expect((await service(store, { appVersion: "0.3.0" }).info()).due).toBeUndefined();

    // A card never closed survives the same trip.
    const other = fakeStore({ lastRunVersion: "0.2.0" });
    await service(other, { appVersion: "0.3.0" }).info();
    expect((await service(other, { appVersion: "0.2.0" }).info()).due).toBeUndefined();
    expect((await service(other, { appVersion: "0.3.0" }).info()).due).toEqual({ card: "0.3.0" });
  });

  it("a missing folder is no failure: no notes, and the version is recorded", async () => {
    const store = fakeStore({ lastRunVersion: "0.1.0" });
    const log = vi.fn();
    expect(await service(store, { folder: join(dir, "missing"), log }).info()).toEqual({ appVersion: "0.2.0", notes: [] });
    expect(store.get().lastRunVersion).toBe("0.2.0");
    expect(log).not.toHaveBeenCalled();
  });

  it.skipIf(process.getuid?.() === 0)("keeps lastRunVersion when the notes cannot be read, so a later start can still show them", async () => {
    mkdirSync(join(dir, "locked"));
    chmodSync(join(dir, "locked"), 0o000);
    try {
      const store = fakeStore({ lastRunVersion: "0.1.0" });
      const log = vi.fn();
      const info = await service(store, { folder: join(dir, "locked"), log }).info();
      expect(info).toEqual({ appVersion: "0.2.0", notes: [] });
      expect(store.get().lastRunVersion).toBe("0.1.0");
      expect(log.mock.calls[0]?.[0]).toMatch(/^could not read the release notes: .*EACCES/);
    } finally {
      chmodSync(join(dir, "locked"), 0o700);
    }
  });
});
