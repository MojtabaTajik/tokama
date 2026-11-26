import type { RunRequest, RunResult } from "@tokama/core";
import { describe, expect, it, vi } from "vitest";
import type { PlayedSound } from "./player.js";
import { playerFor, recordingPlayer } from "./player.js";

const FINISHED: RunResult = { kind: "finished", pid: 1, exitCode: 0, signal: null, timedOut: false, aborted: false, startedAt: 0, endedAt: 1, durationMs: 1 };

function setup(options: { packaged?: boolean; result?: () => Promise<RunResult> } = {}) {
  const requests: RunRequest[] = [];
  const release: Array<() => void> = [];
  const beep = vi.fn();
  const runner = {
    run: (request: RunRequest) => {
      requests.push(request);
      if (options.result !== undefined) return options.result();
      return new Promise<RunResult>((resolve) => release.push(() => resolve(FINISHED)));
    },
  };
  const makeRunner = vi.fn(() => runner);
  const deps = { makeRunner, soundsDir: "/res", packaged: options.packaged ?? true, beep };
  return { requests, release, beep, deps, makeRunner };
}

describe("the macOS player", () => {
  it("runs afplay on the file of each sound with a timeout, from a path built from the fixed table", () => {
    const { deps, requests } = setup();
    const player = playerFor("darwin", deps);
    player.play("needsYou", "tokama");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ command: { argv: ["/usr/bin/afplay", "/res/tokama-needs-you.wav"] }, cwd: "/res", timeoutMs: 5000 });
  });

  it("uses the development file names when not packaged", () => {
    const { deps, requests } = setup({ packaged: false });
    playerFor("darwin", deps).play("tokayCall", "tokama");
    expect(requests[0]?.command).toEqual({ argv: ["/usr/bin/afplay", "/res/tokay-call.wav"] });
  });

  it("beeps for the macOS default set and never runs a process", () => {
    const { deps, requests, beep } = setup();
    for (const name of ["needsYou", "finished", "failed"] as const) playerFor("darwin", deps).play(name, "macos");
    expect(beep).toHaveBeenCalledTimes(3);
    expect(requests).toEqual([]);
  });

  it("plays the call of the Tokay from its file whatever the set", () => {
    const { deps, requests, beep } = setup();
    playerFor("darwin", deps).play("tokayCall", "macos");
    expect(beep).not.toHaveBeenCalled();
    expect(requests[0]?.command).toEqual({ argv: ["/usr/bin/afplay", "/res/tokama-tokay-call.wav"] });
  });

  it("drops a play while one runs, and plays again after it ends", async () => {
    const { deps, requests, release } = setup();
    const player = playerFor("darwin", deps);
    player.play("needsYou", "tokama");
    player.play("failed", "tokama");
    expect(requests).toHaveLength(1);
    release[0]?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    player.play("failed", "tokama");
    expect(requests).toHaveLength(2);
  });

  it("does not throw when the runner rejects, and plays again after", async () => {
    const { deps, requests } = setup({ result: () => Promise.reject(new Error("boom")) });
    const player = playerFor("darwin", deps);
    expect(() => player.play("needsYou", "tokama")).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    player.play("needsYou", "tokama");
    expect(requests).toHaveLength(2);
  });
});

describe("the player of other platforms", () => {
  it("does nothing, and never makes a process runner (it cannot be made on Windows)", () => {
    const { deps, requests, beep, makeRunner } = setup();
    for (const platform of ["linux", "win32"] as const) playerFor(platform, deps).play("needsYou", "macos");
    expect(makeRunner).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
    expect(beep).not.toHaveBeenCalled();
  });
});

describe("recordingPlayer", () => {
  it("keeps what was played where a test can read it", () => {
    const player = recordingPlayer();
    player.play("failed", "macos");
    player.play("tokayCall", "tokama");
    expect((globalThis as { __tokamaSounds?: PlayedSound[] }).__tokamaSounds).toEqual([{ name: "failed", set: "macos" }, { name: "tokayCall", set: "tokama" }]);
  });
});
