// Installs the packaged app the way a user does and runs it for real:
//   node scripts/smoke-installed.ts --dmg <dmg> [--install-dir /Applications] [--out <dir>] [--home <dir>]
//     [--signed --team <TEAMID> --feed-url <url>]
//   node scripts/smoke-installed.ts --deb <deb> [--out <dir>] [--home <dir>]
//   node scripts/smoke-installed.ts --rpm-engine-only [--out <dir>] [--home <dir>]
// It mounts the dmg, copies Tokama.app into the install folder (or installs the deb with apt-get),
// starts the app with a temporary HOME and a PATH without node, and checks that the engine starts
// from the app's own folder, answers through the client, runs the bundled hook, and outlives the app
// until it is asked to stop. There are no test switches in the app and no UI driver: the app's own
// files are all it looks at.
// The deb run needs a display (run it under xvfb-run), sudo without a password, and no Tokama
// installed; it removes the package at the end. It also checks that no process of the app turns the
// Chromium sandbox off.
// `--rpm-engine-only` runs on a machine where the rpm is already installed (the Fedora container
// of the workflow): it starts the engine alone, without a window, and runs the same engine checks.
// `--home` runs against a folder that is kept, so a second run can read what the first left.
// Logs go to --out (default apps/desktop/smoke-output). Exit 1 names the failed step.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { accessSync, closeSync, constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { requestShutdown, connect } from "@tokama/client";
import { API_VERSION, readEngineLock, tokenPathOf } from "@tokama/core";
import { appVersion, run } from "./package.ts";

const appDir = resolve(import.meta.dirname, "..");
/** What a Finder-launched app finds on PATH when no tool is installed: no node, from any version manager or package manager. */
const REDUCED_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
/** The display variables matter on Linux, where the app needs the X server (or Wayland socket) of the session it runs in; macOS ignores them. */
const KEPT_ENV = ["USER", "LOGNAME", "TMPDIR", "LANG", "SHELL", "DISPLAY", "XAUTHORITY", "XDG_RUNTIME_DIR"] as const;
/** Where the deb and the rpm put the app. */
const LINUX_ROOT = "/opt/Tokama";
const LINUX_PACKAGE = "tokama";

/** What is installed and run: the dmg's app, the deb's app (with a window), or an installed rpm's engine alone. */
export type SmokeTarget = { readonly kind: "dmg"; readonly file: string } | { readonly kind: "deb"; readonly file: string } | { readonly kind: "rpm-engine-only" };

export interface SmokeArgs {
  readonly target: SmokeTarget;
  readonly installDir: string | undefined;
  readonly out: string;
  readonly home: string | undefined;
  /** Set for a signed build: the verify script then runs on the installed copy. */
  readonly signed: { readonly team: string; readonly feedUrl: string } | undefined;
}

/** Reads and checks the command line; throws an Error that names the problem. */
export function parseSmokeArgs(argv: readonly string[]): SmokeArgs {
  const { values } = parseArgs({
    args: [...argv],
    options: { dmg: { type: "string" }, deb: { type: "string" }, "rpm-engine-only": { type: "boolean" }, "install-dir": { type: "string" }, out: { type: "string" }, home: { type: "string" }, signed: { type: "boolean" }, team: { type: "string" }, "feed-url": { type: "string" } },
  });
  const named = [values.dmg !== undefined, values.deb !== undefined, values["rpm-engine-only"] === true].filter(Boolean).length;
  if (named !== 1) throw new Error("name exactly one of --dmg, --deb and --rpm-engine-only");
  const target: SmokeTarget = values.dmg !== undefined ? { kind: "dmg", file: resolve(values.dmg) } : values.deb !== undefined ? { kind: "deb", file: resolve(values.deb) } : { kind: "rpm-engine-only" };
  if (target.kind !== "dmg" && (values.signed === true || values.team !== undefined || values["feed-url"] !== undefined || values["install-dir"] !== undefined)) throw new Error("--signed, --team, --feed-url and --install-dir belong to --dmg");
  if (values.signed === true && (values.team === undefined || values["feed-url"] === undefined)) throw new Error("--signed needs --team and --feed-url");
  if (values.signed !== true && (values.team !== undefined || values["feed-url"] !== undefined)) throw new Error("--team and --feed-url belong to --signed");
  const signed = values.signed === true && values.team !== undefined && values["feed-url"] !== undefined ? { team: values.team, feedUrl: values["feed-url"] } : undefined;
  return { target, installDir: values["install-dir"], out: resolve(values.out ?? join(appDir, "smoke-output")), home: values.home === undefined ? undefined : resolve(values.home), signed };
}

/** Why `dir` cannot be the install folder, or undefined: only the two folders where macOS accepts an app without a move prompt. */
export function installDirProblem(dir: string, home: string): string | undefined {
  return dir === "/Applications" || dir === join(home, "Applications") ? undefined : `the install folder must be /Applications or ${join(home, "Applications")}, not ${dir}`;
}

/** The engine's `<pid> <engineId> <socketPath>` lock line, or undefined when it is not one. */
export function parseLock(text: string): { readonly pid: number; readonly engineId: string } | undefined {
  const match = /^(\d+) (\S+) \S.*$/.exec(text.trim());
  return match?.[1] === undefined || match[2] === undefined ? undefined : { pid: Number(match[1]), engineId: match[2] };
}

/** The command line the desktop starts its engine with. `engine` is the app's engine folder (Contents/Resources/engine in the macOS app, /opt/Tokama/resources/engine on Linux). `dirs` and `homes` list the engine dir and the Tokama home as given and as the system resolves them (/tmp is /private/tmp), since either may show in `ps`. The desktop passes no other flag in a normal run. */
export function expectedEngineCommands(engine: string, dirs: readonly string[], homes: readonly string[]): string[] {
  return dirs.flatMap((dir) => homes.map((home) => `${join(engine, "tokama-engine")} ${join(engine, "dist", "main.js")} --dir ${dir} --home ${home}`));
}

/** The whole environment of the app: its HOME, a PATH without node, and a few variables every login has. Nothing of Tokama's, Electron's or Node's switches passes. */
export function reducedEnv(home: string, source: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const env: Record<string, string> = { HOME: home, PATH: REDUCED_PATH };
  for (const key of KEPT_ENV) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/** How many entries of a `diagnostics_list` reply are crash reports. */
export function crashCount(data: unknown): number {
  const entries = (data as { entries?: unknown } | null)?.entries;
  return Array.isArray(entries) ? entries.filter((entry) => (entry as { type?: unknown } | null)?.type === "crash").length : 0;
}

/** Why the process list (`ps -eww -o args=`) shows the app of `root` without the Chromium sandbox, or that it shows no process of the app at all; undefined when every process of the app runs with the sandbox. */
export function sandboxProblem(processes: string, root: string): string | undefined {
  // The app's own executable, not the engine in its resources folder: that one never has the switch.
  const lines = processes.split("\n").filter((line) => line === `${root}/tokama` || line.startsWith(`${root}/tokama `));
  if (lines.length === 0) return `no process runs from ${root}`;
  const off = lines.filter((line) => /(^|\s)--no-sandbox(\s|$)/.test(line));
  return off.length === 0 ? undefined : `${off.length} process(es) run with --no-sandbox, e.g. ${off[0]?.slice(0, 200) ?? ""}`;
}

// ---- The run ----

class StepFailure extends Error {
  readonly step: number;
  readonly stepName: string;

  constructor(step: number, stepName: string, message: string) {
    super(message);
    this.step = step;
    this.stepName = stepName;
  }
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const commandOf = (pid: number): string => run("ps", ["-ww", "-p", String(pid), "-o", "command="]).stdout.trim();

async function waitFor<T>(what: string, timeoutMs: number, probe: () => T | undefined | false): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = probe();
    if (found !== undefined && found !== false) return found;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs / 1000} s waiting for ${what}`);
    await sleep(250);
  }
}

interface Run {
  readonly args: SmokeArgs;
  readonly version: string;
  /** The folder of the installed app (the dmg's Tokama.app, or /opt/Tokama), and whether this run put it there (and so removes it). */
  installed: string | undefined;
  home: string | undefined;
  /** The app, or for `--rpm-engine-only` the engine process this run started. */
  app: ChildProcess | undefined;
  appExit: string | undefined;
}

/** The engine folder of the app under test: where its Node, `dist/main.js` and `dist/hook.js` are. Undefined while nothing is installed. */
function engineFolder(state: Run): string | undefined {
  if (state.installed === undefined) return undefined;
  return state.args.target.kind === "dmg" ? join(state.installed, "Contents", "Resources", "engine") : join(state.installed, "resources", "engine");
}

const engineFolderOf = (state: Run): string => engineFolder(state) ?? "";

/** What is being run: the app, or for `--rpm-engine-only` the engine alone. */
const subject = (state: Run): string => (state.args.target.kind === "rpm-engine-only" ? "the engine" : "the app");

async function main(): Promise<void> {
  let args: SmokeArgs;
  try {
    args = parseSmokeArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`smoke: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
  const wanted = args.target.kind === "dmg" ? "darwin" : "linux";
  if (process.platform !== wanted) {
    process.stderr.write(`smoke: a ${args.target.kind === "dmg" ? "dmg" : "Linux package"} can only be tested on ${wanted === "darwin" ? "macOS" : "Linux"}.\n`);
    process.exit(1);
  }
  if (args.home !== undefined) {
    // The engine of a kept home is stopped at the end; the real one may be running items.
    const real = [homedir(), userInfo().homedir].map((dir) => realpathSync(dir));
    if (existsSync(args.home) && real.includes(realpathSync(args.home))) {
      process.stderr.write("smoke: --home must not be the real home folder\n");
      process.exit(2);
    }
  }
  mkdirSync(args.out, { recursive: true });
  const state: Run = { args, version: appVersion(appDir), installed: undefined, home: undefined, app: undefined, appExit: undefined };
  // The app runs detached, so Ctrl-C or a cancelled job would leave it, its engine and the installed copy behind.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      cleanUp(state);
      process.exit(130);
    });
  }
  let step = 0;
  const common: [string, () => Promise<void>][] = [
    ["engine lock and process", () => engineProcess(state)],
    ["client answers", () => clientChecks(state)],
    ["bundled hook denies", () => hook(state)],
  ];
  const steps: [string, () => Promise<void>][] =
    args.target.kind === "dmg"
      ? [["install from the dmg", () => install(state)], ["verify the installed copy", () => verifyInstalled(state)], ["start the app", () => start(state)], ...common, ["quit the app, stop the engine", () => quit(state)]]
      : args.target.kind === "deb"
        ? [["install the deb", () => installDeb(state)], ["start the app", () => start(state)], ...common, ["the Chromium sandbox is on", () => sandbox()], ["quit the app, stop the engine", () => quit(state)]]
        : [["start the engine", () => start(state)], ...common, ["stop the engine", () => quit(state)]];
  try {
    for (const [name, body] of steps) {
      step += 1;
      try {
        await body();
      } catch (error) {
        throw new StepFailure(step, name, error instanceof Error ? error.message : String(error));
      }
      process.stdout.write(`smoke: step ${step} ok: ${name}\n`);
    }
    process.stdout.write("smoke: passed\n");
  } catch (error) {
    if (!(error instanceof StepFailure)) throw error;
    process.stderr.write(`smoke: FAILED at step ${error.step} (${error.stepName}): ${error.message}\n`);
    process.exitCode = 1;
  } finally {
    cleanUp(state);
  }
}

/** The folder the app goes to: the one asked for, else /Applications when it is writable, else ~/Applications. */
function installFolder(requested: string | undefined): string {
  const home = homedir();
  if (requested !== undefined) {
    const problem = installDirProblem(requested, home);
    if (problem !== undefined) throw new Error(problem);
    return requested;
  }
  for (const dir of ["/Applications", join(home, "Applications")]) {
    try {
      accessSync(dir, constants.W_OK);
      return dir;
    } catch {
      // Try the next folder.
    }
  }
  throw new Error("neither /Applications nor ~/Applications is a writable folder");
}

/** Installs the deb with apt-get, which also installs its dependencies, so the dependency names are tried on a real system. The package is removed again by cleanUp. */
async function installDeb(state: Run): Promise<void> {
  const { target } = state.args;
  if (target.kind !== "deb") throw new Error("not a deb run");
  statSync(target.file);
  const running = run("pgrep", ["-x", LINUX_PACKAGE]);
  if (running.status === 0) throw new Error(`a Tokama is running (pid ${running.stdout.trim().split("\n").join(", ")}); quit it first, because the app allows one instance`);
  if (run("dpkg", ["-s", LINUX_PACKAGE]).status === 0 || existsSync(LINUX_ROOT)) throw new Error(`${LINUX_PACKAGE} is installed; this test never replaces an installed app`);
  const noninteractive = ["-n", "env", "DEBIAN_FRONTEND=noninteractive"];
  const update = spawnSync("sudo", [...noninteractive, "apt-get", "update"], { stdio: "inherit" });
  if (update.status !== 0) throw new Error("apt-get update failed, above");
  // The remove in cleanUp must run for a package that stopped half-way too.
  state.installed = LINUX_ROOT;
  const install = spawnSync("sudo", [...noninteractive, "apt-get", "install", "-y", target.file], { stdio: "inherit" });
  if (install.status !== 0) throw new Error("apt-get install failed, above");
  process.stdout.write(`installed ${LINUX_ROOT}\n`);
}

async function install(state: Run): Promise<void> {
  const { target: source } = state.args;
  if (source.kind !== "dmg") throw new Error("not a dmg run");
  statSync(source.file);
  const running = run("pgrep", ["-x", "Tokama"]);
  if (running.status === 0) throw new Error(`a Tokama is running (pid ${running.stdout.trim().split("\n").join(", ")}); quit it first, because the app allows one instance`);
  const target = join(installFolder(state.args.installDir), "Tokama.app");
  if (existsSync(target)) throw new Error(`${target} exists; this test never replaces an installed app`);
  const mount = mkdtempSync("/tmp/tk-smoke-mnt-");
  try {
    const attach = run("hdiutil", ["attach", "-nobrowse", "-readonly", "-mountpoint", mount, source.file]);
    if (attach.status !== 0) throw new Error(`hdiutil attach: ${attach.stderr.trim()}`);
    try {
      // A plain mkdir claims the target and fails if anything appeared there since the check above, so the cleanup never removes a folder this run did not make.
      mkdirSync(target);
      state.installed = target;
      const copy = run("ditto", [join(mount, "Tokama.app"), target]);
      if (copy.status !== 0) throw new Error(`ditto: ${copy.stderr.trim()}`);
    } finally {
      if (run("hdiutil", ["detach", mount]).status !== 0) run("hdiutil", ["detach", "-force", mount]);
    }
  } finally {
    // Only an empty folder: a mount that did not detach must not be emptied.
    try {
      rmdirSync(mount);
    } catch {
      // Left for the system's temp cleanup.
    }
  }
  process.stdout.write(`installed ${target}\n`);
}

async function verifyInstalled(state: Run): Promise<void> {
  const { signed } = state.args;
  const app = state.installed;
  if (app === undefined) throw new Error("no installed copy");
  if (signed === undefined) {
    process.stdout.write("skip (unsigned build)\n");
    return;
  }
  const verify = spawnSync(process.execPath, [join(appDir, "scripts", "verify-package.ts"), "--signed", "--team", signed.team, "--app", app, "--version", state.version, "--feed-url", signed.feedUrl], { stdio: "inherit" });
  if (verify.status !== 0) throw new Error("verify-package.ts reported failed checks, above");
}

const engineDir = (home: string) => join(home, ".tokama", "run");
/** The engine's lock is in the Tokama home, whatever its engine dir. */
const lockFileOf = (home: string) => join(home, ".tokama", "engine.lock");

/** Starts the app as its launcher does (the app of the dmg or the deb), or for `--rpm-engine-only` the engine as the desktop starts it. */
async function start(state: Run): Promise<void> {
  const { target } = state.args;
  // The rpm was installed by the caller (dnf); there is nothing of it for cleanUp to remove.
  if (target.kind === "rpm-engine-only") state.installed = LINUX_ROOT;
  const installed = state.installed;
  const engine = engineFolder(state);
  if (installed === undefined || engine === undefined) throw new Error("no installed copy");
  const home = state.args.home ?? mkdtempSync("/tmp/tk-smoke-");
  mkdirSync(home, { recursive: true });
  state.home = home;
  const which = spawnSync("/usr/bin/which", ["node"], { env: { PATH: REDUCED_PATH }, encoding: "utf8" });
  if (which.status === 0) throw new Error(`node is on the reduced PATH: ${which.stdout.trim()}`);
  const stdout = openSync(join(state.args.out, "app.stdout.log"), "w");
  const stderr = openSync(join(state.args.out, "app.stderr.log"), "w");
  try {
    const [command, args] =
      target.kind === "dmg"
        ? [join(installed, "Contents", "MacOS", "Tokama"), []]
        : target.kind === "deb"
          ? [`/usr/bin/${LINUX_PACKAGE}`, []]
          : [join(engine, "tokama-engine"), [join(engine, "dist", "main.js"), "--dir", engineDir(home), "--home", join(home, ".tokama")]];
    if (target.kind === "rpm-engine-only") mkdirSync(join(home, ".tokama"), { recursive: true });
    const child = spawn(command, args, { env: reducedEnv(home, process.env), stdio: ["ignore", stdout, stderr], detached: true });
    child.once("exit", (code, signal) => void (state.appExit = `exit ${String(code ?? signal)}`));
    child.once("error", (error) => void (state.appExit = `could not start: ${error.message}`));
    child.unref();
    state.app = child;
  } finally {
    closeSync(stdout);
    closeSync(stderr);
  }
  if (state.app?.pid === undefined) throw new Error(`${subject(state)} did not start`);
  process.stdout.write(`pid ${state.app.pid}, HOME ${home}\n`);
}

function homeOf(state: Run): string {
  if (state.home === undefined) throw new Error("the app was not started");
  return state.home;
}

async function engineProcess(state: Run): Promise<void> {
  const home = homeOf(state);
  const engine = engineFolderOf(state);
  const dir = engineDir(home);
  const lockFile = lockFileOf(home);
  // A lock left by an engine that died (a kept --home) names a pid that is gone; the app's new engine replaces it.
  const { lock, command } = await waitFor("engine.lock of a running engine", 60_000, () => {
    if (state.appExit !== undefined) throw new Error(`${subject(state)} ended before the engine started (${state.appExit}); see app.stderr.log`);
    try {
      const found = parseLock(readFileSync(lockFile, "utf8"));
      const running = found === undefined ? "" : commandOf(found.pid);
      return found !== undefined && running !== "" ? { lock: found, command: running } : undefined;
    } catch {
      return undefined;
    }
  });
  const tokamaHome = join(home, ".tokama");
  const expected = expectedEngineCommands(engine, [...new Set([dir, realpathSync(dir)])], [...new Set([tokamaHome, realpathSync(tokamaHome)])]);
  if (!expected.includes(command)) throw new Error(`the engine runs\n  ${command}\nexpected\n  ${expected.join("\n  or ")}`);
  process.stdout.write(`engine pid ${lock.pid}: ${command}\n`);
}

async function clientChecks(state: Run): Promise<void> {
  const home = homeOf(state);
  // The engine publishes its lock once it listens, so the lock may not be there yet; connect never starts one.
  const deadline = Date.now() + 60_000;
  const open = () => connect({ dir: engineDir(home), lockPath: lockFileOf(home), reconnect: false, requestTimeoutMs: 15_000 });
  let connected = await open();
  while (!connected.ok && connected.error.code === "not_running" && Date.now() < deadline) {
    await sleep(500);
    connected = await open();
  }
  if (!connected.ok) throw new Error(`connect: ${connected.error.code}: ${connected.error.message}`);
  const client = connected.value;
  try {
    if (client.engine.apiVersion !== API_VERSION) throw new Error(`the engine's API version is ${client.engine.apiVersion}, the client's is ${API_VERSION}`);
    if (client.engine.engineVersion !== state.version) throw new Error(`the engine's version is ${client.engine.engineVersion ?? "missing"}, the app's is ${state.version}`);
    for (const type of ["setup", "board"] as const) {
      const reply = await client.query({ type });
      if (!reply.ok) throw new Error(`${type} query failed: ${JSON.stringify(reply.error)}`);
    }
    // A renderer or desktop crash right after the start is reported to the engine within seconds.
    for (let poll = 0; poll < 5; poll += 1) {
      const reply = await client.query({ type: "diagnostics_list" });
      if (!reply.ok) throw new Error(`diagnostics_list failed: ${JSON.stringify(reply.error)}`);
      writeFileSync(join(state.args.out, "diagnostics.json"), `${JSON.stringify(reply.data, null, 2)}\n`);
      if (crashCount(reply.data) > 0) throw new Error("the diagnostics hold a crash entry; see diagnostics.json");
      if (state.appExit !== undefined) throw new Error(`${subject(state)} ended (${state.appExit}); see app.stderr.log`);
      await sleep(1000);
    }
  } finally {
    await client.close();
  }
  if (state.appExit !== undefined) throw new Error(`${subject(state)} ended (${state.appExit}); see app.stderr.log`);
  if (state.args.target.kind !== "rpm-engine-only" && !existsSync(join(home, ".tokama", "desktop.running"))) throw new Error("desktop.running is missing");
}

/** The renderer and helper processes of the deb's app all run with the Chromium sandbox: a machine that cannot give it makes Chromium fail, and a --no-sandbox in the launcher would hide that. */
async function sandbox(): Promise<void> {
  const problem = sandboxProblem(run("ps", ["-eww", "-o", "args="]).stdout, LINUX_ROOT);
  if (problem !== undefined) throw new Error(problem);
}

async function hook(state: Run): Promise<void> {
  const engine = engineFolderOf(state);
  const rules = join(homeOf(state), "rules-smoke.json");
  writeFileSync(rules, JSON.stringify({ commands: [] }));
  const reply = spawnSync(join(engine, "tokama-engine"), [join(engine, "dist", "hook.js"), rules], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "rm -rf /tmp/x" } }),
    env: reducedEnv(homeOf(state), process.env),
    encoding: "utf8",
    timeout: 20_000,
  });
  if (reply.status !== 42 || !reply.stdout.includes('"permissionDecision":"deny"')) throw new Error(`unexpected reply (exit ${String(reply.status)}): ${`${reply.stdout}${reply.stderr}`.slice(0, 500)}`);
}

async function quit(state: Run): Promise<void> {
  const home = homeOf(state);
  const appPid = state.app?.pid;
  const lock = readEngineLock(lockFileOf(home));
  if (appPid === undefined || lock === undefined) throw new Error("the app or the engine lock is gone");
  if (state.args.target.kind !== "rpm-engine-only") {
    // SIGTERM makes Chromium quit like Cmd-Q. Asking the app through AppleScript could open an automation prompt that hangs a runner.
    process.kill(appPid, "SIGTERM");
    await waitFor("the app to quit", 20_000, () => !alive(appPid));
    if (!alive(lock.pid)) throw new Error("the engine ended with the app; it must keep running");
  }
  if (!(await requestShutdown({ socketPath: lock.socketPath, tokenPath: tokenPathOf(lock.socketPath) }, 5_000))) throw new Error("the engine did not accept the shutdown request");
  await waitFor("the engine to stop", 20_000, () => !alive(lock.pid) && !existsSync(lockFileOf(home)));
}

/** Always runs: copies the engine log, stops what this run started, removes what it installed. */
function cleanUp(state: Run): void {
  const home = state.home;
  const installed = state.installed;
  if (home !== undefined) {
    try {
      copyFileSync(join(engineDir(home), "engine.log"), join(state.args.out, "engine.log"));
    } catch {
      // There may be no log yet.
    }
  }
  // Only processes this run started: the app it spawned, and the engine whose command is the installed one.
  const appPid = state.app?.pid;
  // Not after the app has exited: its pid may belong to another process by now.
  if (appPid !== undefined && state.appExit === undefined && alive(appPid)) process.kill(appPid, "SIGKILL");
  const engine = engineFolder(state);
  if (home !== undefined && engine !== undefined) {
    try {
      const lock = parseLock(readFileSync(lockFileOf(home), "utf8"));
      if (lock !== undefined && alive(lock.pid) && commandOf(lock.pid).startsWith(join(engine, "tokama-engine"))) process.kill(lock.pid, "SIGKILL");
    } catch {
      // No lock, no engine.
    }
  }
  if (installed !== undefined) {
    const { target } = state.args;
    if (target.kind === "dmg") rmSync(installed, { recursive: true, force: true });
    else if (target.kind === "deb") spawnSync("sudo", ["-n", "env", "DEBIAN_FRONTEND=noninteractive", "apt-get", "remove", "-y", LINUX_PACKAGE], { stdio: "inherit" });
  }
  if (home !== undefined && state.args.home === undefined) rmSync(home, { recursive: true, force: true });
}

if (import.meta.main) await main();
