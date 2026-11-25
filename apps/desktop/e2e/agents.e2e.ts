// Settings > Agents in the real app: the built-in agents, a personal agent and one that does not
// load, read from files in the test's `~/.tokama/agents`. The page is read-only. Screenshots go to
// `<outDir>/screenshots`.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import { flow } from "./harness.js";

const agentFile = (name: string, runsOn: string) => `---\nformat: 1\nname: ${name}\nruns_on: ${runsOn}\nmodel: sonnet\ntools: read-only\nicon: eye\n---\nYou are ${name}. Read the diff and say what is risky.\n`;

flow("lists the built-in and personal agents, and a file that does not load with its problem", async ({ page, home, resize, screenshot }) => {
  const agents = join(home, ".tokama", "agents");
  mkdirSync(agents, { recursive: true });
  writeFileSync(join(agents, "scribe.md"), agentFile("Scribe", "claude-code"));
  writeFileSync(join(agents, "triager.md"), agentFile("Triager", "claud-code"));

  await page.getByRole("button", { name: "Settings" }).click();
  const rows = page.locator(".agents-list .agent-row");
  await rows.first().waitFor();
  expect(await rows.locator(".agent-row-name").allInnerTexts()).toEqual(["Architect", "Builder", "Reviewer", "Scribe", "✕ brokentriager"]);
  expect(await rows.locator(".agent-row-line").allInnerTexts()).toEqual(["CC · opus · cloud", "CC · sonnet · cloud", "CC · opus · cloud", "CC · sonnet · cloud", "agents/triager.md"]);

  const detail = page.locator(".agent-detail");
  expect(await detail.getByRole("heading", { name: "Architect", level: 2 }).count()).toBe(1);
  expect(await detail.innerText()).toContain("builtin/architect.md");
  await screenshot("10-agents");

  await rows.filter({ hasText: "Scribe" }).click();
  expect(await detail.innerText()).toContain("agents/scribe.md");
  expect(await detail.innerText()).toContain("Read the diff and say what is risky.");

  await rows.filter({ hasText: "triager" }).click();
  await detail.getByText("This file does not load").waitFor();
  expect(await detail.locator(".agent-problems").innerText()).toContain("runs_on 'claud-code' isn't known. Did you mean claude-code?");
  await screenshot("10-agents-problem");
  // The macOS CI screen: narrower, and the three panes still fit.
  await resize(1024, 642);
  await screenshot("10-agents-problem-1024");
  await resize(1200, 800);

  expect(await page.locator(".agents input:not([aria-label='Filter agents']), .agents textarea, .agents select").count()).toBe(0);
  await page.getByRole("button", { name: "← Back" }).click();
  await page.locator(".settings").waitFor({ state: "detached" });
  await page.locator("nav.rail").waitFor();
});
