import { describe, expect, it } from "vitest";
import { err, ok, type Result } from "../../kernel/result/index.js";
import { TemplateRecordSchema, type TemplateRecord, type TemplateRef } from "../../kernel/schemas/index.js";
import { clean, quote } from "./quote.js";
import { closest } from "./suggest.js";
import { validateTemplate, type AgentLocation, type TemplateProblem } from "./validate.js";

const AGENTS: ReadonlyMap<string, AgentLocation> = new Map([
  ["builder", { cloud: true }],
  ["reviewer", { cloud: true }],
  ["local-investigator", { cloud: false }],
]);

const files: Record<string, string> = { "fix.md": "Fix the bug.\n" };
const readInstructions = async (file: string): Promise<Result<string, string>> =>
  file in files ? ok(files[file]!) : err("does not exist");

function validate(text: string, agents = AGENTS) {
  return validateTemplate(text, {
    ref: "orders-api/sample" as TemplateRef,
    source: { kind: "repo", repoId: "orders-api" as never, file: ".tokama/templates/sample.yaml" },
    agents,
    readInstructions,
  });
}

async function problems(text: string, agents = AGENTS): Promise<TemplateProblem[]> {
  const result = await validate(text, agents);
  if (result.ok) throw new Error("expected problems, got a template");
  return result.error;
}

async function record(text: string): Promise<TemplateRecord> {
  const result = await validate(text);
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

// One cloud step that edits the picked repo, then a cloud reviewer. Tests change one line of it.
const BASE = `format: 1
name: Plan and build
uses:
  repos: edit
start:
  needs: [text, repo]
steps:
  - id: build
    name: Build
    agent: builder
    instructions: fix.md
    done_when: checks pass
    checks: [pnpm test]
    if_failed: retry
    data: repo-and-diff
  - id: review
    name: Review
    agent: reviewer
    instructions: Review the diff.
    done_when: reviewer approves
    if_changes_requested: { back: build }
    max_attempts: 2
    data: repo-and-diff
finish: [commit]
`;
const edit = (from: string, to: string) => {
  if (!BASE.includes(from)) throw new Error(`not in BASE: ${from}`);
  return BASE.replace(from, to);
};

describe("validateTemplate: a valid template", () => {
  it("fills the defaults and reads instruction files", async () => {
    const template = await record(BASE);
    expect(template).toMatchObject({
      schemaVersion: 2,
      ref: "orders-api/sample",
      id: "sample",
      uses: { repos: { picked: "edit", named: [] }, connections: [], commands: [] },
      start: { needs: ["text", "repo"], askBeforeCloud: false, notify: false },
      finish: ["commit"],
    });
    expect(template.steps[0]).toEqual({
      id: "build",
      name: "Build",
      agentId: "builder",
      instructions: { file: "fix.md", text: "Fix the bug.\n" },
      doneWhen: "checks pass",
      checks: { commands: ["pnpm test"] },
      ifFailed: { action: "retry" },
      maxAttempts: 3,
      data: "repo-and-diff",
      sees: [],
      connections: [],
      commands: [],
    });
    expect(template.steps[1]).toMatchObject({
      instructions: { text: "Review the diff." },
      ifFailed: { action: "ask" },
      ifChangesRequested: { action: "back", stepId: "build" },
      maxAttempts: 2,
    });
  });

  it("produces a record that survives JSON and its own schema", async () => {
    const template = await record(BASE);
    expect(TemplateRecordSchema.parse(JSON.parse(JSON.stringify(template)))).toEqual(template);
  });

  it("gives local steps every earlier result by default and cloud steps none", async () => {
    const template = await record(`format: 1
name: Investigate
uses:
  connections: { app-insights: read }
steps:
  - id: query
    name: Query
    agent: local-investigator
    instructions: Look at the errors.
    uses: { connections: { app-insights: read } }
  - id: dig
    name: Dig
    agent: local-investigator
    instructions: Dig deeper.
  - id: plan
    name: Plan
    agent: builder
    instructions: Plan the fix.
    data: summary-after-approval
    sees: [dig]
  - id: summary
    name: Summary
    agent: builder
    instructions: Summarize.
    data: summary-after-approval
finish: [findings]
budget: { time: 1h30m }
`);
    expect(template.steps.map((step) => step.sees)).toEqual([[], ["query"], ["dig"], []]);
    expect(template.steps[0]?.data).toBe("none");
    expect(template.steps[0]?.connections).toEqual([{ connectionId: "app-insights", access: "read" }]);
    expect(template.uses.repos).toEqual({ named: [] });
    expect(template.start.needs).toEqual(["text"]);
    expect(template.budget).toEqual({ timeMinutes: 90 });
  });

  it("takes named repos, setup, run options, icon and colour", async () => {
    const template = await record(`format: 1
name: Refine
icon: list-check
color: teal
uses:
  repos: { orders-api: read }
  connections: { azure-boards: write }
start: { needs: [text], ask_before_cloud: true, notify: true }
setup: pnpm install
steps:
  - id: refine
    name: Refine
    agent: local-investigator
    instructions: Refine the ticket.
    icon: pen
    color: plum
finish: [document, outside-changes]
`);
    expect(template).toMatchObject({
      icon: "list-check",
      color: "teal",
      setup: "pnpm install",
      uses: { repos: { named: [{ repoId: "orders-api", access: "read" }] } },
      start: { askBeforeCloud: true, notify: true },
      finish: ["document", "outside-changes"],
    });
    expect(template.steps[0]).toMatchObject({ icon: "pen", color: "plum" });
  });
});

describe("validateTemplate: rules", () => {
  it("refuses an unknown agent, with its line and a suggestion", async () => {
    expect(await problems(edit("agent: builder", "agent: buildr"))).toEqual([
      { line: 10, message: 'Step "build" uses agent "buildr", which is not set up. Did you mean "builder"?' },
    ]);
  });

  it("lists the agents when nothing is close", async () => {
    const [problem] = await problems(edit("agent: builder", "agent: zzz"));
    expect(problem?.message).toBe('Step "build" uses agent "zzz", which is not set up. Agents set up: builder, reviewer, local-investigator.');
  });

  it("refuses two steps with the same id", async () => {
    expect(await problems(edit("id: review", "id: build"))).toContainEqual({
      line: 16,
      message: 'Two steps have the id "build"; step ids must be different.',
    });
  });

  it("refuses a back target that does not exist", async () => {
    expect(await problems(edit("{ back: build }", "{ back: biuld }"))).toEqual([
      { line: 21, message: 'Step "review": "if_changes_requested" goes back to "biuld", which is not a step in this template. Did you mean "build"?' },
    ]);
  });

  it("refuses a back target written on its own line, with that line", async () => {
    const text = edit("    if_failed: retry\n", "    if_failed:\n      back: nowhere\n");
    expect(await problems(text)).toEqual([
      { line: 15, message: 'Step "build": "if_failed" goes back to "nowhere", which is not a step in this template.' },
    ]);
  });

  describe("every loop is bounded", () => {
    it("refuses a back target that comes later, which is not a loop back", async () => {
      expect(await problems(edit("if_failed: retry", "if_failed: { back: review }"))).toEqual([
        { line: 14, message: 'Step "build": "if_failed" goes back to "review", which comes later; back can only go to this step or an earlier one.' },
      ]);
    });

    it.each([
      ["0", '"max_attempts" must be at least 1.'],
      ["11", '"max_attempts" must be at most 10.'],
      ["1.5", '"max_attempts" must be a whole number.'],
      [".inf", '"max_attempts" must be a whole number.'],
      ["many", '"max_attempts" must be a whole number.'],
    ])("refuses max_attempts: %s", async (value, message) => {
      expect(await problems(edit("max_attempts: 2", `max_attempts: ${value}`))).toEqual([{ line: 22, message: `Step "review": ${message}` }]);
    });
  });

  it("refuses a reviewer that uses the agent of the step it reviews", async () => {
    expect(await problems(edit("agent: reviewer", "agent: builder"))).toEqual([
      { line: 18, message: 'Step "review" reviews step "build", so it needs a different agent; both use "builder".' },
    ]);
  });

  it("takes the step before a reviewer as the reviewed step when changes are not sent back", async () => {
    const text = edit("if_changes_requested: { back: build }", "if_changes_requested: ask").replace("agent: reviewer", "agent: builder");
    expect((await problems(text)).map((p) => p.message)).toEqual([
      'Step "review" reviews step "build", so it needs a different agent; both use "builder".',
    ]);
  });

  it("refuses a reviewer as the first step", async () => {
    const text = `format: 1
name: Only review
steps:
  - id: review
    name: Review
    agent: local-investigator
    instructions: Review.
    done_when: reviewer approves
finish: [findings]
`;
    expect(await problems(text)).toEqual([
      { line: 8, message: 'Step "review" waits for a reviewer, but there is no earlier step for it to review.' },
    ]);
  });

  it("refuses a cloud agent on a step with data: none", async () => {
    expect(await problems(edit("    data: repo-and-diff\n  - id: review", "    data: none\n  - id: review"))).toEqual([
      {
        line: 15,
        message: 'Step "build" has data: none, but "builder" is a cloud agent and would get nothing. Use summary-after-approval or repo-and-diff, or a local agent.',
      },
    ]);
  });

  it("refuses a cloud step that does not say what may leave the machine", async () => {
    expect(await problems(edit("    data: repo-and-diff\n  - id: review", "  - id: review"))).toEqual([
      {
        line: 10,
        message:
          'Step "build" runs on "builder", a cloud agent, so it must say what may leave this machine: add data: summary-after-approval or data: repo-and-diff.',
      },
    ]);
  });

  it("refuses a cloud step with connections, and connections the template does not list", async () => {
    const text = edit("    data: repo-and-diff\n  - id: review", "    data: repo-and-diff\n    uses: { connections: { app-insigts: read } }\n  - id: review");
    expect(await problems(text)).toEqual([
      { line: 16, message: 'Step "build" runs on "builder", a cloud agent, and cloud steps cannot use connections. Remove them or use a local agent.' },
      { line: 16, message: 'Step "build" uses connection "app-insigts", which the template does not list in uses.connections.' },
    ]);
  });

  it("refuses a missing instructions file", async () => {
    expect(await problems(edit("instructions: fix.md", "instructions: instructions/missing.md"))).toEqual([
      { line: 11, message: 'Step "build": the instructions file "instructions/missing.md" does not exist.' },
    ]);
  });

  it.each(["../secrets.md", "/etc/notes.md", "docs/../../x.md"])("refuses the instructions path %s", async (path) => {
    expect(await problems(edit("instructions: fix.md", `instructions: ${path}`))).toEqual([
      { line: 11, message: `Step "build": the instructions file "${path}" must be a path inside the templates folder, without "..".` },
    ]);
  });

  it("refuses instruction files where no reader is given (built-ins)", async () => {
    const result = await validateTemplate(BASE, { ref: "builtin/sample" as TemplateRef, source: { kind: "builtin" }, agents: AGENTS });
    expect(result.ok ? [] : result.error).toEqual([
      { line: 11, message: 'Step "build": built-in templates keep their instructions inline, not in "fix.md".' },
    ]);
  });

  it("refuses checks on a step that does not wait for them, and if_changes_requested without a reviewer", async () => {
    const text = edit("done_when: checks pass", "done_when: agent finishes").replace("done_when: reviewer approves", "done_when: you approve");
    expect((await problems(text)).map((p) => p.line)).toEqual([13, 21]);
  });

  it("refuses sees that name an unknown or a later step", async () => {
    const text = edit("    if_failed: retry\n", "    if_failed: retry\n    sees: [review, buld]\n");
    expect(await problems(text)).toEqual([
      { line: 15, message: 'Step "build" sees "review", but a step can only see the results of earlier steps.' },
      { line: 15, message: 'Step "build" sees "buld", which is not a step in this template. Did you mean "build"?' },
    ]);
  });

  it("refuses repos: edit when Start picks no repo", async () => {
    expect(await problems(edit("needs: [text, repo]", "needs: [text]"))).toEqual([
      {
        line: 4,
        message: '"repos: edit" gives access to the repos picked at Start, but start.needs asks for no repo. Add repo to start.needs, or name the repos.',
      },
      { line: 24, message: '"finish: commit" needs a repo with edit access, but uses.repos gives none.' },
    ]);
  });

  it("refuses a budget outside 1m to 24h", async () => {
    expect(await problems(`${BASE}budget: { time: 25h }\n`)).toEqual([{ line: 25, message: '"time" must be between 1m and 24h, for example 90m or 2h.' }]);
  });

  it("reports every problem of a file at once, in line order", async () => {
    const text = edit("agent: builder", "agent: nobody").replace("{ back: build }", "{ back: nope }");
    expect((await problems(text)).map((p) => p.line)).toEqual([10, 21]);
  });
});

describe("validateTemplate: shape problems in plain words", () => {
  it("names an unknown field on its own line, with a suggestion", async () => {
    expect(await problems(edit("done_when: checks pass", "done_wen: checks pass"))).toEqual([
      { line: 12, message: 'Step "build" has an unknown field "done_wen". Did you mean "done_when"?' },
    ]);
    expect(await problems(`${BASE}colour: sky\n`)).toEqual([{ line: 25, message: 'The template has an unknown field "colour". Did you mean "color"?' }]);
  });

  it("lists the words a field takes, with a suggestion", async () => {
    expect(await problems(edit("if_failed: retry", "if_failed: retyr"))).toEqual([
      { line: 14, message: 'Step "build": "if_failed" must be retry, ask, stop or back: <step id>. Did you mean "retry"?' },
    ]);
    expect(await problems(edit("finish: [commit]", "finish: [comit]"))).toEqual([
      { line: 24, message: '"finish" must be commit, pull-request, findings, document or outside-changes. Did you mean "commit"?' },
    ]);
  });

  it("says the old finish word is now called outside-changes", async () => {
    expect(await problems(edit("finish: [commit]", "finish: [update-tickets]"))).toEqual([
      { line: 24, message: '"finish" no longer takes update-tickets; it is now called outside-changes.' },
    ]);
  });

  it("names a missing field on the line of the step", async () => {
    expect(await problems(edit("    agent: reviewer\n", ""))).toEqual([{ line: 16, message: 'Step "review": "agent" is missing.' }]);
  });

  it("explains a back target written on the same line as its field", async () => {
    expect(await problems(edit("if_failed: retry", "if_failed: back: build"))).toEqual([
      { line: 14, message: 'Write "if_failed: { back: build }", or put "back: build" on its own line under "if_failed:".' },
    ]);
  });

  it("reports broken YAML, a repeated field and a second document", async () => {
    expect(await problems("name: [unclosed\nsteps: []\n")).toEqual([{ line: 2, message: expect.stringMatching(/^The file is not valid YAML: /) }]);
    expect(await problems(`${BASE}name: Again\n`)).toEqual([{ line: 25, message: "This field appears twice; keep one." }]);
    expect(await problems(`${BASE}---\nname: Other\n`)).toEqual([
      { line: 25, message: "A template file holds one template; remove the second document (after ---)." },
    ]);
  });

  it("refuses a file that is not a set of fields", async () => {
    for (const text of ["", "- a\n- b\n", "just text\n"]) {
      expect(await problems(text)).toEqual([{ line: 1, message: expect.stringContaining("A template is a set of fields") }]);
    }
  });

  it("refuses a bad id and a bad step id format", async () => {
    expect(await problems(edit("id: build", "id: Build"))).toEqual([
      { line: 8, message: 'Step "Build": "id" must be lowercase letters, digits and hyphens (at most 64).' },
    ]);
  });
});

describe("validateTemplate: every message is plain words", () => {
  it.each([
    ["a bad budget", `${BASE}budget: { time: 90 min }\n`, '"time" must be a time such as 90m, 2h or 1h30m.'],
    ["a list given as a word", edit("needs: [text, repo]", "needs: text"), '"needs" must be a list, such as [a, b].'],
    ["a step list given as a number", "format: 1\nname: X\nsteps: 3\nfinish: [commit]\n", '"steps" must be a list, such as [a, b].'],
    ["a wrong format", edit("format: 1", "format: 0"), '"format" must be 1.'],
    ["a number for if_failed", edit("if_failed: retry", "if_failed: 3"), 'Step "build": "if_failed" must be retry, ask, stop or back: <step id>.'],
    ["a wrong word in a repo map", edit("repos: edit", "repos: { orders-api: wrte }"), '"orders-api" must be read or edit.'],
  ])("for %s", async (_, text, message) => {
    const found = await problems(text);
    expect(found.map((p) => p.message)).toEqual([message]);
    for (const problem of found) expect(problem.message).not.toMatch(/Invalid|expected|\/\^/);
  });

  it("names an unknown field inside a back: map, on its line", async () => {
    expect(await problems(edit("if_failed: retry", "if_failed: { bak: build }"))).toEqual([
      { line: 14, message: 'Step "build": "back" is missing.' },
      { line: 14, message: 'Step "build": "if_failed" has an unknown field "bak". Did you mean "back"?' },
    ]);
  });

  it("asks for format: 1 when it is missing", async () => {
    expect(await problems(BASE.replace("format: 1\n", ""))).toEqual([{ line: 1, message: '"format" is missing: add format: 1 at the top of the file.' }]);
  });

  it("refuses more connections than a record can hold, instead of returning a record items cannot store", async () => {
    const many = Array.from({ length: 21 }, (_, i) => `c${i}: read`).join(", ");
    expect(await problems(edit("  repos: edit\n", `  repos: edit\n  connections: { ${many} }\n`))).toEqual([
      { line: 5, message: '"connections" has more than 20 entries.' },
    ]);
  });
});

const TEAM: ReadonlyMap<string, AgentLocation> = new Map([
  ["planner", { cloud: false }],
  ["architect", { cloud: true }],
  ["builder", { cloud: true }],
  ["writer", { cloud: true }],
  ["local", { cloud: false }],
]);

/** A template from step lines, with the picked repo editable so finish: [commit] is allowed. */
const steps = (body: string) => `format: 1
name: Team
uses:
  repos: edit
start:
  needs: [text, repo]
steps:
${body}finish: [commit]
`;
const step = (id: string, agent: string, extra = "") =>
  `  - id: ${id}\n    name: ${id}\n    agent: ${agent}\n    instructions: Do ${id}.\n    data: repo-and-diff\n${extra}`;
const review = (agent: string, extra = "") => step("review", agent, `    done_when: reviewer approves\n${extra}`);

async function teamProblems(text: string): Promise<string[]> {
  const result = await validate(text, TEAM);
  return result.ok ? [] : result.error.map((p) => p.message);
}
async function teamRecord(text: string): Promise<TemplateRecord> {
  const result = await validate(text, TEAM);
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

describe("reviewer independence: the reviewer may run no step in its range", () => {
  it("refuses a builder reviewing its own build when changes go back to plan", async () => {
    const text = steps(step("plan", "architect") + step("build", "builder") + review("builder", "    if_changes_requested: { back: plan }\n"));
    expect(await teamProblems(text)).toEqual(['Step "review" reviews step "build", so it needs a different agent; both use "builder".']);
  });

  it("accepts an architect reviewing builder work back to a plan someone else made", async () => {
    const text = steps(step("plan", "planner") + step("build", "builder") + review("architect", "    if_changes_requested: { back: plan }\n"));
    expect(await teamProblems(text)).toEqual([]);
  });

  it("refuses an architect reviewing back to a plan it made itself", async () => {
    const text = steps(step("plan", "architect") + step("build", "builder") + review("architect", "    if_changes_requested: { back: plan }\n"));
    expect(await teamProblems(text)).toEqual(['Step "review" reviews step "plan", so it needs a different agent; both use "architect".']);
  });

  it("refuses build(builder), docs(writer), review(builder): the range covers every step since the start", async () => {
    const text = steps(step("build", "builder") + step("docs", "writer") + review("builder"));
    expect(await teamProblems(text)).toEqual(['Step "review" reviews step "build", so it needs a different agent; both use "builder".']);
  });

  it("starts the range after the previous reviewer", async () => {
    const text = steps(
      step("build", "builder") +
        step("check", "writer", "    done_when: reviewer approves\n") +
        step("docs", "writer") +
        step("final", "builder", "    done_when: reviewer approves\n"),
    );
    expect(await teamProblems(text)).toEqual([]);
  });

  it("gives a reviewer if_changes_requested: ask by default", async () => {
    const template = await teamRecord(steps(step("build", "builder") + review("writer")));
    expect(template.steps[1]?.ifChangesRequested).toEqual({ action: "ask" });
    expect(template.steps[0]?.ifChangesRequested).toBeUndefined();
  });
});

describe("loops can loop", () => {
  it("gives a back target without max_attempts 3 attempts, and other steps 1", async () => {
    const text = steps(step("plan", "planner") + step("build", "builder") + review("writer", "    if_changes_requested: { back: plan }\n"));
    const template = await teamRecord(text);
    expect(template.steps.map((s) => [s.id, s.maxAttempts])).toEqual([
      ["plan", 3],
      ["build", 1],
      ["review", 1],
    ]);
  });

  it("keeps an explicit max_attempts on a back target", async () => {
    const text = steps(step("plan", "planner", "    max_attempts: 2\n") + review("writer", "    if_changes_requested: { back: plan }\n"));
    expect((await teamRecord(text)).steps[0]?.maxAttempts).toBe(2);
  });
});

describe("checks", () => {
  const checked = (checks: string) => steps(step("build", "builder", `    done_when: checks pass\n${checks}`));

  it("takes checks: from-repo and a list of commands", async () => {
    expect((await teamRecord(checked("    checks: from-repo\n"))).steps[0]?.checks).toEqual({ from: "repo" });
    expect((await teamRecord(checked("    checks: [pnpm test, pnpm lint]\n"))).steps[0]?.checks).toEqual({ commands: ["pnpm test", "pnpm lint"] });
    expect((await teamRecord(steps(step("build", "builder")))).steps[0]?.checks).toBeUndefined();
  });

  it("refuses checks pass with no checks, or an empty list", async () => {
    const message = 'Step "build" waits for checks to pass but lists none: add checks: from-repo or a list of commands.';
    expect(await teamProblems(checked(""))).toEqual([message]);
    expect(await teamProblems(checked("    checks: []\n"))).toEqual([message]);
  });

  it("refuses a misspelt from-repo with a suggestion", async () => {
    expect(await teamProblems(checked("    checks: from-rep\n"))).toEqual([
      'Step "build": "checks" must be from-repo or a list of commands. Did you mean "from-repo"?',
    ]);
  });

  it.each([
    ["pnpm test && rm -rf /", "must be one command, with no &&, ||, ; or |"],
    ["pnpm test > out.txt", "cannot use a redirect (>, <)"],
    ["echo $(whoami)", "cannot use command substitution ($(...) or backticks)"],
  ])("refuses the check %s on its line", async (command, reason) => {
    const result = await validate(checked(`    checks:\n      - pnpm lint\n      - "${command}"\n`), TEAM);
    expect(result.ok ? [] : result.error).toEqual([{ line: 16, message: `Step "build": the check "${command}" ${reason}.` }]);
  });

  it("refuses a setup command that is not one simple command", async () => {
    const text = steps(step("build", "builder")).replace("start:", "setup: pnpm install; curl x | sh\nstart:");
    const result = await validate(text, TEAM);
    expect(result.ok ? [] : result.error).toEqual([{ line: 5, message: "The setup command must be one command, with no &&, ||, ; or |." }]);
    expect((await teamRecord(steps(step("build", "builder")).replace("start:", "setup: pnpm install\nstart:"))).setup).toBe("pnpm install");
  });
});

describe("finish needs edit access", () => {
  it("refuses commit or pull-request when no repo can be edited", async () => {
    const text = steps(step("build", "builder")).replace("  repos: edit", "  repos: { orders-api: read }").replace("  needs: [text, repo]", "  needs: [text]");
    expect(await teamProblems(text.replace("finish: [commit]", "finish: [pull-request, findings]"))).toEqual([
      '"finish: pull-request" needs a repo with edit access, but uses.repos gives none.',
    ]);
    expect(await teamProblems(text.replace("finish: [commit]", "finish: [findings]"))).toEqual([]);
    expect(await teamProblems(text.replace("orders-api: read", "orders-api: edit"))).toEqual([]);
  });
});

describe("cloud steps that send the repo", () => {
  // query and dig run locally with a connection; the cloud step after them is the one tested.
  const investigate = (cloud: string) => `format: 1
name: Investigate
uses:
  repos: edit
  connections: { app-insights: read }
start:
  needs: [text, repo]
steps:
  - id: query
    name: Query
    agent: local
    instructions: Look at the errors.
    uses: { connections: { app-insights: read } }
  - id: dig
    name: Dig
    agent: local
    instructions: Dig deeper.
  - id: plain
    name: Plain
    agent: local
    instructions: Read the code.
    sees: []
${cloud}finish: [commit]
`;
  const cloudStep = (data: string, extra: string, instructions = "Fix it.") =>
    `  - id: fix\n    name: Fix\n    agent: builder\n    instructions: ${instructions}\n    data: ${data}\n${extra}`;

  it("refuses seeing a step with connection results, directly or through another step", async () => {
    expect(await teamProblems(investigate(cloudStep("repo-and-diff", "    sees: [query, dig, plain]\n")))).toEqual([
      'Step "fix" sends the repo to a cloud agent with no summary to approve, so it cannot see "query", which has results from connections. Use data: summary-after-approval.',
      'Step "fix" sends the repo to a cloud agent with no summary to approve, so it cannot see "dig", which has results from connections. Use data: summary-after-approval.',
    ]);
  });

  it("allows it with summary-after-approval, which the engineer reads first", async () => {
    expect(await teamProblems(investigate(cloudStep("summary-after-approval", "    sees: [query, dig]\n")))).toEqual([]);
  });

  it("refuses a {{ step.x }} reference that is not in sees", async () => {
    const text = investigate(cloudStep("repo-and-diff", "    sees: [plain]\n", '"Use {{ plain.notes }} and {{ dig.findings }}."'));
    const result = await validate(text, TEAM);
    expect(result.ok ? [] : result.error).toEqual([
      { line: 26, message: 'Step "fix" uses {{ dig... }} in its instructions, but does not list "dig" in sees.' },
    ]);
    expect(await teamProblems(investigate(cloudStep("summary-after-approval", "    sees: [plain]\n", '"Use {{ dig.findings }}."')))).toEqual([]);
  });

});

describe("uses.commands", () => {
  const AGENT_FILE = "Remove it; the commands an agent may run are set in its agent file.";

  it("refuses a template that lists commands, with the line of the field", async () => {
    expect(await problems(edit("  repos: edit\n", "  repos: edit\n  commands: [gh, az boards]\n"))).toEqual([
      { line: 5, message: `"uses" lists commands, which Tokama does not read, so they would never reach an agent. ${AGENT_FILE}` },
    ]);
  });

  it("refuses a step that lists commands", async () => {
    expect(await problems(edit("    data: repo-and-diff\n  - id: review", "    data: repo-and-diff\n    uses: { commands: [gh] }\n  - id: review"))).toEqual([
      { line: 16, message: `Step "build": "uses" lists commands, which Tokama does not read, so they would never reach an agent. ${AGENT_FILE}` },
    ]);
  });

  it("gives every step an empty command list", async () => {
    expect((await record(BASE)).uses.commands).toEqual([]);
    expect((await record(BASE)).steps.map((step) => step.commands)).toEqual([[], []]);
  });
});

describe("reserved step ids", () => {
  it.each(["inputs", "item", "repo", "steps"])("refuses %s as a step id", async (id) => {
    const text = BASE.replace("id: build", `id: ${id}`).replace("{ back: build }", `{ back: ${id} }`);
    expect(await problems(text)).toEqual([{ line: 8, message: `"${id}" is a reserved name; pick another step id.` }]);
  });
});

describe("reference roots", () => {
  const MISSING_ROOT = (root: string, step = "review") =>
    `Step "${step}" uses {{ ${root}... }} in its instructions, but "${root}" is not a step in this template. Only {{ <step id>.<field> }} references are allowed.`;

  it("refuses a reference whose first word is not a step of the template", async () => {
    expect(await problems(edit("instructions: Review the diff.", "instructions: Check {{ inputs.ticket }}."))).toEqual([
      { line: 19, message: MISSING_ROOT("inputs") },
    ]);
  });

  it("suggests the step a misspelt root is close to", async () => {
    expect(await problems(edit("instructions: Review the diff.", "instructions: Check {{ biuld.summary }}."))).toEqual([
      { line: 19, message: `${MISSING_ROOT("biuld")} Did you mean "build"?` },
    ]);
  });

  it("accepts a reference to a step of the template", async () => {
    await record(edit("instructions: Review the diff.\n", "instructions: Check {{ build.summary }}.\n    sees: [build]\n"));
  });

  it("reports an unknown root once per step, however often it is used", async () => {
    expect(await problems(edit("instructions: Review the diff.", "instructions: Check {{ inputs.a }} and {{ inputs.b }}."))).toEqual([
      { line: 19, message: MISSING_ROOT("inputs") },
    ]);
  });

  it("checks the text of an instructions file too", async () => {
    files["refs.md"] = "See {{ item.title }}.\n";
    expect(await problems(edit("instructions: fix.md", "instructions: refs.md"))).toEqual([{ line: 11, message: MISSING_ROOT("item", "build") }]);
  });

  it("leaves braces with no root.field shape to the prompt's own warning", async () => {
    await record(edit("instructions: Review the diff.", "instructions: Check {{ nothing }} and {{ }}."));
  });
});

describe("connection access", () => {
  const withConnection = (access: string) => edit("  repos: edit\n", `  repos: edit\n  connections: { app-insights: ${access} }\n`);

  it("refuses a word other than read or write in the template's connections", async () => {
    expect(await problems(withConnection("query"))).toEqual([{ line: 5, message: 'Connection "app-insights" must be read or write.' }]);
  });

  it("refuses it in a step's connections, and suggests the close word", async () => {
    const text = steps(step("build", "local", "    uses: { connections: { data: wrte } }\n")).replace("  repos: edit", "  repos: edit\n  connections: { data: read }");
    expect(await teamProblems(text)).toEqual(['Step "build": connection "data" must be read or write. Did you mean "write"?']);
  });

  it.each(["read", "write"])("accepts %s and keeps it in the record", async (access) => {
    expect((await record(withConnection(access))).uses.connections).toEqual([{ connectionId: "app-insights", access }]);
  });
});

describe("a newer template format", () => {
  it("tells the engineer to update Tokama, and nothing else", async () => {
    const message = "This template needs a newer Tokama (format 2). Update Tokama to use it.";
    expect(await problems(edit("format: 1", "format: 2"))).toEqual([{ line: 1, message }]);
    expect(await problems(`${edit("format: 1", "format: 2")}colour: sky\n`)).toEqual([{ line: 1, message }]);
  });

  it.each(["1.5", "-1", "0"])("keeps the plain format message for format: %s", async (value) => {
    expect((await problems(edit("format: 1", `format: ${value}`))).map((p) => p.message)).toEqual(['"format" must be 1.']);
  });
});

describe("instructions that look like a file", () => {
  const withInstructions = (value: string) => steps(step("build", "builder").replace("instructions: Do build.", `instructions: ${value}`));

  it.each(["fix.txt", "docs/fix", "prompts/fix.markdown"])("refuses %s, which is not a .md file", async (value) => {
    expect(await teamProblems(withInstructions(value))).toEqual([
      `Step "build": "${value}" looks like a file name, but instruction files must end in .md. Inline instructions are a sentence.`,
    ]);
  });

  it("accepts .MD as an instructions file", async () => {
    files["FIX.MD"] = "Fix.\n";
    expect((await teamRecord(withInstructions("FIX.MD"))).steps[0]?.instructions).toEqual({ file: "FIX.MD", text: "Fix.\n" });
  });

  it("refuses characters outside letters, digits, . _ / -", async () => {
    expect(await teamProblems(withInstructions("fix$name.md"))).toEqual([
      'Step "build": the instructions file name "fix$name.md" may use only letters, digits, ".", "_", "/" and "-".',
    ]);
  });
});

describe("untrusted text in messages", () => {
  it("escapes C0, DEL, C1 and bidi characters and cuts long values", () => {
    expect(clean("a\u0000b\u001bc\u007fd\u0085e‮f⁦g‏h")).toBe("a\\u{0}b\\u{1b}c\\u{7f}d\\u{85}e\\u{202e}f\\u{2066}g\\u{200f}h");
    expect(clean("x".repeat(100))).toBe(`${"x".repeat(79)}…`);
    expect(quote('say "hi"')).toBe('"say \\"hi\\""');
  });

  it("quotes an unknown field name with control characters", async () => {
    const [problem] = await problems(`${BASE}"evil\\u001b[31m\\u202e": 1\n`);
    expect(problem?.message).toBe('The template has an unknown field "evil\\u{1b}[31m\\u{202e}".');
  });

  it("quotes an inline back target", async () => {
    const [problem] = await problems(edit("if_failed: retry", "if_failed: back: b‮uild"));
    expect(problem?.message).toBe('Write "if_failed: { back: b\\u{202e}uild }", or put "back: b\\u{202e}uild" on its own line under "if_failed:".');
  });

  it("quotes a step id in the step's problems", async () => {
    const [problem] = await problems(edit("id: build", `id: "b\\u0085${"x".repeat(100)}"`));
    expect(problem?.message).toMatch(/^Step "b\\u\{85\}x+…": "id" must be lowercase/);
  });
});

describe("validateTemplate: warnings", () => {
  const REVIEWER_IF_FAILED = edit("    if_changes_requested: { back: build }\n", "    if_changes_requested: { back: build }\n    if_failed: { back: build }\n");
  const collect = async (text: string) => {
    const warnings: TemplateProblem[] = [];
    const result = await validateTemplate(text, {
      ref: "orders-api/sample" as TemplateRef,
      source: { kind: "repo", repoId: "orders-api" as never, file: ".tokama/templates/sample.yaml" },
      agents: AGENTS,
      readInstructions,
      onWarning: (warning) => warnings.push(warning),
    });
    return { result, warnings };
  };

  it("warns, with the line of the field, on a reviewer step with if_failed", async () => {
    const { result, warnings } = await collect(REVIEWER_IF_FAILED);
    expect(result.ok).toBe(true);
    expect(warnings).toEqual([{ line: 22, message: 'Step "review": "if_failed" has no effect on a reviewer step; use "if_changes_requested".' }]);
  });

  it("does not warn on a checks step with if_failed", async () => {
    const { result, warnings } = await collect(BASE);
    expect(result.ok).toBe(true);
    expect(warnings).toEqual([]);
  });

  it("tells no warning of a file that is refused", async () => {
    const { result, warnings } = await collect(REVIEWER_IF_FAILED.replace("agent: reviewer", "agent: nobody"));
    expect(result.ok).toBe(false);
    expect(warnings).toEqual([]);
  });

  it("still checks that the back of an ignored if_failed goes to a step", async () => {
    expect(await problems(REVIEWER_IF_FAILED.replace("if_failed: { back: build }", "if_failed: { back: nowhere }"))).toEqual([
      expect.objectContaining({ message: expect.stringContaining('"if_failed" goes back to "nowhere"') }),
    ]);
  });

  it("lets an ignored if_failed change no step's default max_attempts", async () => {
    const attempts = async (text: string) => (await record(text)).steps.map((step) => step.maxAttempts);
    const plain = await attempts(BASE);
    expect(await attempts(REVIEWER_IF_FAILED)).toEqual(plain);
    expect(await attempts(REVIEWER_IF_FAILED.replace("if_failed: { back: build }", "if_failed: retry"))).toEqual(plain);
    expect(await attempts(REVIEWER_IF_FAILED.replace("if_failed: { back: build }", "if_failed: { back: review }"))).toEqual(plain);
  });

  it("validates with no onWarning given", async () => {
    expect((await validate(REVIEWER_IF_FAILED)).ok).toBe(true);
  });
});

describe("closest", () => {
  it("suggests only near misses", () => {
    expect(closest("buidler", ["builder", "reviewer"])).toBe("builder");
    expect(closest("x", ["builder"])).toBeUndefined();
    expect(closest("builder", ["builder"])).toBeUndefined();
  });
});
