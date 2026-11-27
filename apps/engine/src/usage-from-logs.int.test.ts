import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { connect, type EngineClient } from "@tokama/client";
import { manualClock, parseQueryResult } from "@tokama/core";
import { afterEach, describe, expect, it } from "vitest";
import { startEngine } from "./engine.js";
import { tempEngineDir } from "./testing/helpers.js";
import { USAGE_NOW, writeUsageItems, writeV4Database } from "./testing/usage-fixture.js";

let cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups = [];
});

const tempFolder = (): string => {
  const folder = mkdtempSync(join(tmpdir(), "tokama-usage-"));
  cleanups.push(() => rmSync(folder, { recursive: true, force: true }));
  return folder;
};

async function clientOf(dir: string, lockPath: string): Promise<EngineClient> {
  const connected = await connect({ dir, lockPath, startTimeoutMs: 2_000 });
  if (!connected.ok) throw new Error(connected.error.message);
  cleanups.push(() => connected.value.close());
  return connected.value;
}

describe("usage from the item logs", () => {
  it("answers from the item logs on a version 4 database, and upgrades it in place", async () => {
    const home = tempFolder();
    const items = writeUsageItems(home);
    writeV4Database(join(home, "tokama.db"), items);

    const dir = tempEngineDir(cleanups);
    const started = await startEngine({
      dir,
      home,
      clock: manualClock(USAGE_NOW),
      planSources: {},
      claudeLogs: tempFolder(),
      processTable: { list: async () => [], bootTime: () => 0, signalGroup: () => undefined },
    });
    if (!started.ok) throw new Error(started.error.message);
    cleanups.push(() => started.value.close());
    const client = await clientOf(dir, started.value.endpoint.lockPath);

    const reply = await client.query({ type: "usage" });
    if (!reply.ok) throw new Error(reply.error.message);
    expect(parseQueryResult("usage", reply.data).ok).toBe(true);
    // Today's calls come from the item logs, not from the call rows of the old database; a deleted item has none.
    expect(reply.data.today?.items.map((item) => item.title)).toEqual(["Triage the login errors", "Fix the checkout timeout"]);
    expect(reply.data.today?.itemCount).toBe(2);

    // The database is upgraded in place: the call rows and the project table are gone, the data that is not in the logs stays.
    const raw = new DatabaseSync(join(home, "tokama.db"), { readOnly: true });
    cleanups.push(() => raw.close());
    expect(raw.prepare("PRAGMA user_version").get()).toEqual({ user_version: 6 });
    expect(raw.prepare("SELECT name FROM sqlite_master WHERE name IN ('usage_calls', 'claude_local_projects')").all()).toEqual([]);
    expect(raw.prepare("SELECT cli_id FROM plan_samples").all()).toEqual([{ cli_id: "claude-code" }]);
    expect(raw.prepare("SELECT key FROM claude_local_messages ORDER BY key").all()).toEqual([{ key: "req_1" }, { key: "req_2" }]);
  });
});
