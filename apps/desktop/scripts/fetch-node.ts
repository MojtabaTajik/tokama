// Fetches the official Node.js binary the packaged app runs its engine on:
//   node scripts/fetch-node.ts --out <dir> [--platform darwin --arch arm64]
// writes `<dir>/tokama-engine` (Node's own binary, renamed) and `<dir>/LICENSE-node`.
// The version and the SHA-256 of each tarball are pinned in packaging/node-runtime.json. A tarball
// is unpacked only after its hash matches, and only the binary and the licence are taken from it.
// It never copies the node that runs this script or one from PATH.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parseArgs } from "node:util";

export type NodeRuntime = {
  readonly version: string;
  /** SHA-256 of the `.tar.xz` file, by `<platform>-<arch>`. */
  readonly sha256: Readonly<Record<string, string>>;
};

const DOWNLOAD_TIMEOUT_MS = 300_000;

/** Reads and checks `node-runtime.json`: a plain version, and a 64-digit lowercase hex hash for each `<platform>-<arch>`. */
export function readNodeRuntime(file: string): NodeRuntime {
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (typeof parsed !== "object" || parsed === null) throw new Error(`${file}: not an object`);
  const { version, sha256 } = parsed as { version?: unknown; sha256?: unknown };
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`${file}: version must be like 26.13.1`);
  if (typeof sha256 !== "object" || sha256 === null) throw new Error(`${file}: sha256 must be an object`);
  for (const [key, hash] of Object.entries(sha256)) {
    if (!/^(darwin|linux|win32)-(arm64|x64)$/.test(key)) throw new Error(`${file}: "${key}" is not a <platform>-<arch> key`);
    if (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) throw new Error(`${file}: the hash of ${key} must be 64 lowercase hex digits`);
  }
  return { version, sha256: sha256 as Record<string, string> };
}

export const tarballName = (version: string, platform: string, arch: string) => `node-v${version}-${platform}-${arch}.tar.xz`;

export const tarballUrl = (version: string, platform: string, arch: string) => `https://nodejs.org/dist/v${version}/${tarballName(version, platform, arch)}`;

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export interface EnsureNodeOptions {
  readonly runtimeFile: string;
  /** Where downloaded tarballs are kept between builds. */
  readonly cacheDir: string;
  readonly outDir: string;
  readonly platform: string;
  readonly arch: string;
  /** For tests; default: the global fetch. */
  readonly fetch?: typeof fetch;
}

const changeHint = "The hash in node-runtime.json may change only through a reviewed change.";

/** Puts the pinned Node binary and its licence in `outDir`; returns their paths. */
export async function ensureNodeRuntime(options: EnsureNodeOptions): Promise<{ node: string; license: string }> {
  const { runtimeFile, cacheDir, outDir, platform, arch } = options;
  const runtime = readNodeRuntime(runtimeFile);
  const key = `${platform}-${arch}`;
  const expected = runtime.sha256[key];
  if (expected === undefined) throw new Error(`no pinned Node for ${key}`);

  mkdirSync(cacheDir, { recursive: true });
  const archive = join(cacheDir, tarballName(runtime.version, platform, arch));
  if (existsSync(archive) && (await sha256File(archive)) !== expected) rmSync(archive, { force: true });
  if (!existsSync(archive)) await download(tarballUrl(runtime.version, platform, arch), archive, expected, options.fetch ?? fetch);

  const prefix = `node-v${runtime.version}-${key}`;
  const tmp = mkdtempSync(join(tmpdir(), "tokama-node-"));
  try {
    // Only these two members are extracted.
    execFileSync("tar", ["-xJf", archive, "-C", tmp, `${prefix}/bin/node`, `${prefix}/LICENSE`], { stdio: ["ignore", "ignore", "inherit"] });
    const node = join(tmp, prefix, "bin", "node");
    const license = join(tmp, prefix, "LICENSE");
    for (const path of [node, license]) {
      if (!lstatSync(path).isFile()) throw new Error(`${path} is not a regular file`);
    }
    mkdirSync(outDir, { recursive: true });
    const out = { node: join(outDir, "tokama-engine"), license: join(outDir, "LICENSE-node") };
    copyFileSync(node, out.node);
    chmodSync(out.node, 0o755);
    copyFileSync(license, out.license);
    if (key === `${process.platform}-${process.arch}`) {
      const reported = execFileSync(out.node, ["--version"], { encoding: "utf8" }).trim();
      if (reported !== `v${runtime.version}`) throw new Error(`the Node binary reports ${reported}, not v${runtime.version}`);
    }
    return out;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Downloads `url` to `target`; the file is put in place only when its hash is `expected`. */
async function download(url: string, target: string, expected: string, fetcher: typeof fetch): Promise<void> {
  const response = await fetcher(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok || response.body === null) throw new Error(`download of ${url} failed: HTTP ${response.status}`);
  const part = `${target}.part-${process.pid}`;
  const hash = createHash("sha256");
  try {
    await pipeline(
      Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
      async function* (source: AsyncIterable<Buffer>) {
        for await (const chunk of source) {
          hash.update(chunk);
          yield chunk;
        }
      },
      createWriteStream(part, { mode: 0o600 }),
    );
    const actual = hash.digest("hex");
    if (actual !== expected) throw new Error(`${url} has SHA-256 ${actual}, expected ${expected}. ${changeHint}`);
    renameSync(part, target);
  } finally {
    rmSync(part, { force: true });
  }
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { out: { type: "string" }, platform: { type: "string", default: "darwin" }, arch: { type: "string", default: "arm64" } }, strict: true });
  if (values.out === undefined) {
    process.stderr.write("usage: node scripts/fetch-node.ts --out <dir> [--platform darwin --arch arm64]\n");
    process.exit(2);
  }
  const appDir = resolve(import.meta.dirname, "..");
  const done = await ensureNodeRuntime({ runtimeFile: join(appDir, "packaging", "node-runtime.json"), cacheDir: join(appDir, "package-cache", "node"), outDir: resolve(values.out), platform: values.platform, arch: values.arch });
  process.stdout.write(`${done.node}\n`);
}
