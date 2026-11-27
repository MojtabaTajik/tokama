import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { connect, type EngineClient } from "@tokama/client";
import { manualClock, type UsageRange, type UsageScope } from "@tokama/core";
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
  it("answers every range and scope with the numbers the usage_calls table gave, from a version 4 database", async () => {
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

    // The first query for all usage starts the scan of Claude Code's logs; wait until it ends.
    for (let tries = 0; ; tries++) {
      const reply = await client.query({ type: "usage", range: 14, scope: "all" });
      if (reply.ok && reply.data.scan?.state !== "scanning") break;
      if (tries > 250) throw new Error("the scan of Claude Code's logs did not end");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const reports: Record<string, unknown> = {};
    for (const scope of ["tokama", "all"] as const satisfies readonly UsageScope[]) {
      for (const range of [14, 30, 90] as const satisfies readonly UsageRange[]) {
        const reply = await client.query({ type: "usage", range, scope });
        if (!reply.ok) throw new Error(reply.error.message);
        reports[`${scope}-${range}`] = reply.data;
      }
    }
    // Item ids are new on every run: name them by their title's place.
    let text = JSON.stringify(reports, null, 2);
    [...items].sort((a, b) => a.title.localeCompare(b.title)).forEach((item, n) => (text = text.replaceAll(item.id, `item-${n}`)));
    await expect(`${text}\n`).toMatchFileSnapshot("./usage-from-logs.golden.json");

    // The database is upgraded in place: the call rows are gone, the data that is not in the logs stays.
    const raw = new DatabaseSync(join(home, "tokama.db"), { readOnly: true });
    cleanups.push(() => raw.close());
    expect(raw.prepare("PRAGMA user_version").get()).toEqual({ user_version: 5 });
    expect(raw.prepare("SELECT name FROM sqlite_master WHERE name = 'usage_calls'").all()).toEqual([]);
    expect(raw.prepare("SELECT cli_id FROM plan_samples").all()).toEqual([{ cli_id: "claude-code" }]);
    expect(raw.prepare("SELECT key FROM claude_local_messages ORDER BY key").all()).toEqual([{ key: "req_1" }, { key: "req_2" }]);
  });
});
