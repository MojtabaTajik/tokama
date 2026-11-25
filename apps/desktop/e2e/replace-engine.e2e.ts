// An older engine still running when the app starts, as after an update: a fake engine of the
// previous API version, a real process in the app's engine dir. Idle, the app replaces it by
// itself; busy (or not saying), it asks first. Screenshots go to `<outDir>/screenshots`.
import { join } from "node:path";
import { API_VERSION } from "@tokama/core";
import { expect } from "vitest";
import { alive, oldEngineNotes, setOldRunning, startOldEngine } from "../src/main/testing/old-engine.js";
import { flow } from "./harness.js";

/** The app's sample engine dir in a test, as the harness sets it. */
const engineDir = (tmp: string) => join(tmp, "e", "sample");
let oldPid = 0;
const seed = (runningItems: number | undefined) => async (_home: string, tmp: string) => {
  oldPid = await startOldEngine({ root: join(tmp, "old"), dir: engineDir(tmp), apiVersion: API_VERSION - 1, sample: true, ...(runningItems !== undefined && { runningItems }) });
};

flow(
  "replaces an idle older engine by itself and connects to the new one",
  async ({ page, connection, tmp }) => {
    await expect.poll(async () => (await connection()).status, { timeout: 30_000 }).toBe("connected");
    await page.locator(".pl-row").first().waitFor();
    expect(alive(oldPid)).toBe(false);
    // An engine from before the shutdown request refuses it; SIGTERM stops it.
    expect(oldEngineNotes(engineDir(tmp))).toEqual(expect.arrayContaining(["got shutdown", "SIGTERM"]));
  },
  "older",
  seed(0),
);

flow(
  "asks before it restarts a busy older engine; Wait restarts it once nothing runs",
  async ({ page, connection, screenshot, tmp }) => {
    const failure = page.locator(".board .failure");
    await failure.getByText("An older Tokama engine is still running. Restart it?").waitFor();
    expect(await failure.locator(".hint").innerText()).toBe("It is running 3 tasks. Restart now (they pause and ask Retry or Stop) or Wait until they finish.");
    expect(await failure.locator(".log").innerText()).toContain(`pid   ${oldPid}`);
    await screenshot("103-older-engine-busy");

    await failure.getByRole("button", { name: "Wait", exact: true }).click();
    await failure.getByText("Waiting for 3 tasks to finish").waitFor();
    await screenshot("103-older-engine-waiting");
    expect(alive(oldPid)).toBe(true);
    expect(oldEngineNotes(engineDir(tmp))).not.toContain("SIGTERM");

    setOldRunning(engineDir(tmp), 0);
    await expect.poll(async () => (await connection()).status, { timeout: 30_000 }).toBe("connected");
    expect(alive(oldPid)).toBe(false);
  },
  "older",
  seed(3),
);

flow(
  "asks before it restarts an older engine that does not say whether it is busy; Restart engine restarts it",
  async ({ page, connection, screenshot }) => {
    const failure = page.locator(".board .failure");
    await failure.getByText("An older Tokama engine is still running. Restart it?").waitFor();
    expect(await failure.getByRole("button").allInnerTexts()).toEqual(["Restart engine"]);
    await screenshot("103-older-engine");
    await failure.getByRole("button", { name: "Restart engine" }).click();
    await expect.poll(async () => (await connection()).status, { timeout: 30_000 }).toBe("connected");
    expect(alive(oldPid)).toBe(false);
  },
  "older",
  seed(undefined),
);
