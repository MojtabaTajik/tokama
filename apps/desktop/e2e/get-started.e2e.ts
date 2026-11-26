// The Get started checklist in the real app, on a real engine with an empty home and a fake
// `claude` on the PATH (e2e/fake-tools.ts) that the flow changes between checks: from no AI CLI at
// all, through logged out, to ready; then a repo, the first Quick fix, the "Setup done" line, and
// Help > Get started. git is the machine's own. Screenshots go to `<outDir>/screenshots`.
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { expect } from "vitest";
import { fakeToolsEnv, setClaude } from "./fake-tools.js";
import { flow } from "./harness.js";

const SAMPLE_TASK = "Fix typos and unclear sentences in README.md";
/** The engine caches its checks for 5 s, and the list asks again every 5 s: a change shows within about 10 s. */
const CHECK_TIMEOUT_MS = 25_000;

const list = (page: Page) => page.getByRole("region", { name: "Get started" });
const row = (page: Page, id: "ai-cli" | "git" | "repo" | "quick-fix") => list(page).locator(`[data-row="${id}"]`);
const words = (page: Page) => list(page).locator(".gs-word").allInnerTexts();
const count = (page: Page) => list(page).locator(".gs-count").innerText();

/** A git repo with a README, and (with `checks`) a test script that Add repo finds. */
function makeRepo(tmp: string, name: string, checks: boolean): string {
  const folder = join(realpathSync(tmp), name);
  mkdirSync(folder);
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: folder });
  git("init", "-q", "-b", "main");
  writeFileSync(join(folder, "README.md"), "Teh quick start\n");
  if (checks) {
    writeFileSync(join(folder, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
    writeFileSync(join(folder, "pnpm-lock.yaml"), "");
  }
  git("add", "-A");
  git("commit", "-q", "-m", "first");
  return folder;
}

flow(
  "goes from no AI CLI to a first Quick fix by following the list, and comes back from Help",
  async ({ app, page, tmp, screenshot }) => {
    await list(page).waitFor();
    // 1. Nothing is set up: no AI CLI, git is fine, no repo. The next step is the install link, and New work is off.
    await expect.poll(() => words(page), { message: "the rows of a first launch", timeout: CHECK_TIMEOUT_MS }).toEqual(["Not installed", "Ready", "To do", "To do"]);
    expect(await count(page)).toBe("1 of 4 done");
    expect(await page.locator("main h1").innerText()).toBe("Tokama");
    const install = row(page, "ai-cli").getByRole("link", { name: /Install Claude Code/ });
    expect(await install.getAttribute("href")).toBe("https://tokama.dev/docs/install-claude-code");
    expect(await list(page).locator(".btn-primary").count()).toBe(1);
    expect(await page.locator(".new-work").isDisabled()).toBe(true);
    expect(await page.locator(".np-text").count()).toBe(0);
    await screenshot("20-gs-1-new");

    // 2. Claude Code is installed but logged out: the row names the login command, with Copy.
    setClaude(tmp, "logged-out");
    await list(page).getByRole("button", { name: "Check again" }).click();
    await expect.poll(() => words(page).then((all) => all[0]), { message: "logged out", timeout: CHECK_TIMEOUT_MS }).toBe("Logged out");
    expect(await row(page, "ai-cli").locator(".command-copy-text").innerText()).toBe("claude auth login");
    expect(await row(page, "ai-cli").innerText()).toContain("Claude Code 2.1.332 is installed but not logged in.");
    // The real renderer code copies; the page's clipboard is replaced so the result does not depend on window focus.
    await page.evaluate(() => {
      const seen: string[] = [];
      (globalThis as unknown as { copied: string[] }).copied = seen;
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => void seen.push(text) } });
    });
    await row(page, "ai-cli").getByRole("button", { name: "Copy claude auth login" }).click();
    // The ✓ is decoration for screen readers, so the button's name is Copied.
    await row(page, "ai-cli").getByRole("button", { name: "Copied" }).waitFor();
    expect(await row(page, "ai-cli").locator(".command-copy-button").textContent()).toBe("✓ Copied");
    expect(await page.evaluate(() => (globalThis as unknown as { copied: string[] }).copied)).toEqual(["claude auth login"]);
    await screenshot("20-gs-6-copied", row(page, "ai-cli"));

    // 3. Logged in: step 1 turns ✓ by itself.
    setClaude(tmp, "ready");
    await expect.poll(() => words(page).then((all) => all[0]), { message: "ready, without a click", timeout: CHECK_TIMEOUT_MS }).toBe("Ready");
    expect(await count(page)).toBe("2 of 4 done");
    expect(await list(page).locator(".btn-primary").allInnerTexts()).toEqual(["Add repo"]);
    await screenshot("20-gs-2-partly");
    await screenshot("20-gs-6-ready", row(page, "ai-cli"));

    // 4. Add the first repo through the list; Start a Quick fix unlocks.
    const folder = makeRepo(tmp, "orders-api", true);
    await app.evaluate(({ dialog }, path) => {
      (dialog as { showOpenDialog: unknown }).showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, folder);
    expect(await row(page, "quick-fix").getByRole("button", { name: "Start a Quick fix" }).isDisabled()).toBe(true);
    await row(page, "repo").getByRole("button", { name: "Add repo" }).click();
    const add = page.getByRole("dialog", { name: "Add repo" });
    await expect.poll(() => add.getByLabel("Id", { exact: true }).inputValue(), { message: "the suggested id" }).toBe("orders-api");
    await add.getByRole("button", { name: "Add repo" }).click();
    await add.waitFor({ state: "detached" });
    await expect.poll(() => words(page), { message: "the repo is added" }).toEqual(["Ready", "Ready", "Added", "To do"]);
    expect(await row(page, "repo").innerText()).toContain("pnpm test");
    expect(await list(page).locator(".btn-primary").allInnerTexts()).toEqual(["Start a Quick fix"]);

    // 5. Start a Quick fix fills in New work and starts nothing.
    await row(page, "quick-fix").getByRole("button", { name: "Start a Quick fix" }).click();
    const box = page.locator("textarea.np-text");
    await expect.poll(() => box.inputValue(), { message: "the sample task" }).toBe(SAMPLE_TASK);
    expect(await box.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd, document.activeElement === el])).toEqual([0, SAMPLE_TASK.length, true]);
    expect(await page.locator(".np-trigger", { hasText: "Template" }).innerText()).toContain("Quick fix");
    expect(await page.locator(".np-trigger", { hasText: "Repos" }).innerText()).toContain("orders-api");
    await page.locator(".np-start:not([disabled])").waitFor();
    await screenshot("20-gs-3-newwork");

    // 6. Start: the list folds into the "Setup done" line, and the item is running below it.
    await page.locator(".np-start").click();
    await page.locator(".gs-line-done").waitFor();
    expect(await page.locator(".gs-line-title").innerText()).toBe("Setup done");
    expect(await list(page).count()).toBe(0);
    expect(await page.locator("main h1").innerText()).toBe("All work");
    await screenshot("20-gs-4-done-line");

    // 7. Help > Get started opens the list again over the work, checked again, with Close.
    await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById("help-get-started")?.click());
    await list(page).waitFor();
    // Opening it checks every row again; the AI CLI row says Checking… for a moment first.
    await expect.poll(() => count(page), { message: "everything is done", timeout: CHECK_TIMEOUT_MS }).toBe("4 of 4 done");
    expect(await row(page, "quick-fix").innerText()).toContain(SAMPLE_TASK);
    expect(await page.locator(".gs-line-done").count()).toBe(0);
    await screenshot("20-gs-5-help");
    await list(page).getByRole("button", { name: "Close" }).click();
    await list(page).waitFor({ state: "detached" });
  },
  "real",
  undefined,
  { env: fakeToolsEnv },
);

flow(
  "shows a repo without checks the way to Quick change, and an AI CLI that is too old with its update command",
  async ({ page, tmp, screenshot }) => {
    await list(page).waitFor();
    await expect.poll(() => words(page), { message: "everything but the first run is done", timeout: CHECK_TIMEOUT_MS }).toEqual(["Ready", "Ready", "Added", "To do"]);
    const quick = row(page, "quick-fix");
    expect(await quick.innerText()).toContain("Quick fix runs your checks after the change, and orders-api has none yet.");
    expect(await list(page).locator(".btn-primary").allInnerTexts()).toEqual(["Start a Quick change"]);
    await screenshot("20-gs-6-no-checks", quick);

    // A Quick change opens New work with its own template.
    await quick.getByRole("button", { name: "Start a Quick change" }).click();
    await expect.poll(() => page.locator(".np-trigger", { hasText: "Template" }).innerText()).toContain("Quick change");
    await page.keyboard.press("Escape");

    // An older Claude Code: the row says so, with the update command to copy, and New work is off.
    setClaude(tmp, "old");
    await expect.poll(() => words(page).then((all) => all[0]), { message: "too old", timeout: CHECK_TIMEOUT_MS }).toBe("Too old");
    expect(await row(page, "ai-cli").locator(".command-copy-text").innerText()).toBe("claude update");
    expect(await row(page, "ai-cli").innerText()).toContain("Claude Code 2.1.290 is too old. Tokama needs 2.1.315 or newer.");
    await screenshot("20-gs-6-too-old", row(page, "ai-cli"));
    expect(await page.locator(".new-work").getAttribute("aria-disabled")).toBe("true");
    await page.locator(".new-work").focus();
    await page.getByRole("tooltip").waitFor();
    expect(await page.getByRole("tooltip").innerText()).toBe("Set up an AI CLI first: too old");
  },
  "real",
  (home, tmp) => {
    const folder = makeRepo(tmp, "orders-api", false);
    const tokamaHome = join(home, ".tokama");
    mkdirSync(tokamaHome, { recursive: true });
    writeFileSync(join(tokamaHome, "repos.yaml"), `format: 1\nrepos:\n  - id: orders-api\n    path: ${folder}\n    base_branch: main\n`);
    setClaude(tmp, "ready");
  },
  { env: fakeToolsEnv },
);
