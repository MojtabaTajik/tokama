// What every UI flow test shares: one Electron app per test, on its own sample engine in its own
// temp dir. The app starts the engine itself, as it does for a user, so a restart test sees the
// real reconnect path. Linux needs a display (CI uses xvfb-run). Nothing outside the temp dir is
// touched; the app, then the engine, are stopped at the end of every test.
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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

export interface Session {
  readonly app: ElectronApplication;
  readonly page: Page;
  /** What the renderer gets through the preload bridge. */
  connection(): Promise<ConnectionState>;
  /** The running engine's id and pid, from its lock file; undefined while none runs. */
  engine(): { readonly engineId: string; readonly pid: number } | undefined;
  /** Stops the running engine; the app starts a new one by itself. */
  killEngine(): void;
  /** A screenshot into `<outDir>/screenshots`. */
  screenshot(name: string): Promise<void>;
}

/** Runs `fn` against a fresh app; on failure, prints the app and engine output and saves a screenshot. */
export function flow(name: string, fn: (session: Session) => Promise<void>): void {
  it(name, async () => {
    const tmp = mkdtempSync(join(tmpdir(), "tk-"));
    const output: string[] = [];
    // The app's engine dir is this plus "sample": the sample engine never shares a dir with a real one.
    const baseDir = join(tmp, "e");
    const engineDir = join(baseDir, "sample");
    let app: ElectronApplication | undefined;
    let page: Page | undefined;
    try {
      app = await launch(tmp, baseDir, output);
      page = await app.firstWindow({ timeout: START_TIMEOUT_MS });
      page.setDefaultTimeout(ACTION_TIMEOUT_MS);
      await page.waitForLoadState("load");
      const session = sessionOf(app, page, engineDir);
      await connected(session);
      await fn(session);
    } catch (error) {
      await report(name, tmp, engineDir, output, page);
      throw error;
    } finally {
      await app?.close().catch(() => undefined);
      await stopEngine(engineDir);
      rmSync(tmp, { recursive: true, force: true });
    }
  });
}

async function launch(tmp: string, baseDir: string, output: string[]): Promise<ElectronApplication> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) if (value !== undefined) env[name] = value;
  env["TOKAMA_ENGINE_DIR"] = baseDir;
  env["TOKAMA_SAMPLE"] = "1";
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

function sessionOf(app: ElectronApplication, page: Page, engineDir: string): Session {
  const engine = () => readEngine(engineDir);
  return {
    app,
    page,
    connection: () => page.evaluate(() => (globalThis as unknown as { tokama: TokamaBridge }).tokama.getConnection()),
    engine,
    killEngine: () => {
      const running = engine();
      if (running === undefined) throw new Error("no engine is running: engine.lock is missing");
      process.kill(running.pid, "SIGTERM");
    },
    screenshot: async (name) => {
      const dir = join(outDir, "screenshots");
      mkdirSync(dir, { recursive: true });
      await page.screenshot({ path: join(dir, `${name}.png`), animations: "disabled" });
    },
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

/** Stops whichever engine the app started; the app is already closed, so none is started again. */
async function stopEngine(engineDir: string): Promise<void> {
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    const deadline = Date.now() + 5_000;
    for (let running = readEngine(engineDir); running !== undefined && Date.now() < deadline; running = readEngine(engineDir)) {
      try {
        process.kill(running.pid, signal);
      } catch {
        return;
      }
      await new Promise((done) => setTimeout(done, 100));
    }
    if (readEngine(engineDir) === undefined) return;
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
