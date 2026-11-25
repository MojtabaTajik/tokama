// @vitest-environment happy-dom
import { type DiagnosticEntry, DiagnosticEntrySchema, entryText } from "@tokama/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConnectionState, DiagnosticsItem, DiagnosticsSendResult } from "../../shared/bridge.js";
import { CONNECTED, fakeBridge, type Reply } from "../testing/bridge.js";
import { NOW } from "../testing/sample.js";
import { DiagnosticsPage } from "./DiagnosticsPage.js";

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
const button = (name: string) => $$("button").find((b) => b.textContent === name) as HTMLButtonElement | undefined;
const HOUR = 60 * 60 * 1000;

const envelope = {
  schemaVersion: 1,
  installId: "install_00000000-0000-7000-8000-000000000001",
  sessionId: "session_00000000-0000-7000-8000-000000000002",
  appVersion: "0.1.0",
  engineVersion: "0.1.0",
  clis: [],
  machine: { os: "macos", osVersion: "15.2", distro: null, arch: "arm64", cpu: { family: "Apple M3 Pro", cores: 12 }, ramGb: "16-32", gpu: null },
};
const id = (n: number) => `diag_00000000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const make = (n: number, ago: number, body: object): DiagnosticsItem => {
  const entry: DiagnosticEntry = DiagnosticEntrySchema.parse({ ...envelope, id: id(n), at: NOW - ago, ...body });
  return { entry, text: entryText(entry) };
};
const ITEMS: DiagnosticsItem[] = [
  make(1, HOUR, { type: "error", source: "engine", where: "request", name: "TypeError", fingerprint: "0123456789abcdef", stack: "TypeError: <b>not html</b>\n    at run (<path>/engine.js:1:1)" }),
  make(2, 2 * HOUR, { type: "warning", source: "renderer", code: "renderer_unresponsive" }),
  make(3, 3 * HOUR, { type: "crash", source: "engine", kind: "unclean_exit" }),
  make(4, 3 * 24 * HOUR, { type: "usage", day: "2025-10-17", counts: [{ action: "approve", count: 2 }] }),
];

function render(options: { items?: DiagnosticsItem[]; collect?: boolean; connection?: ConnectionState; send?: () => Promise<DiagnosticsSendResult> } = {}) {
  let items = options.items ?? ITEMS;
  let collect = options.collect ?? true;
  const fake = fakeBridge(options.connection ?? CONNECTED, {
    loadDiagnostics: async () => ({ ok: true, items }),
    reply: (query): Reply | undefined => (query.type === "diagnostics_settings" ? { ok: true, data: { collect, installId: envelope.installId, crashWaiting: false } } : undefined),
    commandReply: (command) => {
      const c = command as { type: string; collect?: boolean; all?: true };
      if (c.type === "diagnostics_settings" && c.collect !== undefined) collect = c.collect;
      if (c.type === "diagnostics_delete") items = [];
      return { ok: true, data: null };
    },
    ...(options.send !== undefined && { sendDiagnostics: options.send }),
    saveDiagnostics: async () => ({ ok: true }),
  });
  const setItems = (next: DiagnosticsItem[]) => (items = next);
  return { ...fake, setItems, show: () => act(async () => root.render(<DiagnosticsPage bridge={fake.bridge} connection={options.connection ?? CONNECTED} now={NOW} />)) };
}

describe("DiagnosticsPage", () => {
  it("lists the entries with time, type and summary, and shows the exact text of the chosen one as text", async () => {
    const page = render();
    await page.show();
    expect($("h1")?.textContent).toBe("Diagnostics");
    expect(container.textContent).toContain("Kept on this Mac: last 30 days, up to 2 MB.");
    const rows = $$(".dg-entry");
    // Last 7 days: all four.
    expect(rows.map((row) => row.textContent)).toEqual([
      "Today 14:00ErrorTypeError in the engine, while answering a request",
      "Today 13:00WarningThe window stopped answering for a while",
      "Today 12:00ErrorEngine stopped unexpectedly",
      "Fri 17 OctUsageDaily usage summary for 17 Oct",
    ]);
    expect(rows[0]?.getAttribute("aria-pressed")).toBe("true");
    expect($(".dg-exact")?.textContent).toBe("Exactly what is sent");
    expect($(".dg-text")?.textContent).toBe(ITEMS[0]?.text);
    expect($(".dg-text b")).toBeNull();
    await click(rows[3]);
    expect($(".dg-detail-title")?.textContent).toBe("Daily usage summary for 17 Oct");
    expect($(".dg-text")?.textContent).toBe(ITEMS[3]?.text);
    expect($(".dg-size")?.textContent).toMatch(/^\d+\.\d KB$/);
  });

  it("filters only the view: crashes count as errors, and Send all still names every entry", async () => {
    const page = render();
    await page.show();
    expect($$(".dg-type").map((b) => b.textContent)).toEqual(["All4", "Error2", "Warning1", "Usage1"]);
    expect(container.textContent).toContain("Filters only change what you see; Send all sends everything.");
    await click($$(".dg-type")[1]);
    expect($$(".dg-entry").map((row) => row.querySelector(".dg-summary")?.textContent)).toEqual(["TypeError in the engine, while answering a request", "Engine stopped unexpectedly"]);
    await act(async () => {
      const select = $(".dg-date select") as HTMLSelectElement;
      select.value = "today";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await click($$(".dg-type")[0]);
    expect($$(".dg-entry")).toHaveLength(3);
    expect(button("Send all (4)")).toBeDefined();
    await click(button("Send all (4)"));
    expect(page.bridge.sendDiagnostics).toHaveBeenCalledWith(ITEMS.map((item) => item.entry.id));
  });

  it("disables the buttons while sending, then says the entries were sent and removed", async () => {
    let finish: (result: DiagnosticsSendResult) => void = () => undefined;
    const page = render({ send: () => new Promise((resolve) => (finish = resolve)) });
    await page.show();
    await click(button("Send all (4)"));
    expect($(".dg-status")?.textContent).toBe("◐Sending all 4 entries…");
    expect(["Send all (4)", "Clear all", "Save as file…"].map((name) => button(name)?.disabled)).toEqual([true, true, true]);
    page.setItems([]);
    await act(async () => finish({ ok: true, sent: 4 }));
    expect($(".dg-status")?.textContent).toBe("✓Sent 4 entries. They were removed from this Mac.");
    expect(button("Send all (0)")?.disabled).toBe(true);
    expect(container.textContent).toContain("Nothing waiting");
  });

  it("says why a send failed, keeps everything, and lets you try again", async () => {
    const page = render({ send: async () => ({ ok: false, reason: "timeout", count: 4 }) });
    await page.show();
    await click(button("Send all (4)"));
    expect($(".dg-status")?.textContent).toBe("✕Couldn’t send 4 entries. tokama.dev didn’t answer within 30 seconds. They are kept here.");
    expect($$(".dg-entry")).toHaveLength(4);
    expect(button("Send all (4)")?.disabled).toBe(false);
  });

  it.each([
    [{ reason: "rate_limited" }, "tokama.dev has too many reports right now; try again in a minute."],
    [{ reason: "busy_today" }, "The server is busy today; try tomorrow."],
    [{ reason: "rejected", detail: "entries[0].code: not a known code" }, "tokama.dev didn’t accept them: entries[0].code: not a known code."],
    [{ reason: "network" }, "tokama.dev couldn’t be reached. Check the connection."],
  ] as const)("says in plain words why the receiver refused: %j", async (failure, words) => {
    const page = render({ send: async () => ({ ok: false, count: 1, ...failure }), items: [ITEMS[0]!] });
    await page.show();
    await click(button("Send all (1)"));
    expect($(".dg-status")?.textContent).toBe(`✕Couldn’t send 1 entry. ${words} It is kept here.`);
    expect($$(".dg-entry")).toHaveLength(1);
  });

  it("says when sent entries could not be removed from this machine", async () => {
    const page = render({ send: async () => ({ ok: true, sent: 4, kept: 4 }) });
    await page.show();
    await click(button("Send all (4)"));
    expect($(".dg-status")?.textContent).toBe("✓Sent 4 entries. 4 entries couldn’t be removed from this Mac and may be sent again.");
    expect($$(".dg-entry")).toHaveLength(4);
  });

  it("clears every entry with one click, and saves every entry to a file", async () => {
    const page = render();
    await page.show();
    await click(button("Save as file…"));
    expect(page.bridge.saveDiagnostics).toHaveBeenCalledWith(ITEMS.map((item) => item.entry.id));
    await click(button("Clear all"));
    expect(page.command).toHaveBeenCalledWith({ type: "diagnostics_delete", all: true });
    expect(container.textContent).toContain("Nothing waiting");
  });

  it("shows Nothing waiting with only the switch when no entry waits", async () => {
    const page = render({ items: [] });
    await page.show();
    expect($(".dg-empty .empty-state-title")?.textContent).toBe("Nothing waiting");
    expect(container.textContent).toContain("New errors, warnings and the daily usage summary show up here.");
    expect($(".dg-filters")).toBeNull();
    expect(button("Send all (0)")).toBeUndefined();
    expect($("[role=switch]")).not.toBeNull();
  });

  it("reflects the collect switch and flips it through the engine", async () => {
    const page = render({ collect: false });
    await page.show();
    const sw = () => $("[role=switch]") as HTMLButtonElement;
    expect(sw().getAttribute("aria-checked")).toBe("false");
    expect(sw().textContent).toBe("Off");
    expect(sw().getAttribute("aria-labelledby")).toBe("dg-collect-label");
    await click(sw());
    expect(page.command).toHaveBeenCalledWith({ type: "diagnostics_settings", collect: true });
    expect(sw().getAttribute("aria-checked")).toBe("true");
    expect(sw().textContent).toBe("On");
    // Collecting off still lists, sends and clears what waits.
    expect(button("Send all (4)")?.disabled).toBe(false);
  });

  it("offers nothing to send while the engine is not running", async () => {
    const failed: ConnectionState = { status: "failed", reason: "no node", logPath: "/tmp/engine.log", logTail: [] };
    const page = render({ connection: failed });
    await page.show();
    expect(container.textContent).toContain("The engine is not available");
    expect(button("Send all (4)")).toBeUndefined();
    expect(button("Clear all")).toBeUndefined();
    expect(page.bridge.loadDiagnostics).not.toHaveBeenCalled();
  });

  it("loads again when entries change", async () => {
    const page = render({ items: [] });
    await page.show();
    page.setItems([ITEMS[1]!]);
    await page.pushEvent({ type: "diagnostics_changed" });
    expect($$(".dg-entry")).toHaveLength(1);
  });
});
