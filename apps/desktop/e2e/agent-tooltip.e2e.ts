// The working agent's badge on list rows, the agent label in the drawer, and the tooltip of both on
// hover and on keyboard focus. Against the sample engine, where "Paginate the orders list" runs its
// Build step on a repo agent with more power than the built-ins.
// Screenshots go to the e2e output folder like the other flows'.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator } from "playwright-core";
import { expect } from "vitest";
import { drawer, flow, openRow } from "./harness.js";

const TITLE = "Paginate the orders list";
/** --warn in theme.css. */
const AMBER = "rgb(217, 169, 58)";

/** The text of an element on one line: boxes that sit side by side read as separate lines. */
const flat = (text: Promise<string>): Promise<string> => text.then((value) => value.replace(/\s+/g, " ").trim());

flow("shows the agent and the step in words on a row, and opens the agent tooltip from the badge on hover with no blink", async ({ page, screenshot }) => {
  const wrap = page.locator(".pl-row-wrap", { has: page.locator(".pl-title", { hasText: TITLE }) });
  await wrap.waitFor();
  // Line two says the step, its attempt and the agent in words; the badge is named for who works on what.
  await expect.poll(() => flat(wrap.locator(".pl-meta").innerText()), { message: "line two" }).toMatch(/Build, step 2 of \d · \d+ m(?: \d\d s)? · Orders builder$/);
  await expect.poll(() => wrap.locator(".ag-badge").getAttribute("aria-label")).toMatch(/^Agent Orders builder, running Build/);
  // The row's click cover must not hide the badge and the time from the pointer: the badge opens its tooltip, the time shows its title.
  // A small window (the macOS runner's is 1024 x 674) puts the row below the fold, and a point outside the
  // viewport hits nothing, so the row is scrolled into view first.
  await wrap.scrollIntoViewIfNeeded();
  for (const part of [".pl-time", ".ag-badge"]) {
    const hit = await wrap.locator(part).first().evaluate((el) => {
      const box = el.getBoundingClientRect();
      const top = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return top !== null && el.contains(top);
    });
    expect(hit, `${part} takes the pointer`).toBe(true);
  }
  await screenshot("12-agent-row");

  const label = wrap.locator(".ag-badge");
  await label.hover();
  const tip = page.locator('[role="tooltip"]');
  await tip.waitFor({ state: "visible" });
  await expect.poll(() => flat(tip.locator(".al-owner").innerText())).toBe("repo orders-api");
  await expect.poll(() => flat(tip.locator(".al-run").innerText())).toBe("Claude Code qwen3-coder:30b");
  await expect.poll(() => tip.locator(".al-role").innerText()).toBe("“You change orders-api and keep its migrations reversible.”");
  // Extra commands and web access of a repo agent: amber, with the icon and the words.
  const amber = tip.locator(".al-can[data-extra]");
  expect((await amber.allInnerTexts()).map((text) => text.replace(/\s+/g, " "))).toEqual(["runs: pnpm test, pnpm db:migrate, docker compose up", "web: on"]);
  for (const part of await amber.all()) {
    expect(await part.evaluate((el) => getComputedStyle(el).color)).toBe(AMBER);
    expect(await part.locator("svg").count()).toBe(1);
  }
  // It sits fully inside the window: no list or drawer clips it.
  const box = (await tip.boundingBox())!;
  const view = page.viewportSize() ?? (await page.evaluate(() => ({ width: innerWidth, height: innerHeight })));
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(view.width);
  expect(box.y + box.height).toBeLessThanOrEqual(view.height);
  await screenshot("13-agent-tooltip-hover");

  // The pointer rests on the label, then crosses to the tooltip: it stays shown the whole time.
  const shown: boolean[] = [];
  for (let i = 0; i < 10; i++) {
    shown.push(await tip.isVisible());
    await page.waitForTimeout(40);
  }
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
  for (let i = 0; i < 10; i++) {
    shown.push(await tip.isVisible());
    await page.waitForTimeout(40);
  }
  expect(shown.every(Boolean)).toBe(true);

  // Escape closes it; a click on the label does not open the item.
  await page.keyboard.press("Escape");
  await tip.waitFor({ state: "detached" });
  await label.click();
  expect(await drawer(page).count()).toBe(0);
  expect(await page.locator('.pl-row[aria-current="true"]').count()).toBe(0);
  await page.mouse.move(0, 0);
});

flow("opens the agent tooltip on keyboard focus, reaches its link with Tab, and closes it with Escape", async ({ page, screenshot }) => {
  const wrap = page.locator(".pl-row-wrap", { has: page.locator(".pl-title", { hasText: TITLE }) });
  await wrap.waitFor();
  const tip = page.locator('[role="tooltip"]');
  await wrap.locator(".ag-badge").focus();
  await tip.waitFor({ state: "visible" });
  await screenshot("14-agent-tooltip-focus");
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => document.activeElement?.classList.contains("al-open"))).toBe(true);
  expect(await tip.isVisible()).toBe(true);
  await page.keyboard.press("Escape");
  await tip.waitFor({ state: "detached" });
  expect(await page.evaluate(() => document.activeElement?.className)).toContain("ag-badge");
  // The item did not open, and a second Escape does nothing to the list.
  expect(await drawer(page).count()).toBe(0);
});

flow("shows the agent tooltip in the drawer, closes only it on Escape, and opens the agent in Settings", async ({ page, screenshot }) => {
  await openRow(page, TITLE);
  const panel = drawer(page);
  const labels = panel.locator(".step-where .al-button");
  await expect.poll(() => labels.allInnerTexts().then((texts) => texts.map((text) => text.replace(/\s+/g, " ")))).toEqual(["Architect · opus", "Orders builder · qwen3-coder:30b", "Reviewer · gpt-5-codex"]);
  await labels.nth(1).hover();
  const tip = page.locator('[role="tooltip"]');
  await tip.waitFor({ state: "visible" });
  await expect.poll(() => flat(tip.locator(".al-owner").innerText())).toBe("repo orders-api");
  await screenshot("15-agent-tooltip-drawer");

  await page.keyboard.press("Escape");
  await tip.waitFor({ state: "detached" });
  expect(await panel.count()).toBe(1);

  await labels.nth(1).focus();
  await tip.waitFor({ state: "visible" });
  await tip.getByRole("button", { name: "Open in Settings →" }).click();
  await page.locator('nav[aria-label="Settings"] [aria-current="page"]').waitFor();
  expect(await page.locator('nav[aria-label="Settings"] [aria-current="page"]').innerText()).toBe("Agents");
});

/** The sidebar at its widest and the drawer at its narrowest, written before the app starts. */
const seedNarrow = (home: string): void => {
  mkdirSync(join(home, ".tokama"), { recursive: true });
  writeFileSync(
    join(home, ".tokama", "desktop.json"),
    JSON.stringify({
      sidebar: { width: 360, collapsed: false },
      drawer: { width: 340 },
    }),
  );
};
/** The widest window a CI display has: with the sidebar and the drawer open, 520 px are left for the list. */
const NARROW_WINDOW = 1280;

interface LabelShape {
  readonly name: string;
  readonly nameCut: boolean;
  readonly nameWidth: number;
  /** The name sits on the label's first line, fully inside the label. */
  readonly nameInside: boolean;
  /** "whole" inside the label, "hidden" wrapped out of it, "cut" anywhere between, "none" without a model. */
  readonly model: "whole" | "hidden" | "cut" | "none";
}

/** How a label shows its parts: the name, whether it is cut, and whether the model is whole, hidden or (wrongly) cut. */
const shapeOf = (label: Locator): Promise<LabelShape> =>
  label.evaluate((button) => {
    const box = button.getBoundingClientRect();
    const name = button.querySelector(".ellipsis") as HTMLElement;
    const model = button.querySelector(".al-model");
    const nameBox = name.getBoundingClientRect();
    const at = model?.getBoundingClientRect();
    const state = at === undefined ? "none" : at.top >= box.bottom - 1 ? "hidden" : at.right <= box.right + 0.5 && at.left >= box.left ? "whole" : "cut";
    return {
      name: name.textContent ?? "",
      nameCut: name.scrollWidth > name.clientWidth,
      nameWidth: name.clientWidth,
      nameInside: nameBox.top >= box.top - 0.5 && nameBox.bottom <= box.bottom + 0.5,
      model: state,
    };
  });

/** Two boxes that share some area. */
const overlap = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): boolean =>
  a.x < b.x + b.width - 0.5 && b.x < a.x + a.width - 0.5 && a.y < b.y + b.height - 0.5 && b.y < a.y + a.height - 0.5;

flow(
  "keeps the agent names whole in a drawer at its narrowest and puts the text after them under them",
  async ({ page, resize, screenshot }) => {
    await resize(NARROW_WINDOW, 900);
    await openRow(page, TITLE);
    const panel = drawer(page);
    expect(Math.round((await panel.boundingBox())!.width)).toBe(340);
    const steps = panel.locator(".step-where", {
      has: page.locator(".al-button"),
    });
    await expect.poll(() => steps.count()).toBe(3);
    for (const step of await steps.all()) {
      const label = step.locator(".al-button");
      const shape = await shapeOf(label);
      expect(shape.nameCut, `${shape.name} is not cut`).toBe(false);
      expect(shape.nameInside, `${shape.name} sits on the label's line`).toBe(true);
      expect(shape.model, `${shape.name}: the model is whole`).toBe("whole");
      // The text after the label never sits on the label, wrapped or not.
      const data = (await step.locator(":scope > span").last().boundingBox())!;
      expect(overlap((await label.boundingBox())!, data)).toBe(false);
      expect(await step.locator(":scope > span").last().innerText()).toMatch(/^· (local|cloud)/);
    }
    await screenshot("16-agent-drawer-narrow");
    // The dotted underline still marks the target, and the tooltip still opens.
    const first = steps.first().locator(".al-button");
    expect(await first.evaluate((el) => getComputedStyle(el).textDecorationLine)).toBe("underline");
    await first.hover();
    await page.locator('[role="tooltip"]').waitFor({ state: "visible" });
  },
  "sample",
  seedNarrow,
);

flow(
  "keeps the badge whole in a narrow list, clear of the title and the time, and shows the model it does not print in its tooltip",
  async ({ page, resize, screenshot }) => {
    await resize(NARROW_WINDOW, 900);
    const wrap = page.locator(".pl-row-wrap", {
      has: page.locator(".pl-title", { hasText: TITLE }),
    });
    await wrap.waitFor();
    // The drawer is closed: the list has the whole main area minus the sidebar. Open it to narrow the list to its minimum.
    await openRow(page, TITLE);
    for (const row of await page.locator(".pl-row-wrap").all()) {
      const badge = row.locator(".ag-badge");
      if ((await badge.count()) === 0) continue;
      const box = (await badge.boundingBox())!;
      expect(Math.round(box.width), "the badge is a round 18 px").toBe(18);
      expect(Math.round(box.height)).toBe(18);
      // It sits in the mark's cell, clear of the title, the line under it and the time.
      for (const other of [".pl-title", ".pl-meta", ".pl-time"]) {
        const part = await row.locator(other).first().boundingBox();
        if (part !== null) expect(overlap(box, part), `the badge does not overlap ${other}`).toBe(false);
      }
    }
    await screenshot("17-agent-list-narrow");
    // The badge may sit below the fold: scroll it into view with the pointer out of the list, so
    // no other row's badge passes under the pointer and opens its own tooltip.
    const badge = wrap.locator(".ag-badge");
    await page.mouse.move(0, 0);
    await badge.scrollIntoViewIfNeeded();
    await badge.hover();
    const tip = page.locator('[role="tooltip"]');
    await tip.waitFor({ state: "visible" });
    await expect.poll(() => flat(tip.locator(".al-run").innerText())).toBe("Claude Code qwen3-coder:30b");
  },
  "sample",
  seedNarrow,
);

flow("shows the tool's official icon beside the agent's name in the drawer, loaded from the built app", async ({ page, screenshot }) => {
  await openRow(page, TITLE);
  const icon = drawer(page).getByRole("img", { name: "Claude Code" }).first();
  await icon.waitFor();
  // A blocked or missing file would leave a broken image with no width.
  await expect.poll(() => icon.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  expect(await drawer(page).locator(".step-where").nth(1).innerText()).toContain("Orders builder");
  await screenshot("12-agent-row-icon");

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "AI CLIs" }).click();
  const codex = page.locator(".ai-clis-list .ai-cli-row", { hasText: "Codex" });
  // The row prints the name, so its mark carries no name of its own.
  const mark = codex.locator("img.backend-mark");
  await mark.waitFor();
  await expect.poll(() => mark.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
});
