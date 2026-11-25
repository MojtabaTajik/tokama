// Settings > Repos in the real app. On the real engine with an empty home: the empty state, then
// add a repo from a temp git folder (the native picker is replaced in the main process), edit its
// checks, and remove it, with repos.yaml checked at each step. On the sample engine: the sample
// repos are listed and cannot be edited or removed. Screenshots go to `<outDir>/screenshots`.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import { flow } from "./harness.js";

const openRepos = async (page: import("@playwright/test").Page) => {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: "Repos" }).click();
};

flow(
  "adds a repo, edits its checks and removes it from Settings",
  async ({ app, page, tmp, home, screenshot }) => {
    const folder = join(tmp, "billing-api");
    mkdirSync(folder);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: folder });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "first"], { cwd: folder });
    writeFileSync(join(folder, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
    writeFileSync(join(folder, "pnpm-lock.yaml"), "");
    await app.evaluate(({ dialog }, path) => {
      (dialog as { showOpenDialog: unknown }).showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, folder);

    await openRepos(page);
    const empty = page.locator(".rp-empty");
    await empty.getByRole("heading", { name: "No repos added yet" }).waitFor();
    await screenshot("139-repos-empty");

    await empty.getByRole("button", { name: "Add repo", exact: true }).click();
    const add = page.getByRole("dialog", { name: "Add repo" });
    await expect.poll(() => add.getByLabel("Id", { exact: true }).inputValue(), { message: "the suggested id" }).toBe("billing-api");
    await add.getByRole("button", { name: "Add repo", exact: true }).click();
    await add.waitFor({ state: "detached" });

    const row = page.locator(".rp-row", { hasText: "billing-api" });
    await row.waitFor();
    await empty.waitFor({ state: "detached" });
    expect(await row.locator(".rp-row-meta").textContent()).toBe("main · 1 check");
    const file = join(home, ".tokama", "repos.yaml");
    expect(readFileSync(file, "utf8")).toContain(`path: ${realpathSync(folder)}`);
    const detail = page.locator(".rp-detail");
    expect(await detail.locator(".rp-checks li").allInnerTexts()).toEqual(["1\npnpm test"]);

    await detail.getByRole("button", { name: "Edit…" }).click();
    const edit = page.getByRole("dialog", { name: "Edit repo" });
    await edit.getByRole("textbox", { name: /^Checks/ }).fill("pnpm test\npnpm lint");
    await edit.getByLabel("Base branch", { exact: true }).fill("develop");
    await edit.getByRole("button", { name: "Save" }).click();
    await edit.waitFor({ state: "detached" });
    await expect.poll(() => detail.locator(".rp-checks li").allInnerTexts(), { message: "the page shows the new checks" }).toEqual(["1\npnpm test", "2\npnpm lint"]);
    expect(await row.locator(".rp-row-meta").textContent()).toBe("develop · 2 checks");
    const edited = readFileSync(file, "utf8");
    expect(edited).toContain("base_branch: develop");
    expect(edited).toContain("- pnpm lint");
    await screenshot("139-repos-detail");

    await detail.getByRole("button", { name: "Remove…" }).click();
    const confirm = page.getByRole("dialog", { name: "Remove billing-api?" });
    await screenshot("139-repos-remove");
    await confirm.getByRole("button", { name: "Remove repo" }).click();
    await confirm.waitFor({ state: "detached" });
    await empty.waitFor();
    expect(readFileSync(file, "utf8")).not.toContain("billing-api");
    expect(existsSync(join(folder, "package.json")), "the folder itself is untouched").toBe(true);
    await expect.poll(() => page.evaluate(() => document.activeElement?.textContent), { message: "focus moves to + Add repo" }).toBe("+ Add repo");
  },
  "real",
);

flow("lists the sample repos in Settings without Edit or Remove, and fits the narrowest window", async ({ page, resize, screenshot }) => {
  await openRepos(page);
  const rows = page.locator(".rp-row");
  await rows.first().waitFor();
  expect(await rows.count()).toBeGreaterThan(1);
  expect(await page.locator(".rp-detail").getByRole("heading", { level: 2 }).count()).toBe(1);
  expect(await page.getByRole("button", { name: "Remove…" }).count()).toBe(0);
  expect(await page.getByRole("button", { name: "Edit…" }).count()).toBe(0);
  await screenshot("139-repos-sample");
  await resize(1440, 800);
  await screenshot("139-repos-1440");

  await resize(720, 600);
  const overflow = await page.evaluate(() => {
    const pane = document.querySelector(".rp-pane");
    const page = document.querySelector(".rp-page");
    return { pane: pane!.scrollWidth - pane!.clientWidth, page: page!.scrollWidth - page!.clientWidth, doc: document.documentElement.scrollWidth - document.documentElement.clientWidth };
  });
  expect(overflow).toEqual({ pane: 0, page: 0, doc: 0 });
  await screenshot("139-repos-720");
  await resize(1200, 800);
});
