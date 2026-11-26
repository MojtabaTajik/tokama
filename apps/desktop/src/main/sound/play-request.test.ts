import type { RunRequest, RunResult } from "@tokama/core";
import { describe, expect, it, vi } from "vitest";
import { rateLimit } from "../diagnostics.js";
import { playRequestHandler } from "./play-request.js";
import { playerFor, type SoundPlayer } from "./player.js";

function recorder() {
  const plays: unknown[][] = [];
  const player: SoundPlayer = { play: (...args) => void plays.push(args) };
  return { plays, player };
}

describe("playRequestHandler", () => {
  it("plays a known name from a known set", () => {
    const { plays, player } = recorder();
    const handle = playRequestHandler(player, () => true);
    handle("needsYou", "tokama");
    handle("tokayCall", "macos");
    expect(plays).toEqual([["needsYou", "tokama"], ["tokayCall", "macos"]]);
  });

  it("drops a bad name or set without asking the rate limit", () => {
    const { plays, player } = recorder();
    const allow = vi.fn(() => true);
    const handle = playRequestHandler(player, allow);
    for (const bad of ["../x", "__proto__", "constructor", "toString", "needsyou", "", " needsYou", 5, null, undefined, {}, ["needsYou"], { toString: () => "needsYou" }]) {
      handle(bad, "tokama");
      handle("needsYou", bad);
    }
    expect(plays).toEqual([]);
    expect(allow).not.toHaveBeenCalled();
  });

  it("allows 20 plays in 10 seconds and then drops them until the window has passed", () => {
    const { plays, player } = recorder();
    let now = 0;
    const handle = playRequestHandler(player, rateLimit(20, 10_000, () => now));
    for (let i = 0; i < 25; i++) handle("finished", "tokama");
    expect(plays).toHaveLength(20);
    now = 10_001;
    handle("finished", "tokama");
    expect(plays).toHaveLength(21);
  });

  it("drops a request while a sound still plays", () => {
    const requests: RunRequest[] = [];
    const runner = { run: (request: RunRequest) => (requests.push(request), new Promise<RunResult>(() => undefined)) };
    const player = playerFor("darwin", { makeRunner: () => runner, soundsDir: "/res", packaged: true, beep: () => undefined });
    const handle = playRequestHandler(player, () => true);
    handle("needsYou", "tokama");
    handle("failed", "tokama");
    expect(requests).toHaveLength(1);
  });
});
