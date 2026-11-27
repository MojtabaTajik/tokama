import type { ItemRecord } from "@tokama/core";
import { describe, expect, it } from "vitest";
import { ITEMS, NOW } from "../testing/sample.js";
import { AWAY_LINES, awayLine, awayModel } from "./away-model.js";

const MINUTE = 60_000;
const SEEN = NOW - 100 * MINUTE;
const asked = (item: ItemRecord, minutesAgo: number, id?: string): ItemRecord => ({ ...item, ...(id === undefined ? {} : { id }), decision: { ...item.decision!, askedAt: NOW - minutesAgo * MINUTE } }) as ItemRecord;
const ended = (item: ItemRecord, minutesAgo: number, id: string): ItemRecord => ({ ...item, id, outcome: { kind: item.state === "failed" ? "failed" : "done", at: NOW - minutesAgo * MINUTE } }) as ItemRecord;
const id = (n: number) => `item_00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const page = (items: readonly ItemRecord[], total = items.length) => ({ items, total });

describe("awayModel", () => {
  it("lists the questions asked after seenUntil, oldest first, and leaves out older ones and ones with no time", () => {
    const model = awayModel({
      seenUntil: SEEN,
      open: [asked(ITEMS.needsYou, 10, id(1)), asked(ITEMS.needsYou, 60, id(2)), asked(ITEMS.needsYou, 200, id(3)), ITEMS.needsYou, ITEMS.working],
      done: undefined,
      failed: undefined,
    });
    expect(model.needs.shown.map((item) => item.id)).toEqual([id(2), id(1)]);
    expect(model.needs.count).toBe(2);
    expect(model.news).toBe(true);
  });

  it("counts a question asked at the very time of seenUntil, as the engine counts an item that ended then", () => {
    const model = awayModel({ seenUntil: SEEN, open: [{ ...ITEMS.needsYou, decision: { ...ITEMS.needsYou.decision!, askedAt: SEEN } } as ItemRecord], done: undefined, failed: undefined });
    expect(model.needs.count).toBe(1);
  });

  it("caps each group at five lines and keeps the full count", () => {
    const many = Array.from({ length: 8 }, (_, n) => asked(ITEMS.needsYou, 90 - n, id(n + 1)));
    const finished = Array.from({ length: 7 }, (_, n) => ended(ITEMS.done, 50, id(100 + n)));
    const model = awayModel({ seenUntil: SEEN, open: many, done: page(finished, 7), failed: undefined });
    expect(AWAY_LINES).toBe(5);
    expect(model.needs.shown).toHaveLength(5);
    expect(model.needs.count).toBe(8);
    // The first was asked 90 minutes ago, the last 83.
    expect(model.needs.shown.map((item) => item.id)).toEqual([1, 2, 3, 4, 5].map(id));
    expect(model.finished.shown).toHaveLength(5);
    expect(model.finished.count).toBe(7);
  });

  it("counts finished and failed from the engine's totals, not only the rows loaded", () => {
    const model = awayModel({ seenUntil: SEEN, open: [], done: page([ended(ITEMS.done, 30, id(1))], 60), failed: page([ended(ITEMS.failed, 30, id(2))], 3) });
    expect(model.finished.count).toBe(60);
    expect(model.failed.count).toBe(3);
  });

  it("does not call an item the user stopped finished, and takes it off the count", () => {
    const stopped = { ...ITEMS.stopped, outcome: { kind: "stopped", at: NOW - 40 * MINUTE } } as ItemRecord;
    const model = awayModel({ seenUntil: SEEN, open: [], done: page([ended(ITEMS.done, 30, id(1)), stopped], 2), failed: undefined });
    expect(model.finished.shown.map((item) => item.id)).toEqual([id(1)]);
    expect(model.finished.count).toBe(1);
  });

  it("lists the items that run now, and running alone is no news", () => {
    const model = awayModel({ seenUntil: SEEN, open: [ITEMS.working, ITEMS.verifying, ITEMS.queued], done: page([]), failed: page([]) });
    expect(model.running.shown.map((item) => item.title)).toEqual([ITEMS.working.title, ITEMS.verifying.title]);
    expect(model.news).toBe(false);
  });

  it("has no news while nothing asks, ended or failed; a page still loading counts as none", () => {
    expect(awayModel({ seenUntil: SEEN, open: [], done: undefined, failed: { items: [], total: undefined } }).news).toBe(false);
  });
});

describe("awayLine", () => {
  const said = { source: "headline", headline: "Receipt total now includes tax.", points: [], morePoints: 0, bodyBytes: 40 };
  const withSaid = (item: ItemRecord): ItemRecord => ({ ...item, steps: item.steps.map((step, index) => (index === 0 ? { ...step, attempts: [{ attempt: 1, result: "passed", checks: [], said }] } : step)) }) as ItemRecord;

  it("a question line is the question, then what the agent said before it", () => {
    expect(awayLine(ITEMS.needsYou)).toEqual({ text: ITEMS.needsYou.decision!.question, facts: [] });
    expect(awayLine(withSaid(ITEMS.needsYou)).text).toBe(`${ITEMS.needsYou.decision!.question} Receipt total now includes tax.`);
  });

  it("a finished line is the headline over the facts", () => {
    const line = awayLine(withSaid(ITEMS.done));
    expect(line.text).toBe("Receipt total now includes tax.");
    expect(line.facts.length).toBeGreaterThan(0);
  });

  it("a finished line with no headline is its facts alone", () => {
    const line = awayLine(ITEMS.done);
    expect(line.text).toBeUndefined();
    expect(line.facts.length).toBeGreaterThan(0);
  });

  it("a failed line is its facts, even when its agent said something", () => {
    const line = awayLine(withSaid(ITEMS.failed));
    expect(line.text).toBeUndefined();
    expect(line.facts.map((fact) => fact.text)).toContain("stopped at Fix, step 1 of 2");
  });

  it("an item with neither says its card line", () => {
    const bare = { ...ITEMS.stopped, state: "done", cardLine: "commit 3f2a9c1 · tokama/0b9f3c1e", steps: [] } as unknown as ItemRecord;
    expect(awayLine({ ...bare, kind: "investigation" } as ItemRecord)).toEqual({ text: "commit 3f2a9c1 · tokama/0b9f3c1e", facts: [] });
  });
});
