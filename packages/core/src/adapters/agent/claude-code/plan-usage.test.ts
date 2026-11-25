import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProcessRunner, RunRequest, RunResult } from "../../../kernel/process/index.js";
import { compareVersions, GET_USAGE_FROM, parseGetUsageReply, parseUsageCache, readClaudePlanCache, requestClaudePlan } from "./plan-usage.js";

// The fixtures keep the real shapes Claude Code 2.1.332 wrote (codenamed buckets, microsecond
// reset times, 0 to 100 utilization) with made-up values and no account data.
const fixture = (name: string) => readFileSync(join(import.meta.dirname, "testing", "fixtures", name), "utf8");
const REPLY = fixture("get-usage.jsonl").trim();
const NOW = Date.UTC(2025, 9, 20, 14, 32);

type Reply = { readonly out: readonly string[]; readonly exitCode?: number; readonly timedOut?: boolean; readonly aborted?: boolean } | "missing" | "aborted";

/** A runner that answers each argv by its first argument after the command. */
function fakeRunner(replies: { version: Reply; usage?: Reply }): ProcessRunner & { requests: RunRequest[] } {
  const requests: RunRequest[] = [];
  return {
    requests,
    run: async (request: RunRequest): Promise<RunResult> => {
      requests.push(request);
      const argv = "argv" in request.command ? request.command.argv : [];
      const reply = argv[1] === "--version" ? replies.version : (replies.usage ?? "missing");
      if (reply === "missing") return { kind: "not-started", reason: "spawn-error", message: "ENOENT", code: "ENOENT" };
      if (reply === "aborted") return { kind: "not-started", reason: "aborted", message: "aborted before start" };
      for (const line of reply.out) request.stdout?.onLine?.(line);
      return { kind: "finished", pid: 2, exitCode: reply.exitCode ?? 0, signal: null, timedOut: reply.timedOut ?? false, aborted: reply.aborted ?? false, startedAt: 0, endedAt: 0, durationMs: 0 };
    },
  };
}

const clock = { now: () => NOW, setTimeout: () => 0 as never, clearTimeout: () => undefined };

describe("parseGetUsageReply", () => {
  it("reads the windows, reset times, plan and extra usage of a recorded reply", () => {
    expect(parseGetUsageReply(REPLY, NOW)).toEqual({
      ok: true,
      value: {
        windows: [
          { window: "five_hour", usedPercent: 36, resetsAt: Date.parse("2025-10-20T17:10:00.299Z") },
          { window: "seven_day", usedPercent: 58, resetsAt: Date.parse("2025-10-23T09:00:00.299Z") },
        ],
        asOf: NOW,
        plan: "pro",
        extraUsage: "off",
      },
    });
  });

  it("reports a login without plan windows, an error reply and an unknown shape as unknown, never as numbers", () => {
    const reply = JSON.parse(REPLY) as { response: { response: Record<string, unknown> } };
    const apiKey = { ...reply, response: { ...reply.response, response: { ...reply.response.response, rate_limits_available: false, rate_limits: null } } };
    expect(parseGetUsageReply(JSON.stringify(apiKey), NOW)).toEqual({ ok: false, error: expect.stringMatching(/no plan windows/) });
    const failed = { type: "control_response", response: { subtype: "error", request_id: "tokama-usage", error: "not logged in" } };
    expect(parseGetUsageReply(JSON.stringify(failed), NOW)).toEqual({ ok: false, error: expect.stringMatching(/not logged in/) });
    expect(parseGetUsageReply(REPLY.replace('"rate_limits_available":true', '"rate_limits_available":"yes"'), NOW)).toMatchObject({ ok: false, error: expect.stringMatching(/shape/) });
    expect(parseGetUsageReply("{not json", NOW).ok).toBe(false);
    // Another request's answer is not this one.
    expect(parseGetUsageReply(REPLY.replace('"request_id":"tokama-usage"', '"request_id":"other"'), NOW).ok).toBe(false);
  });

  it("skips a window without a utilization and keeps one whose reset time is missing", () => {
    const reply = JSON.parse(REPLY) as { response: { response: { rate_limits: Record<string, unknown> } } };
    reply.response.response.rate_limits["five_hour"] = { utilization: null, resets_at: null };
    reply.response.response.rate_limits["seven_day"] = { utilization: 101.5 };
    const parsed = parseGetUsageReply(JSON.stringify(reply), NOW);
    expect(parsed.ok && parsed.value.windows).toEqual([{ window: "seven_day", usedPercent: 101.5 }]);
  });
});

describe("parseUsageCache", () => {
  it("reads the cached windows with their fetch time and keeps no account data", () => {
    const parsed = parseUsageCache(fixture("claude-config.json"));
    expect(parsed).toEqual({
      ok: true,
      value: {
        windows: [
          { window: "five_hour", usedPercent: 41, resetsAt: Date.parse("2025-10-20T17:10:00.299Z") },
          { window: "seven_day", usedPercent: 63, resetsAt: Date.parse("2025-10-23T09:00:00.299Z") },
          { window: "seven_day_sonnet", usedPercent: 12, resetsAt: Date.parse("2025-10-23T09:00:00Z") },
        ],
        asOf: 1760970000000,
        extraUsage: "off",
      },
    });
    expect(JSON.stringify(parsed)).not.toMatch(/example\.com|00000000-|orders-api/);
  });

  it("has nothing to read in a config without the cache", () => {
    expect(parseUsageCache(JSON.stringify({ numStartups: 1 })).ok).toBe(false);
    expect(parseUsageCache("").ok).toBe(false);
  });
});

describe("readClaudePlanCache", () => {
  let home: string | undefined;
  afterEach(() => home && rmSync(home, { recursive: true, force: true }));

  it("reads the file in Claude Code's home folder, and says so when there is none", async () => {
    home = mkdtempSync(join(tmpdir(), "tokama-claude-home-"));
    expect(await readClaudePlanCache(home)).toEqual({ ok: false, error: "Claude Code has no cached usage." });
    writeFileSync(join(home, ".claude.json"), fixture("claude-config.json"));
    expect(await readClaudePlanCache(home)).toMatchObject({ ok: true, value: { asOf: 1760970000000 } });
  });
});

describe("requestClaudePlan", () => {
  it("asks an idle restricted session with the get_usage control request, and sends no prompt", async () => {
    const runner = fakeRunner({ version: { out: ["2.1.332 (Claude Code)"] }, usage: { out: ['{"type":"system","subtype":"init"}', REPLY] } });
    const plan = await requestClaudePlan({ runner, clock });
    expect(plan).toMatchObject({ ok: true, value: { version: "2.1.332", plan: "pro", asOf: NOW } });
    const asked = runner.requests[1]!;
    expect("argv" in asked.command && asked.command.argv).toEqual([
      "claude",
      "-p",
      "--input-format=stream-json",
      "--output-format=stream-json",
      "--verbose",
      "--restricted",
      "--permission-mode=dontAsk",
      "--strict-mcp-config",
      "--tools=",
    ]);
    expect(JSON.parse(asked.stdin!)).toEqual({ type: "control_request", request_id: "tokama-usage", request: { subtype: "get_usage", skip_behaviors: true } });
    expect(asked.timeoutMs).toBeGreaterThan(0);
  });

  it("hands the caller's signal to every process, so shutdown stops a request in flight", async () => {
    const runner = fakeRunner({ version: { out: ["2.1.332"] }, usage: { out: [REPLY] } });
    const signal = new AbortController().signal;
    await requestClaudePlan({ runner, clock, signal });
    expect(runner.requests.map((request) => request.signal)).toEqual([signal, signal]);
  });

  it("says a stopped or slow request was stopped or slow, not that the CLI is missing", async () => {
    expect(await requestClaudePlan({ runner: fakeRunner({ version: "aborted" }), clock })).toEqual({ ok: false, error: "The usage request was stopped." });
    expect(await requestClaudePlan({ runner: fakeRunner({ version: { out: [], timedOut: true } }), clock, timeoutMs: 5_000 })).toEqual({ ok: false, error: "Claude Code did not report its version within 5 s." });
    const slow = fakeRunner({ version: { out: ["2.1.332"] }, usage: { out: [], timedOut: true } });
    expect(await requestClaudePlan({ runner: slow, clock })).toMatchObject({ ok: false, error: expect.stringMatching(/did not answer the usage request within/) });
    const stopped = fakeRunner({ version: { out: ["2.1.332"] }, usage: { out: [], aborted: true } });
    expect(await requestClaudePlan({ runner: stopped, clock })).toEqual({ ok: false, error: "The usage request was stopped." });
    // An answer that came before the timeout still counts.
    const lingering = fakeRunner({ version: { out: ["2.1.332"] }, usage: { out: [REPLY], timedOut: true } });
    expect(await requestClaudePlan({ runner: lingering, clock })).toMatchObject({ ok: true });
    const aborted = new AbortController();
    aborted.abort();
    expect(await requestClaudePlan({ runner: fakeRunner({ version: { out: ["2.1.332"] }, usage: { out: [REPLY] } }), clock, signal: aborted.signal })).toEqual({ ok: false, error: "The usage request was stopped." });
  });

  it("does not ask a version older than the one get_usage was checked on", async () => {
    const runner = fakeRunner({ version: { out: ["2.1.300 (Claude Code)"] }, usage: { out: [REPLY] } });
    expect(await requestClaudePlan({ runner, clock })).toEqual({ ok: false, error: expect.stringContaining(GET_USAGE_FROM) });
    expect(runner.requests).toHaveLength(1);
  });

  it("reports a missing CLI, an unreadable version and a session that never answers", async () => {
    expect(await requestClaudePlan({ runner: fakeRunner({ version: "missing" }), clock })).toMatchObject({ ok: false, error: expect.stringMatching(/not installed/) });
    expect(await requestClaudePlan({ runner: fakeRunner({ version: { out: ["claude"] } }), clock })).toMatchObject({ ok: false, error: expect.stringMatching(/version/) });
    const silent = fakeRunner({ version: { out: ["2.1.331"] }, usage: { out: ['{"type":"system"}'], exitCode: 1 } });
    expect(await requestClaudePlan({ runner: silent, clock })).toMatchObject({ ok: false, error: expect.stringMatching(/did not answer/) });
  });
});

describe("compareVersions", () => {
  it("orders versions by number, not by text", () => {
    expect(compareVersions("2.1.331", "2.1.331")).toBe(0);
    expect(compareVersions("2.1.40", "2.1.331")).toBeLessThan(0);
    expect(compareVersions("2.10.0", "2.9.9")).toBeGreaterThan(0);
  });
});
