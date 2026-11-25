import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findOnPath } from "./which.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function folder(files: Record<string, number>): string {
  const dir = mkdtempSync(join(tmpdir(), "tk-which-"));
  dirs.push(dir);
  for (const [name, mode] of Object.entries(files)) {
    writeFileSync(join(dir, name), "#!/bin/sh\n");
    chmodSync(join(dir, name), mode);
  }
  return dir;
}

describe("findOnPath", () => {
  it("returns the first runnable match in PATH order", () => {
    const first = folder({ claude: 0o755 });
    const second = folder({ claude: 0o755 });
    expect(findOnPath("claude", { PATH: `${first}:${second}` })).toBe(join(first, "claude"));
  });

  it("skips a file without an execute bit and a folder of the same name", () => {
    const plain = folder({ claude: 0o644 });
    const real = folder({ claude: 0o755 });
    const withDir = folder({});
    mkdirSync(join(withDir, "claude"));
    expect(findOnPath("claude", { PATH: `${plain}:${withDir}:${real}` })).toBe(join(real, "claude"));
  });

  it("follows a link to a runnable file", () => {
    const target = folder({ real: 0o755 });
    const links = folder({});
    symlinkSync(join(target, "real"), join(links, "claude"));
    expect(findOnPath("claude", { PATH: links })).toBe(join(links, "claude"));
  });

  it("looks only on the PATH the runner passes: relative entries do not count", () => {
    const dir = folder({ claude: 0o755 });
    expect(findOnPath("claude", { PATH: `.:${dir.slice(1)}:` })).toBeUndefined();
  });

  it("finds nothing without a PATH, for an empty name or for a name with a slash", () => {
    const dir = folder({ claude: 0o755 });
    expect(findOnPath("claude", {})).toBeUndefined();
    expect(findOnPath("", { PATH: dir })).toBeUndefined();
    expect(findOnPath("../claude", { PATH: dir })).toBeUndefined();
  });
});
