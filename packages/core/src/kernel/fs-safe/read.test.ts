import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProcessRunner } from "../process/index.js";
import type { Result } from "../result/index.js";
import {
  isInside,
  listFiles,
  listFolders,
  readJsonFile,
  readLinesFrom,
  readTextFile,
  readTextFileInside,
  readTextHead,
  type ReadFailure,
  type ReadFailureReason,
} from "./index.js";

// Cases ported from ai-pipeline tests/test_summarize.py (read_text refuses FIFO, symlink and big
// files) and tests/test_serve.py (FIFO run file refused, run dir must resolve inside runs_dir).

const BIG = { maxBytes: 1024 };
let dir: string;
let outside: string;
beforeEach(() => {
  // realpath: on macOS the temp folder is behind the /var -> /private/var link.
  dir = realpathSync(mkdtempSync(join(tmpdir(), "tokama-fs-safe-")));
  outside = realpathSync(mkdtempSync(join(tmpdir(), "tokama-fs-safe-outside-")));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

function write(name: string, content: string | Buffer, base = dir): string {
  const path = join(base, name);
  writeFileSync(path, content);
  return path;
}

function reason(result: Result<unknown, ReadFailure>): ReadFailureReason | "ok" {
  return result.ok ? "ok" : result.error.reason;
}

describe("readTextFile", () => {
  it("reads a regular file", async () => {
    expect(await readTextFile(write("a.txt", "héllo\n"), BIG)).toEqual({ ok: true, value: "héllo\n" });
    expect(await readTextFile(write("empty", ""), BIG)).toEqual({ ok: true, value: "" });
  });

  it("reports a missing file, also under a missing or non-directory parent", async () => {
    const result = await readTextFile(join(dir, "missing"), BIG);
    expect(result).toEqual({ ok: false, error: expect.objectContaining({ reason: "not_found", path: join(dir, "missing") }) });
    expect(reason(await readTextFile(join(dir, "nope", "x"), BIG))).toBe("not_found");
    expect(reason(await readTextFile(join(write("file", "x"), "x"), BIG))).toBe("not_found");
  });

  it("refuses a symlink, also a dangling one or one to a directory", async () => {
    const target = write("target.txt", "secret");
    symlinkSync(target, join(dir, "link"));
    symlinkSync(join(dir, "gone"), join(dir, "dangling"));
    symlinkSync(outside, join(dir, "dirlink"));
    expect(reason(await readTextFile(join(dir, "link"), BIG))).toBe("symlink");
    expect(reason(await readTextFile(join(dir, "dangling"), BIG))).toBe("symlink");
    expect(reason(await readTextFile(join(dir, "dirlink"), BIG))).toBe("symlink");
  });

  it("refuses a directory", async () => {
    mkdirSync(join(dir, "sub"));
    expect(reason(await readTextFile(join(dir, "sub"), BIG))).toBe("not_regular_file");
  });

  it("refuses a FIFO with no writer without hanging", { timeout: 10_000 }, async () => {
    const fifo = join(dir, "fifo");
    const made = await createProcessRunner().run({ command: { argv: ["mkfifo", fifo] }, cwd: dir, timeoutMs: 5_000 });
    expect(made).toMatchObject({ kind: "finished", exitCode: 0 });
    // A blocking open would wait here for a writer forever; the test timeout turns that into a failure.
    expect(reason(await readTextFile(fifo, BIG))).toBe("not_regular_file");
  });

  it("refuses a device", async () => {
    expect(reason(await readTextFile("/dev/zero", BIG))).toBe("not_regular_file");
  });

  it("caps the size at maxBytes", async () => {
    expect(await readTextFile(write("ok", "x".repeat(10)), { maxBytes: 10 })).toEqual({ ok: true, value: "x".repeat(10) });
    const big = await readTextFile(write("big", "x".repeat(11)), { maxBytes: 10 });
    expect(big).toEqual({ ok: false, error: expect.objectContaining({ reason: "too_large" }) });
    // Larger than one read chunk; the size check refuses it before any read.
    expect(reason(await readTextFile(write("huge", Buffer.alloc(200_000, 0x61)), { maxBytes: 199_999 }))).toBe("too_large");
    expect(reason(await readTextFile(join(dir, "huge"), { maxBytes: 200_000 }))).toBe("ok");
  });

  // procfs files are regular files whose fstat size is 0, so only the read loop sees how big they are,
  // as with a file that grows after fstat.
  it.runIf(process.platform === "linux")("caps the bytes read when fstat reports a smaller size", async () => {
    expect(reason(await readTextFile("/proc/self/status", { maxBytes: 8 }))).toBe("too_large");
    expect(reason(await readTextFile("/proc/self/status", { maxBytes: 1024 * 1024 }))).toBe("ok");
  });

  it("caps the line count at maxLines", async () => {
    const lines = { maxBytes: 1024, maxLines: 3 };
    expect(reason(await readTextFile(write("3", "a\nb\nc"), lines))).toBe("ok");
    expect(reason(await readTextFile(write("3nl", "a\nb\nc\n"), lines))).toBe("ok");
    expect(reason(await readTextFile(write("3crlf", "a\r\nb\r\nc\r\n"), lines))).toBe("ok");
    expect(reason(await readTextFile(write("4", "a\nb\nc\nd"), lines))).toBe("too_many_lines");
    expect(reason(await readTextFile(write("4blank", "a\nb\nc\n\n"), lines))).toBe("too_many_lines");
    expect(reason(await readTextFile(write("none", ""), { maxBytes: 10, maxLines: 0 }))).toBe("ok");
  });

  it("refuses invalid UTF-8", async () => {
    const result = await readTextFile(write("bad", Buffer.from([0x61, 0xff, 0x62])), BIG);
    expect(reason(result)).toBe("invalid_utf8");
    // A multi-byte character cut off at the end of the file.
    expect(reason(await readTextFile(write("cut", Buffer.from([0x61, 0xc3])), BIG))).toBe("invalid_utf8");
  });
});

describe("readTextHead", () => {
  it("reads a whole file within the cap", async () => {
    expect(await readTextHead(write("a.txt", "héllo\n"), BIG)).toEqual({ ok: true, value: { text: "héllo\n", truncated: false } });
    expect(await readTextHead(write("ten", "x".repeat(10)), { maxBytes: 10 })).toEqual({ ok: true, value: { text: "x".repeat(10), truncated: false } });
  });

  it("returns the first maxBytes of a larger file, also past one read chunk", async () => {
    expect(await readTextHead(write("big", "x".repeat(11)), { maxBytes: 10 })).toEqual({ ok: true, value: { text: "x".repeat(10), truncated: true } });
    const huge = await readTextHead(write("huge", Buffer.alloc(200_000, 0x61)), { maxBytes: 100_000 });
    expect(huge.ok && huge.value.text.length).toBe(100_000);
    expect(huge.ok && huge.value.truncated).toBe(true);
  });

  it("leaves out a character the cap splits", async () => {
    // "aé€" is 61 | c3 a9 | e2 82 ac: caps inside é and inside € drop the split character.
    const path = write("split", "aé€");
    expect(await readTextHead(path, { maxBytes: 2 })).toEqual({ ok: true, value: { text: "a", truncated: true } });
    expect(await readTextHead(path, { maxBytes: 3 })).toEqual({ ok: true, value: { text: "aé", truncated: true } });
    expect(await readTextHead(path, { maxBytes: 5 })).toEqual({ ok: true, value: { text: "aé", truncated: true } });
    expect(await readTextHead(path, { maxBytes: 6 })).toEqual({ ok: true, value: { text: "aé€", truncated: false } });
  });

  it("keeps the open rules and refuses invalid UTF-8", async () => {
    symlinkSync(write("target.txt", "secret"), join(dir, "link"));
    mkdirSync(join(dir, "sub"));
    expect(reason(await readTextHead(join(dir, "missing"), BIG))).toBe("not_found");
    expect(reason(await readTextHead(join(dir, "link"), BIG))).toBe("symlink");
    expect(reason(await readTextHead(join(dir, "sub"), BIG))).toBe("not_regular_file");
    expect(reason(await readTextHead("/dev/zero", BIG))).toBe("not_regular_file");
    expect(reason(await readTextHead(write("bad", Buffer.from([0x61, 0xff, 0x62])), BIG))).toBe("invalid_utf8");
  });
});

describe("readJsonFile", () => {
  it("parses JSON", async () => {
    expect(await readJsonFile(write("a.json", '{"a": [1, null]}'), BIG)).toEqual({ ok: true, value: { a: [1, null] } });
  });

  it("refuses invalid JSON, including a torn file", async () => {
    expect(reason(await readJsonFile(write("torn.json", '{"a": '), BIG))).toBe("invalid_json");
    expect(reason(await readJsonFile(write("nan.json", '{"a": NaN}'), BIG))).toBe("invalid_json");
  });

  it("passes read failures through", async () => {
    symlinkSync(write("t.json", "{}"), join(dir, "link.json"));
    expect(reason(await readJsonFile(join(dir, "link.json"), BIG))).toBe("symlink");
    expect(reason(await readJsonFile(write("big.json", "[1,2,3]"), { maxBytes: 3 }))).toBe("too_large");
  });
});

describe("isInside", () => {
  it("accepts the root and paths below it", async () => {
    mkdirSync(join(dir, "sub"));
    write("f", "x", join(dir, "sub"));
    expect(await isInside(dir, dir)).toBe(true);
    expect(await isInside(dir, join(dir, "sub"))).toBe(true);
    expect(await isInside(dir, join(dir, "sub", "f"))).toBe(true);
    expect(await isInside(dir, `${dir}/sub/../sub/f`)).toBe(true);
    expect(await isInside(dir, write("..x", "a"))).toBe(true);
  });

  it("refuses a path that escapes through a symlinked parent", async () => {
    write("secret", "s", outside);
    symlinkSync(outside, join(dir, "escape"));
    expect(await isInside(dir, join(dir, "escape", "secret"))).toBe(false);
  });

  it("applies .. after a symlink, as the OS does, not before", async () => {
    // root/link -> outside/deep; root/link/../secret is outside/secret to the OS, though a
    // lexical normalisation would turn it into root/secret.
    mkdirSync(join(outside, "deep"));
    write("secret", "outside", outside);
    write("secret", "inside");
    symlinkSync(join(outside, "deep"), join(dir, "link"));
    // Not join(): it would normalise the `..` away before the call.
    const path = `${dir}/link/../secret`;
    expect(await isInside(dir, path)).toBe(false);
    // The read that follows sees the same file the check saw.
    expect(await readTextFile(path, BIG)).toEqual({ ok: true, value: "outside" });
  });

  it("refuses a sibling whose name starts with the root's name", async () => {
    const sibling = `${dir}-evil`;
    mkdirSync(sibling);
    try {
      expect(await isInside(dir, write("f", "x", sibling))).toBe(false);
    } finally {
      rmSync(sibling, { recursive: true, force: true });
    }
  });

  it("refuses paths above the root and missing paths", async () => {
    expect(await isInside(dir, join(dir, ".."))).toBe(false);
    expect(await isInside(dir, outside)).toBe(false);
    expect(await isInside(dir, join(dir, "missing"))).toBe(false);
    expect(await isInside(join(dir, "missing"), dir)).toBe(false);
  });
});

describe("readTextFileInside", () => {
  it("reads a file inside the root", async () => {
    expect(await readTextFileInside(dir, write("a.txt", "x"), BIG)).toEqual({ ok: true, value: "x" });
  });

  it("does not open a file reached through a symlinked folder outside the root", async () => {
    write("secret.txt", "secret", outside);
    symlinkSync(outside, join(dir, "linked"));
    expect(reason(await readTextFileInside(dir, join(dir, "linked", "secret.txt"), BIG))).toBe("outside_root");
  });

  it("names a missing file and a symlink to outside", async () => {
    expect(reason(await readTextFileInside(dir, join(dir, "gone.txt"), BIG))).toBe("not_found");
    symlinkSync(write("secret.txt", "secret", outside), join(dir, "link.txt"));
    expect(reason(await readTextFileInside(dir, join(dir, "link.txt"), BIG))).toBe("symlink");
  });

  it("still refuses a symlink that stays inside the root", async () => {
    symlinkSync(write("real.txt", "x"), join(dir, "link.txt"));
    expect(reason(await readTextFileInside(dir, join(dir, "link.txt"), BIG))).toBe("symlink");
  });
});

describe("listFiles", () => {
  it("lists the entries that are not folders, sorted", async () => {
    mkdirSync(join(dir, "sub", "folder"), { recursive: true });
    write("sub/b.yaml", "");
    write("sub/a.yaml", "");
    symlinkSync(join(dir, "sub", "a.yaml"), join(dir, "sub", "c.yaml"));
    expect(await listFiles(dir, "sub", { max: 10 })).toEqual({ ok: true, value: ["a.yaml", "b.yaml", "c.yaml"] });
  });

  it("refuses a folder that links outside the root, before listing it", async () => {
    symlinkSync(outside, join(dir, "sub"));
    expect(reason(await listFiles(dir, "sub", { max: 10 }))).toBe("symlink");
    mkdirSync(join(dir, "real"));
    symlinkSync(outside, join(dir, "real", "nested"));
    write("x.yaml", "", outside);
    expect(reason(await listFiles(dir, "real/nested", { max: 10 }))).toBe("symlink");
  });

  it("refuses a folder inside a symlinked folder outside the root", async () => {
    mkdirSync(join(outside, "inner"));
    symlinkSync(outside, join(dir, "linked"));
    expect(reason(await listFiles(dir, "linked/inner", { max: 10 }))).toBe("outside_root");
  });

  it("names a missing folder and too many entries", async () => {
    expect(reason(await listFiles(dir, "gone", { max: 10 }))).toBe("not_found");
    mkdirSync(join(dir, "many"));
    for (let i = 0; i < 3; i++) write(`many/${i}`, "");
    expect(reason(await listFiles(dir, "many", { max: 2 }))).toBe("too_many_entries");
  });
});

describe("listFolders", () => {
  it("lists real folders only, sorted: no files, no links to folders", async () => {
    mkdirSync(join(dir, "sub", "b"), { recursive: true });
    mkdirSync(join(dir, "sub", "a"));
    write("sub/file.txt", "");
    symlinkSync(join(dir, "sub", "a"), join(dir, "sub", "c"));
    symlinkSync(outside, join(dir, "sub", "d"));
    expect(await listFolders(dir, "sub", { max: 10 })).toEqual({ ok: true, value: ["a", "b"] });
  });

  it("refuses a folder that links outside the root, a missing folder and too many entries", async () => {
    symlinkSync(outside, join(dir, "linked"));
    expect(reason(await listFolders(dir, "linked", { max: 10 }))).toBe("symlink");
    expect(reason(await listFolders(dir, "gone", { max: 10 }))).toBe("not_found");
    for (let i = 0; i < 3; i++) mkdirSync(join(dir, `many-${i}`));
    expect(reason(await listFolders(dir, "", { max: 2 }))).toBe("too_many_entries");
  });
});

describe("readLinesFrom", () => {
  const LIMITS = { maxFileBytes: 1024 * 1024, maxLineBytes: 100 };
  async function lines(path: string, options: Parameters<typeof readLinesFrom>[1] = LIMITS) {
    const seen: string[] = [];
    const result = await readLinesFrom(path, options, (line) => seen.push(line));
    return { seen, result };
  }

  it("gives each complete line and leaves a line still being written for later", async () => {
    const path = write("log.jsonl", "one\r\ntwo\nthr");
    const first = await lines(path);
    expect(first.seen).toEqual(["one", "two"]);
    expect(first.result).toEqual({ ok: true, value: expect.objectContaining({ start: 0, end: 9, size: 12, skipped: 0 }) });
    if (!first.result.ok) return;
    appendFileSync(path, "ee\nfour\n");
    const second = await lines(path, { ...LIMITS, resume: { ino: first.result.value.ino, offset: first.result.value.end } });
    expect(second.seen).toEqual(["three", "four"]);
    expect(second.result.ok && second.result.value).toMatchObject({ start: 9, end: 20, size: 20 });
  });

  it("skips a line over the cap and an invalid UTF-8 line, and goes on after them", async () => {
    // The long line spans several chunks, so it is dropped without being kept.
    const path = write("log.jsonl", Buffer.concat([Buffer.from(`a\n${"x".repeat(200 * 1024)}\n`), Buffer.from([0xff, 0xfe, 10]), Buffer.from("b\n")]));
    const { seen, result } = await lines(path);
    expect(seen).toEqual(["a", "b"]);
    expect(result.ok && result.value.skipped).toBe(2);
  });

  it("starts again from the beginning when the file was replaced or truncated", async () => {
    const path = write("log.jsonl", "old line one\nold line two\n");
    const first = await lines(path);
    if (!first.result.ok) throw new Error("read failed");
    const { ino, end } = first.result.value;
    writeFileSync(path, "new\n");
    expect((await lines(path, { ...LIMITS, resume: { ino, offset: end } })).seen).toEqual(["new"]);
    write("other.jsonl", "fresh\n");
    renameSync(join(dir, "other.jsonl"), path);
    expect((await lines(path, { ...LIMITS, resume: { ino, offset: 0 } })).seen).toEqual(["fresh"]);
  });

  it("refuses a symlink, a folder and a file over the size cap", async () => {
    symlinkSync(write("real.jsonl", "x\n"), join(dir, "link.jsonl"));
    expect(reason((await lines(join(dir, "link.jsonl"))).result)).toBe("symlink");
    mkdirSync(join(dir, "folder.jsonl"));
    expect(reason((await lines(join(dir, "folder.jsonl"))).result)).toBe("not_regular_file");
    expect(reason((await lines(write("big.jsonl", "x".repeat(50)), { maxFileBytes: 10, maxLineBytes: 100 })).result)).toBe("too_large");
    expect(reason((await lines(join(dir, "missing.jsonl"))).result)).toBe("not_found");
  });

  it("ends at the size of a file not changed since a time, without reading it", async () => {
    const path = write("old.jsonl", "a\nb\n");
    utimesSync(path, new Date(1_000_000), new Date(1_000_000));
    const { seen, result } = await lines(path, { ...LIMITS, modifiedSince: 2_000_000 });
    expect(seen).toEqual([]);
    expect(result.ok && result.value).toMatchObject({ start: 0, end: 4, size: 4 });
    expect((await lines(path, { ...LIMITS, modifiedSince: 500_000 })).seen).toEqual(["a", "b"]);
  });

  it("stops when aborted and ends at the last complete line read", async () => {
    const stop = new AbortController();
    const path = write("long.jsonl", `${"line\n".repeat(100_000)}`);
    const seen: string[] = [];
    const result = await readLinesFrom(path, { ...LIMITS, signal: stop.signal }, (line) => {
      seen.push(line);
      stop.abort();
    });
    expect(seen.length).toBeLessThan(100_000);
    expect(result.ok && result.value.end).toBe(seen.length * 5);
  });
});
