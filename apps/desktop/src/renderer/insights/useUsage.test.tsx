// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TokamaBridge } from "../../shared/bridge.js";
import { CONNECTED, fakeBridge } from "../testing/bridge.js";
import type { UsageReport, UsageScope } from "@tokama/core";
import { allReport, usageReport } from "../testing/usage.js";
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
function Probe({ bridge, live, scope }: { readonly bridge: TokamaBridge; readonly live: boolean; readonly scope: UsageScope }) {
  view = useUsage(bridge, CONNECTED, 14, scope, live, REFRESH_MS);
  return null;
}

function setup(data: (scope: UsageScope | undefined) => UsageReport = () => usageReport) {
  const fake = fakeBridge(CONNECTED, { reply: (q) => (q.type === "usage" ? { ok: true, data: data((q as { scope?: UsageScope }).scope) } : undefined) });
  const usageQueries = () => fake.query.mock.calls.filter(([q]) => q.type === "usage").length;
  const render = (live: boolean, scope: UsageScope = "tokama") => act(async () => root.render(<Probe bridge={fake.bridge} live={live} scope={scope} />));
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

  it("asks for the scope shown, and again when it changes", async () => {
    const { fake, render } = setup((scope) => (scope === "all" ? allReport : usageReport));
    await render(false);
    await render(false, "all");
    expect(fake.query.mock.calls.filter(([q]) => q.type === "usage").map(([q]) => (q as { scope?: UsageScope }).scope)).toEqual(["tokama", "all"]);
    expect(view?.report?.scope).toBe("all");
  });

  it("loads again on each usage_changed the engine sends while it reads the logs", async () => {
    let scans = 1;
    const { fake, render } = setup(() => (scans-- > 0 ? ({ ...allReport, scan: { state: "scanning", filesDone: 1, filesTotal: 9 } } as UsageReport) : allReport));
    await render(false, "all");
    expect(view?.report?.scan?.state).toBe("scanning");
    await fake.pushEvent({ type: "usage_changed" });
    expect(view?.report?.scan?.state).toBe("ready");
  });
});
