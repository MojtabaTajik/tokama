// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
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
  vi.useRealTimers();
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
const groups = () => $$('[role="radiogroup"]');
const checkedIn = (group: Element | undefined) => [...(group?.querySelectorAll('[role="radio"]') ?? [])].find((radio) => radio.getAttribute("aria-checked") === "true")?.textContent;
const checks = () => groups().map(checkedIn);
const option = (group: number, label: string) => [...groups()[group]!.querySelectorAll('[role="radio"]')].find((radio) => radio.textContent?.includes(label));
const previews = () => $$(".notes-slot").map((el) => el.textContent);
const playButton = (name: string) => $$("button").find((button) => button.getAttribute("aria-label") === `Play the ${name} sound`)!;

describe("Settings > Notifications", () => {
  it("is the first page under Personal, and shows the board's texts, a mode per kind and the sound set, with the new defaults", async () => {
    await openPage(fakeBridge(CONNECTED).bridge);
    expect($('nav[aria-label="Settings"] [aria-current="page"]')?.textContent).toBe("Notifications");
    expect($("h1")?.textContent).toBe("Notifications");
    expect($(".notes-intro")?.textContent).toBe("macOS notifications about your items. Click one to open its item in Tokama.");
    expect($$(".notes-name").map((el) => el.textContent)).toEqual(["⏸Needs you", "✓Finished", "✕Failed", "♪Sounds", "✉Test"]);
    expect($$(".notes-help").map((el) => el.textContent)).toEqual([
      "An item waits for your decision, like approving a plan or a change.",
      "An item is done and ready to merge, open a PR or discard.",
      "An item stopped because a step failed.",
      "Used by Banner + sound and Sound only. The ▶ buttons play it too, whatever a row is set to.",
      "Shows one banner and plays the Needs you sound, the way a real event does. A locked screen keeps the sound quiet. After you allow notifications in System Settings, send a test to check.",
    ]);
    expect(groups().map((group) => group.getAttribute("aria-labelledby"))).toEqual(["notes-needsYou", "notes-finished", "notes-failed", "notes-sounds"]);
    expect([...groups()[0]!.querySelectorAll('[role="radio"]')].map((radio) => radio.textContent?.replace("✓", ""))).toEqual(["Banner + sound", "Banner only", "Sound only", "Off"]);
    expect([...groups()[3]!.querySelectorAll('[role="radio"]')].map((radio) => radio.textContent?.replace("✓", ""))).toEqual(["Tokama sounds", "macOS default"]);
    expect(checks()).toEqual(["✓Banner + sound", "✓Banner only", "✓Banner + sound", "✓Tokama sounds"]);
    expect($$(".notes-info-text span").map((el) => el.textContent)).toEqual([
      "No notification while you are looking at that item: Tokama is in front and the item is open in the drawer or the full view.",
      "Sound only: macOS cannot play a sound without a banner, so Tokama plays it itself while the app is running. Sounds play even during Focus, but not while your Mac is locked. Choose Banner only for a row if that bothers you. The ▶ buttons always play.",
    ]);
    expect($(".notes-preview-hint")?.textContent).toBe("How each one looks in the top-right corner of the screen. Plain text, no formatting.");
  });

  it("previews a banner for the kinds that show one, a line for the sound-only kind, and the sound note", async () => {
    await openPage(fakeBridge(CONNECTED, { desktopState: withNotifications({ finished: "sound" }) }).bridge);
    expect(previews()).toEqual([
      "Needs you: Add order export endpointnowBuild it this way?Plan and build · orders-api",
      "Finished is sound only: no banner, the Tokama sound plays.",
      "Failed: Upgrade the Postgres drivernowStopped at Build, step 2 of 3: pnpm test failed 3 timesPlan and build · orders-api",
    ]);
    expect($(".notes-sound-note")?.textContent).toBe("♪ Plays the Tokama sound for 3 of 3 kinds.");
    expect($(".notes-card")?.getAttribute("aria-label")).toBe("Notification preview. Needs you: Add order export endpoint. Build it this way?");
    expect($(".notes-icon")?.getAttribute("src")).toBeTruthy();
  });

  it("saves a mode, changes the preview line, and keeps the sound note in step", async () => {
    const fake = fakeBridge(CONNECTED);
    await openPage(fake.bridge);
    await click(option(1, "Off"));
    expect(fake.saveNotifications).toHaveBeenLastCalledWith({ finished: "off" });
    expect(checkedIn(groups()[1])).toBe("✓Off");
    expect(previews()[1]).toBe("Finished is off, so this one never shows.");
    expect($(".notes-sound-note")?.textContent).toBe("♪ Plays the Tokama sound for 2 of 3 kinds.");
    await click(option(1, "Banner only"));
    expect(fake.saveNotifications).toHaveBeenLastCalledWith({ finished: "banner" });
    expect(previews()[1]).toContain("Done in 9 min · checks 3/3 passed. Ready to merge or open a PR.");
    expect($(".notes-sound-note")?.textContent).toBe("♪ Plays the Tokama sound for 2 of 3 kinds.");
    await click(option(0, "Off"));
    await click(option(2, "Banner only"));
    expect($(".notes-sound-note")?.textContent).toBe("Silent. No kind plays a sound.");
  });

  describe("the notification status and the test button", () => {
    const button = (label: string) => $$("button").find((candidate) => candidate.textContent === label);

    it("shows no warning while the system has not turned a notification down", async () => {
      await openPage(fakeBridge(CONNECTED).bridge);
      expect($(".notes-blocked")).toBeNull();
    });

    it("on macOS names the problem and opens the Notifications pane from a button", async () => {
      const fake = fakeBridge(CONNECTED);
      fake.notificationStatus.mockResolvedValue({ blocked: true, canOpenSettings: true });
      await openPage(fake.bridge);
      expect($(".notes-blocked-text")?.textContent).toBe("macOS is not showing Tokama's notifications.");
      await click(button("Open System Settings › Notifications"));
      expect(fake.bridge.openNotificationSettings).toHaveBeenCalledTimes(1);
    });

    it("elsewhere gives a short hint and no button", async () => {
      const fake = fakeBridge(CONNECTED);
      fake.notificationStatus.mockResolvedValue({ blocked: true, canOpenSettings: false });
      await openPage(fake.bridge);
      expect($(".notes-blocked-text")?.textContent).toBe("No notification service answered. Check that one is running.");
      expect($$(".notes-blocked button")).toHaveLength(0);
      expect($$(".notes-help").at(-1)?.textContent).not.toContain("System Settings");
    });

    it("sends a test notification, and asks the status again a moment later", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const fake = fakeBridge(CONNECTED);
      await openPage(fake.bridge);
      const asked = fake.notificationStatus.mock.calls.length;
      fake.notificationStatus.mockResolvedValue({ blocked: true, canOpenSettings: true });
      await click(button("Send a test notification"));
      expect(fake.sendTestNotification).toHaveBeenCalledTimes(1);
      expect($(".notes-blocked")).toBeNull();
      await act(async () => vi.advanceTimersByTimeAsync(1_100));
      expect(fake.notificationStatus.mock.calls.length).toBe(asked + 1);
      expect($(".notes-blocked")).not.toBeNull();
    });
  });

  it("saves the sound set and names it in the lines and the note", async () => {
    const fake = fakeBridge(CONNECTED, { desktopState: withNotifications({ finished: "sound" }) });
    await openPage(fake.bridge);
    await click(option(3, "macOS default"));
    expect(fake.saveNotifications).toHaveBeenLastCalledWith({ sounds: "macos" });
    expect(previews()[1]).toBe("Finished is sound only: no banner, the macOS default sound plays.");
    expect($(".notes-sound-note")?.textContent).toBe("♪ Plays the macOS default sound for 3 of 3 kinds.");
  });

  it("shows the saved choices, not the defaults", async () => {
    await openPage(fakeBridge(CONNECTED, { desktopState: withNotifications({ needsYou: "off", finished: "sound", sounds: "macos" }) }).bridge);
    expect(checks()).toEqual(["✓Off", "✓Sound only", "✓Banner + sound", "✓macOS default"]);
    expect(previews()[0]).toBe("Needs you is off, so this one never shows.");
  });

  it("plays a kind's sound with the chosen set, whatever its mode, and shows Playing for a moment", async () => {
    vi.useFakeTimers();
    const fake = fakeBridge(CONNECTED, { desktopState: withNotifications({ needsYou: "off" }) });
    await openPage(fake.bridge);
    expect(playButton("Needs you").getAttribute("title")).toBe("Play the Needs you sound");
    await click(playButton("Needs you"));
    expect(fake.playSound).toHaveBeenLastCalledWith("needsYou", "tokama");
    // Three live regions are always in the page, and only the row that plays says the word.
    expect($$(".notes-playing").map((el) => [el.getAttribute("aria-live"), el.textContent])).toEqual([["polite", "Playing"], ["polite", ""], ["polite", ""]]);
    await act(async () => vi.advanceTimersByTime(1500));
    expect($$(".notes-playing").map((el) => el.textContent)).toEqual(["", "", ""]);
    await click(option(3, "macOS default"));
    await click(playButton("Failed"));
    expect(fake.playSound).toHaveBeenLastCalledWith("failed", "macos");
  });

  it("clears the Playing timer when the page goes away", async () => {
    vi.useFakeTimers();
    const fake = fakeBridge(CONNECTED);
    await openPage(fake.bridge);
    await click(playButton("Finished"));
    await act(async () => root.unmount());
    expect(vi.getTimerCount()).toBe(0);
    root = createRoot(container);
  });

  it("keeps the choices working when saving fails or the saved state cannot be read", async () => {
    const fake = fakeBridge(CONNECTED);
    fake.saveNotifications.mockRejectedValue(new Error("disk full"));
    await openPage(fake.bridge);
    await click(option(2, "Off"));
    expect(checkedIn(groups()[2])).toBe("✓Off");
    const broken = fakeBridge(CONNECTED);
    (broken.bridge.getDesktopState as unknown as Mock).mockRejectedValue(new Error("no"));
    await act(async () => root.unmount());
    root = createRoot(container);
    await openPage(broken.bridge);
    expect(checks()).toEqual(["✓Banner + sound", "✓Banner only", "✓Banner + sound", "✓Tokama sounds"]);
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
