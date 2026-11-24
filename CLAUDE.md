# Tokama

Tokama (an invented name from the Tokay gecko and the Agama lizard; say to-KA-ma) is a desktop engineering companion. It runs AI agents on code tasks (build, fix, review) and on investigations (incidents, using connected systems such as Azure, App Insights, databases and logs). Agents run on any backend: Claude Code or Codex CLI on the user's subscription plans, or local models. User-written templates define each kind of work step by step, including which agent runs each step and what data may leave the machine. Every agent call is measured.

Don't design anything around a fixed planner/executor/verifier trio, a single provider, or code-only work. Cheap building with local models is one use, not the purpose.

## Where things are

- Product spec: `.agent/spec/product.md` (maintainer-local, not in the repo) (concepts, v1 scope, flows, templates, privacy, safety). Architecture: `.agent/spec/architecture.md` (packages, engine API, slices, kernel, adapters, storage, build order). Read both before planning or building anything; update them when a decision changes.
- Agent working files go in `.agent/` (git-ignored): plans, review notes, exports, scratch. Never put agent scratch elsewhere in the repo.
- Maintainer-specific notes (status, links, local paths, preferences) live in `CLAUDE.local.md` (git-ignored), loaded next to this file. Keep this file to stable project rules.
- Repo: `MojtabaTajik/tokama`, Apache-2.0, default branch `main`. Paid cloud features live outside this repo, so the open engine must work fully without them. Domains (registered): tokama.dev (primary), tokama.ai (redirects to tokama.dev). Point user-facing URLs (updates, install scripts, docs) at tokama.dev, not GitHub, so a later move to an organization breaks nothing.
- Never commit employer or customer names, personal paths, secrets or business plans: the repo is meant to be public. Use neutral sample names (e.g. "Northwind prod", `orders-api`) in docs, specs and designs.
- `main` is protected by a ruleset: no direct pushes, no force pushes, no deletion, linear history. Every change, docs included, goes through a pull request and is squash-merged by a maintainer. Agents never merge.
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

## UI design

- Design every screen before building it; charts follow the `dataviz` skill.
- Users are engineers who keep Tokama open all day. Calm and minimal: one dark ground, hairline dividers, flat cards, no colored boxes, little color. Visibility still comes first: every item shows which template step it is in, which agent runs it, and what it waits for; numbers link to their source.
- Locked layout (v2 board):
  - **Icon rail** (left): panel toggle, Board, Needs you (amber badge), Insights, Settings, Attention "!" (red badge: health issues such as an expiring token, quota at 84%, a host's Ollama down; opens a popup, never shown inline), then one usage ring per installed AI CLI (Claude Code, Codex CLI, Ollama; click for plan, windows, reset times, who uses it), then the user avatar.
  - **Workspaces panel**: "+ New work", workspaces grouped by host, each expanding to its live items only (⏸ needs you, ● working, ◐ checks, ◌ queued). Repos, connections and templates are not listed here; the workspace header shows one line ("2 repos · 4 connections · 5 templates") and links to Workspace settings.
  - **Board**: columns are generic stages (Queued, Working, Verifying, Review, Done) so mixed templates fit. The View dropdown filters to one template and turns the columns into that template's real steps. Cards are flat: kind (◎ Investigation / ▣ Task) and privacy ("local only" / "local + cloud"), title, one mono hint line, agent dot + name; a card that needs you gets one amber line and a faint amber border.
  - **Item drawer** (right): kind, template, title, state; an amber-ruled "needs you" note with the decision buttons; tabs Steps (each step with agent, where it runs and what it sees), Evidence, Findings, Log (Diff, Checks for tasks); actions as plain links.
  - **New work**: a floating input at the bottom of the board; on focus it expands upward with a Template dropdown (searchable, grouped Investigate / Build, suggested one marked), a Repos multi-select dropdown (searchable), the template's connections as read-only "uses" badges, the template's steps on one line, options, and Start (⌘↵). No chip rows that grow with the number of repos or templates.
- **Settings** is its own space: a settings nav replaces the rail (← Back, search, groups Personal / Workspace / Engine, Documentation). List-type settings (AI CLIs, connections, agents, templates) use three panes: filterable list with "+ Add", then the selected item's form. AI CLI config covers command, headless args, model arg, permission args (never a skip-all-permissions flag), resume args, prompt transport (argv/stdin), environment allowlist, local-model routing, usage source, restore default.
- Brand palette (final), from the Agama and Tokay lizards: Agama blue `#1F5BFF` (primary: logo, app icon, website buttons), Agama flame `#FF6B1A` (accent; never a status color; on white use Flame deep `#C2410C`), Agama turquoise `#14C8C8` (second accent for illustrations and charts), Tokay vermilion `#FF4A2B` (mascot and illustrations only). Vivid colors are the brand; inside the app they are accents only.
- App UI colors: night ground `#0B0F17`, panels `#121826`, raised/selected `#18213A`, inputs `#0F1420`, hairlines `#1F262E`; text `#E6EDF3` / `#D5DCE3` / muted `#7D8894` (lowest grey allowed; 4.5:1 or better); links and focus Tokay sky `#7FB2FF`; "running now", selection and the primary button Blue live `#5C8CFF` (primary button border `#1F5BFF`). Status colors keep their meaning: needs you / warning amber `#D9A93A`, failure red `#E07A70`, pass green `#6FB884`. Agent identity dots: `#8F73F2`, `#22A98B`, `#b23a6e` in join order, then neutral `#4A5563`. Color is never the only signal (pair with ⏸ ● ✓ ✕ or a word). Inter for UI, JetBrains Mono for code, paths, numbers, model names.
- Logo: a placeholder for now. Keep it swappable: one SVG mark plus the wordmark in a single brand assets location per app, referenced everywhere through that location, never inlined or copied into screens, so replacing the logo is a file swap.
- Backends are text labels or neutral monograms (CC, CX, OL), never another company's logo.
- Templates and steps carry a user-chosen icon and tag colour. Icons: Font Awesome Free solid and regular, bundled as SVGs, never the brands set. Tag colours: a fixed set of 8 muted colours distinct from the status colours, applied to the icon only, never as a fill.

## Issue tracking

GitHub issues in `MojtabaTajik/tokama` track actual implementation work only: code to write, bugs, improvements to built code, tooling/CI chores, and open decisions that block code. Every issue and PR gets labels.

- No issues for design iterations, canvas edits, doc housekeeping or unscheduled ideas. Designs live on the design canvas, ideas stay out of the tracker until scheduled; open an issue only when the work is scheduled to be built.
- Before starting implementation work, find or open its issue. Reference it in the branch and PR (`Closes #N`). Bugs found along the way become issues, not TODO comments.
- Labels: exactly one type label, plus area labels for the packages touched, plus modifiers when they apply.
  - Type: `feature` (new capability), `bug` (something broken), `improvement` (better version of something built), `documentation`, `chore` (tooling, CI, deps, repo setup).
  - Area: `area:core`, `area:cli`, `area:desktop`.
  - Modifiers: `security` (sandboxing, process spawn, input handling, egress), `question` (decision needed from a maintainer).
  - Closing: `duplicate`, `wontfix`.
- Use only these labels. Add a new one only when an existing label can't express it and it will be used on more than one issue; remove labels that stop being used. Update this list when the label set changes.
