// Builds Tokama.app for this Mac, ad-hoc signed: `node scripts/package.ts [--dmg]`, run from
// apps/desktop after `pnpm build` (the root `pnpm package` does both). It stages the engine
// folder (the bundled engine, the pinned Node and a package.json with the app's version), packs
// the app with electron-builder, and then checks the result; any failed check ends the script
// with a message that names it.
import { execFileSync, spawnSync } from "node:child_process";
import { accessSync, constants, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const appDir = resolve(import.meta.dirname, "..");
const repoDir = resolve(appDir, "..", "..");

/** The app's version: the one source of every version the build writes. */
export function appVersion(dir: string): string {
  const { version } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version?: unknown };
  if (typeof version !== "string" || version === "") throw new Error(`${dir}/package.json has no version`);
  return version;
}

/** The package.json of the staged engine folder. Its version is the app's, so an app never takes its own engine for an older one. `type` is module because the bundle's files are ES modules. */
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

function run(command: string, args: string[], input?: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(command, args, { encoding: "utf8", ...(input !== undefined && { input }) });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

const mb = (path: string) => `${(statSync(path).size / 1024 / 1024).toFixed(0)} MB`;

async function main(): Promise<void> {
  const dmg = process.argv.includes("--dmg");
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    process.stderr.write("package: only Apple silicon (macOS arm64) packaging exists so far.\n");
    process.exit(1);
  }

  const stage = join(appDir, "package-stage", "engine");
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  // Child processes rather than imports: a Node-run TypeScript import would need `.ts` specifiers.
  execFileSync(process.execPath, [join(repoDir, "apps", "engine", "scripts", "bundle.ts"), "--out", join(stage, "dist")], { stdio: "inherit" });
  execFileSync(process.execPath, [join(appDir, "scripts", "fetch-node.ts"), "--out", stage], { stdio: "inherit" });
  writeFileSync(join(stage, "package.json"), engineManifest(appVersion(appDir)));
  checkEngineVersion(appDir, stage);

  // The ad-hoc identity and the keychain: never discover a real certificate.
  process.env["CSC_IDENTITY_AUTO_DISCOVERY"] = "false";
  const { build, Arch, Platform } = await import("electron-builder");
  await build({
    projectDir: appDir,
    targets: Platform.MAC.createTarget(dmg ? ["dmg", "zip"] : ["dir"], Arch.arm64),
    publish: "never",
    config: {
      // Ad-hoc on purpose, so the keychain's real certificate is never picked; hardened runtime is off
      // because an ad-hoc signature cannot pass library validation.
      mac: { identity: "-", hardenedRuntime: false, notarize: false },
      dmg: { sign: false },
    },
  });

  await check(join(appDir, "release", "mac-arm64", "Tokama.app"));
}

async function check(app: string): Promise<void> {
  const engine = join(app, "Contents", "Resources", "engine");
  const node = join(engine, "tokama-engine");

  for (const file of ["tokama-engine", "LICENSE-node", "package.json", "dist/main.js", "dist/hook.js"]) {
    try {
      statSync(join(engine, file));
    } catch {
      fail("layout", `${join(engine, file)} is missing`);
    }
  }
  const dist = readdirSync(join(engine, "dist")).sort().join(",");
  if (dist !== "hook.js,main.js") fail("layout", `engine/dist holds ${dist}`);
  try {
    accessSync(node, constants.X_OK);
  } catch {
    fail("layout", "tokama-engine is not executable");
  }

  const nodeVersion = (JSON.parse(readFileSync(join(appDir, "packaging", "node-runtime.json"), "utf8")) as { version: string }).version;
  const reported = run(node, ["--version"]).stdout.trim();
  if (reported !== `v${nodeVersion}`) fail("node version", `tokama-engine reports ${reported}, not v${nodeVersion}`);

  const plistVersion = run("plutil", ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", join(app, "Contents", "Info.plist")]).stdout.trim();
  if (plistVersion !== appVersion(appDir)) fail("version", `the app's Info.plist says ${plistVersion}, package.json ${appVersion(appDir)}`);
  try {
    checkEngineVersion(appDir, engine);
  } catch (error) {
    fail("version", String(error));
  }

  // Guard against the keychain's certificate: the app and the Node binary must both be ad-hoc.
  for (const path of [app, node]) {
    const { stderr } = run("codesign", ["-dv", "--verbose=4", path]);
    process.stdout.write(`${stderr.split("\n").filter((line) => /^(Identifier|Signature|TeamIdentifier|Authority|CodeDirectory)/.test(line)).join("\n")}\n`);
    if (!stderr.includes("Signature=adhoc")) fail("signature", `${path} is not ad-hoc signed`);
    if (/TeamIdentifier=(?!not set)\S+/.test(stderr)) fail("signature", `${path} carries a team identifier`);
  }
  const verify = run("codesign", ["--verify", "--deep", "--strict", app]);
  if (verify.status !== 0) fail("signature", `codesign --verify: ${verify.stderr}`);

  const { FuseV1Options, getCurrentFuseWire } = await import("@electron/fuses");
  const wire = await getCurrentFuseWire(join(app, "Contents", "MacOS", "Tokama"));
  // The wire holds the characters "0" and "1": 48 is off and 49 is on.
  const ON = 49;
  const OFF = 48;
  const expected = [
    ["RunAsNode", FuseV1Options.RunAsNode, OFF],
    ["EnableNodeOptionsEnvironmentVariable", FuseV1Options.EnableNodeOptionsEnvironmentVariable, OFF],
    ["EnableNodeCliInspectArguments", FuseV1Options.EnableNodeCliInspectArguments, OFF],
    ["EnableEmbeddedAsarIntegrityValidation", FuseV1Options.EnableEmbeddedAsarIntegrityValidation, ON],
    ["OnlyLoadAppFromAsar", FuseV1Options.OnlyLoadAppFromAsar, ON],
  ] as const;
  for (const [name, option, state] of expected) {
    const actual = wire[option];
    process.stdout.write(`fuse ${name}: ${actual === ON ? "on" : actual === OFF ? "off" : String(actual)}\n`);
    if (actual !== state) fail("fuses", `${name} is ${String(actual)}, expected ${state}`);
  }

  // The hook the bundled Node runs: a command no rule allows is denied.
  const scratch = mkdtempSync(join(tmpdir(), "tk-package-"));
  try {
    const rules = join(scratch, "rules.json");
    writeFileSync(rules, JSON.stringify({ commands: [] }));
    const hook = run(node, [join(engine, "dist", "hook.js"), rules], JSON.stringify({ tool_name: "Bash", tool_input: { command: "rm -rf /tmp/x" } }));
    if (hook.status !== 0 || !hook.stdout.includes('"permissionDecision":"deny"')) fail("hook", `unexpected reply: ${hook.stdout}${hook.stderr}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  process.stdout.write(`app: ${app} (${run("du", ["-sh", app]).stdout.split("\t")[0]})\nnode: ${mb(node)}\n`);
}

if (import.meta.main) await main();
