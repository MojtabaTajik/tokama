// The sample mode's repo templates: YAML files as an engineer would write them in the sample
// repos, loaded through the real validator against the sample agents. One loads; the other has
// the mistakes a first draft often has, so the Templates page shows problems with line numbers.
// The sample repos are not on disk, so these files cannot be opened in an editor.
import { type AgentLocation, type RepoId, type TemplateLoad, type TemplateRef, lineWarning, templateWarnings, validateTemplate, type TemplateProblem } from "@tokama/core";
import { sampleSetup } from "./data.js";

const TEMPLATES_DIR = ".tokama/templates";

const PLAN_AND_BUILD = `# yaml-language-server: $schema=https://tokama.dev/schema/template-1.json
format: 1
name: Plan and build
icon: hammer
color: sky
uses:
  repos: edit
  commands: [pnpm test]
start:
  needs: [text, repo]
budget:
  time: 90m
steps:
  - id: plan
    name: Plan
    agent: architect
    instructions: instructions/plan.md
    done_when: you approve
    data: repo-and-diff
  - id: build
    name: Build
    agent: local-builder
    instructions: instructions/build.md
    done_when: checks pass
    checks: from-repo
    if_failed: retry
    max_attempts: 3
    sees: [plan]
  - id: review
    name: Review
    agent: reviewer
    instructions: instructions/review.md
    done_when: reviewer approves
    if_changes_requested:
      back: build
    max_attempts: 2
    data: repo-and-diff
finish: [commit, pull-request]
`;

const FLAKY_TEST_FIX = `format: 1
name: Flaky test fix
icon: bug
color: moss
uses:
  repos: edit
start:
  needs: [text, repo]
steps:
  - id: build
    name: Fix the test
    agent: local-builder
    instructions: Find why the named test fails now and then, and make it reliable.
    done_when: checks pass
    checks: [npm test]
    if_failed: retry
    max_attempts: 3
  - id: review
    name: Review
    agent: reviewr
    instructions: Review the fix.
    done_when: reviewer approves
    if_changes_requested:
      back: buld
    data: repo-and-diff
finish: [commit]
`;

const INSTRUCTIONS: Readonly<Record<string, string>> = {
  "instructions/plan.md": "Read the task and the repo, and write a short plan.",
  "instructions/build.md": "Make the change the plan describes. Keep the diff small.",
  "instructions/review.md": "Review the diff against the plan.",
};

const FILES = [
  { repoId: "orders-api", id: "plan-and-build", text: PLAN_AND_BUILD },
  { repoId: "checkout-web", id: "flaky-test-fix", text: FLAKY_TEST_FIX },
] as const;

const agents: ReadonlyMap<string, AgentLocation> = new Map(sampleSetup.agents.map((agent) => [agent.id, { cloud: agent.runsOn === "cloud" }]));

export async function sampleTemplateLoads(): Promise<TemplateLoad[]> {
  const loads: TemplateLoad[] = [];
  for (const { repoId, id, text } of FILES) {
    const ref = `${repoId}/${id}` as TemplateRef;
    const file = `${TEMPLATES_DIR}/${id}.yaml`;
    const notes: TemplateProblem[] = [];
    const result = await validateTemplate(text, {
      ref,
      source: { kind: "repo", repoId: repoId as RepoId, file },
      agents,
      readInstructions: async (name) => (name in INSTRUCTIONS ? { ok: true, value: INSTRUCTIONS[name]! } : { ok: false, error: "does not exist" }),
      onWarning: (warning) => notes.push(warning),
    });
    loads.push(result.ok ? { ok: true, template: result.value, warnings: [...notes.map(lineWarning), ...templateWarnings(result.value)], text } : { ok: false, ref, origin: repoId, file, problems: result.error, text });
  }
  return loads;
}
