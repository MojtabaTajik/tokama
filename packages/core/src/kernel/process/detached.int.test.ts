import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ChildProcess, spawnDetached } from "./detached.js";

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "tokama-detached-")));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const exited = (child: ChildProcess) => new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));

describe("spawnDetached", () => {
  it("appends stdout and stderr to a private log and leads its own process group", async () => {
    const logPath = join(dir, "engine.log");
    writeFileSync(logPath, "before\n", { mode: 0o644 });
    const started = spawnDetached({ command: "/bin/sh", args: ["-c", "echo out; echo err >&2; ps -o pgid= -p $$"], env: { PATH: "/usr/bin:/bin" }, logPath });
    if (!started.ok) throw new Error(started.error.message);
    const child = started.value;
    expect(await exited(child)).toBe(0);
    const [before, out, err, pgid] = readFileSync(logPath, "utf8").trim().split("\n");
    expect([before, out, err]).toEqual(["before", "out", "err"]);
    expect(Number(pgid)).toBe(child.pid);
    expect(statSync(logPath).mode & 0o777).toBe(0o600);
  });

  it("fails without spawning when the log cannot be opened", () => {
    const logPath = join(dir, "missing", "engine.log");
    expect(spawnDetached({ command: "/bin/sh", args: ["-c", "exit 0"], env: {}, logPath })).toMatchObject({ ok: false, error: { message: expect.stringContaining(`cannot prepare ${logPath}`) } });
  });

  it("refuses a symlink in place of the log and leaves its target alone", () => {
    const target = join(dir, "elsewhere");
    writeFileSync(target, "keep\n", { mode: 0o644 });
    symlinkSync(target, join(dir, "engine.log"));
    expect(spawnDetached({ command: "/bin/sh", args: ["-c", "echo out"], env: {}, logPath: join(dir, "engine.log") }).ok).toBe(false);
    expect(readFileSync(target, "utf8")).toBe("keep\n");
    expect(statSync(target).mode & 0o777).toBe(0o644);
  });
});
