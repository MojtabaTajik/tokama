// The Templates page in Settings, on the sample engine: the list with each file's state, a valid
// template in plain words with its flow, and a broken one whose problem lines open the file there.
// Driven by keyboard where a user would, so the page stays reachable without a mouse. Then a real
// repo's template on the real engine, opened in the editor (the system's opener is replaced).
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import { flow } from "./harness.js";

flow("shows templates with their flow, steps and problems in Settings", async ({ page, screenshot }) => {
  await page.getByRole("button", { name: /^Settings(?: · \d+\+? diagnostics waiting)?$/ }).click();
  await page.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: "Templates" }).click();
  const list = page.getByRole("list", { name: "Template files" });
  await list.getByRole("button", { name: /Plan and build.*orders-api/ }).waitFor();
  expect(await page.getByRole("navigation", { name: "Settings" }).locator('[aria-current="page"]').textContent()).toBe("Templates");
  expect(await list.locator(".tp-status").allTextContents()).toEqual(expect.arrayContaining(["✓ valid", "✕ 2 problems"]));

  const detail = page.locator("main.tp-detail");
  await detail.getByRole("heading", { name: "Plan and build" }).waitFor();
  await detail.getByRole("img", { name: /Start → Plan → Build → Review → Finish/ }).waitFor();
  expect(await detail.locator(".tp-steps li").count()).toBe(3);
  expect(await detail.locator(".tp-steps li").nth(1).textContent()).toContain("if checks fail, try again, up to 3 attempts");
  await screenshot("6-templates");

  // The broken sample template, picked by keyboard.
  await list.getByRole("button", { name: /flaky-test-fix\.yaml/ }).focus();
  await page.keyboard.press("Enter");
  await detail.getByRole("heading", { name: "✕ 2 problems" }).waitFor();
  await detail.getByRole("button", { name: "line 20" }).press("Enter");
  const marked = detail.locator(".tp-file-line[data-mark]");
  await marked.waitFor();
  expect(await marked.textContent()).toBe("20✕    agent: reviewr");
  await screenshot("7-templates-problems");

  await page.getByRole("button", { name: "← Back" }).click();
  await page.locator("nav.rail").waitFor();
});

flow(
  "shows a real repo's template and opens it in the editor",
  async ({ app, page, tmp, home }) => {
    const repo = join(tmp, "billing-api");
    mkdirSync(join(repo, ".tokama", "templates"), { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    const file = join(repo, ".tokama", "templates", "docs-fix.yaml");
    writeFileSync(file, "format: 1\nname: Docs fix\nsteps:\n  - id: fix\n    name: Fix\n    agent: buildr\n    instructions: Fix the docs.\nfinish: [commit]\n");
    // The engine reads repos.yaml and the templates again on every query.
    writeFileSync(join(home, ".tokama", "repos.yaml"), `format: 1\nrepos:\n  - id: billing-api\n    path: ${realpathSync(repo)}\n    base_branch: main\n    checks: []\n`);
    await app.evaluate(({ shell }) => {
      const opened: string[] = [];
      (globalThis as { opened?: string[] }).opened = opened;
      (shell as { openPath: unknown }).openPath = async (path: string) => (opened.push(path), "");
    });

    await page.getByRole("button", { name: /^Settings(?: · \d+\+? diagnostics waiting)?$/ }).click();
    await page.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: "Templates" }).click();
    const list = page.getByRole("list", { name: "Template files" });
    await list.getByRole("button", { name: /docs-fix\.yaml.*✕ \d+ problems?/ }).click();
    const detail = page.locator("main.tp-detail");
    await detail.getByRole("heading", { name: /^✕ \d+ problems?$/ }).waitFor();
    expect(await detail.locator(".tp-problems").textContent()).toContain('"buildr"');
    for (const name of [/Quick fix.*✓ valid.*built-in/, /Plan and build.*✓ valid.*built-in/, /Review only.*✓ valid.*built-in/]) await list.getByRole("button", { name }).waitFor();

    await detail.getByRole("button", { name: "Open in editor" }).click();
    await expect.poll(() => app.evaluate(() => (globalThis as { opened?: string[] }).opened ?? [])).toEqual([realpathSync(file)]);
  },
  "real",
);

flow(
  "shows the reserved step id, unknown reference root and newer format messages on a real repo's template",
  async ({ page, tmp, home }) => {
    const repo = join(tmp, "billing-api");
    mkdirSync(join(repo, ".tokama", "templates"), { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    const dir = join(repo, ".tokama", "templates");
    writeFileSync(join(dir, "reserved.yaml"), "format: 1\nname: Reserved\nsteps:\n  - id: inputs\n    name: Fix\n    agent: builder\n    instructions: Fix {{ item.title }}.\nfinish: [findings]\n");
    writeFileSync(join(dir, "newer.yaml"), "format: 2\nname: Newer\n");
    writeFileSync(join(home, ".tokama", "repos.yaml"), `format: 1\nrepos:\n  - id: billing-api\n    path: ${realpathSync(repo)}\n    base_branch: main\n    checks: []\n`);

    await page.getByRole("button", { name: /^Settings(?: · \d+\+? diagnostics waiting)?$/ }).click();
    await page.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: "Templates" }).click();
    const list = page.getByRole("list", { name: "Template files" });
    const detail = page.locator("main.tp-detail");
    await list.getByRole("button", { name: /reserved\.yaml/ }).click();
    await detail.getByRole("heading", { name: /^✕ \d+ problems?$/ }).waitFor();
    const problems = await detail.locator(".tp-problems").textContent();
    expect(problems).toContain('"inputs" is a reserved name; pick another step id.');
    expect(problems).toContain('Step "inputs" uses {{ item... }} in its instructions, but "item" is not a step in this template.');
    await list.getByRole("button", { name: /newer\.yaml/ }).click();
    await detail.getByRole("heading", { name: "✕ 1 problem" }).waitFor();
    expect(await detail.locator(".tp-problems").textContent()).toContain("This template needs a newer Tokama (format 2). Update Tokama to use it.");
  },
  "real",
);
