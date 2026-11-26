import { describe, expect, it } from "vitest";
import type { UpdateState } from "../../shared/update.js";
import { next, type UpdateEvent } from "./state.js";

const run = (start: UpdateState, ...events: UpdateEvent[]): UpdateState => events.reduce(next, start);
const idle: UpdateState = { status: "idle" };
const critical = { reason: "Fixes a security problem." };

describe("update state", () => {
  it("goes from idle through checking and downloading to ready", () => {
    expect(run(idle, { type: "check_started" })).toEqual({ status: "checking" });
    const downloading = run(idle, { type: "check_started" }, { type: "available", version: "0.2.0" });
    expect(downloading).toEqual({ status: "downloading", version: "0.2.0", percent: 0, transferred: 0, total: 0 });
    expect(next(downloading, { type: "progress", percent: 39.6, transferred: 38, total: 96 })).toMatchObject({ percent: 40, transferred: 38, total: 96 });
    expect(next(downloading, { type: "downloaded", version: "0.2.0" })).toEqual({ status: "ready", version: "0.2.0" });
  });

  it("goes back to idle, with the time, when nothing newer exists", () => {
    expect(run(idle, { type: "check_started" }, { type: "up_to_date", at: 5 })).toEqual({ status: "idle", checkedAt: 5 });
  });

  it("keeps the time of the last check while checking again", () => {
    expect(run({ status: "idle", checkedAt: 5 }, { type: "check_started" })).toEqual({ status: "checking", checkedAt: 5 });
  });

  it("carries the important flag from the feed to ready", () => {
    const state = run(idle, { type: "check_started" }, { type: "available", version: "0.2.2", critical }, { type: "downloaded", version: "0.2.2", critical });
    expect(state).toEqual({ status: "ready", version: "0.2.2", critical });
  });

  it("ignores Check now while downloading, ready or installing", () => {
    for (const state of [
      { status: "downloading", version: "0.2.0", percent: 10, transferred: 1, total: 10 },
      { status: "ready", version: "0.2.0" },
      { status: "installing", version: "0.2.0" },
    ] as const) {
      expect(next(state, { type: "check_started" })).toBe(state);
    }
  });

  it("keeps a ready update through a failed check", () => {
    const ready: UpdateState = { status: "ready", version: "0.2.0" };
    expect(next(ready, { type: "error", at: 9 })).toBe(ready);
  });

  it("names the stage of a failure: check, then download", () => {
    expect(run(idle, { type: "check_started" }, { type: "error", at: 9 })).toEqual({ status: "error", stage: "check", at: 9 });
    expect(run(idle, { type: "check_started" }, { type: "available", version: "0.2.0", critical }, { type: "error", at: 9 })).toEqual({ status: "error", stage: "download", at: 9, version: "0.2.0", critical });
  });

  it("checks again after an error", () => {
    expect(next({ status: "error", stage: "check", at: 9 }, { type: "check_started" })).toEqual({ status: "checking" });
  });

  it("installs only from ready, and a failed install is an error of its own", () => {
    expect(next(idle, { type: "install_started" })).toBe(idle);
    const installing = next({ status: "ready", version: "0.2.0" }, { type: "install_started" });
    expect(installing).toEqual({ status: "installing", version: "0.2.0" });
    expect(next(installing, { type: "install_failed", at: 3 })).toEqual({ status: "error", stage: "install", at: 3, version: "0.2.0" });
    expect(next(installing, { type: "error", at: 3 })).toBe(installing);
  });

  it("returns to ready, with the important flag, when an install is aborted before it touched anything", () => {
    const ready: UpdateState = { status: "ready", version: "0.2.2", critical };
    const installing = next(ready, { type: "install_started" });
    expect(installing).toEqual({ status: "installing", version: "0.2.2", critical });
    expect(next(installing, { type: "install_aborted" })).toEqual(ready);
    expect(next(idle, { type: "install_aborted" })).toBe(idle);
  });

  it("never leaves unavailable", () => {
    const unavailable: UpdateState = { status: "unavailable", reason: "development" };
    expect(next(unavailable, { type: "check_started" })).toBe(unavailable);
    expect(next(unavailable, { type: "downloaded", version: "0.2.0" })).toBe(unavailable);
  });

  it("clamps a progress that is out of range", () => {
    const downloading: UpdateState = { status: "downloading", version: "0.2.0", percent: 0, transferred: 0, total: 0 };
    expect(next(downloading, { type: "progress", percent: 140, transferred: 1, total: 1 })).toMatchObject({ percent: 100 });
    expect(next(downloading, { type: "progress", percent: Number.NaN, transferred: -1, total: 1 })).toMatchObject({ percent: 0, transferred: 0 });
  });
});
