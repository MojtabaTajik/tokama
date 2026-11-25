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
      Run the project's tests before you finish, and fix what they report.
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
icon: code
color: sand
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
      Run the project's tests before you finish, and fix what they report.

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

const REVIEW_ONLY = `format: 1
name: Review only
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
  ["review-only", REVIEW_ONLY],
]);
