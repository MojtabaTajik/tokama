// Templates that ship with Tokama, as the YAML an engineer would write. They load through the same
// validator as repo templates, and can be copied into a repo's `.tokama/templates/` as they are.

const QUICK_FIX = `format: 1
name: Quick fix
icon: screwdriver-wrench
color: sky
uses:
  repos: edit
start:
  needs: [text, repo]
steps:
  - id: fix
    name: Fix
    agent: builder
    instructions: |
      Make the change described below in this repository, keeping the diff small.
      When you finish, Tokama runs the repo's checks and sends you what fails.
    done_when: checks pass
    checks: from-repo
    if_failed: retry
    max_attempts: 3
    data: repo-and-diff
finish: [commit]
`;

const QUICK_CHANGE = `# For repos without tests or checks: you review the change yourself. Approve commits the diff
# you saw; Request changes runs the step again with your note.
format: 1
name: Quick change
icon: bolt
color: rose
uses:
  repos: edit
start:
  needs: [text, repo]
steps:
  - id: change
    name: Change
    agent: builder
    instructions: |
      Make the change described below in this repository, keeping the diff small.
      The engineer reads the diff before it is committed: change only what the task needs.
    done_when: you approve
    max_attempts: 3
    data: repo-and-diff
finish: [commit]
`;

const PLAN_AND_BUILD = `format: 1
name: Plan and build
icon: list-check
color: teal
uses:
  repos: edit
start:
  needs: [text, repo]
steps:
  - id: plan
    name: Plan
    agent: architect
    instructions: |
      Read the task and the code around it, then write a short plan: the files to change,
      the tests to add and the risks. Do not change any file.
    done_when: you approve
    data: repo-and-diff
  - id: build
    name: Build
    agent: builder
    instructions: |
      Make the change the approved plan describes, keeping the diff small.
      When you finish, Tokama runs the repo's checks and sends you what fails.

      The approved plan:
      {{ plan.summary }}
    sees: [plan]
    done_when: checks pass
    checks: from-repo
    if_failed: retry
    max_attempts: 3
    data: repo-and-diff
  - id: review
    name: Review
    agent: reviewer
    instructions: |
      Review the change in this worktree against the approved plan. Judge the diff and the
      check output, not the builder's account. Say what must change, with a file and line each.

      The approved plan:
      {{ plan.summary }}
    sees: [plan]
    done_when: reviewer approves
    if_changes_requested:
      back: build
    data: repo-and-diff
finish: [commit]
`;

const ASK = `# Answers a question about the repo and changes no file: the agent reads, and nothing is committed.
format: 1
name: Ask
icon: circle-question
color: sand
uses:
  repos: read
start:
  needs: [text, repo]
steps:
  - id: answer
    name: Answer
    agent: architect
    instructions: |
      Answer the question below about this repository. Read the code you need. Do not change any file.
      Start with the answer in one or two sentences. Then give the reasons, each with a file and line.
      If the question is "how hard" or "how long", name the files that would change and the main risk.
      If you could not find something, say so. Do not guess, and do not write a plan unless asked.
      If the cause is not in this repository, say where the evidence points: which service or boundary,
      and what you saw there (for example "the text already arrives cut from billing-api"). Then stop.
      That is a complete answer, not a failure.
    done_when: agent finishes
    data: repo-and-diff
finish: [findings]
`;

const REVIEW_ONLY = `format: 1
name: Review code
icon: eye
color: plum
uses:
  repos: read
start:
  needs: [text, repo]
steps:
  - id: review
    name: Review
    agent: reviewer
    instructions: |
      Review the code the task below points at. Read it, do not change it.
      Report what is wrong or risky, with a file and line for each finding.
    done_when: agent finishes
    data: repo-and-diff
finish: [findings]
`;

/** Built-in templates by id; their refs are `builtin/<id>`. */
export const BUILTIN_TEMPLATES: ReadonlyMap<string, string> = new Map([
  ["quick-fix", QUICK_FIX],
  ["quick-change", QUICK_CHANGE],
  ["plan-and-build", PLAN_AND_BUILD],
  ["ask", ASK],
  ["review-only", REVIEW_ONLY],
]);
