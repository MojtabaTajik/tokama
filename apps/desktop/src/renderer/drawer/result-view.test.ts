import type { ItemRecord } from "@tokama/core";
import { describe, expect, it } from "vitest";
import { setup } from "../testing/drawer.js";
import { followUpText, resultView } from "./result-view.js";

const attempt = (over: Record<string, unknown> = {}) => ({ attempt: 1, result: "passed", checks: [], ...over });
const check = (command: string, passed = true) => ({ command, passed, exitCode: passed ? 0 : 1 });
const said = (over: Record<string, unknown> = {}) => ({ source: "headline", headline: "Receipt total now includes tax.", points: [], morePoints: 0, bodyBytes: 90, ...over });

const plan = { name: "Plan", stage: "working", state: "passed", agentId: "architect", data: "repo-and-diff", doneWhen: "you approve", attempts: [attempt()] };
const build = { name: "Build", stage: "working", state: "passed", agentId: "local-builder", data: "none", doneWhen: "agent finishes", attempts: [attempt({ said: said() })] };
const checks = { name: "Run checks", stage: "working", state: "passed", data: "none", doneWhen: "checks pass", attempts: [attempt({ checks: [check("pnpm lint"), check("pnpm test")] })] };
const review = { name: "Review", stage: "review", state: "passed", agentId: "reviewer", data: "repo-and-diff", doneWhen: "reviewer approves", attempts: [attempt()] };

const item = (steps: object[], over: Record<string, unknown> = {}): ItemRecord =>
  ({
    schemaVersion: 1,
    id: "item_1a2b3c4d-0030-4a1b-8c1d-000000000030",
    kind: "task",
    templateId: "builtin/plan-and-build",
    title: "Add order export endpoint",
    text: "",
    repoIds: ["orders-api"],
    privacy: "local_and_cloud",
    state: "done",
    createdAt: 1_760_000_000_000,
    steps,
    outcome: { kind: "done", commits: [{ repoId: "orders-api", commit: "3f2a9c1d4e5f60718293a4b5c6d7e8f901234567", branch: "tokama/0b9f3c1e" }] },
    ...over,
  }) as unknown as ItemRecord;

const rowsOf = (record: ItemRecord) => resultView(record, setup).rows.map((row) => [row.key, row.mark?.symbol ?? "", row.text, row.detail ?? ""]);

describe("the facts of a done item", () => {
  it("names the checks that passed, the reviewer that approved, and who got what", () => {
    expect(rowsOf(item([plan, build, checks, review]))).toEqual([
      ["checked", "✓", "2 of 2 checks passed", "pnpm lint · pnpm test"],
      ["reviewed", "✓", "Reviewer approved", "Codex CLI · gpt-5-codex"],
      ["sent", "↗", "Code and diffs to Claude Code and Codex CLI", ""],
    ]);
  });

  it("says on which attempt the checks passed when it was not the first", () => {
    const retried = { ...checks, maxAttempts: 3, attempts: [attempt({ checks: [check("pnpm test", false)], result: "failed" }), attempt({ attempt: 2, result: "failed", checks: [check("pnpm test", false)] }), attempt({ attempt: 3, checks: [check("pnpm test")] })] };
    expect(rowsOf(item([plan, build, retried, review]))[0]).toEqual(["checked", "✓", "1 of 1 check passed, on attempt 3 of 3", "pnpm test"]);
  });

  it("counts only the latest attempt of each step, and names the check that failed with its exit code", () => {
    const failing = { ...checks, state: "failed", attempts: [attempt({ result: "failed", checks: [check("pnpm lint"), check("pnpm test", false)] })] };
    expect(rowsOf(item([plan, build, failing], { state: "failed", outcome: undefined }))[0]).toEqual(["checked", "✕", "1 of 2 checks passed", "pnpm test exit 1"]);
  });

  it("warns when the template runs no checks, and when it has a checks step that recorded none", () => {
    expect(rowsOf(item([plan, build, review]))[0]).toEqual(["checked", "!", "This template runs no checks", ""]);
    expect(rowsOf(item([plan, build, { ...checks, attempts: [attempt()] }, review]))[0]).toEqual(["checked", "!", "No checks ran", ""]);
  });

  it("leaves Checked out for an item that ended with nothing to change", () => {
    expect(rowsOf(item([plan, build], { outcome: { kind: "no_action_needed" } })).map(([key]) => key)).toEqual(["reviewed", "sent"]);
  });

  it("says a missing review with the template's name, so it is seen and not guessed", () => {
    expect(rowsOf(item([plan, build, checks]))[1]).toEqual(["reviewed", "–", "Plan and build has no review step", ""]);
    // A template the setup does not list is named by its id.
    expect(resultView(item([plan, build, checks], { templateId: "acme/quick-fix" }), setup).rows[1]?.text).toBe("acme/quick-fix has no review step");
  });

  it("says a reviewer that asked for changes, not the review of an earlier run that failed", () => {
    const asked = { ...review, state: "failed", attempts: [attempt({ result: "failed" }), attempt({ attempt: 2, result: "run_failed" })] };
    expect(rowsOf(item([plan, build, checks, asked], { state: "failed", outcome: undefined }))[1]).toEqual(["reviewed", "!", "Reviewer asked for changes", ""]);
    const never = { ...review, state: "pending", attempts: undefined };
    expect(rowsOf(item([plan, build, checks, never], { state: "failed", outcome: undefined }))[1]).toEqual(["reviewed", "–", "Review did not run", ""]);
  });

  it("lists a step that never ran nowhere in what was sent out, and says nothing left only when no step that ran may send", () => {
    const neverRan = { ...review, state: "pending", attempts: undefined };
    expect(rowsOf(item([{ ...plan, data: "none" }, build, checks, neverRan], { state: "failed", outcome: undefined })).at(-1)).toEqual(["sent", "", "Nothing: local only", ""]);
    expect(rowsOf(item([plan, build, checks, neverRan], { state: "failed", outcome: undefined })).at(-1)).toEqual(["sent", "↗", "Code and diffs to Claude Code", ""]);
  });

  it("separates what each data rule sent, and a step that ran without attempts (an old record) still counts", () => {
    const summary = { name: "Propose a fix", stage: "review", state: "passed", agentId: "reviewer", data: "summary-after-approval", doneWhen: "you approve" };
    expect(rowsOf(item([plan, summary])).at(-1)?.[2]).toBe("Code and diffs to Claude Code · The summary you approved to Codex CLI");
  });

  it("lists no local agent, whatever its data rule allows: it ran on this machine", () => {
    const local = { ...build, data: "repo-and-diff" };
    expect(rowsOf(item([{ ...plan, data: "none" }, local])).at(-1)).toEqual(["sent", "", "Nothing: local only", ""]);
  });

  it("does not list a cloud step that stopped at its approval question, and adds the branch Open PR pushed", () => {
    const asked = { name: "Propose a fix", stage: "review", state: "stopped", agentId: "reviewer", data: "summary-after-approval", doneWhen: "you approve" };
    expect(rowsOf(item([{ ...plan, data: "none" }, asked], { state: "stopped", outcome: undefined })).at(-1)).toEqual(["sent", "", "Nothing: local only", ""]);
    const pushed = item([{ ...plan, data: "none" }, build], { finish: { worktreeRemoved: false, pushTarget: "github.com/northwind/orders-api", pullRequest: { url: "https://github.com/northwind/orders-api/pull/1" } } });
    expect(rowsOf(pushed).at(-1)).toEqual(["sent", "↗", "The branch to github.com/northwind/orders-api", ""]);
  });

  it("names a step's agent by its id when the setup does not list it", () => {
    const stranger = { ...plan, agentId: "retired-agent" };
    expect(rowsOf(item([stranger])).at(-1)?.[2]).toBe("Code and diffs to retired-agent");
  });
});

describe("an investigation", () => {
  const find = { name: "Find the cause", stage: "working", state: "passed", agentId: "local-investigator", data: "none", doneWhen: "agent finishes", attempts: [attempt()] };
  const approve = { name: "Propose a fix", stage: "review", state: "passed", agentId: "architect", data: "summary-after-approval", doneWhen: "you approve", attempts: [attempt()] };

  it("says what you approved and has no Reviewed row", () => {
    expect(rowsOf(item([find, approve], { kind: "investigation", outcome: { kind: "done" } }))).toEqual([
      ["checked", "✓", "You approved the findings", ""],
      ["sent", "↗", "The summary you approved to Claude Code", ""],
    ]);
  });

  it("has no Checked row when nothing was approved", () => {
    expect(rowsOf(item([find], { kind: "investigation", outcome: { kind: "done" } })).map(([key]) => key)).toEqual(["sent"]);
  });
});

describe("a record the template's own words do not describe", () => {
  it("says what was measured and what was sent, and claims nothing about what a template lacks", () => {
    const bare = [{ ...plan, doneWhen: undefined }, { ...build, doneWhen: undefined }];
    expect(rowsOf(item(bare)).map(([key]) => key)).toEqual(["sent"]);
  });
});

describe("followUpText", () => {
  const withText = (text: string) => item([{ ...build, attempts: [attempt({ said: said({ headline: "Done." }) })] }], { text });

  it("puts the question, the headline and the points together", () => {
    expect(followUpText(withText("How hard is it?"))).toBe("How hard is it?\n\nThe answer: Done.");
  });

  it("stays within 4000 UTF-16 units, and never leaves half an emoji at the cut", () => {
    // The 4000th unit is the first half of an emoji.
    const long = followUpText(withText(`${"a".repeat(3999)}😀${"b".repeat(100)}`))!;
    expect(long.length).toBe(3999);
    expect(long.endsWith("a")).toBe(true);
    const plain = followUpText(withText("a".repeat(5000)))!;
    expect(plain.length).toBe(4000);
  });
});

describe("the agent's words", () => {
  const words = (steps: object[], over: Record<string, unknown> = {}) => resultView(item(steps, over), setup).words;

  it("has a headline in three sizes: one line, points with Read more, and a must-read", () => {
    expect(words([plan, build])).toMatchObject({ kind: "said", agent: "Local builder", stepIndex: 1, headline: "Receipt total now includes tax.", points: [], read: undefined, more: undefined });
    const points = { ...build, attempts: [attempt({ said: said({ points: ["Not done: columns."], morePoints: 1, bodyBytes: 2450 }) })] };
    expect(words([plan, points])).toMatchObject({ kind: "said", points: ["Not done: columns."], morePoints: 1, more: "2.4 KB" });
    const mustRead = { ...build, attempts: [attempt({ said: said({ bodyBytes: 3480, readMinutes: 6 }) })] };
    expect(words([plan, mustRead])).toMatchObject({ kind: "said", read: "read · 6 min", more: undefined });
  });

  it("offers no Read more when the reply was only the headline block", () => {
    const blockOnly = { ...build, attempts: [attempt({ said: said({ points: ["Not done: columns."], bodyBytes: 0 }) })] };
    expect(words([blockOnly])).toMatchObject({ points: ["Not done: columns."], more: undefined });
  });

  it("offers more to read for a long reply even when the agent wrote no points", () => {
    const long = { ...build, attempts: [attempt({ said: said({ bodyBytes: 1200 }) })] };
    expect(words([long])).toMatchObject({ more: "1.2 KB" });
  });

  it("shows the first lines the engine kept, as lines and not as a headline", () => {
    const lines = { ...build, attempts: [attempt({ said: said({ source: "first_lines", headline: "I updated the tax helper.", points: ["All tests pass now."], bodyBytes: 40 }) })] };
    expect(words([lines])).toEqual({ kind: "lines", agent: "Local builder", stepIndex: 0, lines: ["I updated the tax helper.", "All tests pass now."], more: "40 B" });
  });

  it("asks for the first lines of the output of the last worker that passed when nothing was said, and of no reviewer", () => {
    const plain = { ...build, attempts: [attempt({ attempt: 2 })] };
    expect(words([plan, plain, checks, review])).toEqual({ kind: "fetch", agent: "Local builder", stepIndex: 1, attempt: 2 });
    expect(words([checks])).toBeUndefined();
  });

  it("is the same for a discarded item: what it produced is still said", () => {
    const discarded = item([plan, build, checks, review], { finish: { worktreeRemoved: true } });
    expect(resultView(discarded, setup).words).toMatchObject({ kind: "said", headline: "Receipt total now includes tax." });
    expect(resultView(discarded, setup).failure).toBeUndefined();
  });
});

describe("an item that did not finish", () => {
  const stopped = (over: Record<string, unknown> = {}) => item([plan, { ...build, state: "failed", attempts: [attempt({ result: "failed", checks: [check("pnpm test", false)], said: said({ headline: "The retry test needs a fake clock." }) })] }], { state: "failed", outcome: undefined, ...over });

  it("says where it stopped, and what its agent said", () => {
    const view = resultView(stopped(), setup);
    expect(view.failure).toBe("Stopped at Build, step 2 of 2: pnpm test failed");
    expect(view.words).toMatchObject({ kind: "said", agent: "Local builder", headline: "The retry test needs a fake clock." });
    expect(view.rows.map((row) => [row.key, row.mark?.symbol, row.text])).toEqual([
      ["checked", "✕", "0 of 1 check passed"],
      ["reviewed", "–", "Plan and build has no review step"],
      ["sent", "↗", "Code and diffs to Claude Code"],
    ]);
  });

  it("shows no first lines of its output in the agent's place", () => {
    const silent = item([plan, { ...build, state: "failed", attempts: [attempt({ result: "failed" })] }], { state: "failed", outcome: undefined });
    expect(resultView(silent, setup).words).toBeUndefined();
  });

  it("is the same for a stopped item", () => {
    expect(resultView(stopped({ state: "stopped" }), setup).failure).toContain("Stopped at Build");
  });
});
