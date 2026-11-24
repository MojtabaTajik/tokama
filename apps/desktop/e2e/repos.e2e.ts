// Adding and removing a repo from the sidebar, against a temp git repo. The native folder picker
// is replaced in the main process for the test; the engine still checks the folder it gets.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import { flow, sidebarRow } from "./harness.js";

flow("adds a repo from a folder and removes it again", async ({ app, page, tmp, home }) => {
  const folder = join(tmp, "billing-api");
  mkdirSync(folder);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: folder });
  writeFileSync(join(folder, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
  writeFileSync(join(folder, "pnpm-lock.yaml"), "");
  await app.evaluate(({ dialog }, path) => {
    (dialog as { showOpenDialog: unknown }).showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, folder);

  await page.getByRole("button", { name: "+ Add repo" }).click();
  const add = page.getByRole("dialog", { name: "Add repo" });
  await expect.poll(() => add.getByLabel("Id", { exact: true }).inputValue(), { message: "the suggested id" }).toBe("billing-api");
  expect(await add.getByLabel("Base branch", { exact: true }).inputValue()).toBe("main");
  expect(await add.getByLabel("Checks", { exact: true }).inputValue()).toBe("pnpm test");
  await add.getByRole("button", { name: "Add repo" }).click();
  await add.waitFor({ state: "detached" });
  await sidebarRow(page, "billing-api").waitFor();

  const file = join(home, ".tokama", "repos.yaml");
  const written = readFileSync(file, "utf8");
  expect(written).toMatch(/^format: 1$/m);
  expect(written).toContain(`path: ${realpathSync(folder)}`);
  expect(written).toContain("- pnpm test");
  expect(statSync(file).mode & 0o777).toBe(0o600);

  // Remove, by keyboard: the row menu opens with ArrowDown, its item takes Enter.
  await page.getByRole("button", { name: "Actions for billing-api" }).focus();
  await page.keyboard.press("ArrowDown");
  await page.getByRole("menuitem", { name: "Remove repo…" }).press("Enter");
  const confirm = page.getByRole("dialog", { name: "Remove billing-api?" });
  await confirm.getByRole("button", { name: "Remove repo" }).click();
  await confirm.waitFor({ state: "detached" });
  await sidebarRow(page, "billing-api").waitFor({ state: "detached" });
  expect(readFileSync(file, "utf8")).not.toContain("billing-api");
  expect(existsSync(join(folder, "package.json")), "the folder itself is untouched").toBe(true);
});
