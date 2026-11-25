// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_DESKTOP_STATE } from "../../shared/desktop-state.js";
import { App } from "../App.js";
import { CONNECTED, fakeBridge, type Reply } from "../testing/bridge.js";
import { NOW } from "../testing/sample.js";

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

const dialog = () => container.querySelector("dialog[aria-label='Tokama stopped unexpectedly']");
const click = (name: string) => act(async () => [...container.querySelectorAll("button")].find((b) => b.textContent === name)?.click());

function start(options: { crashWaiting?: boolean; askAfterCrash?: boolean } = {}) {
  let crashWaiting = options.crashWaiting ?? true;
  const fake = fakeBridge(CONNECTED, {
    reply: (query): Reply | undefined => (query.type === "diagnostics_settings" ? { ok: true, data: { collect: true, installId: "install_00000000-0000-7000-8000-000000000001", crashWaiting } } : undefined),
    commandReply: (command) => {
      if ((command as { crashSeen?: true }).crashSeen) crashWaiting = false;
      return { ok: true, data: null };
    },
  });
  const show = () => act(async () => root.render(<App bridge={fake.bridge} now={NOW} initial={{ ...DEFAULT_DESKTOP_STATE, askAfterCrash: options.askAfterCrash ?? true }} />));
  return { ...fake, show, crash: () => (crashWaiting = true) };
}

describe("crash prompt", () => {
  it("asks after a crash with the board's words; Review and send opens Diagnostics and marks it seen", async () => {
    const app = start();
    await app.show();
    expect(dialog()?.querySelector("h2")?.textContent).toBe("Tokama stopped unexpectedly. Send a report?");
    expect(dialog()?.textContent).toContain("Review and send opens Diagnostics. Nothing is sent until you click Send all there.");
    expect([...(dialog()?.querySelectorAll("button") ?? [])].map((b) => b.textContent)).toEqual(["Don’t ask again", "Not now", "Review and send"]);
    await click("Review and send");
    expect(dialog()).toBeNull();
    expect(app.command).toHaveBeenCalledWith({ type: "diagnostics_settings", crashSeen: true });
    expect(container.querySelector(".settings-entry[aria-current=page]")?.textContent).toBe("Diagnostics");
    expect(container.querySelector(".dg-title")?.textContent).toBe("Diagnostics");
  });

  it("Not now marks the crash seen; a crash later in the same run does not ask again", async () => {
    const app = start();
    await app.show();
    await click("Not now");
    expect(dialog()).toBeNull();
    expect(app.command).toHaveBeenCalledWith({ type: "diagnostics_settings", crashSeen: true });
    app.crash();
    await app.pushEvent({ type: "setup_changed" });
    expect(dialog()).toBeNull();
  });

  it("Don't ask again remembers it on this machine and marks the crash seen", async () => {
    const app = start();
    await app.show();
    await click("Don’t ask again");
    expect(dialog()).toBeNull();
    expect(app.bridge.stopCrashPrompt).toHaveBeenCalled();
    expect(app.command).toHaveBeenCalledWith({ type: "diagnostics_settings", crashSeen: true });
  });

  it("never asks without a waiting crash, or after Don't ask again", async () => {
    await start({ crashWaiting: false }).show();
    expect(dialog()).toBeNull();
    act(() => root.unmount());
    root = createRoot(container);
    await start({ askAfterCrash: false }).show();
    expect(dialog()).toBeNull();
  });

  it("shows once a crash is recorded while the app runs", async () => {
    const app = start({ crashWaiting: false });
    await app.show();
    app.crash();
    await app.pushEvent({ type: "setup_changed" });
    expect(dialog()).not.toBeNull();
  });
});
