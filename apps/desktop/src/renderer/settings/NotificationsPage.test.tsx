// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, type Mock } from "vitest";
import type { TokamaBridge } from "../../shared/bridge.js";
import { DEFAULT_DESKTOP_STATE, type DesktopState } from "../../shared/desktop-state.js";
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

const $ = (selector: string) => container.querySelector(selector);
const $$ = (selector: string) => [...container.querySelectorAll(selector)];
const click = (el: Element | null | undefined) => act(async () => (el as HTMLElement).click());
const railButton = (label: RegExp) => $$(".rail button").find((button) => label.test(button.getAttribute("aria-label") ?? ""))!;
const withNotifications = (notifications: Partial<DesktopState["notifications"]>): DesktopState => ({ ...DEFAULT_DESKTOP_STATE, notifications: { ...DEFAULT_DESKTOP_STATE.notifications, ...notifications } });

async function openPage(bridge: TokamaBridge) {
  await act(async () => root.render(<App bridge={bridge} retryDelayMs={10} now={NOW} />));
  await click(railButton(/^Settings/));
  await click($$('nav[aria-label="Settings"] button').find((el) => el.textContent === "Notifications"));
}
const switches = () => $$('[role="switch"]');
const states = () => switches().map((el) => [el.getAttribute("aria-checked"), el.textContent]);
const previews = () => $$(".notes-slot").map((el) => el.textContent);

describe("Settings > Notifications", () => {
  it("is the first page under Personal, and shows the board's texts and the four switches with their defaults", async () => {
    await openPage(fakeBridge(CONNECTED).bridge);
    expect($('nav[aria-label="Settings"] [aria-current="page"]')?.textContent).toBe("Notifications");
    expect($("h1")?.textContent).toBe("Notifications");
    expect($(".notes-intro")?.textContent).toBe("macOS notifications about your items. Click one to open its item in Tokama.");
    expect($$(".notes-name").map((el) => el.textContent)).toEqual(["⏸Needs you", "✓Finished", "✕Failed", "♪Sound"]);
    expect($$(".notes-help").map((el) => el.textContent)).toEqual([
      "An item waits for your decision, like approving a plan or a change.",
      "An item is done and ready to merge, open a PR or discard.",
      "An item stopped because a step failed.",
      "Play the macOS notification sound with each one.",
    ]);
    expect(states()).toEqual([["true", "On"], ["true", "On"], ["true", "On"], ["false", "Off"]]);
    expect(switches().map((el) => el.getAttribute("aria-labelledby"))).toEqual(["notes-needsYou", "notes-finished", "notes-failed", "notes-sound"]);
    expect($(".notes-info")?.textContent).toBe("iNo notification while you are looking at that item: Tokama is in front and the item is open in the drawer or the full view.");
    expect($(".notes-preview-hint")?.textContent).toBe("How each one looks in the top-right corner of the screen. Plain text, no formatting.");
  });

  it("previews the three notifications, and the sound note", async () => {
    await openPage(fakeBridge(CONNECTED).bridge);
    expect(previews()).toEqual([
      "Needs you: Add order export endpointnowThe plan is ready. Approve it to start Build.Plan and build · orders-api",
      "Finished: Fix the null check in cart totalsnowDone in 9 min. Ready to merge or open a PR.Quick fix · checkout-web",
      "Failed: Upgrade the Postgres drivernowBuild failed 3 times: pnpm test, 4 failing.Plan and build · orders-api",
    ]);
    expect($(".notes-sound-note")?.textContent).toBe("Silent. Sound is off.");
    expect($(".notes-card")?.getAttribute("aria-label")).toBe("Notification preview. Needs you: Add order export endpoint. The plan is ready. Approve it to start Build.");
    expect($(".notes-icon")?.getAttribute("src")).toBeTruthy();
  });

  it("flips a switch, says On or Off in words, saves it, and turns a preview into its off line", async () => {
    const fake = fakeBridge(CONNECTED);
    await openPage(fake.bridge);
    await click(switches()[1]);
    expect(states()[1]).toEqual(["false", "Off"]);
    expect(fake.saveNotifications).toHaveBeenLastCalledWith({ finished: false });
    expect(previews()[1]).toBe("Finished is off, so this one never shows.");
    expect($$(".notes-card")).toHaveLength(2);
    await click(switches()[3]);
    expect(fake.saveNotifications).toHaveBeenLastCalledWith({ sound: true });
    expect($(".notes-sound-note")?.textContent).toBe("♪ Plays the macOS notification sound.");
    await click(switches()[1]);
    expect(fake.saveNotifications).toHaveBeenLastCalledWith({ finished: true });
    expect(previews()[1]).toContain("Done in 9 min");
  });

  it("shows the saved switches, not the defaults", async () => {
    await openPage(fakeBridge(CONNECTED, { desktopState: withNotifications({ needsYou: false, sound: true }) }).bridge);
    expect(states()).toEqual([["false", "Off"], ["true", "On"], ["true", "On"], ["true", "On"]]);
    expect(previews()[0]).toBe("Needs you is off, so this one never shows.");
  });

  it("keeps the switches working when saving fails or the saved state cannot be read", async () => {
    const fake = fakeBridge(CONNECTED);
    fake.saveNotifications.mockRejectedValue(new Error("disk full"));
    await openPage(fake.bridge);
    await click(switches()[2]);
    expect(states()[2]).toEqual(["false", "Off"]);
    const broken = fakeBridge(CONNECTED);
    (broken.bridge.getDesktopState as unknown as Mock).mockRejectedValue(new Error("no"));
    await act(async () => root.unmount());
    root = createRoot(container);
    await openPage(broken.bridge);
    expect(states()).toEqual([["true", "On"], ["true", "On"], ["true", "On"], ["false", "Off"]]);
  });
});

describe("notifications in the app", () => {
  const needsYou = items.find((item) => item.state === "needs_you")!;
  const render = (bridge: TokamaBridge) => act(async () => root.render(<App bridge={bridge} retryDelayMs={10} now={NOW} />));

  it("tells the main process which item the drawer shows, and none when it closes or Settings opens", async () => {
    const fake = fakeBridge(CONNECTED);
    await render(fake.bridge);
    expect(fake.setViewedItem).toHaveBeenLastCalledWith(undefined);
    await click($$(".pl-row").find((row) => row.textContent?.includes(needsYou.title)));
    expect(fake.setViewedItem).toHaveBeenLastCalledWith(needsYou.id);
    await click(railButton(/^Settings/));
    expect(fake.setViewedItem).toHaveBeenLastCalledWith(undefined);
  });

  it("opens the item a clicked notification names, also from Settings", async () => {
    const fake = fakeBridge(CONNECTED);
    await render(fake.bridge);
    await click(railButton(/^Settings/));
    expect($(".settings")).not.toBeNull();
    await fake.openItem(needsYou.id);
    expect($(".settings")).toBeNull();
    expect($(".drawer h2, .drawer h1")?.textContent).toContain(needsYou.title);
    expect(fake.setViewedItem).toHaveBeenLastCalledWith(needsYou.id);
  });

  it("stays on the Needs you page when a notification opens an item", async () => {
    const fake = fakeBridge(CONNECTED);
    await render(fake.bridge);
    await click(railButton(/^Needs you/));
    await fake.openItem(needsYou.id);
    expect($(".drawer")).not.toBeNull();
    expect($("h1")?.textContent).toContain("Needs you");
  });
});
