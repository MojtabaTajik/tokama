// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_DESKTOP_STATE } from "../../shared/desktop-state.js";
import type { UpdateState } from "../../shared/update.js";
import { App } from "../App.js";
import { CONNECTED, fakeBridge } from "../testing/bridge.js";
import { items, NOW } from "../testing/sample.js";

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

const READY: UpdateState = { status: "ready", version: "0.2.0" };
const idle = items.filter((item) => item.state !== "running");
const $ = (selector: string) => container.querySelector<HTMLElement>(selector);
const click = (el: Element) => act(async () => (el as HTMLElement).click());
const COLLAPSED = { ...DEFAULT_DESKTOP_STATE, sidebar: { ...DEFAULT_DESKTOP_STATE.sidebar, collapsed: true } };

async function start(options: Parameters<typeof fakeBridge>[1] = {}, initial = DEFAULT_DESKTOP_STATE) {
  const fake = fakeBridge(CONNECTED, options);
  await act(async () => root.render(<App bridge={fake.bridge} retryDelayMs={10} now={NOW} initial={initial} />));
  return fake;
}

describe("App: ready update", () => {
  it("shows no chip while there is no ready update, and the chip at the foot of the sidebar once there is", async () => {
    const { setUpdate } = await start();
    expect($(".up-chip")).toBeNull();
    await setUpdate(READY);
    expect($(".panel .sb-foot .up-chip")?.textContent).toBe("Update");
    await setUpdate({ status: "idle" });
    expect($(".up-chip")).toBeNull();
  });

  it("opens the panel, and does not restart, when the chip is clicked with items running", async () => {
    const { setUpdate, installUpdate } = await start();
    await setUpdate(READY);
    await click($(".up-chip")!);
    expect(installUpdate).not.toHaveBeenCalled();
    const panel = $('[role="dialog"]')!;
    expect(panel.textContent).toContain("3 items are running. Tokama updates when they finish and you restart.");
    expect(panel.textContent).toContain("Checkout p95 latency spike · ");
    expect(panel.querySelector('button[aria-disabled="true"]')?.textContent).toBe("Restart now");
    await click([...panel.querySelectorAll("button")].find((button) => button.textContent === "Restart later")!);
    expect($('[role="dialog"]')).toBeNull();
  });

  it("restarts at once, with no panel, when nothing runs", async () => {
    const { setUpdate, installUpdate } = await start({ boardItems: idle });
    await setUpdate(READY);
    await click($(".up-chip")!);
    expect(installUpdate).toHaveBeenCalledTimes(1);
    expect($('[role="dialog"]')).toBeNull();
  });

  it("opens the panel when the main process finds something running that the window did not see", async () => {
    const { setUpdate, installUpdate } = await start({ boardItems: idle, installUpdate: async () => ({ ok: false, reason: "busy", running: 1 }) });
    await setUpdate(READY);
    await click($(".up-chip")!);
    expect(installUpdate).toHaveBeenCalledTimes(1);
    const panel = $('[role="dialog"]')!;
    expect(panel.textContent).toContain("1 item is running. Tokama updates when it finishes and you restart.");
    expect(panel.textContent).not.toContain("Nothing is running");
    expect(panel.querySelector('button[aria-disabled="true"]')?.textContent).toBe("Restart now");
  });

  it("says it cannot tell what runs, with Restart now off, when the main process would not say", async () => {
    const { setUpdate, installUpdate } = await start({ boardItems: idle, installUpdate: async () => ({ ok: false, reason: "busy" }) });
    await setUpdate(READY);
    await click($(".up-chip")!);
    const panel = $('[role="dialog"]')!;
    expect(panel.textContent).toContain("Tokama can't tell what's running right now");
    expect(panel.textContent).not.toContain("Nothing is running");
    const restartNow = [...panel.querySelectorAll("button")].find((button) => button.textContent === "Restart now")!;
    expect(restartNow.getAttribute("aria-disabled")).toBe("true");
    await click(restartNow);
    expect(installUpdate).toHaveBeenCalledTimes(1);
    // Closing the panel lets the next click ask again.
    await click([...panel.querySelectorAll("button")].find((button) => button.textContent === "Restart later")!);
    await click($(".up-chip")!);
    expect(installUpdate).toHaveBeenCalledTimes(2);
  });

  it("becomes the status line while it restarts", async () => {
    const { setUpdate } = await start({ boardItems: idle });
    await setUpdate({ status: "installing", version: "0.2.0" });
    expect($('.sb-foot [role="status"]')?.textContent).toBe("●Restarting to update…");
  });

  it("shows the rail icon with the sidebar closed, and a click opens the sidebar and the panel when items run", async () => {
    const { setUpdate, installUpdate } = await start({}, COLLAPSED);
    await setUpdate(READY);
    expect($(".panel")).toBeNull();
    expect($(".up-rail-button")?.getAttribute("aria-label")).toBe("Update: Tokama 0.2.0 is ready. 3 items are running. Restart once they finish.");
    await click($(".up-rail-button")!);
    expect(installUpdate).not.toHaveBeenCalled();
    expect($(".panel")).not.toBeNull();
    expect($('[role="dialog"]')).not.toBeNull();
    expect($(".up-rail-button")).toBeNull();
  });
});

describe("App: About updates row", () => {
  const openAbout = () => click($('.rail-user[aria-label="About Tokama"]')!);
  const row = () => $(".about-update")?.textContent;

  it("shows no Updates section for a development build", async () => {
    const { setUpdate } = await start();
    await setUpdate({ status: "unavailable", reason: "development" });
    await openAbout();
    expect($("#about-updates")).toBeNull();
  });

  it("shows the state, runs Check now, and keeps Restart now off while items run", async () => {
    const { setUpdate, checkForUpdates } = await start();
    await openAbout();
    await setUpdate({ status: "idle", checkedAt: NOW - 60_000 });
    expect(row()).toContain("Up to date");
    expect(row()).toContain("Version 1.2.3 · checked today at 14:59");
    await click([...container.querySelectorAll(".about-update button")].find((button) => button.textContent === "Check now")!);
    expect(checkForUpdates).toHaveBeenCalledTimes(1);
    await setUpdate(READY);
    expect(row()).toContain("0.2.0 is ready");
    expect(row()).toContain("3 items are running. Restart once they finish. Tokama never restarts by itself.");
    const restart = $(".about-update button")!;
    expect(restart.getAttribute("aria-disabled")).toBe("true");
  });

  it("shows that it cannot tell what runs, with Restart now off, when the main process refused the restart without a count", async () => {
    const { setUpdate, installUpdate } = await start({ boardItems: idle, installUpdate: async () => ({ ok: false, reason: "busy" }) });
    await openAbout();
    await setUpdate(READY);
    const restart = () => $(".about-update button")!;
    expect(restart().getAttribute("aria-disabled")).toBeNull();
    await click(restart());
    expect(installUpdate).toHaveBeenCalledTimes(1);
    expect($(".about-update")?.textContent).toContain("Tokama can't tell what's running right now");
    expect(restart().getAttribute("aria-disabled")).toBe("true");
  });

  it("opens the notes from the What's new link while an update is ready, and shows no link when it is not", async () => {
    const { setUpdate, openUpdateNotes } = await start();
    await openAbout();
    await setUpdate({ status: "idle", checkedAt: NOW });
    const notes = () => $("#about-updates")?.parentElement?.querySelector<HTMLElement>(".about-action") ?? null;
    expect(notes()).toBeNull();
    await setUpdate(READY);
    const link = notes()!;
    expect(link.textContent).toBe("What's new in 0.2.0");
    await click(link);
    expect(openUpdateNotes).toHaveBeenCalledTimes(1);
  });

  it("restarts from the row when nothing runs", async () => {
    const { setUpdate, installUpdate } = await start({ boardItems: idle });
    await openAbout();
    await setUpdate(READY);
    await click($(".about-update button")!);
    expect(installUpdate).toHaveBeenCalledTimes(1);
  });

  it("tries again after a failed check", async () => {
    const { setUpdate, checkForUpdates } = await start();
    await openAbout();
    await setUpdate({ status: "error", stage: "check", at: NOW });
    expect(row()).toContain("Couldn’t check for updates");
    await click($(".about-update button")!);
    expect(checkForUpdates).toHaveBeenCalledTimes(1);
  });
});
