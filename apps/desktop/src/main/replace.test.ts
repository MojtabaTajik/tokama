// The wait for another app's replace, on a manual clock: no real time passes.
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { manualClock, type EngineProcesses } from "@tokama/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { replaceOlderEngine, type ReplaceOptions } from "./replace.js";

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "tk-rep-wait-")));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const untouched: EngineProcesses = {
  describe: () => Promise.reject(new Error("the waiting app must not look at processes")),
  signal: () => {
    throw new Error("the waiting app must not send signals");
  },
};

/** Another live app (this test process) holds replace.lock; an older engine holds engine.lock. */
function waiting(clock: ReturnType<typeof manualClock>): ReplaceOptions {
  writeFileSync(join(dir, "engine.lock"), "4242 engine-old\n");
  writeFileSync(join(dir, "replace.lock"), `${process.pid} ${clock.now()}\n`);
  return {
    dir,
    engine: { lockPath: join(dir, "engine.lock"), commandEnd: `/opt/tokama/engine/dist/main.js --dir ${dir}` },
    processes: untouched,
    requestShutdown: () => Promise.reject(new Error("the waiting app must not send a shutdown request")),
    pollMs: 100,
    staleMs: 1_000,
    clock,
  };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("replaceOlderEngine while another app replaces", () => {
  it("gives up once staleMs passes on the clock", async () => {
    const clock = manualClock(Date.now());
    let result: unknown;
    void replaceOlderEngine(waiting(clock)).then((r) => (result = r));
    for (let step = 0; step < 9; step++) {
      await settle();
      clock.advance(100);
    }
    await settle();
    expect(result).toBeUndefined();
    clock.advance(100);
    await settle();
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("has not finished") });
  });

  it("stops waiting when the older engine lets go of its lock", async () => {
    const clock = manualClock(Date.now());
    let result: unknown;
    void replaceOlderEngine(waiting(clock)).then((r) => (result = r));
    await settle();
    clock.advance(100);
    await settle();
    expect(result).toBeUndefined();
    writeFileSync(join(dir, "engine.lock"), "4343 engine-new\n");
    clock.advance(100);
    await settle();
    expect(result).toEqual({ ok: true, forced: false });
  });
});
