// The real end-to-end task through the desktop app: the built app, the real Claude Code CLI, one
// fixture repo in a temp folder. The user adds the repo with "+ Add repo", starts Quick fix from
// New work and watches it reach Done; the drawer shows the commit. Run it with `pnpm e2e:real`;
// it costs a few cents and never runs in CI.
//
// The engine is started first, as the user's own background engine would be, with the real HOME
// for Claude Code's login and a Tokama home inside the temp HOME. The app gets that temp HOME and
// the same engine dir, so it connects to that engine instead of starting one.
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { _electron, type ElectronApplication, type Page } from "playwright-core";
import { afterEach, expect, it } from "vitest";
import {
  CHECK_COMMAND,
  claudeProblem,
  createWorkspace,
  DESKTOP_DIR,
  expectGoodRun,
  ITEM_DEADLINE_MS,
  mainTree,
  REPO_ID,
  realTokamaHome,
  skipNote,
  startEngine,
  TASK,
  usageLine,
  type Workspace,
} from "./support/real.js";

// The electron package's main export is the path of its binary.
const electronPath = createRequire(import.meta.url)("electron") as string;
const outDir = resolve(import.meta.dirname, "e2e-output", "real");
const ACTION_TIMEOUT_MS = 15_000;
const START_TIMEOUT_MS = 60_000;

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function launch(workspace: Workspace, output: string[]): Promise<ElectronApplication> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) if (value !== undefined) env[name] = value;
  // The app's HOME is the temp one; its engine dir is the one the running engine uses.
  env["HOME"] = workspace.home;
  env["TOKAMA_ENGINE_DIR"] = workspace.engineDir;
  delete env["TOKAMA_SAMPLE"];
  delete env["ELECTRON_RENDERER_URL"];
  const app = await _electron.launch({
    executablePath: electronPath,
    chromiumSandbox: true,
    args: [DESKTOP_DIR, `--user-data-dir=${join(workspace.root, "u")}`],
    env,
    timeout: START_TIMEOUT_MS,
  });
  app.process().stdout?.on("data", (chunk: Buffer) => output.push(chunk.toString()));
  app.process().stderr?.on("data", (chunk: Buffer) => output.push(chunk.toString()));
  return app;
}

const shot = async (page: Page, name: string): Promise<void> => {
  mkdirSync(outDir, { recursive: true });
  await page.screenshot({ path: join(outDir, `${name}.png`), animations: "disabled" });
};

it("adds the repo, runs Quick fix from New work and shows the commit in the drawer", async ({ skip }) => {
  const started = Date.now();
  const workspace = createWorkspace();
  cleanups.push(() => workspace.cleanup());
  const realHomeBefore = realTokamaHome();
  const before = mainTree(workspace);

  const engine = await startEngine(workspace);
  cleanups.push(() => engine.stop());
  const problem = await claudeProblem(engine.client);
  if (problem !== undefined) skip(skipNote(problem));

  const output: string[] = [];
  const app = await launch(workspace, output);
  cleanups.push(async () => {
    const closed = await Promise.race([app.close().then(() => true, () => true), new Promise<false>((done) => setTimeout(done, 5_000, false))]);
    if (!closed) app.process().kill("SIGKILL");
  });
  const page = await app.firstWindow({ timeout: START_TIMEOUT_MS });
  page.setDefaultTimeout(ACTION_TIMEOUT_MS);
  try {
    await page.waitForLoadState("load");

    // Add the repo through the folder picker, which the test replaces in the main process.
    await app.evaluate(({ dialog }, path) => {
      (dialog as { showOpenDialog: unknown }).showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, workspace.repo);
    await page.getByRole("button", { name: "+ Add repo" }).click({ timeout: START_TIMEOUT_MS });
    const add = page.getByRole("dialog", { name: "Add repo" });
    await expect.poll(() => add.getByLabel("Id", { exact: true }).inputValue(), { message: "the suggested id", timeout: 10_000 }).toBe(REPO_ID);
    expect(await add.getByLabel("Base branch", { exact: true }).inputValue()).toBe("main");
    await add.getByLabel("Checks", { exact: true }).fill(CHECK_COMMAND);
    await add.getByRole("button", { name: "Add repo" }).click();
    await add.waitFor({ state: "detached" });
    await page.locator(".sb-main", { has: page.getByText(REPO_ID, { exact: true }) }).waitFor();
    await shot(page, "1-repo-added");

    // The app is attached to the engine started above, not to one of its own.
    const lock = readFileSync(join(workspace.engineDir, "engine.lock"), "utf8").trim().split(" ");
    expect(Number.parseInt(lock[0] ?? "", 10), "the app uses the running engine").toBe(engine.pid);

    // Start Quick fix from New work. It is the only template, so it is the suggested one.
    await page.locator("main h1").click();
    await page.keyboard.press("ControlOrMeta+n");
    await page.locator("textarea.np-text:focus").waitFor();
    await page.locator("textarea.np-text").fill(TASK);
    await expect.poll(() => page.locator(".np-trigger", { hasText: "Template" }).innerText(), { message: "the suggested template" }).toContain("Quick fix");
    const repos = page.locator(".np-trigger", { hasText: "Repos" });
    if ((await repos.innerText()).includes("Choose")) {
      await repos.click();
      await page.getByRole("option", { name: new RegExp(REPO_ID) }).click();
    }
    await shot(page, "2-new-work");
    await page.locator("button.np-start").click();

    // The item is on the list and its drawer is open; wait for Done, and stop early on a bad end.
    const drawer = page.locator("aside.drawer");
    await drawer.getByRole("heading", { name: TASK }).waitFor();
    await shot(page, "3-started");
    const state = drawer.locator(".drawer-state");
    const deadline = Date.now() + ITEM_DEADLINE_MS;
    for (;;) {
      const text = await state.innerText();
      if (/done/i.test(text)) break;
      if (/failed|stopped/i.test(text)) throw new Error(`the item did not reach Done: ${text}`);
      if (Date.now() > deadline) throw new Error(`the item did not reach Done within ${ITEM_DEADLINE_MS} ms: ${text}`);
      await new Promise((done) => setTimeout(done, 500));
    }
    await shot(page, "4-done");

    // The drawer shows the commit and its branch, and they are the ones git has.
    const itemId = readdirSync(join(workspace.tokamaHome, "items"))[0];
    expect(itemId, "one item was stored").toBeDefined();
    const reply = await engine.client.query({ type: "item", itemId: itemId! });
    if (!reply.ok) throw new Error(reply.error.message);
    const { commit, branch, events } = expectGoodRun(workspace, before, reply.data.item);
    await expect.poll(() => state.innerText(), { message: "the drawer's commit" }).toContain(`commit ${commit.slice(0, 7)} on ${branch}`);
    await shot(page, "5-drawer-commit");

    expect(readFileSync(join(workspace.tokamaHome, "repos.yaml"), "utf8")).toContain(`path: ${workspace.repo}`);
    expect(realTokamaHome(), "the real ~/.tokama is untouched").toEqual(realHomeBefore);
    const attempts = events.filter((event) => event.type === "attempt_started").length;
    const usage = usageLine(reply.data.item.id) ?? "no usage found: the engine stores none and the session transcript was not found";
    process.stdout.write(`real app: done in ${Math.round((Date.now() - started) / 1000)} s, ${attempts} attempt(s), commit ${commit.slice(0, 7)} on ${branch}, ${usage}\nscreenshots: ${outDir}\n`);
  } catch (error) {
    mkdirSync(outDir, { recursive: true });
    await page.screenshot({ path: join(outDir, "failed.png"), timeout: 5_000 }).catch(() => undefined);
    process.stderr.write(`--- app output ---\n${output.join("")}\n--- page text ---\n${await page.locator("body").innerText({ timeout: 2_000 }).catch(() => "(none)")}\nscreenshot: ${join(outDir, "failed.png")}\n`);
    throw error;
  }
});
