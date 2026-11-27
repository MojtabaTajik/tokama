import { describe, expect, it } from "vitest";
import { callWeight, splitLimit, weigher, windowWeight, type CallLogs } from "./split.js";
import { call, DAY, MILLION, NOW } from "./testing/items.js";

const FROM = NOW - 3 * DAY;
// One million input tokens on claude-opus-5-5 weigh 4 and on claude-haiku-5-5 0.1 (the price table).
const logs = (totals: { model: string; tokens: typeof MILLION }[], over: Partial<CallLogs> = {}): CallLogs => ({ totals: () => totals, coveredFrom: FROM - DAY, ready: true, ...over });
const opus = (endedAt = NOW - DAY) => call({ stepId: "build", attempt: 1, endedAt, model: "claude-opus-5-5", tokens: MILLION });

describe("a call's weight", () => {
  it("is its tokens at the price table's prices, per model", () => {
    expect(callWeight(opus())).toBe(4);
    expect(callWeight(call({ stepId: "build", attempt: 1, endedAt: NOW, models: { "claude-opus-5-5": MILLION, "claude-haiku-5-5": MILLION } }))).toBeCloseTo(4.1, 10);
  });

  it("falls back to the CLI's figure for an unpriced model, and has none without one; a local model has none", () => {
    expect(callWeight(call({ stepId: "build", attempt: 1, endedAt: NOW, cliId: "codex-cli", model: "gpt-5-codex", reportedCostUsd: 0.7 }))).toBe(0.7);
    expect(callWeight(call({ stepId: "build", attempt: 1, endedAt: NOW, cliId: "codex-cli", model: "gpt-5-codex" }))).toBeUndefined();
    expect(callWeight(call({ stepId: "build", attempt: 1, endedAt: NOW, cliId: "ollama", model: "qwen3-coder:30b", reportedCostUsd: 1 }))).toBeUndefined();
  });

  it("ranks calls by tokens for the whole set when any call has no weight, so the unit is never mixed", () => {
    const priced = opus();
    const unpriced = call({ stepId: "build", attempt: 1, endedAt: NOW, cliId: "codex-cli", model: "gpt-5-codex", tokens: { input: 3, output: 0, cacheRead: 0, cacheWrite: 0 } });
    expect(weigher([priced]).of(priced)).toBe(4);
    expect(weigher([priced, unpriced])).toMatchObject({ priced: false });
    expect(weigher([priced, unpriced]).of(priced)).toBe(1_000_000);
  });
});

describe("what a window weighed", () => {
  it("is Tokama's calls against everything the logs hold", () => {
    expect(windowWeight([opus()], logs([{ model: "claude-opus-5-5", tokens: { ...MILLION, input: 2_000_000 } }]), FROM, NOW)).toEqual({ tokama: 4, all: 8 });
  });

  it("moves with the price table: the same tokens on a cheaper model weigh less against the same logs", () => {
    const cheap = call({ stepId: "build", attempt: 1, endedAt: NOW - DAY, model: "claude-haiku-5-5", tokens: MILLION });
    const everything = logs([{ model: "claude-opus-5-5", tokens: MILLION }]);
    expect(windowWeight([opus()], everything, FROM, NOW)).toEqual({ tokama: 4, all: 4 });
    expect(windowWeight([cheap], everything, FROM, NOW)).toEqual({ tokama: 0.1, all: 4 });
  });

  it("is unknown when a logged model has no price, when a call has none, or without logs", () => {
    expect(windowWeight([opus()], logs([{ model: "mystery-model", tokens: MILLION }]), FROM, NOW)).toBeUndefined();
    const unknown = call({ stepId: "build", attempt: 1, endedAt: NOW - DAY, model: "opus" });
    expect(windowWeight([unknown], logs([{ model: "claude-opus-5-5", tokens: MILLION }]), FROM, NOW)).toBeUndefined();
    expect(windowWeight([opus()], undefined, FROM, NOW)).toBeUndefined();
  });

  it("is unknown while the logs are being read, or when they begin after the window does", () => {
    const totals = [{ model: "claude-opus-5-5", tokens: MILLION }];
    expect(windowWeight([opus()], logs(totals, { ready: false }), FROM, NOW)).toBeUndefined();
    expect(windowWeight([opus()], logs(totals, { coveredFrom: FROM + 1 }), FROM, NOW)).toBeUndefined();
    expect(windowWeight([opus()], logs(totals, { coveredFrom: undefined }), FROM, NOW)).toBeUndefined();
    expect(windowWeight([opus()], logs(totals, { coveredFrom: FROM }), FROM, NOW)).toEqual({ tokama: 4, all: 4 });
  });
});

describe("the split of a window", () => {
  const weight = { tokama: 3, all: 4 };

  it("shares the use in proportion to the weight; the two parts add up to the use", () => {
    expect(splitLimit(80, weight)).toEqual({ tokamaPercent: 60, outsidePercent: 20 });
    expect(splitLimit(33.33, { tokama: 1, all: 3 })).toEqual({ tokamaPercent: 11.11, outsidePercent: 22.22 });
  });

  it("tells nothing under 10 points of use, and tells it from 10", () => {
    expect(splitLimit(9.9, weight)).toBeUndefined();
    expect(splitLimit(10, weight)).toEqual({ tokamaPercent: 7.5, outsidePercent: 2.5 });
  });

  it("holds over the limit: use of 105 splits into parts that add up to 105", () => {
    expect(splitLimit(105, { tokama: 1, all: 2 })).toEqual({ tokamaPercent: 52.5, outsidePercent: 52.5 });
  });

  it("never gives Tokama more than the whole, and tells nothing without a weight", () => {
    expect(splitLimit(50, { tokama: 9, all: 4 })).toEqual({ tokamaPercent: 50, outsidePercent: 0 });
    expect(splitLimit(50, undefined)).toBeUndefined();
    expect(splitLimit(50, { tokama: 0, all: 0 })).toBeUndefined();
    expect(splitLimit(50, { tokama: 1, all: Number.POSITIVE_INFINITY })).toBeUndefined();
    expect(splitLimit(50, { tokama: Number.POSITIVE_INFINITY, all: 1 })).toBeUndefined();
  });
});
