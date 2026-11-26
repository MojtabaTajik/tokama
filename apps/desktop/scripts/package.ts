// Builds Tokama.app for this Mac, ad-hoc signed: `node scripts/package.ts [--dmg] [--feed-url <url>]`,
// run from apps/desktop after `pnpm build` (the root `pnpm package` does both). It stages the
// engine folder (the bundled engine, the pinned Node and a package.json with the app's version),
// packs the app with electron-builder, and then checks the result: the ad-hoc signature here, and
// everything else through verify-package.ts. Any failed check ends the script with a message that
// names it.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { AfterPackContext } from "electron-builder";

const appDir = resolve(import.meta.dirname, "..");
const repoDir = resolve(appDir, "..", "..");

/** The update feed of the packaged app, as electron-builder.yml has it. */
export const DEFAULT_FEED_URL = "https://updates.tokama.dev/mac/";

/** Why `url` cannot be the update feed, or undefined when it can: https, a plain host and plain path segments, and a trailing slash. */
export function feedUrlProblem(url: string): string | undefined {
  return /^https:\/\/[A-Za-z0-9.-]+(\/[A-Za-z0-9._~-]+)*\/$/.test(url) ? undefined : `the feed URL must be https, with a plain host and path and a trailing slash, not ${JSON.stringify(url)}`;
}

/** electron-builder's `afterPack` hook: Electron's own demo app archive is never opened (only the app's archive loads), so it does not ship. */
export function removeDefaultApp(context: AfterPackContext): void {
  rmSync(join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources", "default_app.asar"), { force: true });
}

/** The app's version: the one source of every version the build writes. It must be plain `x.y.z`, the only form the engine reads back. */
export function appVersion(dir: string): string {
  const { version } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version?: unknown };
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`${dir}/package.json: the version must be plain x.y.z, not ${JSON.stringify(version)}`);
  return version;
}

/** The package.json of the staged engine folder. Its version is the app's, so the engine reports the version of the app it ships in. `type` is module because the bundle's files are ES modules. */
export function engineManifest(version: string): string {
  return `${JSON.stringify({ name: "tokama-engine", private: true, version, type: "module" }, null, 2)}\n`;
}

/** Throws unless the engine folder's package.json holds the app's version. */
export function checkEngineVersion(dir: string, engineDir: string): void {
  const engine = appVersion(engineDir);
  const app = appVersion(dir);
  if (engine !== app) throw new Error(`the engine's version is ${engine}, the app's is ${app}`);
}

function fail(check: string, detail: string): never {
  process.stderr.write(`package: check failed: ${check}: ${detail}\n`);
  process.exit(1);
}

/** Runs a command to the end and returns what it printed; it never throws on a failed exit. */
export function run(command: string, args: string[], input?: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(command, args, { encoding: "utf8", ...(input !== undefined && { input }) });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

const mb = (path: string) => `${(statSync(path).size / 1024 / 1024).toFixed(0)} MB`;

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { dmg: { type: "boolean" }, "feed-url": { type: "string" } } });
  const dmg = values.dmg === true;
  const feedUrl = values["feed-url"];
  if (feedUrl !== undefined) {
    const problem = feedUrlProblem(feedUrl);
    if (problem !== undefined) fail("feed URL", problem);
  }
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    process.stderr.write("package: only Apple silicon (macOS arm64) packaging exists so far.\n");
    process.exit(1);
  }

  const stage = join(appDir, "package-stage", "engine");
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  // Child processes rather than imports: they keep each step's output and exit code apart.
  execFileSync(process.execPath, [join(repoDir, "apps", "engine", "scripts", "bundle.ts"), "--out", join(stage, "dist")], { stdio: "inherit" });
  execFileSync(process.execPath, [join(appDir, "scripts", "fetch-node.ts"), "--out", stage], { stdio: "inherit" });
  writeFileSync(join(stage, "package.json"), engineManifest(appVersion(appDir)));
  checkEngineVersion(appDir, stage);

  // electron-builder looks for an identity whose name contains the qualifier "-" in the keychain it
  // is given, and ad-hoc signs only when it finds none. It is given a new, empty keychain, so it
  // can find none and a real certificate is never used. The signature check below stays as the
  // second guard.
  const keychainDir = mkdtempSync(join(tmpdir(), "tk-package-keychain-"));
  const keychain = join(keychainDir, "empty.keychain-db");
  execFileSync("security", ["create-keychain", "-p", "", keychain], { stdio: "ignore" });
  process.env["CSC_KEYCHAIN"] = keychain;
  process.env["CSC_IDENTITY_AUTO_DISCOVERY"] = "false";
  try {
    const { build, Arch, Platform } = await import("electron-builder");
    await build({
      projectDir: appDir,
      targets: Platform.MAC.createTarget(dmg ? ["dmg", "zip"] : ["dir"], Arch.arm64),
      publish: "never",
      config: {
        // Ad-hoc on purpose; hardened runtime is off because an ad-hoc signature cannot pass library validation.
        mac: { identity: "-", hardenedRuntime: false, notarize: false },
        dmg: { sign: false },
        afterPack: removeDefaultApp,
        ...(feedUrl !== undefined && { publish: { provider: "generic", url: feedUrl } }),
      },
    });
  } finally {
    spawnSync("security", ["delete-keychain", keychain], { stdio: "ignore" });
    rmSync(keychainDir, { recursive: true, force: true });
  }

  check(join(appDir, "release"), dmg, feedUrl ?? DEFAULT_FEED_URL);
}

function check(release: string, dmg: boolean, feedUrl: string): void {
  const app = join(release, "mac-arm64", "Tokama.app");
  const node = join(app, "Contents", "Resources", "engine", "tokama-engine");

  // Guard against the keychain's certificate: the app and the Node binary must both be ad-hoc.
  for (const path of [app, node]) {
    const { stderr } = run("codesign", ["-dv", "--verbose=4", path]);
    process.stdout.write(`${stderr.split("\n").filter((line) => /^(Identifier|Signature|TeamIdentifier|Authority|CodeDirectory)/.test(line)).join("\n")}\n`);
    if (!stderr.includes("Signature=adhoc")) fail("signature", `${path} is not ad-hoc signed`);
    if (/TeamIdentifier=(?!not set)\S+/.test(stderr)) fail("signature", `${path} carries a team identifier`);
  }
  const verify = run("codesign", ["--verify", "--deep", "--strict", app]);
  if (verify.status !== 0) fail("signature", `codesign --verify: ${verify.stderr}`);

  const version = appVersion(appDir);
  // A build of the app folder alone gets no update feed from electron-builder.
  const files = dmg
    ? ["--zip", join(release, `Tokama-${version}-arm64-mac.zip`), "--dmg", join(release, `Tokama-${version}-arm64.dmg`), "--latest", join(release, "latest-mac.yml")]
    : ["--dir-build"];
  const verified = spawnSync(process.execPath, [join(appDir, "scripts", "verify-package.ts"), "--unsigned", "--app", app, "--version", version, "--feed-url", feedUrl, ...files], { stdio: "inherit" });
  if (verified.status !== 0) fail("verify", "verify-package.ts reported failed checks, above");

  process.stdout.write(`app: ${app} (${run("du", ["-sh", app]).stdout.split("\t")[0]})\nnode: ${mb(node)}\n`);
}

if (import.meta.main) await main();
