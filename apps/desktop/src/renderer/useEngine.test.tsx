// @vitest-environment happy-dom
import type { ItemRecord } from "@tokama/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isOpen } from "./model.js";
import { CONNECTED, fakeBridge } from "./testing/bridge.js";
import { items } from "./testing/sample.js";
import { COUNTS_DELAY_MS, type EngineView, useEngine } from "./useEngine.js";

let container: HTMLDivElement;
let root: Root;
let view: EngineView | undefined;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  view = undefined;
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function Probe({ bridge }: { readonly bridge: Parameters<typeof useEngine>[0] }) {
  view = useEngine(bridge, 10);
  return null;
}

const wait = (ms: number) => act(async () => new Promise((resolve) => setTimeout(resolve, ms)));
const boardQueries = (fake: ReturnType<typeof fakeBridge>) => fake.query.mock.calls.filter(([q]) => q.type === "board").length;
const finished = () => view?.data?.counts.reduce((sum, row) => sum + row.done + row.failed, 0);
const id = (n: number) => `item_00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("useEngine", () => {
  it("holds only the open items, and counts the finished ones from the board", async () => {
    const fake = fakeBridge(CONNECTED);
    await act(async () => root.render(<Probe bridge={fake.bridge} />));
    expect([...(view?.data?.items.values() ?? [])].every(isOpen)).toBe(true);
    expect(view?.data?.items.size).toBe(items.filter(isOpen).length);
    expect(finished()).toBe(items.filter((item) => !isOpen(item)).length);
  });

  it("drops each item that finishes, so thousands of finished items leave the items as small as before, and loads the board once for the counts", async () => {
    const fake = fakeBridge(CONNECTED);
    await act(async () => root.render(<Probe bridge={fake.bridge} />));
    const open = view?.data?.items.size ?? 0;
    const before = finished() ?? 0;
    expect(boardQueries(fake)).toBe(1);

    const template = items.find((item) => item.state === "queued")!;
    for (let n = 1; n <= 2000; n++) {
      const item = { ...template, id: id(n), title: `Item ${n}` } as ItemRecord;
      await fake.pushItem(item);
      await fake.pushItem({ ...item, state: n % 4 === 0 ? "failed" : "done" } as ItemRecord);
    }
    expect(view?.data?.items.size).toBe(open);
    // The finished events came in one burst: the board loads once after it, with the counts.
    await wait(COUNTS_DELAY_MS + 20);
    expect(boardQueries(fake)).toBe(2);
    expect(finished()).toBe(before + 2000);
    expect(view?.data?.items.size).toBe(open);
  });

  it("with 5,000 items on the engine, holds only the open ones and counts the rest, from one board query", async () => {
    const template = items.find((item) => item.state === "queued")!;
    const seeded = Array.from({ length: 5000 }, (_, index) => ({ ...template, id: id(index + 1), title: `Item ${index + 1}`, state: index < 30 ? "running" : index % 4 === 0 ? "failed" : "done" }) as ItemRecord);
    const fake = fakeBridge(CONNECTED, { boardItems: seeded });
    await act(async () => root.render(<Probe bridge={fake.bridge} />));
    expect(view?.data?.items.size).toBe(30);
    expect(finished()).toBe(4970);
    expect(boardQueries(fake)).toBe(1);
  });

  it("keeps an item that finishes while the board loads out of the items", async () => {
    const fake = fakeBridge(CONNECTED);
    let release: (() => void) | undefined;
    const answer = fake.query.getMockImplementation()!;
    let gated = true;
    fake.query.mockImplementation(async (q) => {
      // The engine answers with the board as it was before the item finished.
      const reply = await answer(q);
      if (q.type === "board" && gated) await new Promise<void>((resolve) => (release = resolve));
      return reply;
    });
    await act(async () => root.render(<Probe bridge={fake.bridge} />));
    const running = items.find((item) => item.state === "running")!;
    await fake.pushItem({ ...running, state: "done" } as ItemRecord);
    gated = false;
    await act(async () => release?.());
    expect(view?.data?.items.has(running.id)).toBe(false);
  });
});
