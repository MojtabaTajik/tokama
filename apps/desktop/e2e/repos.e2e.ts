// Adding and removing a repo from the sidebar, against a temp git repo, on the real engine with an
// empty home (first launch). The native folder picker is replaced in the main process for the
// test; the engine still checks the folder it gets.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import { flow, sidebarRow } from "./harness.js";

flow(
  "adds a repo from a folder and removes it again",
  async ({ app, page, tmp, home }) => {
    const firstLaunch = page.locator(".board .state").getByRole("heading", { name: "Add your first repos" });
    await firstLaunch.waitFor();
    const folder = join(tmp, "billing-api");
    mkdirSync(folder);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: folder });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "first"], { cwd: folder });
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
    await firstLaunch.waitFor({ state: "detached" });

    const file = join(home, ".tokama", "repos.yaml");
    const written = readFileSync(file, "utf8");
    expect(written).toMatch(/^format: 1$/m);
    expect(written).toContain(`path: ${realpathSync(folder)}`);
    expect(written).toContain("- pnpm test");
    expect(statSync(file).mode & 0o777).toBe(0o600);

    // Edit the checks from the row menu, then see repos.yaml change.
    await page.getByRole("button", { name: "Actions for billing-api" }).click();
    await page.getByRole("menuitem", { name: "Edit repo…" }).click();
    const edit = page.getByRole("dialog", { name: "Edit repo" });
    expect(await edit.getByLabel("Id", { exact: true }).isEditable(), "the id is read-only").toBe(false);
    expect(await edit.getByLabel("Checks", { exact: true }).inputValue()).toBe("pnpm test");
    await edit.getByLabel("Checks", { exact: true }).fill("pnpm test\npnpm lint");
    await edit.getByLabel("Base branch", { exact: true }).fill("develop");
    await edit.getByRole("button", { name: "Save" }).click();
    await edit.waitFor({ state: "detached" });
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute("aria-label")), { message: "focus returns to the row menu button" }).toBe("Actions for billing-api");
    const edited = readFileSync(file, "utf8");
    expect(edited).toContain("base_branch: develop");
    expect(edited).toContain("- pnpm lint");
    expect(edited).toContain(`path: ${realpathSync(folder)}`);

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
    await firstLaunch.waitFor();
  },
  "real",
);

flow(
  "warns about a repo without commits, and about a repo without checks",
  async ({ app, page, tmp, screenshot }) => {
    const fresh = join(tmp, "fresh-repo");
    mkdirSync(fresh);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: fresh });
    writeFileSync(join(fresh, "index.js"), "console.log(1);\n");
    await app.evaluate(({ dialog }, path) => {
      (dialog as { showOpenDialog: unknown }).showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, fresh);

    await page.getByRole("button", { name: "+ Add repo" }).click();
    const add = page.getByRole("dialog", { name: "Add repo" });
    await add.getByText("This repo has no commits yet. Make a first commit, then add it.").waitFor();
    expect(await add.getByRole("button", { name: "Add repo" }).isDisabled()).toBe(true);
    await screenshot("11-add-repo-no-commits");
    await add.getByRole("button", { name: "Cancel" }).click();

    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "first"], { cwd: fresh });
    await page.getByRole("button", { name: "+ Add repo" }).click();
    await add.getByText("No checks yet.").waitFor();
    await screenshot("11-add-repo-no-checks");
    await add.getByRole("button", { name: "Use node --check index.js" }).click();
    expect(await add.getByLabel("Checks", { exact: true }).inputValue()).toBe("node --check index.js");
  },
  "real",
);

flow(
  "sets up git in a plain folder, then adds it",
  async ({ app, page, tmp, home, screenshot }) => {
    // The first commit needs an identity; git reads it from HOME.
    writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = t\n\temail = t@example.com\n");
    const folder = join(tmp, "plain-app");
    mkdirSync(folder);
    writeFileSync(join(folder, "index.js"), "console.log(1);\n");
    await app.evaluate(({ dialog }, path) => {
      (dialog as { showOpenDialog: unknown }).showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, folder);
    await page.getByRole("button", { name: "+ Add repo" }).click();
    const add = page.getByRole("dialog", { name: "Add repo" });
    await add.getByText("This folder isn't a git repo yet.").waitFor();
    await add.getByText("The first commit will hold 1 file:").waitFor();
    await screenshot("11-add-repo-no-git");
    await add.getByRole("button", { name: "Set up git and add" }).click();
    await add.waitFor({ state: "detached" });
    await sidebarRow(page, "plain-app").waitFor();
    expect(execFileSync("git", ["log", "--format=%s"], { cwd: folder }).toString().trim()).toBe("Initial commit");
    expect(readFileSync(join(folder, ".gitignore"), "utf8")).toContain("node_modules/");
  },
  "real",
);
