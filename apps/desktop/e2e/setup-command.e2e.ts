// The Setup command of a repo in the Add and Edit repo dialogs and in Settings > Repos. On the real
// engine the setup really runs in a throwaway worktree of a temp repo: its work is there for the
// check, a failing one skips the checks, and a failure with no setup offers the lockfile's command.
// On the sample engine the answers are canned: a setup with `fail` in it fails, `nothere` is not
// found, and the AI answer holds a setup row. Screenshots go to `<outDir>/screenshots`.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ElectronApplication, Locator, Page } from "playwright-core";
import { expect } from "vitest";
import { fakeToolsEnv } from "./fake-tools.js";
import { flow } from "./harness.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });

/** A git repo with one commit, a package.json with a test script, and the given lockfile. */
function makeRepo(tmp: string, name: string, lockfile: string): string {
  const folder = join(tmp, name);
  mkdirSync(folder);
  git(folder, "init", "-q", "-b", "main");
  writeFileSync(join(folder, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
  writeFileSync(join(folder, lockfile), lockfile.endsWith(".json") ? "{}\n" : "");
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
const setupOf = (dialog: Locator) => dialog.getByRole("textbox", { name: /^Setup command/ });
const words = (results: Locator) => results.locator(".ch-trial-word").allInnerTexts();
/** The group headings as written: the style draws them in capitals. */
const groups = (card: Locator) => card.locator(".ch-group").allTextContents();

flow(
  "runs the setup first on the real engine: its work is there for the check, a failing one skips the checks, and a failure without one offers the lockfile's command",
  async ({ app, page, tmp, home, screenshot, resize }) => {
    await resize(1200, 1700);
    const folder = makeRepo(tmp, "orders-api", "package-lock.json");
    const add = await openAdd(app, page, folder);

    // The lockfile fills the field and says where it came from; nothing ran.
    expect(await setupOf(add).inputValue()).toBe("npm ci");
    await add.getByText("✓ suggested").first().waitFor();
    await add.getByText("Found package-lock.json.").waitFor();
    await screenshot("setup-a-field", add);

    // A setup that makes a file the check needs: Done, then Passed.
    await setupOf(add).fill("touch ready");
    await checksOf(add).fill("test -f ready");
    await add.getByRole("button", { name: "Try checks" }).click();
    const results = add.getByRole("region", { name: "Try checks results" });
    await results.waitFor({ timeout: 60_000 });
    expect(await results.locator(".ch-card-title").textContent()).toContain("Setup and 1 check passed");
    expect(await words(results)).toEqual(["Done", "Passed"]);
    expect(await groups(results)).toEqual(["Setup", "Checks"]);
    await screenshot("setup-o-passed", add);

    // A setup that fails: the checks are not run, and the output is plain text.
    await setupOf(add).fill(`sh -c 'echo "lockfile is <b>out of date</b>"; exit 1'`);
    await add.getByRole("button", { name: "Try checks" }).click();
    const failed = add.getByRole("region", { name: "Try checks results" });
    await failed.getByText("Setup failed · 1 check not run").waitFor({ timeout: 60_000 });
    expect(await words(failed)).toEqual(["Failed, exit 1", "Not run"]);
    await failed.getByRole("button", { name: "Output" }).click();
    expect(await failed.locator(".ch-output-text").textContent()).toContain("lockfile is <b>out of date</b>");
    expect(await failed.locator(".ch-output b").count()).toBe(0);
    expect(await failed.textContent()).toContain("The checks need the setup command to pass first.");
    await screenshot("setup-p-failed", add);

    // A setup that is not found says so, with the PATH sentence.
    await setupOf(add).fill("tokama-no-such-tool --install");
    await add.getByRole("button", { name: "Try checks" }).click();
    const missing = add.getByRole("region", { name: "Try checks results" });
    await missing.getByText("Setup could not start · 1 check not run").waitFor({ timeout: 60_000 });
    expect(await missing.textContent()).toContain("tokama-no-such-tool was not found. Tokama runs commands with the PATH of its background service, which can differ from your terminal.");
    await screenshot("setup-p2-not-found", add);

    // No setup and a check that needs it: the line says what is true, and the button fills the field.
    await setupOf(add).fill("");
    await add.getByRole("button", { name: "Try checks" }).click();
    const noSetup = add.getByRole("region", { name: "Try checks results" });
    await noSetup.getByText("No setup command is set.").waitFor({ timeout: 60_000 });
    expect(await words(noSetup)).toEqual(["Failed, exit 1"]);
    await screenshot("setup-q-no-setup", add);
    await noSetup.getByRole("button", { name: "Use npm ci as setup" }).click();
    expect(await setupOf(add).inputValue()).toBe("npm ci");
    await noSetup.getByText("No setup command is set.").waitFor({ state: "detached" });

    // More than one command is refused in the field, and Try checks is off.
    await setupOf(add).fill("npm ci && npm run build");
    await add.getByText("One command only. Put the second command in Checks, or in a script that the setup command runs.").waitFor();
    expect(await add.getByRole("button", { name: "Try checks" }).isDisabled()).toBe(true);
    await screenshot("setup-n4-refused", add);

    // The repo keeps the setup command, and the engine refuses a bad one in its own words.
    await setupOf(add).fill("touch ready");
    await add.getByRole("button", { name: "Add repo", exact: true }).click();
    await add.waitFor({ state: "detached" });
    expect(readFileSync(join(home, ".tokama", "repos.yaml"), "utf8")).toContain("setup: touch ready");

    // Edit repo: the saved command, changed and cleared.
    await page.getByRole("button", { name: "Actions for orders-api" }).click();
    await page.getByRole("menuitem", { name: /^Edit…/ }).click();
    const edit = page.getByRole("dialog", { name: "Edit repo" });
    await setupOf(edit).waitFor();
    expect(await setupOf(edit).inputValue()).toBe("touch ready");
    await screenshot("setup-e-edit", edit);
    await setupOf(edit).fill("");
    await edit.getByRole("button", { name: "Save" }).click();
    await edit.waitFor({ state: "detached" });
    expect(readFileSync(join(home, ".tokama", "repos.yaml"), "utf8")).not.toContain("setup:");
  },
  "real",
  undefined,
  { env: fakeToolsEnv },
);

flow(
  "shows a long setup command whole at a narrow width, and the same command in Settings > Repos",
  async ({ app, page, tmp, home, screenshot, resize }) => {
    await resize(760, 1500);
    const folder = makeRepo(tmp, "orders-api", "pnpm-lock.yaml");
    const add = await openAdd(app, page, folder);
    const long = "dotnet restore src/Orders.sln --locked-mode --source https://packages.northwind.example/nuget/v3/index.json";
    const height = () => setupOf(add).evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight }));
    await setupOf(add).fill("npm ci");
    const oneLine = await height();
    await setupOf(add).fill(long);
    // It grows past one line, and no line is cut or scrolled away; fonts differ by system, so it is compared with a short command, not with pixels.
    const box = await height();
    expect(box.scroll).toBeLessThanOrEqual(box.client + 1);
    expect(box.client).toBeGreaterThan(oneLine.client);
    await screenshot("setup-760-field", add);
    await add.getByRole("button", { name: "Add repo", exact: true }).click();
    await add.waitFor({ state: "detached" });

    // The file wraps a long value onto a second line; it reads back as the same one line.
    expect(readFileSync(join(home, ".tokama", "repos.yaml"), "utf8").replace(/\n\s+/g, " ")).toContain(`setup: ${long}`);
    await page.getByRole("button", { name: /^Settings(?: · .+)?$/ }).click();
    await page.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: "Repos" }).click();
    const detail = page.locator(".rp-detail");
    await detail.getByRole("heading", { name: "Setup command" }).waitFor();
    expect(await detail.locator(".rp-whole").textContent()).toBe(long);
    const shown = await detail.locator(".rp-whole").evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
    expect(shown.scroll).toBeLessThanOrEqual(shown.client + 1);
    await screenshot("setup-settings-760");
  },
  "real",
  undefined,
  { env: fakeToolsEnv },
);

flow(
  "tries and fails a setup on the sample engine, and takes the setup row of Suggest with AI",
  async ({ app, page, tmp, screenshot, resize }) => {
    await resize(1200, 1700);
    const folder = makeRepo(tmp, "orders-api", "pnpm-lock.yaml");
    const add = await openAdd(app, page, folder);
    await setupOf(add).fill("pnpm install --fail");
    await add.getByRole("button", { name: "Try checks" }).click();
    await add.getByText("Trying setup, then 1 check").waitFor();
    await add.locator(".ch-trial-word", { hasText: "Running" }).waitFor();
    await screenshot("setup-o-running", add);
    const failed = add.getByRole("region", { name: "Try checks results" });
    await failed.getByText("Setup failed · 1 check not run").waitFor();
    expect(await words(failed)).toEqual(["Failed, exit 1", "Not run"]);
    await failed.getByRole("button", { name: "Output" }).click();
    expect(await failed.locator(".ch-output-text").textContent()).toContain("ERR_PNPM_OUTDATED_LOCKFILE");

    // With the field empty, the answer's setup row says Use as setup; with another command, Replace setup.
    await failed.getByRole("button", { name: "Close the results" }).click();
    await setupOf(add).fill("");
    await add.getByRole("button", { name: "Suggest with AI" }).click();
    await add.getByRole("button", { name: "Send and suggest" }).click();
    const card = add.getByRole("region", { name: "Suggested checks" });
    await card.waitFor();
    expect(await groups(card)).toEqual(["Setup command", "Checks"]);
    await screenshot("setup-r-answer", add);
    await card.getByRole("button", { name: "Add all new" }).click();
    expect(await setupOf(add).inputValue()).toBe("");
    await card.getByRole("button", { name: "Use as setup pnpm install --frozen-lockfile" }).click();
    expect(await setupOf(add).inputValue()).toBe("pnpm install --frozen-lockfile");
    await setupOf(add).fill("pnpm install");
    await card.getByRole("button", { name: "Replace setup pnpm install --frozen-lockfile" }).waitFor();
    await screenshot("setup-r-replace", add);
  },
);
