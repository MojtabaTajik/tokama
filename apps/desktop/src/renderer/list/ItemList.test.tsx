// @vitest-environment happy-dom
import type { ItemRecord, Said } from "@tokama/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ITEMS, NOW, setup } from "../testing/sample.js";
import { ItemList } from "./ItemList.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const said = (headline: string, more: Partial<Said> = {}): Said => ({ source: "headline", headline, points: [], morePoints: 0, bodyBytes: 100, ...more });
/** A copy of the sample's done item whose first step's attempt said `said`. */
const withSaid = (said: Said | undefined, base: ItemRecord = ITEMS.done): ItemRecord => ({
  ...base,
  steps: base.steps.map((step, index) => (index === 0 ? { ...step, attempts: [{ attempt: 1, result: "passed", checks: [], ...(said !== undefined && { said }) }] } : step)),
});

const render = (items: ItemRecord[], name = "Done") =>
  act(async () => root.render(<ItemList groups={[{ key: "done", name, items }]} setup={setup} now={NOW} selectedItemId={undefined} onSelect={() => undefined} />));
const third = (row = 0) => container.querySelectorAll(".pl-row")[row]?.querySelector(".pl-said");

describe("a done row's third line", () => {
  it("is the headline the agent wrote, with no tag when it wrote no points", async () => {
    await render([withSaid(said("Fixed the null check in cart totals."))]);
    expect(third()?.querySelector(".pl-said-text")?.textContent).toBe("Fixed the null check in cart totals.");
    expect(third()?.querySelector(".pl-said-tag")).toBeNull();
  });

  it("says how many points follow, counting those only counted", async () => {
    await render([withSaid(said("Fixed it.", { points: ["a", "b", "c"], morePoints: 1 }))]);
    expect(third()?.querySelector(".pl-said-tag")?.textContent).toBe("+4 points");
  });

  it("tags a must-read with its read time, and never shortens its headline in the data", async () => {
    const long = "A design with three choices: " + "x".repeat(110);
    await render([withSaid(said(long, { readMinutes: 6, points: ["a"] }))]);
    expect(third()?.querySelector(".pl-said-tag")?.textContent).toBe("read · 6 min");
    expect(third()?.querySelector(".pl-said-text")?.textContent).toBe(long);
  });

  it("shows the first lines of a reply that had no headline, with no points tag", async () => {
    await render([withSaid(said("Added GET /orders/export.", { source: "first_lines", points: ["It streams CSV."] }))]);
    expect(third()?.querySelector(".pl-said-text")?.textContent).toBe("Added GET /orders/export.");
    expect(third()?.querySelector(".pl-said-tag")).toBeNull();
  });

  it("is absent when the agent said nothing, as for an item from before this existed; the facts stay", async () => {
    await render([withSaid(undefined)]);
    expect(third()).toBeNull();
    expect(container.querySelector(".pl-facts")?.textContent).toBe("no checks");
  });

  it("shows the agent's words as text, never as markup", async () => {
    await render([withSaid(said("<img src=x onerror=alert(1)> **bold**"))]);
    expect(container.querySelector(".pl-said img")).toBeNull();
    expect(third()?.querySelector(".pl-said-text")?.textContent).toBe("<img src=x onerror=alert(1)> **bold**");
  });

  it("is on a done row only: a failed row keeps its facts", async () => {
    await render([withSaid(said("Tried it."), { ...ITEMS.failed })], "Failed");
    expect(third()).toBeNull();
    expect(container.querySelector(".pl-facts")?.textContent).toBe("stopped at Fix, step 1 of 2");
  });
});
