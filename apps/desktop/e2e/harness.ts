// What every UI flow test shares: one Electron app per test, on its own sample engine in its own
// temp dir. The app starts the engine itself, as it does for a user, so a restart test sees the
// real reconnect path. Linux needs a display (CI uses xvfb-run). Nothing outside the temp dir is
// touched: HOME points into it in every mode, so the engine's Tokama home (items, repos.yaml) is
// `<home>/.tokama` of this test. The app, then the engine, are stopped at the end of every test.
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron, type ElectronApplication, type Locator, type Page } from "playwright-core";
import { it } from "vitest";
import type { ConnectionState, TokamaBridge } from "../src/shared/bridge.js";

const appDir = resolve(import.meta.dirname, "..");
// The electron package's main export is the path of its binary.
const electronPath = createRequire(import.meta.url)("electron") as string;

/** Where screenshots and failure files go; CI uploads this folder. */
export const outDir = process.env["TOKAMA_E2E_OUT"] ?? join(appDir, "e2e-output");
/** Playwright's wait for one element or action: shorter than the test's own timeout, so a miss names its locator. */
const ACTION_TIMEOUT_MS = 15_000;
const START_TIMEOUT_MS = 60_000;
/** The app quits in well under a second; this is the margin for a slow CI runner. */
const CLOSE_TIMEOUT_MS = 3_000;

export interface Session {
  readonly app: ElectronApplication;
  readonly page: Page;
  /** The test's temp dir, removed after the test. */
  readonly tmp: string;
  /** HOME of the app and its engine, inside `tmp`. */
  readonly home: string;
  /** What the renderer gets through the preload bridge. */
  connection(): Promise<ConnectionState>;
  /** The running engine's id and pid, from its lock file; undefined while none runs. */
  engine(): { readonly engineId: string; readonly pid: number } | undefined;
  /** Stops the running engine; the app starts a new one by itself. */
  killEngine(): void;
  /** Sizes the window's content area, like a user dragging its edge. */
  resize(width: number, height: number): Promise<void>;
  /** A screenshot into `<outDir>/screenshots`. */
  screenshot(name: string): Promise<void>;
  /**
   * Quits the app and starts it again on the same home folder, like a user restarting it; the
   * engine keeps running through it. Resolves to the new app's session; use that one from then on.
   * `whileClosed` runs after the app has quit and before it starts again, to change what it left on disk.
   */
  restart(whileClosed?: () => void): Promise<Session>;
}

/** One timed line per phase of a test, in `<outDir>/trace.log`: it shows where a hung test stood, also when CI cancels the run. */
function trace(name: string, phase: string): void {
  try {
    mkdirSync(outDir, { recursive: true });
    appendFileSync(join(outDir, "trace.log"), `${new Date().toISOString()} ${name}: ${phase}\n`);
  } catch {
    // Tracing never fails a test.
  }
}

/** The first paths still in a folder that could not be removed, to find what kept writing into it. */
function leftBehind(dir: string, limit = 20): string[] {
  const found: string[] = [];
  const walk = (folder: string) => {
    let names: string[];
    try {
      names = readdirSync(folder);
    } catch {
      return;
    }
    for (const name of names) {
      if (found.length >= limit) return;
      found.push(join(folder, name));
      walk(join(folder, name));
    }
  };
  walk(dir);
  return found;
}

/** `promise`, or undefined after `ms`. */
const within = <T>(promise: Promise<T>, ms: number): Promise<T | undefined> =>
  Promise.race([promise, new Promise<undefined>((done) => setTimeout(done, ms, undefined))]);

/**
 * Which engine the app finds:
 * - `sample` (default): the sample engine, with its repos and items.
 * - `real`: the real engine on an empty home folder, so no repos and no items, as on a first launch.
 * - `unavailable`: no `node` on the app's PATH, so the engine cannot start and the connection fails.
 */
export type EngineMode = "sample" | "real" | "unavailable";

/** Runs `fn` against a fresh app; on failure, prints the app and engine output and saves a screenshot. */
export function flow(name: string, fn: (session: Session) => Promise<void>, mode: EngineMode = "sample"): void {
  it(name, async () => {
    const tmp = mkdtempSync(join(tmpdir(), "tk-"));
    const output: string[] = [];
    // The app's engine dir is this plus "sample": the sample engine never shares a dir with a real one.
    const baseDir = join(tmp, "e");
    const engineDir = mode === "sample" ? join(baseDir, "sample") : baseDir;
    let app: ElectronApplication | undefined;
    let page: Page | undefined;
    let closeHung = false;
    try {
      trace(name, "launching");
      app = await launch(tmp, baseDir, output, mode);
      trace(name, "launched");
      page = await app.firstWindow({ timeout: START_TIMEOUT_MS });
      page.setDefaultTimeout(ACTION_TIMEOUT_MS);
      await page.waitForLoadState("load");
      const restart = async (whileClosed?: () => void): Promise<Session> => {
        const closed = await within((app?.close() ?? Promise.resolve()).catch(() => undefined).then(() => true), CLOSE_TIMEOUT_MS);
        if (closed === undefined) app?.process().kill("SIGKILL");
        whileClosed?.();
        app = await launch(tmp, baseDir, output, mode);
        page = await app.firstWindow({ timeout: START_TIMEOUT_MS });
        page.setDefaultTimeout(ACTION_TIMEOUT_MS);
        await page.waitForLoadState("load");
        const next = sessionOf(app, page, engineDir, tmp, restart);
        await connected(next);
        return next;
      };
      const session = sessionOf(app, page, engineDir, tmp, restart);
      if (mode === "unavailable") await failed(session);
      else await connected(session);
      trace(name, mode === "unavailable" ? "failed, as expected" : "connected");
      await fn(session);
      trace(name, "passed");
    } catch (error) {
      trace(name, `failed: ${String(error).split("\n")[0]}`);
      await report(name, tmp, engineDir, output, page);
      throw error;
    } finally {
      trace(name, "closing the app");
      // A close that hangs fails the test on every OS; the process is ended only so it cannot outlive the run.
      const closed = await within((app?.close() ?? Promise.resolve()).catch(() => undefined).then(() => true), CLOSE_TIMEOUT_MS);
      if (closed === undefined) {
        trace(name, "the app did not close; killing it");
        app?.process().kill("SIGKILL");
        closeHung = true;
      }
      trace(name, "stopping the engine");
      await stopEngine(engineDir);
      // The engine may still be writing into a repo folder as it stops: retry a busy folder.
      try {
        rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch (error) {
        // A temp folder left behind is not a test failure; the log says what kept it busy.
        const message = `cleanup failed (${(error as NodeJS.ErrnoException).code ?? "error"}), left behind: ${leftBehind(tmp).join(", ")}`;
        trace(name, message);
        console.error(`${name}: ${message}`);
      }
      trace(name, "done");
    }
    // Reached only when the flow passed: a failed one has thrown already.
    if (closeHung) throw new Error(`the app did not close within ${CLOSE_TIMEOUT_MS} ms`);
  });
}

async function launch(tmp: string, baseDir: string, output: string[], mode: EngineMode): Promise<ElectronApplication> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) if (value !== undefined) env[name] = value;
  env["TOKAMA_ENGINE_DIR"] = baseDir;
  // No Dock icon, no focus: the app stays in the background while the developer works.
  env["TOKAMA_E2E"] = "1";
  // The engine keeps its items, its lock and repos.yaml in `~/.tokama`: that is a folder of this test.
  env["HOME"] = homeOf(tmp);
  mkdirSync(env["HOME"], { recursive: true });
  if (mode === "real") delete env["TOKAMA_SAMPLE"];
  else env["TOKAMA_SAMPLE"] = "1";
  // An absolute folder with nothing in it: the app finds no node to start the engine with.
  if (mode === "unavailable") env["PATH"] = join(tmp, "no-bin");
  // Load the built renderer, never a dev server.
  delete env["ELECTRON_RENDERER_URL"];
  const app = await _electron.launch({
    executablePath: electronPath,
    // Playwright adds --no-sandbox on Linux unless told otherwise; the app runs sandboxed.
    chromiumSandbox: true,
    args: [appDir, `--user-data-dir=${join(tmp, "u")}`],
    env,
    timeout: START_TIMEOUT_MS,
  });
  app.process().stdout?.on("data", (chunk: Buffer) => output.push(chunk.toString()));
  app.process().stderr?.on("data", (chunk: Buffer) => output.push(chunk.toString()));
  // Renderer errors go to the failure output, from the first one on.
  const watch = (page: Page) => {
    page.on("pageerror", (error) => output.push(`renderer error: ${error.message}\n`));
    page.on("console", (message) => {
      if (message.type() === "error") output.push(`renderer console: ${message.text()}\n`);
    });
  };
  app.on("window", watch);
  for (const page of app.windows()) watch(page);
  return app;
}

/** HOME of the app and its engine in a test. */
const homeOf = (tmp: string): string => join(tmp, "h");

function sessionOf(app: ElectronApplication, page: Page, engineDir: string, tmp: string, restart: (whileClosed?: () => void) => Promise<Session>): Session {
  const engine = () => readEngine(engineDir);
  return {
    app,
    page,
    tmp,
    home: homeOf(tmp),
    connection: () => page.evaluate(() => (globalThis as unknown as { tokama: TokamaBridge }).tokama.getConnection()),
    engine,
    killEngine: () => {
      const running = engine();
      if (running === undefined) throw new Error("no engine is running: engine.lock is missing");
      process.kill(running.pid, "SIGTERM");
    },
    resize: async (width, height) => {
      await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]?.setContentSize(size.width, size.height), { width, height });
      await page.waitForFunction((size) => window.innerWidth === size, width);
    },
    screenshot: async (name) => {
      const dir = join(outDir, "screenshots");
      mkdirSync(dir, { recursive: true });
      await page.screenshot({ path: join(dir, `${name}.png`), animations: "disabled" });
    },
    restart,
  };
}

/** Waits until the renderer reports "connected"; a "failed" connection ends the wait with its reason. */
async function connected(session: Session): Promise<ConnectionState & { status: "connected" }> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  for (;;) {
    const state = await session.connection();
    if (state.status === "connected") return state;
    if (state.status === "failed") throw new Error(`the renderer reports "failed": ${state.reason}\n${state.logTail.join("\n")}`);
    if (Date.now() > deadline) throw new Error(`the renderer still reports "${state.status}" after ${START_TIMEOUT_MS} ms`);
    await new Promise((done) => setTimeout(done, 100));
  }
}

/** Waits until the renderer reports "failed" (the engine could not start). */
async function failed(session: Session): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  for (;;) {
    const state = await session.connection();
    if (state.status === "failed") return;
    if (state.status === "connected") throw new Error('the renderer reports "connected", but no engine should start');
    if (Date.now() > deadline) throw new Error(`the renderer still reports "${state.status}" after ${START_TIMEOUT_MS} ms`);
    await new Promise((done) => setTimeout(done, 100));
  }
}

/** The pid and engine id in `engine.lock` ("<pid> <engineId>"), when the file exists and the pid is alive. */
function readEngine(engineDir: string): { engineId: string; pid: number } | undefined {
  try {
    const [pidField, engineId] = readFileSync(join(engineDir, "engine.lock"), "utf8").trim().split(" ");
    const pid = Number.parseInt(pidField ?? "", 10);
    if (!Number.isInteger(pid) || pid <= 0 || engineId === undefined) return undefined;
    process.kill(pid, 0);
    return { engineId, pid };
  } catch {
    return undefined;
  }
}

/**
 * The pids of the engines of this test: the one in `engine.lock` and any started but not yet locked,
 * found by their `--dir` argument (a test can fail between the app starting the engine and the lock).
 */
function engineProcesses(engineDir: string): number[] {
  const pids = new Set<number>();
  const locked = readEngine(engineDir);
  if (locked !== undefined) pids.add(locked.pid);
  try {
    const found = execFileSync("pgrep", ["-f", "--", `--dir ${engineDir}`], { encoding: "utf8" });
    for (const line of found.split("\n")) if (/^\d+$/.test(line.trim())) pids.add(Number.parseInt(line, 10));
  } catch {
    // pgrep exits with 1 when nothing matches.
  }
  pids.delete(process.pid);
  return [...pids];
}

/** Stops whichever engines the app started; the app is already closed, so none is started again. */
async function stopEngine(engineDir: string): Promise<void> {
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    const deadline = Date.now() + 5_000;
    for (let pids = engineProcesses(engineDir); pids.length > 0 && Date.now() < deadline; pids = engineProcesses(engineDir)) {
      for (const pid of pids) {
        try {
          process.kill(pid, signal);
        } catch {
          // Already gone.
        }
      }
      await new Promise((done) => setTimeout(done, 100));
    }
    if (engineProcesses(engineDir).length === 0) return;
  }
}

/** What a failed test prints: the app's output, the engine's log, and a screenshot of the window. */
async function report(name: string, tmp: string, engineDir: string, output: string[], page: Page | undefined): Promise<void> {
  const parts = [`--- e2e failure: ${name} ---`];
  if (output.length > 0) parts.push(`--- app output ---\n${output.join("")}`);
  try {
    parts.push(`--- engine.log ---\n${readFileSync(join(engineDir, "engine.log"), "utf8")}`);
  } catch {
    // No log: the app never started an engine.
  }
  if (page !== undefined && !page.isClosed()) {
    const dir = join(outDir, "failures");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.png`);
    try {
      await page.screenshot({ path, timeout: 5_000 });
      parts.push(`screenshot: ${path}`);
    } catch {
      parts.push("screenshot: not possible");
    }
    parts.push(`--- page text ---\n${await page.locator("body").innerText({ timeout: 2_000 }).catch(() => "(none)")}`);
  }
  process.stderr.write(`${parts.join("\n")}\ntemp dir: ${tmp}\n`);
}

// Locators for the screens the flows use.

export const segment = (page: Page, label: string): Locator => page.locator(".filter-bar .segment", { hasText: new RegExp(`^${label}`) });
export const row = (page: Page, title: string): Locator =>
  page.locator(".pl-row", { has: page.locator(".pl-title").getByText(title, { exact: true }) });
export const group = (page: Page, name: string): Locator => page.locator(`section.pl-group[aria-label="${name}"]`);
export const sidebarRow = (page: Page, name: string): Locator => page.locator(".sb-main", { has: page.getByText(name, { exact: true }) });
export const drawer = (page: Page): Locator => page.locator("aside.drawer");
/** The titles of all rows on screen, in order. */
export const titles = (page: Page): Promise<string[]> => page.locator(".pl-title").allTextContents();
