// The Templates page in Settings, on the sample engine: the list with each file's state, a valid
// template in plain words with its flow, and a broken one whose problem lines open the file there.
// Driven by keyboard where a user would, so the page stays reachable without a mouse.
import { expect } from "vitest";
import { flow } from "./harness.js";

flow("shows templates with their flow, steps and problems in Settings", async ({ page, screenshot }) => {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const list = page.getByRole("list", { name: "Template files" });
  await list.getByRole("button", { name: /Plan and build/ }).waitFor();
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
