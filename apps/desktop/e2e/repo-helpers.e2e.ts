// Suggest with AI and Try checks in the Add repo dialog. On the sample engine the helper's answer
// and the check results are canned, picked by the folder's name (`fail`, `empty`, `slow` in it);
// the folder itself is a real git repo, so the dialog's own suggestions and add_repo are real. On
// the real engine Try checks runs the commands in a throwaway worktree of a temp repo.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ElectronApplication, Locator, Page } from "playwright-core";
import { expect } from "vitest";
import { flow } from "./harness.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });

/** A git repo with one commit and a package.json that has a test script. */
function makeRepo(tmp: string, name: string, files: Record<string, string> = {}): string {
  const folder = join(tmp, name);
  mkdirSync(folder);
  git(folder, "init", "-q", "-b", "main");
  writeFileSync(join(folder, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
  writeFileSync(join(folder, "pnpm-lock.yaml"), "");
  for (const [file, text] of Object.entries(files)) writeFileSync(join(folder, file), text);
  git(folder, "add", "-A");
  git(folder, "commit", "-q", "-m", "first");
  return folder;
}

async function openAdd(app: ElectronApplication, page: Page, folder: string): Promise<Locator> {
  await app.evaluate(({ dialog }, path) => {
    (dialog as { showOpenDialog: unknown }).showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, folder);
  await page.getByRole("button", { name: "+ Add repo" }).click();
  const add = page.getByRole("dialog", { name: "Add repo" });
  await add.getByRole("textbox", { name: /^Checks/ }).waitFor();
  return add;
}

const checksOf = (dialog: Locator) => dialog.getByRole("textbox", { name: /^Checks/ });

flow(
  "suggests checks with AI, adds one and edits one by hand, tries them, and adds the repo",
  async ({ app, page, tmp, home, screenshot, resize }) => {
    // Tall enough that the dialog shows whole in its screenshots.
    await resize(1200, 1700);
    const folder = makeRepo(tmp, "orders-api");
    const add = await openAdd(app, page, folder);
    expect(await checksOf(add).inputValue()).toBe("pnpm test");
    await screenshot("repo-helpers-a-buttons", add);

    // The first send to a cloud AI tool asks once, and nothing is sent before the answer.
    await add.getByRole("button", { name: "Suggest with AI" }).click();
    await add.getByText("Send this folder's file names and build files to Claude Code?").waitFor();
    await screenshot("repo-helpers-g-consent", add);
    await add.getByRole("button", { name: "Not now" }).click();
    await add.getByRole("button", { name: "Suggest with AI" }).click();
    await add.getByRole("button", { name: "Send and suggest" }).click();
    await add.locator(".ch-status").waitFor();
    await screenshot("repo-helpers-h-running", add);

    // The answer: three rows, one already in the field; nothing was added or run.
    const card = add.getByRole("region", { name: "Suggested checks" });
    await card.waitFor();
    expect(await checksOf(add).inputValue()).toBe("pnpm test");
    expect(await card.textContent()).toContain("3 checks · 2 new");
    await screenshot("repo-helpers-i-answer", add);

    await card.getByRole("button", { name: "Add pnpm lint" }).click();
    expect(await checksOf(add).inputValue()).toBe("pnpm test\npnpm lint");

    // Edit a row: the one-command rule holds, and Enter does not save the repo.
    await card.getByRole("button", { name: "Edit pnpm typecheck" }).click();
    const edit = card.getByRole("textbox", { name: /^Edit the command/ });
    await edit.fill("pnpm typecheck && pnpm lint");
    await card.getByText("One command only: no &&, | or redirects.").waitFor();
    await screenshot("repo-helpers-i2-edit", add);
    await edit.press("Enter");
    expect(await checksOf(add).inputValue()).toBe("pnpm test\npnpm lint");
    expect(await add.isVisible()).toBe(true);
    await edit.fill("pnpm typecheck");
    await edit.press("Enter");
    expect(await checksOf(add).inputValue()).toBe("pnpm test\npnpm lint\npnpm typecheck");

    // Try checks: every check runs, the lint one fails, its output is plain text.
    await add.getByRole("button", { name: "Try checks" }).click();
    await add.getByText("Trying 3 checks").waitFor();
    await screenshot("repo-helpers-k-trying", add);
    const results = add.getByRole("region", { name: "Try checks results" });
    await results.waitFor();
    expect(await results.locator(".ch-card-title").textContent()).toContain("1 of 3 checks failed");
    expect(await results.locator(".ch-trial-word").allInnerTexts()).toEqual(["Passed", "Failed, exit 1", "Passed"]);
    await results.getByRole("button", { name: "Output" }).click();
    expect(await results.locator(".ch-output-text").textContent()).toContain("prefer-const");
    await screenshot("repo-helpers-l-results", add);

    // The repo is added with the three lines, even though one check failed.
    await add.getByRole("button", { name: "Add repo", exact: true }).click();
    await add.waitFor({ state: "detached" });
    const yaml = readFileSync(join(home, ".tokama", "repos.yaml"), "utf8");
    expect(yaml).toContain("- pnpm test");
    expect(yaml).toContain("- pnpm lint");
    expect(yaml).toContain("- pnpm typecheck");

    // The agreement is remembered: the next folder sends at once, and the app wrote it down.
    await expect.poll(() => (JSON.parse(readFileSync(join(home, ".tokama", "desktop.json"), "utf8")) as { helperConsent?: string[] }).helperConsent).toEqual(["claude-code"]);
    const second = await openAdd(app, page, makeRepo(tmp, "checkout-web"));
    await second.getByRole("button", { name: "Suggest with AI" }).click();
    await second.locator(".ch-status").waitFor();
    expect(await second.getByText("Send this folder's file names").count()).toBe(0);
    await second.getByRole("button", { name: "Stop" }).click();
    await second.getByText("Stopped.").waitFor();
    expect(await second.textContent()).toContain("Nothing was added to Checks.");
    await screenshot("repo-helpers-j-stopped", second);
  },
);

flow(
  "shows a failed answer, an empty answer and a retry on the sample engine",
  async ({ app, page, tmp, screenshot, resize }) => {
    await resize(1200, 1700);
    const consent =(dialog: Locator) => dialog.getByRole("button", { name: "Send and suggest" });
    const failing = await openAdd(app, page, makeRepo(tmp, "fail-api"));
    await failing.getByRole("button", { name: "Suggest with AI" }).click();
    await consent(failing).click();
    await failing.getByText("No usable answer.").waitFor();
    await screenshot("repo-helpers-j-failed", failing);
    await page.keyboard.press("Escape");
    await failing.waitFor({ state: "detached" });

    const retrying = await openAdd(app, page, makeRepo(tmp, "retry-api"));
    await retrying.getByRole("button", { name: "Suggest with AI" }).click();
    await retrying.getByText("Asking again, the first answer could not be read").waitFor();
    await page.keyboard.press("Escape");

    // No commands in the field: the button is in the "No checks found" box, and the answer is a note.
    const emptyFolder = join(tmp, "empty-docs");
    mkdirSync(emptyFolder);
    git(emptyFolder, "init", "-q", "-b", "main");
    writeFileSync(join(emptyFolder, "README.md"), "docs\n");
    git(emptyFolder, "add", "-A");
    git(emptyFolder, "commit", "-q", "-m", "first");
    const empty = await openAdd(app, page, emptyFolder);
    await empty.getByText("No checks found in this folder.").waitFor();
    await screenshot("repo-helpers-b-no-checks", empty);
    await empty.getByRole("button", { name: "Suggest with AI" }).click();
    await empty.getByText("Claude Code · haiku suggested no checks").waitFor();
    expect(await empty.locator(".ch-note").textContent()).toContain("No build files found.");
    await screenshot("repo-helpers-i3-empty", empty);
  },
);

flow(
  "tries checks on the real engine in a throwaway worktree: one passes, one fails, the folder is untouched",
  async ({ app, page, tmp, screenshot, resize }) => {
    await resize(1200, 1700);
    const folder = makeRepo(tmp, "billing-api", { "ok.js": "console.log(1);\n", "broken.js": "const = ;\n" });
    const add = await openAdd(app, page, folder);
    await checksOf(add).fill("node --check ok.js\nnode --check broken.js");
    await add.getByRole("button", { name: "Try checks" }).click();
    const results = add.getByRole("region", { name: "Try checks results" });
    await results.waitFor({ timeout: 60_000 });
    expect(await results.locator(".ch-trial-word").allInnerTexts()).toEqual(["Passed", expect.stringMatching(/^Failed, exit \d+$/)]);
    expect(await results.locator(".ch-card-title").textContent()).toContain("1 of 2 checks failed");
    await results.getByRole("button", { name: "Output" }).click();
    expect(await results.locator(".ch-output-text").textContent()).toMatch(/SyntaxError/);
    await screenshot("repo-helpers-l-real", add);
    // The trial's worktree is gone and the folder has no new file but the local exclude line.
    expect(git(folder, "status", "--porcelain").trim()).toBe("");
    expect(git(folder, "worktree", "list").trim().split("\n")).toHaveLength(1);
    const wt = join(folder, ".tokama", "wt");
    expect(!existsSync(wt) || readdirSync(wt).length === 0).toBe(true);
  },
  "real",
);
