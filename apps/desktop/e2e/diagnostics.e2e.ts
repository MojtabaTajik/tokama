// Settings > Diagnostics in the real app on the sample engine, which keeps sample entries of every
// type. Send all goes to a local test server that this file runs (a development build may point
// the app at a loopback server; a packaged app never reads the variable). The save dialog is
// replaced in the main process. The crash prompt is reached by killing the sample engine.
import { readFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { Page } from "playwright-core";
import { afterAll, beforeAll, beforeEach, expect } from "vitest";
import { flow, type Session } from "./harness.js";

interface Received {
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

let status = 201;
let received: Received[] = [];
const server = createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", () => {
    received.push({ headers: request.headers, body: gunzipSync(Buffer.concat(chunks)).toString("utf8") });
    response.writeHead(status, { "content-type": "application/json" });
    response.end(status < 300 ? '{"id":"rep_e2e"}' : '{"error":"daily budget used up"}');
  });
});

beforeAll(async () => {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  process.env["TOKAMA_DIAGNOSTICS_URL"] = `http://127.0.0.1:${(server.address() as AddressInfo).port}/diagnostics`;
});
afterAll(async () => {
  delete process.env["TOKAMA_DIAGNOSTICS_URL"];
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
});
beforeEach(() => {
  status = 201;
  received = [];
});

const SAMPLE_COUNT = 6;
const settingsButton = (page: Page) => page.getByRole("navigation", { name: "App" }).getByRole("button", { name: /^Settings/ });

async function openDiagnostics(page: Page): Promise<void> {
  await settingsButton(page).click();
  await page.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: "Diagnostics" }).click();
  await page.locator(".dg-entry").first().waitFor();
}

const rows = (page: Page) => page.locator(".dg-entry").allInnerTexts();
const statusLine = (page: Page) => page.locator(".dg-status").innerText();

flow("reads an entry, counts waiting entries on Settings, and clears them all", async ({ page, screenshot }) => {
  await expect.poll(() => settingsButton(page).getAttribute("aria-label")).toBe(`Settings · ${SAMPLE_COUNT} diagnostics waiting`);
  await openDiagnostics(page);
  expect(await rows(page)).toHaveLength(SAMPLE_COUNT);
  await page.locator(".dg-entry").filter({ hasText: "TypeError" }).click();
  const text = await page.locator(".dg-text").innerText();
  expect(JSON.parse(text)).toMatchObject({ schemaVersion: 1, type: "error", name: "TypeError", source: "engine", where: "request" });
  // Paths in the stack are cleaned before the entry was written.
  expect(text).toContain("<path>");
  expect(text).not.toContain("/opt/tokama");
  await page.getByRole("button", { name: `Send all (${SAMPLE_COUNT})` }).waitFor();
  await screenshot("14-diagnostics");

  await page.getByRole("button", { name: "Clear all" }).click();
  await page.getByRole("heading", { name: "Nothing waiting" }).waitFor();
  expect(await page.getByRole("button", { name: /^Send all/ }).count()).toBe(0);
  expect(await page.getByRole("switch", { name: "Collect diagnostics" }).getAttribute("aria-checked")).toBe("true");
  await screenshot("14-diagnostics-empty");
  await page.locator(".settings-back").click();
  await expect.poll(() => settingsButton(page).getAttribute("aria-label")).toBe("Settings");
  expect(received).toEqual([]);
});

flow("sends every entry in one gzipped request and removes them after the receiver stored them", async ({ page, screenshot }) => {
  await openDiagnostics(page);
  // A filter changes only the view.
  await page.getByRole("radio", { name: /^Usage/ }).click();
  expect(await rows(page)).toHaveLength(2);
  await page.getByRole("button", { name: `Send all (${SAMPLE_COUNT})` }).click();
  await page.getByText(`Sent ${SAMPLE_COUNT} entries. They were removed from this Mac.`).waitFor();
  expect(await statusLine(page)).toContain("✓");
  await page.getByRole("heading", { name: "Nothing waiting" }).waitFor();
  await screenshot("14-diagnostics-sent");

  expect(received).toHaveLength(1);
  const [request] = received;
  expect(request?.headers["content-type"]).toBe("application/json");
  expect(request?.headers["content-encoding"]).toBe("gzip");
  expect(request?.headers["cookie"]).toBeUndefined();
  expect(request?.headers["authorization"]).toBeUndefined();
  const body = JSON.parse(request?.body ?? "") as { entries: { type: string }[] };
  expect(Object.keys(body)).toEqual(["entries"]);
  const { entries } = body;
  expect(entries).toHaveLength(SAMPLE_COUNT);
  expect(new Set(entries.map((entry) => entry.type))).toEqual(new Set(["error", "warning", "usage", "crash"]));
  await page.locator(".settings-back").click();
  await expect.poll(() => settingsButton(page).getAttribute("aria-label")).toBe("Settings");
});

flow("keeps everything when the receiver fails, and says why", async ({ page, screenshot }) => {
  status = 503;
  await openDiagnostics(page);
  const before = await rows(page);
  await page.getByRole("button", { name: `Send all (${SAMPLE_COUNT})` }).click();
  await page.getByText(`Couldn’t send ${SAMPLE_COUNT} entries. The server is busy today; try tomorrow. They are kept here.`).waitFor();
  expect(await rows(page)).toEqual(before);
  expect(await page.getByRole("button", { name: `Send all (${SAMPLE_COUNT})` }).isEnabled()).toBe(true);
  expect(received).toHaveLength(1);
  await screenshot("14-diagnostics-failed");
});

flow("saves exactly what Send all would send to a file", async ({ app, page, tmp }) => {
  const file = join(tmp, "diagnostics.json");
  await app.evaluate(({ dialog }, path) => {
    (dialog as { showSaveDialog: unknown }).showSaveDialog = async () => ({ canceled: false, filePath: path });
  }, file);
  await openDiagnostics(page);
  const texts: string[] = [];
  for (const row of await page.locator(".dg-entry").all()) {
    await row.click();
    texts.push(await page.locator(".dg-text").innerText());
  }
  await page.getByRole("button", { name: "Save as file…" }).click();
  await expect.poll(() => { try { return readFileSync(file, "utf8").length; } catch { return 0; } }).toBeGreaterThan(0);
  const saved = readFileSync(file, "utf8");
  expect(saved).toBe(`{"entries": [\n${texts.join(",\n")}\n]}\n`);
  expect(received).toEqual([]);
});

/** Kills the sample engine without a clean stop; the app starts a new one, which finds the crash. */
function crashEngine(session: Session): void {
  const running = session.engine();
  if (running === undefined) throw new Error("no engine is running");
  process.kill(running.pid, "SIGKILL");
}

const prompt = (page: Page) => page.getByRole("dialog", { name: "Tokama stopped unexpectedly" });

flow("asks after the engine crashed; Review and send opens Diagnostics", async (session) => {
  const { page, screenshot } = session;
  expect(await prompt(page).count()).toBe(0);
  crashEngine(session);
  await prompt(page).waitFor();
  expect(await prompt(page).getByRole("heading").innerText()).toBe("Tokama stopped unexpectedly. Send a report?");
  await screenshot("14-crash-prompt");
  await prompt(page).getByRole("button", { name: "Review and send" }).click();
  await prompt(page).waitFor({ state: "detached" });
  expect(await page.getByRole("navigation", { name: "Settings" }).locator('[aria-current="page"]').textContent()).toBe("Diagnostics");
  await page.locator(".dg-entry").filter({ hasText: "Engine stopped unexpectedly" }).first().waitFor();
});

flow("Not now does not ask again for the same crash on the next start", async (session) => {
  crashEngine(session);
  await prompt(session.page).waitFor();
  await prompt(session.page).getByRole("button", { name: "Not now" }).click();
  await prompt(session.page).waitFor({ state: "detached" });
  const next = await session.restart();
  await next.page.locator(".rail").waitFor();
  await new Promise((done) => setTimeout(done, 1500));
  expect(await prompt(next.page).count()).toBe(0);
});

flow("Don't ask again stops the prompt, also after the next crash", async (session) => {
  crashEngine(session);
  await prompt(session.page).waitFor();
  await prompt(session.page).getByRole("button", { name: "Don’t ask again" }).click();
  await prompt(session.page).waitFor({ state: "detached" });
  const next = await session.restart();
  expect(JSON.parse(readFileSync(join(session.home, ".tokama", "desktop.json"), "utf8"))).toMatchObject({ askAfterCrash: false });
  crashEngine(next);
  await expect.poll(async () => (await next.connection()).status === "connected" && next.engine()?.pid !== undefined, { timeout: 30_000 }).toBe(true);
  await next.page.locator(".rail").waitFor();
  await new Promise((done) => setTimeout(done, 1500));
  expect(await prompt(next.page).count()).toBe(0);
});
