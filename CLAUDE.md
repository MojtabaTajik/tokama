# Tokama

Tokama is a desktop engineering companion: it runs AI agents (Claude Code, Codex CLI, local models) on code tasks and investigations, following user-written templates. Don't design anything around a fixed planner/executor/verifier trio, a single provider, or code-only work.

## Where things are

- Specs (maintainer-local, not in the repo): `.agent/spec/product.md`, `.agent/spec/architecture.md` and `.agent/spec/design.md`. Read them before planning or building anything; update them when a decision changes. Product, design and planning detail belongs there, not in this file.
- Agent working files go in `.agent/` (git-ignored): plans, review notes, exports, scratch. Never put agent scratch elsewhere in the repo.
- Maintainer-specific notes (status, links, local paths, preferences) live in `CLAUDE.local.md` (git-ignored), loaded next to this file. Keep this file to stable project rules.
- Repo: `tokama-dev/tokama`, Apache-2.0, default branch `main`. The open engine must work fully on its own. Domains (registered): tokama.dev (primary), tokama.ai (redirects to tokama.dev). Point user-facing URLs (updates, install scripts, docs) at tokama.dev, not GitHub, so a later move to an organization breaks nothing.
- Never commit employer or customer names, personal paths, secrets or business plans: the repo is meant to be public. Use neutral sample names (e.g. "Northwind prod", `orders-api`) in docs, specs and designs.
- `main` is protected by a ruleset: no direct pushes, no force pushes, no deletion, linear history. Every change, docs included, goes through a pull request and is squash-merged, by a maintainer or by an agent under the maintainer's standing merge rules (green CI on Linux and macOS, clean review). Agents never merge outside those rules.
- Reference only: `ai-pipeline`, the earlier private Python harness, kept outside this repo. Reuse its hard-won parts and port the tests for them (list in architecture spec, section 12). Do not port it in full, keep its file formats, or call or ship any of its code.

## Engineering rules

- TypeScript only, strict. No Python anywhere in Tokama, no sidecars.
- `core` is headless: no Electron, no UI. The engine runs as its own background service; desktop, CLI and later mobile are clients of the versioned engine API, never of core directly.
- Platforms: macOS first, then Linux, then Windows. OS-specific code (process control, shell parsing, secrets, metrics, paths) only behind an interface with one implementation per OS; CI on macOS and Linux.
- Vertical slices; only `workflow-engine` composes slices. Security primitives (process, git, command policy, egress, secrets, safe file reads) exist once in the kernel. Backends and connectors are adapters (a folder plus one line in `composition.ts`). Boundaries are enforced by lint and CI.
- Code comments and READMEs explain the code itself; they never point to docs, specs or their sections. The specs are written so they can be matched to the code without such links.
- Write tests with the code. When porting a part of ai-pipeline, port its tests first.
- Loop guards on every agent call are required. Never launch an agent with a skip-all-permissions flag.
- Never send data to a cloud agent beyond the step's data rule; in local-only mode, nothing leaves the machine.
- Resolve dependency versions with `npm view` when adding them; pin exactly; commit the lockfile.

## UI

- Everything built must be possible to try. A feature users notice ships with its screen in the same PR (or the PR merged right after it). Pure internals (security primitives, wrappers) need no screen but must be reachable from one within the same milestone. Every milestone ends with something to click through: sample data in the app plus at least one real path.
- Design every screen on the design canvas before building it, following `.agent/spec/design.md`; charts follow the `dataviz` skill.
- Colours and fonts come only from the app's theme tokens; colour is never the only signal (pair it with a symbol or a word).
- The logo is swappable: one SVG mark plus the wordmark in a single brand assets location per app, referenced from there, never copied into screens.
- Backends are text labels or neutral monograms, never another company's logo.
- Agent output, repo content and logs render as text only, never as HTML.

## Issue tracking

GitHub issues in `tokama-dev/tokama` track actual implementation work only: code to write, bugs, improvements to built code, tooling/CI chores, and open decisions that block code. Every issue and PR gets labels.

- No issues for design iterations, canvas edits, doc housekeeping or unscheduled ideas. Designs live on the design canvas, ideas stay out of the tracker until scheduled; open an issue only when the work is scheduled to be built.
- Before starting implementation work, find or open its issue. Reference it in the branch and PR (`Closes #N`). Bugs found along the way become issues, not TODO comments.
- Labels: exactly one type label, plus area labels for the packages touched, plus modifiers when they apply.
  - Type: `feature` (new capability), `bug` (something broken), `improvement` (better version of something built), `documentation`, `chore` (tooling, CI, deps, repo setup).
  - Area: `area:core`, `area:cli`, `area:desktop`.
  - Modifiers: `security` (sandboxing, process spawn, input handling, egress), `question` (decision needed from a maintainer).
  - Closing: `duplicate`, `wontfix`.
- Use only these labels. Add a new one only when an existing label can't express it and it will be used on more than one issue; remove labels that stop being used. Update this list when the label set changes.
