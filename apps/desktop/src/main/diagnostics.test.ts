import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_REPORTED_STACK_CHARS } from "@tokama/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createReporter, mainErrorReport, rateLimit, rendererErrorReport, rendererGoneKind, runMarker } from "./diagnostics.js";

describe("rendererErrorReport", () => {
  it("takes the stack, or the message when there is no stack, and nothing else", () => {
    expect(rendererErrorReport({ message: "x is undefined", stack: "TypeError: x is undefined\n    at f (app.js:1:2)", source: "engine", where: "startup", type: "crash" })).toEqual({
      type: "error",
      source: "renderer",
      where: "uncaught",
      stack: "TypeError: x is undefined\n    at f (app.js:1:2)",
    });
    expect(rendererErrorReport({ message: "lost", stack: "" })).toEqual({ type: "error", source: "renderer", where: "uncaught", stack: "Error: lost" });
  });

  it("refuses anything that is not a message and a stack", () => {
    for (const input of [undefined, null, "Error: x", 42, {}, { message: "", stack: "  " }, { message: 1, stack: ["a"] }]) expect(rendererErrorReport(input)).toBeUndefined();
  });

  it("cuts a huge stack to what the engine accepts", () => {
    const report = rendererErrorReport({ message: "m", stack: "x".repeat(MAX_REPORTED_STACK_CHARS * 3) });
    expect(report?.type === "error" && report.stack.length).toBe(MAX_REPORTED_STACK_CHARS);
  });
});

describe("mainErrorReport and rendererGoneKind", () => {
  it("reports main-process errors and values", () => {
    expect(mainErrorReport(new RangeError("too big"), "uncaught")).toMatchObject({ type: "error", source: "desktop", where: "uncaught", stack: expect.stringMatching(/^RangeError: too big/) });
    expect(mainErrorReport("text", "unhandled_rejection")).toEqual({ type: "error", source: "desktop", where: "unhandled_rejection", stack: "NonError: text" });
  });

  it("maps Electron's reasons, and a clean exit to nothing", () => {
    expect(rendererGoneKind("oom")).toBe("oom");
    expect(rendererGoneKind("launch-failed")).toBe("launch_failed");
    expect(rendererGoneKind("clean-exit")).toBeUndefined();
    expect(rendererGoneKind("toString")).toBeUndefined();
  });
});

describe("rateLimit", () => {
  it("allows max per window", () => {
    let now = 0;
    const allow = rateLimit(2, 1000, () => now);
    expect([allow(), allow(), allow()]).toEqual([true, true, false]);
    now = 1000;
    expect(allow()).toBe(true);
  });
});

describe("createReporter", () => {
  it("waits for a connection, keeps order, drops refused reports and caps the queue", async () => {
    let connected = false;
    const sent: number[] = [];
    // The engine refuses report 3, as an older engine refuses a command it does not know.
    const reporter = createReporter(async (report) => {
      const n = (report as unknown as { n: number }).n;
      if (!connected) return "retry";
      if (n === 3) return "dropped";
      sent.push(n);
      return "sent";
    }, 3);
    const usage = (n: number) => ({ type: "usage" as const, action: "expand_view" as const, n });
    for (const n of [1, 2, 3, 4]) reporter.report(usage(n));
    await reporter.flush();
    expect(sent).toEqual([]);
    connected = true;
    await reporter.flush();
    // 1 fell out of the capped queue; 3 was refused.
    expect(sent).toEqual([2, 4]);
  });

  it("treats a failing send as one to retry", async () => {
    let fail = true;
    const sent: unknown[] = [];
    const reporter = createReporter(async (report) => {
      if (fail) throw new Error("socket");
      sent.push(report);
      return "sent";
    });
    reporter.report({ type: "usage", action: "expand_view" });
    await reporter.flush();
    fail = false;
    await reporter.flush();
    expect(sent).toHaveLength(1);
  });
});

describe("runMarker", () => {
  let dir: string;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "tokama-marker-")));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("finds a crash when the last run's pid is gone, not when it still runs", () => {
    const path = join(dir, "desktop.running");
    expect(runMarker(path, 100, () => false).crashedBefore).toBe(false);
    expect(readFileSync(path, "utf8")).toBe("100\n");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(runMarker(path, 200, () => true).crashedBefore).toBe(false);
    const third = runMarker(path, 300, () => false);
    expect(third.crashedBefore).toBe(true);
    third.clear();
    expect(existsSync(path)).toBe(false);
    expect(runMarker(path, 400, () => false).crashedBefore).toBe(false);
  });

  it("leaves another run's marker alone on clear, and never writes through a symlink", () => {
    const path = join(dir, "desktop.running");
    const mine = runMarker(path, 100, () => false);
    writeFileSync(path, "999\n");
    mine.clear();
    expect(readFileSync(path, "utf8")).toBe("999\n");
    rmSync(path);
    const target = join(dir, "target");
    writeFileSync(target, "keep");
    symlinkSync(target, path);
    expect(runMarker(path, 100, () => false).crashedBefore).toBe(false);
    expect(readFileSync(target, "utf8")).toBe("keep");
  });
});
