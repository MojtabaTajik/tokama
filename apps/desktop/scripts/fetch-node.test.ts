import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureNodeRuntime, readNodeRuntime, sha256File, tarballName, tarballUrl } from "./fetch-node.js";

const pinned = join(import.meta.dirname, "..", "packaging", "node-runtime.json");
const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

describe("node-runtime.json", () => {
  it("pins the version in .node-version", () => {
    const wanted = readFileSync(join(import.meta.dirname, "..", "..", "..", ".node-version"), "utf8").trim();
    expect(readNodeRuntime(pinned).version).toBe(wanted);
  });

  it("has a hash for Apple silicon and for Linux x86_64, and every key and hash is well formed", () => {
    const { sha256 } = readNodeRuntime(pinned);
    expect(Object.keys(sha256)).toEqual(expect.arrayContaining(["darwin-arm64", "linux-x64"]));
    for (const [key, hash] of Object.entries(sha256)) {
      expect(key).toMatch(/^(darwin|linux|win32)-(arm64|x64)$/);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("names the official tarball and its URL", () => {
    expect(tarballName("26.13.1", "darwin", "arm64")).toBe("node-v26.13.1-darwin-arm64.tar.xz");
    expect(tarballUrl("26.13.1", "darwin", "arm64")).toBe("https://nodejs.org/dist/v26.13.1/node-v26.13.1-darwin-arm64.tar.xz");
  });
});

describe("readNodeRuntime", () => {
  let dir: string;
  beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), "tk-node-runtime-"))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it.each([
    ["a version that is not plain", { version: "v26.13", sha256: {} }],
    ["a key that is not platform-arch", { version: "1.2.3", sha256: { mac: sha("a") } }],
    ["a hash that is not 64 lowercase hex digits", { version: "1.2.3", sha256: { "darwin-arm64": sha("a").toUpperCase() } }],
    ["no hash table", { version: "1.2.3" }],
  ])("rejects %s", (_name, content) => {
    const file = join(dir, "node-runtime.json");
    writeFileSync(file, JSON.stringify(content));
    expect(() => readNodeRuntime(file)).toThrow();
  });
});

describe("sha256File", () => {
  it("hashes the file's bytes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tk-sha-"));
    try {
      writeFileSync(join(dir, "f"), "abc");
      expect(await sha256File(join(dir, "f"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("ensureNodeRuntime", () => {
  const VERSION = "1.2.3";
  const PREFIX = `node-v${VERSION}-darwin-arm64`;
  let root: string;
  beforeEach(() => void (root = mkdtempSync(join(tmpdir(), "tk-ensure-node-"))));
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const cacheDir = () => join(root, "cache");
  const outDir = () => join(root, "out");
  const cached = () => join(cacheDir(), tarballName(VERSION, "darwin", "arm64"));

  /** A tarball shaped like Node's, whose `bin/node` is a script that prints its version; `licenseLink` makes LICENSE a symlink instead. */
  function makeTarball(licenseLink = false): Buffer {
    const src = join(root, "src");
    mkdirSync(join(src, PREFIX, "bin"), { recursive: true });
    writeFileSync(join(src, PREFIX, "bin", "node"), `#!/bin/sh\necho v${VERSION}\n`, { mode: 0o755 });
    if (licenseLink) symlinkSync("/etc/hosts", join(src, PREFIX, "LICENSE"));
    else writeFileSync(join(src, PREFIX, "LICENSE"), "a licence\n");
    writeFileSync(join(src, PREFIX, "other"), "not taken\n");
    const file = join(root, "node.tar.xz");
    execFileSync("tar", ["-cJf", file, "-C", src, PREFIX]);
    return readFileSync(file);
  }

  function setup(tarball: Buffer, hash = sha(tarball)) {
    const runtimeFile = join(root, "node-runtime.json");
    writeFileSync(runtimeFile, JSON.stringify({ version: VERSION, sha256: { "darwin-arm64": hash } }));
    const urls: string[] = [];
    const fetcher = (async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response(new Uint8Array(tarball));
    }) as typeof fetch;
    return { runtimeFile, urls, fetcher };
  }

  const run = (runtimeFile: string, fetcher: typeof fetch, platform = "darwin", arch = "arm64") => ensureNodeRuntime({ runtimeFile, cacheDir: cacheDir(), outDir: outDir(), platform, arch, fetch: fetcher });

  it("downloads, checks the hash, and takes only the binary and the licence", async () => {
    const { runtimeFile, urls, fetcher } = setup(makeTarball());
    const done = await run(runtimeFile, fetcher);
    expect(urls).toEqual([tarballUrl(VERSION, "darwin", "arm64")]);
    expect(readdirSync(outDir()).sort()).toEqual(["LICENSE-node", "tokama-engine"]);
    expect(readFileSync(done.license, "utf8")).toBe("a licence\n");
    expect(existsSync(cached())).toBe(true);
  });

  it("uses a cached tarball whose hash matches, without downloading", async () => {
    const tarball = makeTarball();
    const { runtimeFile, urls, fetcher } = setup(tarball);
    mkdirSync(cacheDir(), { recursive: true });
    writeFileSync(cached(), tarball);
    await run(runtimeFile, fetcher);
    expect(urls).toEqual([]);
  });

  it("deletes a cached tarball with the wrong hash, downloads again, and extracts nothing when that one is wrong too", async () => {
    const { runtimeFile, urls, fetcher } = setup(makeTarball(), sha("the pinned file"));
    mkdirSync(cacheDir(), { recursive: true });
    writeFileSync(cached(), "tampered");
    await expect(run(runtimeFile, fetcher)).rejects.toThrow(/expected [0-9a-f]{64}/);
    expect(urls).toHaveLength(1);
    expect(readdirSync(cacheDir())).toEqual([]);
    expect(existsSync(outDir())).toBe(false);
  });

  it("refuses a download that does not succeed", async () => {
    const { runtimeFile } = setup(makeTarball());
    await expect(run(runtimeFile, (async () => new Response("no", { status: 404 })) as typeof fetch)).rejects.toThrow(/HTTP 404/);
    expect(readdirSync(cacheDir())).toEqual([]);
  });

  it("refuses a platform with no pinned hash", async () => {
    const { runtimeFile, fetcher } = setup(makeTarball());
    await expect(run(runtimeFile, fetcher, "linux", "x64")).rejects.toThrow("no pinned Node for linux-x64");
  });

  it("refuses a licence that is a symbolic link", async () => {
    const { runtimeFile, fetcher } = setup(makeTarball(true));
    await expect(run(runtimeFile, fetcher)).rejects.toThrow(/not a regular file/);
    expect(existsSync(outDir())).toBe(false);
  });
});
