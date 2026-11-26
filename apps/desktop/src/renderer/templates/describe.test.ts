import { parseQueryResult, ROUND_TRIPS as ENGINE_ROUND_TRIPS, type TemplateStepView, type TemplateView } from "@tokama/core";
import { describe, expect, it } from "vitest";
import { setup } from "../testing/sample.js";
import { builtinEntry, flakyDetail, flakyEntry, planAndBuild, planDetail } from "../testing/templates.js";
import { agentPhrase, andList, budgetText, FINISH, placeOf, startSentence, statusOf, stepSentence, titleOf, usesOf } from "./describe.js";
import { ROUND_TRIPS } from "./limits.js";

const agents = setup.agents;
const [plan, build, review] = planAndBuild.steps as [TemplateStepView, TemplateStepView, TemplateStepView];
const sentenceOf = (fields: Partial<TemplateStepView>, template: TemplateView = planAndBuild) => stepSentence({ ...build, ...fields } as TemplateStepView, template, agents);

describe("the test data", () => {
  it("is valid engine data", () => {
    expect(parseQueryResult("template_detail", planDetail)).toMatchObject({ ok: true });
    expect(parseQueryResult("template_detail", flakyDetail)).toMatchObject({ ok: true });
  });
});

describe("stepSentence", () => {
  it("says each step of Plan and build in one sentence", () => {
    expect(planAndBuild.steps.map((step) => stepSentence(step, planAndBuild, agents))).toEqual([
      "Architect (Claude Code, cloud) works in the item’s worktree; sends the repo and diff to the cloud; done when you approve; if it fails, ask you.",
      "Local builder (Claude Code, this machine) works in the item’s worktree; done when the repo’s checks pass; if checks fail, try again, up to 3 attempts.",
      "Reviewer (Codex CLI, cloud) reviews the work; sends the repo and diff to the cloud; done when it approves; if it asks for changes, send the work back to Build and check again after each fix, up to 3 round trips, then ask you.",
    ]);
  });

  it.each([
    [{ doneWhen: "agent finishes", ifFailed: { action: "stop" } }, "done when the agent finishes; if it fails, stop."],
    [{ doneWhen: "checks pass", checks: { commands: ["pnpm test"] } }, "done when pnpm test passes;"],
    [{ doneWhen: "checks pass", checks: { commands: ["pnpm test", "pnpm lint"] } }, "done when pnpm test and pnpm lint pass;"],
    [{ ifFailed: { action: "back", stepId: "plan" }, maxAttempts: 2 }, "if checks fail, send the work back to Plan and run again after it, up to 3 round trips, then ask you."],
    [{ ifFailed: { action: "back", stepId: "build" }, maxAttempts: 2 }, "if checks fail, try again, up to 2 attempts."],
    [{ ifFailed: { action: "retry" }, maxAttempts: 1 }, "try again, up to 1 attempt."],
    [{ doneWhen: "reviewer approves", ifChangesRequested: { action: "ask" } }, "if it asks for changes, ask you."],
    [{ doneWhen: "reviewer approves", ifChangesRequested: { action: "back", stepId: "build" }, maxAttempts: 1 }, "if it asks for changes, try again, up to 1 attempt."],
    [{ doneWhen: "reviewer approves", ifChangesRequested: { action: "back", stepId: "plan" } }, "if it asks for changes, send the work back to Plan and check again after each fix, up to 3 round trips, then ask you."],
  ] as const)("says %j as …%s", (fields, ending) => {
    expect(sentenceOf(fields as Partial<TemplateStepView>)).toContain(ending);
  });

  it("says only the changes-requested rule of a reviewer step, never its failure rule", () => {
    const onlyFailed = sentenceOf({ doneWhen: "reviewer approves", ifFailed: { action: "back", stepId: "plan" }, ifChangesRequested: undefined } as Partial<TemplateStepView>);
    expect(onlyFailed).toContain("if it asks for changes, ask you.");
    expect(onlyFailed).not.toContain("if it fails");
    expect(onlyFailed).not.toContain("send the work back");
    const both = sentenceOf({ doneWhen: "reviewer approves", ifFailed: { action: "stop" }, ifChangesRequested: { action: "back", stepId: "plan" } } as Partial<TemplateStepView>);
    expect(both).toContain("if it asks for changes, send the work back to Plan");
    expect(both).not.toContain("stop");
  });

  it("does not tie the round trips to max_attempts", () => {
    const back = { ifFailed: { action: "back", stepId: plan.id } } as const;
    expect(sentenceOf({ ...back, maxAttempts: 1 })).toBe(sentenceOf({ ...back, maxAttempts: 5 }));
  });

  it("keeps the round-trip cap equal to the engine's", () => {
    expect(ROUND_TRIPS).toBe(ENGINE_ROUND_TRIPS);
  });

  it("names what a cloud step sends, and nothing for a local one", () => {
    expect(sentenceOf({ agentId: "architect", data: "summary-after-approval" } as Partial<TemplateStepView>)).toContain("sends a summary to the cloud after you approve it");
    expect(sentenceOf({ agentId: "architect", data: "none" } as Partial<TemplateStepView>)).toContain("sends nothing to the cloud");
    expect(sentenceOf({ data: "repo-and-diff" })).not.toContain("cloud");
  });

  it("says how the step works by the repo access", () => {
    const read = { ...planAndBuild, uses: { ...planAndBuild.uses, repos: { picked: "read", named: [] } } } as TemplateView;
    const none = { ...planAndBuild, uses: { ...planAndBuild.uses, repos: { named: [] } } } as TemplateView;
    expect(stepSentence(plan, read, agents)).toContain("reads the repo");
    expect(stepSentence(plan, none, agents)).toContain("works on the task");
  });

  it("names the step's connections by their names", () => {
    const step = { ...plan, connections: [{ connectionId: "app-insights-prod", access: "query" }] } as TemplateStepView;
    expect(stepSentence(step, planAndBuild, agents, setup.connections as never)).toContain("uses App Insights · prod (query)");
  });

  it("names an agent that is not set up by its id", () => {
    expect(agentPhrase("reviewr", agents)).toBe("reviewr (not set up)");
    expect(stepSentence({ ...review, agentId: "reviewr" } as TemplateStepView, planAndBuild, agents)).toMatch(/^Reviewr \(not set up\) reviews the work;/);
  });
});

describe("startSentence", () => {
  it("says what New work asks for", () => {
    expect(startSentence(planAndBuild)).toBe("Needs a task description and one repo.");
    expect(startSentence({ start: { needs: ["text", "repos"], askBeforeCloud: true, notify: true } })).toBe(
      "Needs a task description and one or more repos. Asks before each cloud step. Sends a notification when it needs you or ends.",
    );
    expect(startSentence({ start: { needs: [], askBeforeCloud: false, notify: false } })).toBe("Needs nothing to start.");
  });
});

describe("usesOf", () => {
  it("lists repos, connections with the steps that use them, and commands", () => {
    const template = {
      ...planAndBuild,
      uses: { repos: { picked: "read", named: [{ repoId: "orders-api", access: "edit" }] }, connections: [{ connectionId: "app-insights-prod", access: "query" }, { connectionId: "gone", access: "read" }], commands: ["gh"] },
      steps: [{ ...plan, connections: [{ connectionId: "app-insights-prod", access: "query" }] }, build],
    } as TemplateView;
    expect(usesOf(template, setup.connections as never)).toEqual({
      repos: [
        { name: "the repo you pick", detail: "read · no worktree" },
        { name: "orders-api", detail: "edit" },
      ],
      connections: [
        { name: "App Insights · prod", detail: "query · used by Plan" },
        { name: "gone", detail: "read" },
      ],
      commands: ["gh"],
    });
  });
});

describe("the list row", () => {
  it("has a symbol and a word for the state", () => {
    expect(statusOf(planDetail.entry)).toEqual({ symbol: "✓", word: "valid", tone: "pass" });
    expect(statusOf(flakyEntry)).toEqual({ symbol: "✕", word: "2 problems", tone: "fail" });
    expect(statusOf({ problemCount: 1 }).word).toBe("1 problem");
  });

  it("names the place and falls back to the file name", () => {
    expect(placeOf(flakyEntry)).toBe("checkout-web/.tokama/templates/flaky-test-fix.yaml");
    expect(placeOf(builtinEntry)).toBe("built-in");
    expect(titleOf(flakyEntry)).toBe("flaky-test-fix.yaml");
    expect(titleOf(builtinEntry)).toBe("Quick fix");
  });
});

describe("the finish words", () => {
  it("names the outside-changes finish", () => {
    expect(FINISH["outside-changes"]).toEqual({ name: "Outside changes", text: "made outside the repo, such as tickets" });
  });
});

describe("small words", () => {
  it("joins lists and times", () => {
    expect(andList([])).toBe("");
    expect(andList(["a"])).toBe("a");
    expect(andList(["a", "b", "c"])).toBe("a, b and c");
    expect(budgetText(90)).toBe("1 h 30 m");
    expect(budgetText(45)).toBe("45 m");
    expect(budgetText(120)).toBe("2 h 00 m");
  });
});
