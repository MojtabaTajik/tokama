// Settings > AI CLIs in the real app on the sample engine: the sample setup says Claude Code is
// installed and logged in, the arguments come from the adapter. The page is read-only. Whether the
// `claude` file is found depends on this machine, so only the stable parts are checked.
// Screenshots go to `<outDir>/screenshots`.
import { expect } from "vitest";
import { flow } from "./harness.js";

flow("shows Claude Code's launch settings from the engine, and Codex as not supported yet", async ({ page, resize, screenshot }) => {
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "AI CLIs" }).click();
  const rows = page.locator(".ai-clis-list .ai-cli-row");
  await rows.first().waitFor();
  expect(await rows.locator(".ai-cli-row-name").allInnerTexts()).toEqual(["Claude Code", "Codex CLI"]);

  const detail = page.locator(".ai-cli-detail");
  expect(await detail.getByRole("heading", { name: "Claude Code", level: 2 }).count()).toBe(1);
  const text = await detail.innerText();
  expect(text).toContain("Logged in");
  expect(text).toContain("2.1.331");
  expect(text).toContain("-p --input-format=stream-json --output-format=stream-json --verbose");
  expect(text).toContain("--model={model}");
  expect(text).toContain("--permission-mode=dontAsk");
  expect(text).toContain("Step prompt: stdin");
  expect(text).toContain("Agent role: argument --append-system-prompt={role}");
  expect(text).not.toMatch(/skip-permissions|bypassPermissions/i);
  const names = await detail.locator(".ai-cli-env li").allInnerTexts();
  expect(names).toContain("PATH");
  expect(names.every((name) => /^[A-Z_]+$/.test(name))).toBe(true);
  await screenshot("11-ai-clis");

  await rows.filter({ hasText: "Codex" }).click();
  await detail.getByText("Tokama cannot run this CLI yet.").waitFor();
  await screenshot("11-ai-clis-codex");
  // The macOS CI screen: narrower, and the three panes still fit.
  await rows.filter({ hasText: "Claude" }).click();
  await resize(1024, 642);
  await screenshot("11-ai-clis-1024");
  await resize(1200, 800);

  expect(await page.locator(".ai-clis input:not([aria-label='Filter CLIs']), .ai-clis textarea, .ai-clis select, .ai-clis [role='switch']").count()).toBe(0);
  await page.getByRole("button", { name: "← Back" }).click();
  await page.locator(".settings").waitFor({ state: "detached" });
});
