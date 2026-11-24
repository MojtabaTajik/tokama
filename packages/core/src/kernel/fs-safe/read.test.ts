import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProcessRunner } from "../process/index.js";
import type { Result } from "../result/index.js";
import {
  isInside,
  listFiles,
  readJsonFile,
  readTextFile,
  readTextFileInside,
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
