import { lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProcessRunner } from "../process/index.js";
import { appendTextSync, replaceTextSync } from "./index.js";

// The temp name is random; a test can pin it to plant something there first.
const pinned = vi.hoisted(() => ({ bytes: undefined as Buffer | undefined }));
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, randomBytes: (size: number) => pinned.bytes ?? actual.randomBytes(size) };
});

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "tokama-fs-write-")));
});
afterEach(() => {
  pinned.bytes = undefined;
  rmSync(dir, { recursive: true, force: true });
});

describe("appendTextSync", () => {
  it("creates the file 0600 and appends to it", () => {
    const file = join(dir, "log.jsonl");
    expect(appendTextSync(file, "one\n")).toEqual({ ok: true, value: undefined });
    expect(appendTextSync(file, "two\n").ok).toBe(true);
    expect(readFileSync(file, "utf8")).toBe("one\ntwo\n");
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("refuses a symlink and leaves its target alone", () => {
    const target = join(dir, "target");
    writeFileSync(target, "keep");
    symlinkSync(target, join(dir, "link"));
    const result = appendTextSync(join(dir, "link"), "x");
    expect(result).toMatchObject({ ok: false, error: { reason: "symlink" } });
    expect(readFileSync(target, "utf8")).toBe("keep");
  });

  it("refuses a FIFO without hanging", { timeout: 10_000 }, async () => {
    const fifo = join(dir, "fifo");
    const made = await createProcessRunner().run({ command: { argv: ["mkfifo", fifo] }, cwd: dir, timeoutMs: 5_000 });
    expect(made).toMatchObject({ kind: "finished", exitCode: 0 });
    expect(appendTextSync(fifo, "x").ok).toBe(false);
  });

  it("refuses a folder", () => {
    expect(appendTextSync(dir, "x").ok).toBe(false);
  });
});

describe("replaceTextSync", () => {
  it("replaces the content and leaves no temp file", () => {
    const file = join(dir, "settings.json");
    writeFileSync(file, "old");
    expect(replaceTextSync(file, "new").ok).toBe(true);
    expect(readFileSync(file, "utf8")).toBe("new");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(["settings.json"]);
  });

  it("replaces a symlink itself, never writing through it", () => {
    const target = join(dir, "target");
    writeFileSync(target, "keep");
    symlinkSync(target, join(dir, "link"));
    expect(replaceTextSync(join(dir, "link"), "new").ok).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("keep");
  });

  it("refuses a planted symlink at the temp path and leaves the link alone", () => {
    const target = join(dir, "target");
    writeFileSync(target, "keep");
    pinned.bytes = Buffer.from("0123456789ab", "hex");
    const temp = join(dir, "file.0123456789ab.tmp");
    symlinkSync(target, temp);
    expect(replaceTextSync(join(dir, "file"), "new")).toMatchObject({ ok: false, error: { reason: "io_error", code: "EEXIST" } });
    expect(readFileSync(target, "utf8")).toBe("keep");
    expect(lstatSync(temp).isSymbolicLink()).toBe(true);
    expect(readdirSync(dir).sort()).toEqual(["file.0123456789ab.tmp", "target"]);
  });

  it("uses a new temp name for every write", () => {
    const file = join(dir, "file");
    pinned.bytes = Buffer.from("0123456789ab", "hex");
    writeFileSync(join(dir, "file.0123456789ab.tmp"), "someone else's");
    pinned.bytes = undefined;
    expect(replaceTextSync(file, "new").ok).toBe(true);
    expect(readFileSync(file, "utf8")).toBe("new");
  });

  it.each([0o600, 0o644])("sets mode %o exactly, whatever the umask and the old file's mode", (mode) => {
    const file = join(dir, "file");
    writeFileSync(file, "old", { mode: 0o666 });
    const before = process.umask(0o077);
    try {
      expect(replaceTextSync(file, "new", mode).ok).toBe(true);
    } finally {
      process.umask(before);
    }
    expect(statSync(file).mode & 0o777).toBe(mode);
  });

  it("reports a missing folder as an error value", () => {
    expect(replaceTextSync(join(dir, "missing", "file"), "x")).toMatchObject({ ok: false, error: { reason: "io_error", code: "ENOENT" } });
  });
});
