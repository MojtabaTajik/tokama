// Adding and removing a repo from the sidebar, against a temp git repo, on the real engine with an
// empty home (first launch). The native folder picker is replaced in the main process for the
// test; the engine still checks the folder it gets.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect } from "vitest";
import { baseBranchButton, branchSearch, chooseBranch } from "./base-branch.js";
import { flow, outDir, sidebarRow } from "./harness.js";

flow(
  "adds a repo from a folder and removes it again",
  async ({ app, page, tmp, home }) => {
    const firstLaunch = page.getByRole("region", { name: "Get started" });
    await firstLaunch.waitFor();
    const repoWord = firstLaunch.locator('[data-row="repo"] .gs-word');
    expect(await repoWord.innerText()).toBe("To do");
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
    await expect.poll(() => baseBranchButton(add).textContent(), { message: "the default branch is preselected" }).toContain("main default");
    expect(await add.getByRole("textbox", { name: /^Checks/ }).inputValue()).toBe("pnpm test");
    await add.getByRole("button", { name: "Add repo" }).click();
    await add.waitFor({ state: "detached" });
    await sidebarRow(page, "billing-api").waitFor();
    // The list is still there until the first item starts, with the repo ticked off.
    await expect.poll(() => repoWord.innerText(), { message: "the list ticks the repo" }).toBe("Added");

    const file = join(home, ".tokama", "repos.yaml");
    const written = readFileSync(file, "utf8");
    expect(written).toMatch(/^format: 1$/m);
    expect(written).toContain(`path: ${realpathSync(folder)}`);
    expect(written).toContain("- pnpm test");
    expect(statSync(file).mode & 0o777).toBe(0o600);

    // Edit the checks from the row menu, then see repos.yaml change.
    await page.getByRole("button", { name: "Actions for billing-api" }).click();
    await page.getByRole("menuitem", { name: /^Edit…/ }).click();
    const edit = page.getByRole("dialog", { name: "Edit repo" });
    expect(await edit.getByRole("textbox", { name: /^Id/ }).isEditable(), "the id is read-only").toBe(false);
    expect(await edit.getByRole("textbox", { name: /^Checks/ }).inputValue()).toBe("pnpm test");
    await edit.getByRole("textbox", { name: /^Checks/ }).fill("pnpm test\npnpm lint");
    // The repo has no develop branch yet: typed text is used, and Save needs the branch to exist.
    execFileSync("git", ["branch", "develop"], { cwd: folder });
    await chooseBranch(edit, "develop");
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
    await page.getByRole("menuitem", { name: /^Remove…/ }).press("Enter");
    const confirm = page.getByRole("dialog", { name: "Remove billing-api?" });
    await confirm.getByRole("button", { name: "Remove repo" }).click();
    await confirm.waitFor({ state: "detached" });
    await sidebarRow(page, "billing-api").waitFor({ state: "detached" });
    expect(readFileSync(file, "utf8")).not.toContain("billing-api");
    expect(existsSync(join(folder, "package.json")), "the folder itself is untouched").toBe(true);
    await expect.poll(() => repoWord.innerText(), { message: "the list takes the repo off again" }).toBe("To do");
  },
  "real",
);

flow(
  "a repo with many branches shows one tidy dropdown with the default chosen",
  async ({ app, page, tmp, home, screenshot }) => {
    const folder = join(tmp, "orders-api");
    mkdirSync(folder);
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: folder, encoding: "utf8" }).trim();
    git("init", "-q", "-b", "develop");
    git("commit", "-q", "--allow-empty", "-m", "first");
    const head = git("rev-parse", "HEAD");
    // The refs come from one update-ref call, as a clone with many branches would have them. No fetch.
    const refs = [
      "refs/heads/main",
      ...Array.from({ length: 250 }, (_, index) => `refs/heads/feature/receipt-tax-${String(index + 1).padStart(3, "0")}`),
      "refs/heads/fix/login-timeout",
      "refs/remotes/origin/main",
      "refs/remotes/origin/release",
    ];
    execFileSync("git", ["update-ref", "--stdin"], { cwd: folder, input: refs.map((ref) => `create ${ref} ${head}\n`).join("") });
    git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    await app.evaluate(({ dialog }, path) => {
      (dialog as { showOpenDialog: unknown }).showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, folder);

    await page.getByRole("button", { name: "+ Add repo" }).click();
    const add = page.getByRole("dialog", { name: "Add repo" });
    // origin's HEAD wins over the current branch (develop).
    await expect.poll(() => baseBranchButton(add).textContent(), { message: "the default branch is preselected" }).toContain("main default");
    expect(await add.textContent()).not.toContain("Found:");

    await baseBranchButton(add).click();
    const options = add.getByRole("option");
    expect(await options.count()).toBe(200);
    const texts = await options.allTextContents();
    expect(texts[0]).toMatch(/main.*default/);
    expect(texts[1]).toBe("develop");
    expect(await add.locator(".combobox-heading").allTextContents()).toEqual(["Other branches"]);
    expect(texts[2]).toBe("feature/receipt-tax-001");
    expect(texts[199]).toBe("feature/receipt-tax-198");
    // The cap cuts the tail; remote-tracking names are not offered.
    expect(texts).not.toContain("feature/receipt-tax-199");
    expect(texts).not.toContain("fix/login-timeout");
    expect(texts.filter((text) => text.includes("origin/"))).toEqual([]);
    expect(await add.textContent()).toContain("Showing the first 200 of 253 branches.");
    await screenshot("repo-branch-dropdown");

    // A name the cap cut can still be used.
    await branchSearch(add).fill("feature/receipt-tax-250");
    expect(await options.allTextContents()).toEqual(["Use ‘feature/receipt-tax-250’"]);

    // Enter alone picks the match, not the "Use" row.
    await branchSearch(add).fill("tax-012");
    expect(await options.allTextContents()).toEqual(["feature/receipt-tax-012", "Use ‘tax-012’"]);
    await branchSearch(add).press("Enter");
    await expect.poll(() => baseBranchButton(add).textContent()).toContain("feature/receipt-tax-012");

    // Escape closes the list and leaves the dialog open.
    await baseBranchButton(add).click();
    await branchSearch(add).press("Escape");
    await branchSearch(add).waitFor({ state: "detached" });
    expect(await add.isVisible()).toBe(true);

    await add.getByRole("button", { name: "Add repo" }).click();
    await add.waitFor({ state: "detached" });
    await sidebarRow(page, "orders-api").waitFor();
    expect(readFileSync(join(home, ".tokama", "repos.yaml"), "utf8")).toContain("base_branch: feature/receipt-tax-012");
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
    await add.getByText(/This repo has no commits yet\./).waitFor();
    await screenshot("11-add-repo-no-commits");
    await add.getByRole("button", { name: "Cancel" }).click();

    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "first"], { cwd: fresh });
    await page.getByRole("button", { name: "+ Add repo" }).click();
    await add.getByText("No checks found in this folder.").waitFor();
    await screenshot("11-add-repo-no-checks");
    await add.getByRole("button", { name: "Use node --check index.js" }).click();
    expect(await add.getByRole("textbox", { name: /^Checks/ }).inputValue()).toBe("node --check index.js");
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
    await add.getByText("First commit").first().waitFor();
    await screenshot("11-add-repo-no-git");
    await add.getByRole("button", { name: "Set up git and add" }).click();
    await add.waitFor({ state: "detached" });
    await sidebarRow(page, "plain-app").waitFor();
    expect(execFileSync("git", ["log", "--format=%s"], { cwd: folder }).toString().trim()).toBe("Initial commit");
    expect(readFileSync(join(folder, ".gitignore"), "utf8")).toContain("node_modules/");
  },
  "real",
);

flow(
  "refuses the reserved ids builtin and personal in the Add repo dialog, with the reason",
  async ({ app, page, tmp, home }) => {
    const folder = join(tmp, "billing-api");
    mkdirSync(folder);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: folder });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "first"], { cwd: folder });
    await app.evaluate(({ dialog }, path) => {
      (dialog as { showOpenDialog: unknown }).showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, folder);

    await page.getByRole("button", { name: "+ Add repo" }).click();
    const add = page.getByRole("dialog", { name: "Add repo" });
    const id = add.getByLabel("Id", { exact: true });
    await expect.poll(() => id.inputValue(), { message: "the suggested id" }).toBe("billing-api");
    for (const reserved of ["builtin", "personal"]) {
      await id.fill(reserved);
      await add.getByRole("button", { name: "Add repo" }).click();
      await add.getByText(`The id '${reserved}' is reserved: template names start with builtin/ and personal/. Pick another id.`).waitFor();
    }
    expect(existsSync(join(home, ".tokama", "repos.yaml"))).toBe(false);
    await id.fill("billing");
    await add.getByRole("button", { name: "Add repo" }).click();
    await add.waitFor({ state: "detached" });
    await sidebarRow(page, "billing").waitFor();
  },
  "real",
);

flow(
  "takes screenshots of every repo dialog state",
  async ({ app, page, tmp, home }) => {
    const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd });
    const put = (folder: string, files: Record<string, string>) => {
      for (const [name, text] of Object.entries(files)) {
        mkdirSync(dirname(join(folder, name)), { recursive: true });
        writeFileSync(join(folder, name), text);
      }
    };
    const shot = async (name: string) => {
      mkdirSync(join(outDir, "screenshots"), { recursive: true });
      await page.locator("dialog.modal").screenshot({ path: join(outDir, "screenshots", `12-dialog-${name}.png`), animations: "disabled" });
    };
    const pick = async (folder: string) => {
      await app.evaluate(({ dialog }, path) => {
        (dialog as { showOpenDialog: unknown }).showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
      }, folder);
      await page.getByRole("button", { name: "+ Add repo" }).click();
    };
    const dialog = page.locator("dialog.modal");
    // Git commits here need a config; one that never guesses an identity makes the commit fail for c3.
    writeFileSync(join(home, ".gitconfig"), "[user]\n\tuseConfigOnly = true\n");

    // a: a repo with suggestions.
    const orders = join(tmp, "orders-api");
    mkdirSync(orders);
    git(orders, "init", "-q", "-b", "main");
    put(orders, { "package.json": JSON.stringify({ scripts: { test: "vitest run", lint: "eslint ." } }), "package-lock.json": "{}", "src/main.js": "1" });
    git(orders, "add", "-A");
    git(orders, "commit", "-q", "-m", "first");
    git(orders, "branch", "develop");
    await pick(orders);
    await dialog.getByRole("textbox", { name: /^Checks/ }).waitFor();
    await shot("a-add");
    await dialog.getByRole("button", { name: "Cancel" }).click();

    // b: no checks found, the package.json main offered.
    const receipt = join(tmp, "receipt-printer");
    mkdirSync(receipt);
    git(receipt, "init", "-q", "-b", "main");
    put(receipt, { "package.json": JSON.stringify({ main: "src/main.js" }), "src/main.js": "1" });
    git(receipt, "add", "-A");
    git(receipt, "commit", "-q", "-m", "first");
    await pick(receipt);
    await dialog.getByText("No checks found in this folder.").waitFor();
    await shot("b-no-checks");
    await dialog.getByRole("button", { name: "Cancel" }).click();

    // c: not a git repo yet.
    const plain = join(tmp, "orders-plain");
    mkdirSync(plain);
    const files: Record<string, string> = { "README.md": "x".repeat(2000), "package.json": "{}", "src/main.js": "1", "src/orders.js": "1", "src/routes/orders.js": "1", "test/orders.test.js": "1", ".env": "SECRET=1", ".DS_Store": "x" };
    for (let i = 0; i < 40; i++) files[`node_modules/dep${i}/index.js`] = "1";
    put(plain, files);
    await pick(plain);
    await dialog.getByText("Left out by the new .gitignore").waitFor();
    await shot("c-not-a-repo");
    // c3: the commit fails (no identity), after git init and .gitignore.
    await dialog.getByRole("button", { name: "Set up git and add" }).click();
    await dialog.getByText("The first commit failed.").waitFor();
    await shot("c3-failed");
    await page.keyboard.press("Escape");

    // c2: the home folder, and a folder with too many files.
    await pick(home);
    await dialog.getByText(/This is your home folder/).waitFor();
    await shot("c2-home");
    await page.keyboard.press("Escape");
    const many = join(tmp, "downloads");
    mkdirSync(many);
    for (let i = 0; i < 5100; i++) writeFileSync(join(many, `f${i}`), "");
    await pick(many);
    await dialog.getByText(/This folder has 5,100 files/).waitFor();
    await shot("c2-many");
    await page.keyboard.press("Escape");
    rmSync(many, { recursive: true, force: true });

    // d: a repo with no commits.
    const inventory = join(tmp, "inventory-service");
    mkdirSync(inventory);
    git(inventory, "init", "-q", "-b", "main");
    put(inventory, { ".gitignore": "node_modules/\n", "README.md": "1", "package.json": JSON.stringify({ scripts: { test: "vitest run" } }), "src/main.js": "1" });
    await pick(inventory);
    await dialog.getByText(/This repo has no commits yet\./).waitFor();
    await shot("d-no-commits");
    await dialog.getByRole("button", { name: "Cancel" }).click();

    // e and f: edit, and the row menu with the remove question.
    writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = t\n\temail = t@example.com\n");
    await pick(orders);
    await dialog.getByRole("button", { name: "Add repo" }).click();
    await dialog.waitFor({ state: "detached" });
    await page.getByRole("button", { name: "Actions for orders-api" }).click();
    await page.screenshot({ path: join(outDir, "screenshots", "12-dialog-f-menu.png"), animations: "disabled" });
    await page.getByRole("menuitem", { name: /^Edit…/ }).click();
    await dialog.getByRole("button", { name: "Save" }).waitFor();
    await shot("e-edit");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await page.getByRole("button", { name: "Actions for orders-api" }).click();
    await page.getByRole("menuitem", { name: /^Remove…/ }).click();
    await dialog.getByRole("button", { name: "Keep" }).waitFor();
    await shot("f-remove");
  },
  "real",
);
