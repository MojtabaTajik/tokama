// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TokamaBridge } from "../../shared/bridge.js";
import { CONNECTED, fakeBridge } from "../testing/bridge.js";
import { usageReport } from "../testing/usage.js";
import { type UsageView, useUsage } from "./useUsage.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(() => act(() => root.unmount()));

const REFRESH_MS = 20;
const wait = (ms: number) => act(async () => new Promise((resolve) => setTimeout(resolve, ms)));
let view: UsageView | undefined;
function Probe({ bridge, live }: { readonly bridge: TokamaBridge; readonly live: boolean }) {
  view = useUsage(bridge, CONNECTED, 14, live, REFRESH_MS);
  return null;
}

function setup() {
  const fake = fakeBridge(CONNECTED, { reply: (q) => (q.type === "usage" ? { ok: true, data: usageReport } : undefined) });
  const usageQueries = () => fake.query.mock.calls.filter(([q]) => q.type === "usage").length;
  const render = (live: boolean) => act(async () => root.render(<Probe bridge={fake.bridge} live={live} />));
  return { fake, usageQueries, render };
}

describe("useUsage", () => {
  it("loads once and then only on usage_changed or refresh while nobody looks at it", async () => {
    const { fake, usageQueries, render } = setup();
    await render(false);
    expect(usageQueries()).toBe(1);
    expect(view?.report).toEqual(usageReport);
    await wait(REFRESH_MS * 4);
    expect(usageQueries()).toBe(1);
    await fake.pushEvent({ type: "usage_changed" });
    expect(usageQueries()).toBe(2);
    await act(async () => view?.refresh());
    expect(usageQueries()).toBe(3);
  });

  it("loads every interval while live, and stops when it is no longer", async () => {
    const { usageQueries, render } = setup();
    await render(true);
    // One wait per tick: ticks inside one act() batch into one render.
    for (let tick = 0; tick < 3; tick++) await wait(REFRESH_MS * 1.5);
    const whileLive = usageQueries();
    expect(whileLive).toBeGreaterThanOrEqual(3);
    await render(false);
    await wait(REFRESH_MS * 4);
    expect(usageQueries()).toBe(whileLive);
  });
});
