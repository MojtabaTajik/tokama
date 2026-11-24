// Smoke test of the built desktop app: `node scripts/smoke.ts` (after `pnpm build` and
// `install-electron`). It starts the engine in sample mode in a temp dir, launches the app on
// that dir with Playwright's Electron driver, and passes when the window loads and the renderer
// reports "connected" to that same engine and Enter and Space select list rows. Linux needs a
// display (CI uses xvfb-run).
//
// The script starts the engine itself because the app starts engines without `--sample`; with
// one already running, the app connects to it. Nothing outside the temp dir is touched: the
// app's userData goes there too, and the engine is stopped at the end.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { connect } from "@tokama/client";
import { _electron, type ElectronApplication, type Page } from "playwright-core";
import type { ConnectionState, TokamaBridge } from "../src/shared/bridge.ts";

const TIMEOUT_MS = 60_000;
const appDir = resolve(import.meta.dirname, "..");
const engineEntry = resolve(appDir, "..", "engine", "dist", "main.js");
// The electron package's main export is the path of its binary.
const electronPath = createRequire(import.meta.url)("electron") as string;

const deadline = Date.now() + TIMEOUT_MS;
// Never 0: Playwright reads a timeout of 0 as "no timeout".
const remaining = () => Math.max(1, deadline - Date.now());
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
const log = (message: string) => process.stdout.write(`smoke: ${message}\n`);

/** Starts the sample engine and waits until a client can say hello; returns its engine id. */
async function startEngine(dir: string, output: string[]): Promise<{ child: ChildProcess; engineId: string }> {
  const child = spawn(process.execPath, [engineEntry, "--dir", dir, "--sample"], { stdio: ["ignore", "pipe", "pipe"] });
  // Last resort: Playwright can end this process on a failed launch before any finally runs.
  process.once("exit", () => child.kill("SIGKILL"));
  child.stdout.on("data", (chunk: Buffer) => output.push(chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => output.push(chunk.toString()));
  let exited: string | undefined;
  child.once("exit", (code, signal) => (exited = `the engine exited (code ${String(code)}, signal ${String(signal)})`));
  child.once("error", (error) => (exited = `cannot start the engine: ${error.message}`));
  while (Date.now() < deadline) {
    if (exited !== undefined) throw new Error(exited);
    // Without a start command, connect() tries once and never starts an engine.
    const client = await connect({ dir, reconnect: false });
    if (client.ok) {
      const engineId = client.value.engineId;
      await client.value.close();
      return { child, engineId };
    }
    await pause(100);
  }
  throw new Error("the engine did not accept a connection in time");
}

async function stopEngine(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((done) => child.once("exit", done));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
  await exited;
  clearTimeout(timer);
}

async function run(tmp: string): Promise<void> {
  const engineDir = join(tmp, "engine");
  mkdirSync(engineDir, { mode: 0o700 });
  const engineOutput: string[] = [];
  let engine: ChildProcess | undefined;
  let app: ElectronApplication | undefined;
  const appOutput: string[] = [];
  try {
    const started = await startEngine(engineDir, engineOutput);
    engine = started.child;
    log(`sample engine ${started.engineId} is running`);

    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(process.env)) if (value !== undefined) env[name] = value;
    env["TOKAMA_ENGINE_DIR"] = engineDir;
    // Load the built renderer, never a dev server.
    delete env["ELECTRON_RENDERER_URL"];

    app = await _electron.launch({
      executablePath: electronPath,
      // Playwright adds --no-sandbox on Linux unless told otherwise; the app runs sandboxed.
      chromiumSandbox: true,
      args: [appDir, `--user-data-dir=${join(tmp, "user-data")}`],
      env,
      timeout: remaining(),
    });
    app.process().stdout?.on("data", (chunk: Buffer) => appOutput.push(chunk.toString()));
    app.process().stderr?.on("data", (chunk: Buffer) => appOutput.push(chunk.toString()));
    // Renderer errors go to the failure output, from the first one on. A window can already
    // exist when launch() returns, so the open ones are watched as well as new ones.
    const watched = new WeakSet<Page>();
    const watch = (page: Page) => {
      if (watched.has(page)) return;
      watched.add(page);
      page.on("pageerror", (error) => appOutput.push(`renderer error: ${error.message}\n`));
      page.on("console", (message) => {
        if (message.type() === "error") appOutput.push(`renderer console: ${message.text()}\n`);
      });
    };
    app.on("window", watch);
    for (const page of app.windows()) watch(page);
    const page = await app.firstWindow({ timeout: remaining() });
    await page.waitForLoadState("load", { timeout: remaining() });
    await page.locator("#root > *").first().waitFor({ timeout: remaining() });
    log(`window "${await page.title()}" loaded`);

    // What the renderer gets through the preload bridge: the state the UI shows.
    let state: ConnectionState | undefined;
    while (Date.now() < deadline) {
      state = await page.evaluate(() => (globalThis as unknown as { tokama: TokamaBridge }).tokama.getConnection());
      if (state.status === "connected" || state.status === "failed") break;
      await pause(100);
    }
    if (state?.status === "failed") {
      const tail = state.logTail.length > 0 ? `\n${state.logTail.join("\n")}` : "";
      throw new Error(`the renderer reports "failed": ${state.reason}${tail}`);
    }
    if (state?.status !== "connected") throw new Error(`the renderer still reports "${state?.status ?? "nothing"}" at the timeout`);
    if (state.engineId !== started.engineId) {
      throw new Error(`the app connected to engine ${String(state.engineId)}, not to the sample engine ${started.engineId}`);
    }
    log(`the renderer reports "connected" to engine ${state.engineId}`);

    // List rows are native buttons: Enter and Space select them and open the drawer. Two
    // finished sample items, which the sample tick never moves; the 30 days range keeps them
    // in view at any time of day.
    for (const [key, status, title] of [
      ["Enter", "Done", "Slow query on order_items"],
      ["Space", "Failed", "Upgrade the Postgres driver in orders-api"],
    ] as const) {
      await page.locator(".segment", { hasText: new RegExp(`^${status}`) }).click({ timeout: remaining() });
      await page.locator(".range").selectOption("30d", { timeout: remaining() });
      const row = page.locator(".pl-row", { has: page.locator(".pl-title", { hasText: title }) });
      await row.focus({ timeout: remaining() });
      await page.keyboard.press(key);
      await page.locator('.pl-row[aria-current="true"]', { hasText: title }).waitFor({ timeout: remaining() });
      await page.locator("aside.drawer h2", { hasText: title }).waitFor({ timeout: remaining() });
      if ((await page.locator('.pl-row[aria-current="true"]').count()) !== 1) throw new Error(`${key} did not move the selection to one row`);
    }
    log("Enter and Space select list rows");
  } catch (error) {
    if (appOutput.length > 0) process.stderr.write(`--- app output ---\n${appOutput.join("")}\n`);
    if (engineOutput.length > 0) process.stderr.write(`--- engine output ---\n${engineOutput.join("")}\n`);
    try {
      process.stderr.write(`--- engine.log ---\n${readFileSync(join(engineDir, "engine.log"), "utf8")}\n`);
    } catch {
      // No log: the app never started an engine of its own.
    }
    throw error;
  } finally {
    await app?.close().catch(() => undefined);
    if (engine !== undefined) await stopEngine(engine);
  }
}

const tmp = mkdtempSync(join(tmpdir(), "tokama-smoke-"));
// Removed on exit, also when Playwright ends the process early.
process.once("exit", () => rmSync(tmp, { recursive: true, force: true }));
try {
  await run(tmp);
  log("passed");
} catch (error) {
  process.stderr.write(`smoke: FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
