import { describe, expect, it } from "vitest";
import { attemptFacts, attemptMs, logFacts, plannedChecks, sizeFact, spokenDuration, spokenSize, stepFacts, transcriptBytes } from "./attempt-view.js";

const ended = (extra: Record<string, unknown> = {}) => ({ attempt: 1, result: "passed" as const, checks: [], ...extra });

describe("spokenDuration", () => {
  it("spells the units, drops the zero ones and says 0 seconds for nothing", () => {
    expect(spokenDuration(252_000)).toBe("4 minutes 12 seconds");
    expect(spokenDuration(61_000)).toBe("1 minute 1 second");
    expect(spokenDuration(3_600_000 + 5_000)).toBe("1 hour 5 seconds");
    expect(spokenDuration(90_000_000)).toBe("1 day 1 hour");
    expect(spokenDuration(400)).toBe("0 seconds");
  });
});

describe("spokenSize", () => {
  it("spells bytes, kilobytes and megabytes", () => {
    expect(spokenSize(1)).toBe("1 byte");
    expect(spokenSize(512)).toBe("512 bytes");
    expect(spokenSize(38 * 1024)).toBe("38 kilobytes");
    expect(spokenSize(1024)).toBe("1 kilobyte");
    expect(spokenSize(3 * 1024 * 1024)).toBe("3.0 megabytes");
  });
});

describe("attemptMs", () => {
  it("is the recorded time once ended and the time since the start while it runs", () => {
    expect(attemptMs({ durationMs: 5_000, startedAt: 1_000, result: "passed" }, 99_000)).toBe(5_000);
    expect(attemptMs({ startedAt: 1_000, result: undefined }, 4_000)).toBe(3_000);
    expect(attemptMs({ startedAt: 9_000, result: undefined }, 4_000)).toBe(0);
    expect(attemptMs({ result: undefined }, 4_000)).toBeUndefined();
    expect(attemptMs({ result: "passed" }, 4_000)).toBeUndefined();
  });
});

describe("transcriptBytes", () => {
  it("adds the sizes of the ended attempts that saved a transcript", () => {
    expect(transcriptBytes([ended({ transcriptSaved: true, transcriptBytes: 100 }), ended({ transcriptSaved: false }), ended({ transcriptSaved: true, transcriptBytes: 50 })])).toBe(150);
  });

  it("is unknown when an ended attempt does not say, as an older record does not, or when nothing was saved", () => {
    expect(transcriptBytes([ended({ transcriptSaved: true, transcriptBytes: 100 }), ended()])).toBeUndefined();
    expect(transcriptBytes([ended({ transcriptSaved: false })])).toBeUndefined();
    expect(transcriptBytes([])).toBeUndefined();
  });

  it("leaves out a running attempt, which has no size yet", () => {
    expect(transcriptBytes([ended({ transcriptSaved: true, transcriptBytes: 100 }), {}])).toBe(100);
  });
});

describe("stepFacts", () => {
  it("says the attempts, the agent time and the size, as seen and as spoken", () => {
    const step = { attempts: [ended({ durationMs: 91_000 }), ended({ attempt: 2, durationMs: 161_000 })] };
    expect(stepFacts(step, 0, sizeFact(38 * 1024))).toEqual({ text: "2 attempts · 4 m 12 s · 38 KB", spoken: "2 attempts, 4 minutes 12 seconds, 38 kilobytes" });
  });

  it("leaves the size out when it is not known, and says one attempt", () => {
    expect(stepFacts({ attempts: [ended({ durationMs: 5_000 })] }, 0, undefined)).toEqual({ text: "1 attempt · 5 s", spoken: "1 attempt, 5 seconds" });
  });

  it("says 'attempt 2 of 3' while it runs, with the running attempt's time counting to now", () => {
    const step = { runs: 2, maxAttempts: 3, attempts: [ended({ durationMs: 4_000 }), { attempt: 2, startedAt: 8_000, checks: [] }] };
    expect(stepFacts(step, 10_000, undefined).text).toBe("attempt 2 of 3 · 6 s");
    expect(stepFacts(step, 70_000, undefined).text).toBe("attempt 2 of 3 · 1 m 06 s");
  });

  it("says there is no log for a step that has no attempt", () => {
    expect(stepFacts({}, 0, undefined)).toEqual({ text: "no log", spoken: "no log" });
  });
});

describe("attemptFacts", () => {
  it("is the clock time, the time it took and its transcript's size", () => {
    const at = new Date(2026, 10, 27, 14, 16).getTime();
    expect(attemptFacts({ startedAt: at, durationMs: 82_000, result: "failed", transcriptSaved: true, transcriptBytes: 12 * 1024 }, 0).text).toBe("14:16 · 1 m 22 s · 12 KB");
  });

  it("has no size for a transcript that was not saved or an attempt that has not said", () => {
    expect(attemptFacts({ durationMs: 82_000, result: "failed", transcriptSaved: false, transcriptBytes: 5 }, 0).text).toBe("1 m 22 s");
    expect(attemptFacts({ durationMs: 82_000, result: "failed" }, 0).text).toBe("1 m 22 s");
  });
});

describe("logFacts", () => {
  it("counts every agent step, even one that did not run, and shows the size when it is known", () => {
    const steps = [{ attempts: [ended({ transcriptSaved: true, transcriptBytes: 61_440 })] }, { attempts: [ended(), ended({ attempt: 2 })] }, {}];
    expect(logFacts([steps[0]!])).toBe("1 step · 1 attempt · 60 KB");
    expect(logFacts(steps)).toBe("3 steps · 3 attempts");
  });
});

describe("plannedChecks", () => {
  const setup = {
    templates: [
      { id: "own", steps: [{ checks: { commands: ["pnpm test", "pnpm lint"] } }] },
      { id: "repo", steps: [{ checks: { from: "repo" } }, {}] },
    ],
    repos: [{ id: "orders-api", checks: ["pnpm test"] }],
  } as never;

  const item = (templateId: string, repoIds: string[]) => ({ templateId, repoIds }) as never;

  it("is the template's commands, or the repo's when the template takes them from it", () => {
    expect(plannedChecks(item("own", ["orders-api"]), setup, 0)).toEqual(["pnpm test", "pnpm lint"]);
    expect(plannedChecks(item("repo", ["orders-api"]), setup, 0)).toEqual(["pnpm test"]);
  });

  it("is none for a step without checks, an unknown template or no setup", () => {
    expect(plannedChecks(item("repo", []), setup, 1)).toEqual([]);
    expect(plannedChecks(item("gone", []), setup, 0)).toEqual([]);
    expect(plannedChecks(item("own", []), undefined, 0)).toEqual([]);
  });
});
