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
    if_failed: retry
    max_attempts: 3
    data: repo-and-diff
finish: [commit]
`;

/** Built-in templates by id; their refs are `builtin/<id>`. */
export const BUILTIN_TEMPLATES: ReadonlyMap<string, string> = new Map([["quick-fix", QUICK_FIX]]);
