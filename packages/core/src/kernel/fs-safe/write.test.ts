import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProcessRunner } from "../process/index.js";
import { appendTextSync, replaceTextSync } from "./index.js";

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "tokama-fs-write-")));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

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

  it("refuses a planted symlink at the temp path", () => {
    const target = join(dir, "target");
    writeFileSync(target, "keep");
    // The stale temp is removed first, so a planted link is unlinked, not followed.
    symlinkSync(target, join(dir, `file.${process.pid}.tmp`));
    expect(replaceTextSync(join(dir, "file"), "new").ok).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("keep");
    expect(readFileSync(join(dir, "file"), "utf8")).toBe("new");
  });

  it("reports a missing folder as an error value", () => {
    expect(replaceTextSync(join(dir, "missing", "file"), "x")).toMatchObject({ ok: false, error: { reason: "io_error", code: "ENOENT" } });
  });
});
