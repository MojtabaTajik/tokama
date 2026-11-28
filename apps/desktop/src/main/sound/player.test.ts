import type { RunRequest, RunResult } from "@tokama/core";
import { describe, expect, it, vi } from "vitest";
import type { PlayedSound } from "./player.js";
import { playerFor, recordingPlayer } from "./player.js";

const FINISHED: RunResult = { kind: "finished", pid: 1, exitCode: 0, signal: null, timedOut: false, aborted: false, startedAt: 0, endedAt: 1, durationMs: 1 };
const FAILED: RunResult = { ...FINISHED, exitCode: 1 };
const NOT_STARTED: RunResult = { kind: "not-started", reason: "spawn-error", message: "ENOENT", code: "ENOENT" };

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(options: { packaged?: boolean; result?: (request: RunRequest) => Promise<RunResult>; installed?: readonly string[]; themeFiles?: readonly string[] } = {}) {
  const requests: RunRequest[] = [];
  const release: Array<() => void> = [];
  const beep = vi.fn();
  const runner = {
    run: (request: RunRequest) => {
      requests.push(request);
      if (options.result !== undefined) return options.result(request);
      return new Promise<RunResult>((resolve) => release.push(() => resolve(FINISHED)));
    },
  };
  const makeRunner = vi.fn(() => runner);
  const installed = options.installed ?? [];
  const findProgram = vi.fn((name: string) => (installed.includes(name) ? `/usr/bin/${name}` : undefined));
  const themeFiles = options.themeFiles ?? [];
  const themeFile = vi.fn((path: string) => (themeFiles.includes(path) ? path : undefined));
  const deps = { makeRunner, findProgram, themeFile, audioEnv: { XDG_RUNTIME_DIR: "/run/user/1000" }, soundsDir: "/res", packaged: options.packaged ?? true, beep };
  return { requests, release, beep, deps, makeRunner, findProgram };
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

  it("beeps for the system set and never runs a process", () => {
    const { deps, requests, beep } = setup();
    for (const name of ["needsYou", "finished", "failed"] as const) playerFor("darwin", deps).play(name, "system");
    expect(beep).toHaveBeenCalledTimes(3);
    expect(requests).toEqual([]);
  });

  it("plays the call of the Tokay from its file whatever the set", () => {
    const { deps, requests, beep } = setup();
    playerFor("darwin", deps).play("tokayCall", "system");
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
    await tick();
    player.play("failed", "tokama");
    expect(requests).toHaveLength(2);
  });

  it("does not throw when the runner rejects, and plays again after", async () => {
    const { deps, requests } = setup({ result: () => Promise.reject(new Error("boom")) });
    const player = playerFor("darwin", deps);
    expect(() => player.play("needsYou", "tokama")).not.toThrow();
    await tick();
    player.play("needsYou", "tokama");
    expect(requests).toHaveLength(2);
  });

  it("beeps when afplay fails, does not start or rejects, and not when it works", async () => {
    for (const result of [FAILED, NOT_STARTED]) {
      const failing = setup({ result: () => Promise.resolve(result) });
      playerFor("darwin", failing.deps).play("needsYou", "tokama");
      await tick();
      expect(failing.beep).toHaveBeenCalledTimes(1);
    }
    const rejecting = setup({ result: () => Promise.reject(new Error("boom")) });
    playerFor("darwin", rejecting.deps).play("needsYou", "tokama");
    await tick();
    expect(rejecting.beep).toHaveBeenCalledTimes(1);
    const working = setup({ result: () => Promise.resolve(FINISHED) });
    playerFor("darwin", working.deps).play("needsYou", "tokama");
    await tick();
    expect(working.beep).not.toHaveBeenCalled();
  });

  it("never reports a missing player and never looks a program up", () => {
    const { deps, findProgram } = setup();
    expect(playerFor("darwin", deps).playerMissing()).toBe(false);
    expect(findProgram).not.toHaveBeenCalled();
  });
});

describe("the Linux player", () => {
  it("runs pw-play first on the packaged file of the sound, by the path the lookup found", () => {
    const { deps, requests, beep } = setup({ installed: ["pw-play", "paplay", "aplay"] });
    playerFor("linux", deps).play("needsYou", "tokama");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ command: { argv: ["/usr/bin/pw-play", "/res/tokama-needs-you.wav"] }, cwd: "/res", timeoutMs: 5000 });
    expect(beep).not.toHaveBeenCalled();
  });

  it("runs paplay when pw-play is not installed, and aplay when neither is", () => {
    const withPaplay = setup({ installed: ["paplay", "aplay"] });
    playerFor("linux", withPaplay.deps).play("needsYou", "tokama");
    expect(withPaplay.requests.map((request) => request.command)).toEqual([{ argv: ["/usr/bin/paplay", "/res/tokama-needs-you.wav"] }]);
    const { deps, requests } = setup({ installed: ["aplay"], packaged: false });
    playerFor("linux", deps).play("failed", "tokama");
    expect(requests.map((request) => request.command)).toEqual([{ argv: ["/usr/bin/aplay", "/res/failed.wav"] }]);
  });

  it("falls back down the list when a program does not start or fails, and stops at the first that works", async () => {
    const argv0 = (request: RunRequest) => ("argv" in request.command ? request.command.argv[0] : undefined);
    for (const bad of [NOT_STARTED, FAILED]) {
      const { deps, requests } = setup({ installed: ["pw-play", "paplay", "aplay"], result: (request) => Promise.resolve(argv0(request) === "/usr/bin/aplay" ? FINISHED : bad) });
      playerFor("linux", deps).play("finished", "tokama");
      await tick();
      expect(requests.map(argv0)).toEqual(["/usr/bin/pw-play", "/usr/bin/paplay", "/usr/bin/aplay"]);
    }
    const second = setup({ installed: ["pw-play", "paplay", "aplay"], result: (request) => Promise.resolve(argv0(request) === "/usr/bin/pw-play" ? FAILED : FINISHED) });
    playerFor("linux", second.deps).play("finished", "tokama");
    await tick();
    expect(second.requests.map(argv0)).toEqual(["/usr/bin/pw-play", "/usr/bin/paplay"]);
    const { deps, requests } = setup({ installed: ["pw-play", "paplay", "aplay"], result: () => Promise.resolve(FINISHED) });
    playerFor("linux", deps).play("finished", "tokama");
    await tick();
    expect(requests).toHaveLength(1);
  });

  it("passes the sound server variables the runner would otherwise drop", () => {
    const { deps, requests } = setup({ installed: ["paplay"] });
    playerFor("linux", deps).play("needsYou", "tokama");
    expect(requests[0]?.env).toEqual({ XDG_RUNTIME_DIR: "/run/user/1000" });
  });

  it("beeps when every program fails, and not when one works", async () => {
    const failing = setup({ installed: ["paplay", "aplay"], result: () => Promise.resolve(FAILED) });
    playerFor("linux", failing.deps).play("needsYou", "tokama");
    await tick();
    expect(failing.beep).toHaveBeenCalledTimes(1);
    const working = setup({ installed: ["paplay"], result: () => Promise.resolve(FINISHED) });
    playerFor("linux", working.deps).play("needsYou", "tokama");
    await tick();
    expect(working.beep).not.toHaveBeenCalled();
  });

  it("falls back down the list when a program rejects, and plays again after all fail", async () => {
    const { deps, requests } = setup({ installed: ["pw-play", "paplay", "aplay"], result: () => Promise.reject(new Error("boom")) });
    const player = playerFor("linux", deps);
    expect(() => player.play("needsYou", "tokama")).not.toThrow();
    await tick();
    expect(requests).toHaveLength(3);
    player.play("needsYou", "tokama");
    await tick();
    expect(requests).toHaveLength(6);
  });

  it("beeps for every sound, and runs nothing, when no program is installed", () => {
    const { deps, requests, beep } = setup({ installed: [] });
    const player = playerFor("linux", deps);
    player.play("needsYou", "tokama");
    player.play("tokayCall", "tokama");
    player.play("failed", "system");
    expect(beep).toHaveBeenCalledTimes(3);
    expect(requests).toEqual([]);
    expect(player.playerMissing()).toBe(true);
  });

  it("plays the system set from the freedesktop theme file of each kind, through pw-play then paplay, never aplay", async () => {
    const THEME = "/usr/share/sounds/freedesktop/stereo";
    const expected = { needsYou: "message-new-instant.oga", finished: "complete.oga", failed: "dialog-warning.oga" } as const;
    for (const [name, file] of Object.entries(expected) as Array<[keyof typeof expected, string]>) {
      const { deps, requests, beep } = setup({ installed: ["pw-play", "paplay", "aplay"], themeFiles: [`${THEME}/${file}`], result: () => Promise.resolve(FAILED) });
      playerFor("linux", deps).play(name, "system");
      await tick();
      // aplay cannot decode Ogg, so after pw-play and paplay fail it goes straight to the beep.
      expect(requests.map((request) => request.command)).toEqual([{ argv: ["/usr/bin/pw-play", `${THEME}/${file}`] }, { argv: ["/usr/bin/paplay", `${THEME}/${file}`] }]);
      expect(requests[0]?.env).toEqual({ XDG_RUNTIME_DIR: "/run/user/1000" });
      expect(beep).toHaveBeenCalledTimes(1);
    }
  });

  it("does not beep when the theme file plays", async () => {
    const { deps, beep } = setup({ installed: ["paplay"], themeFiles: ["/usr/share/sounds/freedesktop/stereo/complete.oga"], result: () => Promise.resolve(FINISHED) });
    playerFor("linux", deps).play("finished", "system");
    await tick();
    expect(beep).not.toHaveBeenCalled();
  });

  it("plays the system set through pw-play alone on a stock PipeWire computer", () => {
    const { deps, requests } = setup({ installed: ["pw-play"], themeFiles: ["/usr/share/sounds/freedesktop/stereo/complete.oga"] });
    playerFor("linux", deps).play("finished", "system");
    expect(requests.map((request) => request.command)).toEqual([{ argv: ["/usr/bin/pw-play", "/usr/share/sounds/freedesktop/stereo/complete.oga"] }]);
  });

  it("beeps for the system set when the theme file is missing, or when only aplay is installed, and runs nothing", () => {
    const missing = setup({ installed: ["paplay"] });
    playerFor("linux", missing.deps).play("finished", "system");
    expect(missing.beep).toHaveBeenCalledTimes(1);
    expect(missing.requests).toEqual([]);
    const onlyAplay = setup({ installed: ["aplay"], themeFiles: ["/usr/share/sounds/freedesktop/stereo/complete.oga"] });
    playerFor("linux", onlyAplay.deps).play("finished", "system");
    expect(onlyAplay.beep).toHaveBeenCalledTimes(1);
    expect(onlyAplay.requests).toEqual([]);
  });

  it("plays the Tokay from its own file in the system set", () => {
    const { deps, requests } = setup({ installed: ["paplay"] });
    playerFor("linux", deps).play("tokayCall", "system");
    expect(requests[0]?.command).toEqual({ argv: ["/usr/bin/paplay", "/res/tokama-tokay-call.wav"] });
  });

  it("looks the programs up on every play, so a program installed later is used", () => {
    const installed: string[] = [];
    const { deps, requests, beep } = setup({ installed });
    const player = playerFor("linux", deps);
    expect(player.playerMissing()).toBe(true);
    player.play("needsYou", "tokama");
    installed.push("aplay");
    expect(player.playerMissing()).toBe(false);
    player.play("needsYou", "tokama");
    expect(beep).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(1);
  });

  it("drops a play while one runs", () => {
    const { deps, requests } = setup({ installed: ["paplay"] });
    const player = playerFor("linux", deps);
    player.play("needsYou", "tokama");
    player.play("failed", "tokama");
    expect(requests).toHaveLength(1);
  });
});

describe("the player of other platforms", () => {
  it("does nothing, and never makes a process runner (it cannot be made on Windows)", () => {
    const { deps, requests, beep, makeRunner } = setup({ installed: ["paplay"] });
    const player = playerFor("win32", deps);
    player.play("needsYou", "system");
    expect(makeRunner).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
    expect(beep).not.toHaveBeenCalled();
    expect(player.playerMissing()).toBe(false);
  });
});

describe("recordingPlayer", () => {
  it("keeps what was played where a test can read it", () => {
    const player = recordingPlayer();
    player.play("failed", "system");
    player.play("tokayCall", "tokama");
    expect((globalThis as { __tokamaSounds?: PlayedSound[] }).__tokamaSounds).toEqual([{ name: "failed", set: "system" }, { name: "tokayCall", set: "tokama" }]);
  });
});
