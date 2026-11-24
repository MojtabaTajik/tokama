# Tokama architecture

Status: draft for v1. Product behavior is in `product.md`; this file says how it is built.

## 1. Principles

- TypeScript only, strict. No Python, no sidecars.
- The engine (`core`) is headless and knows nothing about Electron. The desktop app is a client of the engine API.
- Vertical slices: one folder per capability with its use cases, schemas and tests. No cross-cutting `services/` or `utils/` layers.
- Security primitives exist once, in the kernel. Slices never re-implement them.
- Backends and connectors are removable adapters behind ports.
- Boundaries are enforced by lint and CI, not by convention.

## 2. Packages

```
tokama/
  packages/core/        engine: slices, kernel, adapters, engine API
  apps/desktop/         Electron shell: renderer UI, main process hosts core
  packages/cli/         later (not v1): thin CLI over the engine API
  tooling/              shared tsconfig, eslint, vitest presets
  .agent/                agent working files (git-ignored)
  docs/spec/            this spec
  docs/adr/             architecture decision records
```

pnpm workspaces, `tsc --build` with project references. `desktop` depends on `core` only through its public entry.

## 3. Engine API (host boundary)

The UI never calls slices directly. It talks to the engine through one typed API: commands (start item, approve step, stop, save template, add connection), queries (board, item, settings) and an event stream (item and step updates, usage, attention).

- v1 transport: Electron IPC between renderer and main process, payloads validated with the same schemas the engine uses.
- Later: the same API over an authenticated connection to a remote host. A remote host keeps its own agents, models, repos and credentials; only API messages cross.

## 4. Core layout

```
packages/core/src/
  kernel/          security and shared primitives (section 6)
  slices/          capabilities (section 5)
  adapters/        removable plug-ins (section 7)
  api/             engine API: commands, queries, events
  composition.ts   the only place adapters are wired to slices
  index.ts         public entry
```

## 5. Slices

| Slice | Owns |
|---|---|
| `workspaces` | Workspace config, repos (path, base branch, worktree folder), workspace privacy rules. |
| `connections` | Connection definitions, scopes, credential references, health checks, test. |
| `ai-clis` | Detected CLIs and model hosts, launch config per CLI, login and plan state. |
| `agents` | Agent definitions (CLI + model + host + permissions), availability. |
| `templates` | Template schema, loading from files, validation, built-in examples. |
| `items` | Item and step records, item store, evidence and findings, links between items. |
| `workflow-engine` | Runs an item through its template: scheduling, gates, retries, escalation, approvals, follow-ups, stop. The only slice that composes others. |
| `worktrees` | Worktree and branch per task repo, commit, pull request, cleanup. |
| `execution` | One agent call: launch through an agent runtime, stream parsing, loop guards, usage capture. |
| `verification` | Checks run by Tokama, verdict parsing, verified-tree check. |
| `integrity` | Tamper checks on git guard files, model digest checks. |
| `privacy` | Data rules per step, summary building, redaction, cloud-step approval, egress log. |
| `usage` | Per-call and rolled-up usage, quota windows per CLI, machine samples, attention signals. |

Slices import each other only through `slices/<name>/index.ts`, and only `workflow-engine` does. Shared data shapes live in `kernel/schemas`.

Inside a slice: `index.ts` (public surface), one file per use case, schemas, colocated tests, a five-line `README.md` saying what it owns and must not do.

## 6. Kernel

| Module | Why it is single |
|---|---|
| `process` | Spawn in own process group, kill group on stop/timeout, env allowlist, stream stdout to disk as it arrives. |
| `git` | Every git call hardened (`core.hooksPath=/dev/null`, no fsmonitor, no external diff/textconv, `--no-verify`, no signing). |
| `command-policy` | Quote-aware allowlist parser for checks and step commands. Security boundary. |
| `egress` | The single path for any network call that carries user data; enforces data rules and local-only mode, logs what left. Plus a runtime guard in local-only mode, so it does not rely on lint alone. |
| `fs-safe` | Regular files only, no symlink following, size and line caps. |
| `secrets` | Keychain access; secrets never returned as plain text to slices that pass them to agents. |
| `schemas` | Versioned schemas for config, templates, items, events, API messages. |
| `ports` | `AgentRuntime`, `ModelHost`, `Connector`, `Sampler` interfaces with shared contract tests. |
| `result`, `clock`, `ids` | Result type, injectable clock, id formats. |

## 7. Adapters

```
adapters/
  agent/claude-code/     AgentRuntime: headless claude, stream-json, local-model routing via ANTHROPIC_BASE_URL
  agent/codex-cli/       AgentRuntime: headless codex, JSON events
  host/ollama/           ModelHost: warmup, keep-alive, digest, foreign-client check
  connector/mcp/         Connector: any MCP server by command or URL, tool list, scope
  connector/postgres/    Connector: built-in read-only Postgres
  sampler/macmon/        Sampler (macOS), with sampler/ps-fallback
```

Agent runtime and model host are separate ports, so a local model can run under any runtime. Each adapter folder has its factory, implementation and contract test. Adding one is a folder plus one line in `composition.ts`; removing one is the reverse. CI proves every adapter can be removed and the build still passes.

## 8. Storage

- Host config: `~/.tokama/` (detected CLIs, agents, app settings, workspace list).
- Workspace config: `~/.tokama/workspaces/<id>.yaml` (repos, connections without secrets, privacy rules).
- Templates: in a workspace repo under `.tokama/templates/`, versioned with code.
- Secrets: macOS Keychain.
- Items: `~/.tokama/items/<id>/` with an append-only event log, raw agent transcripts, evidence and findings; a local index for the board and search. (Store format to be settled before the `items` slice is built.)
- Worktrees: inside each repo's worktree folder (default `.tokama/wt/`).

## 9. Boundaries in CI

- ESLint rules: slices only via `index.ts`, only `workflow-engine` composes; slices and adapters never import each other; kernel imports neither; no `electron` in core; process, network and dynamic-import escape hatches banned outside `kernel/process`, `kernel/egress` and `adapters/*`; inline lint-disable comments off in core; rules cover `.ts`, `.tsx`, `.mts`, `.cts`.
- Fixture tests that prove each rule fires, run against the real ESLint config.
- Adapter removal test that never mutates the working tree.
- pnpm strict dependencies, exact version pins, lockfile committed, no install scripts allowed by default.
- GitHub Actions with read-only token, actions pinned by SHA.

## 10. Stability

- Validate every external input at the boundary: CLI event streams, connector results, files, API messages.
- Expected failures are values, not exceptions; the engine maps each to a step outcome explicitly.
- Abort signals through every long call; stopping always kills the process group and records the partial result.
- Injected clock and process spawner, so guard and timeout tests are fast and deterministic.
- Electron: context isolation, sandbox, no Node in the renderer, typed preload, model output rendered as text only.

## 11. What comes from ai-pipeline

`ai-pipeline` (the earlier private Python harness, kept outside this repo) is a reference, not a spec to port in full. Reuse its hard-won parts and port the tests that cover them:

| Tokama home | From ai-pipeline | Tests to port |
|---|---|---|
| `kernel/process` | process group spawn and kill, env allowlist | process cases of `test_claude_call.py` |
| `adapters/agent/claude-code` | `claude -p` argv, stream-json parsing, local-model env | adapter cases of `test_claude_call.py` |
| `execution` | loop guards, usage reconstruction, wasted time | `test_executor_guard.py` |
| `kernel/command-policy` | check allowlist parser | allowlist cases in `test_loop_stub.py` |
| `kernel/git`, `integrity` | hardened git, tamper hashing | related cases in `test_loop_stub.py` |
| `verification` | harness checks, nonce-fenced diff, verdict retry | related cases in `test_loop_stub.py` |
| `adapters/host/ollama` | warmup, repin, digest, foreign-client check | related cases |
| `adapters/sampler/macmon` | macmon sampling, fallback | `test_sampler_and_run.py` sampler cases |

Not carried over: run-file compatibility, `summary.json`/`compare.json` formats and their golden tests, the pricing model as-is, the HTTP dashboard. The plan → build → verify loop becomes a built-in template run by the general engine.

## 12. v1 build order

Each milestone is one or more issues and PRs.

1. Skeleton: workspace, tooling, lint boundaries with fixtures, CI, empty core and desktop that build.
2. Kernel: process, git, command-policy, fs-safe, secrets, schemas, ports with contract tests.
3. Agent runtime: `claude-code` adapter + `execution` (one call with guards and usage) + `host/ollama`. First end-to-end: run one prompt on Opus and on a local model.
4. Templates + agents + workspaces: schema, validation, files, built-in examples.
5. Workflow engine + items + verification + worktrees: run a task template end to end (plan, build, checks, review, commit).
6. Connections + privacy: MCP and Postgres connectors, data rules, redaction, cloud-step approval, egress log. Run an investigation template end to end.
7. Codex CLI adapter.
8. Desktop: engine API over IPC, board, drawer, new work, needs you, attention, usage rings.
9. Desktop: settings, template editor, first run, item full view, notifications.
10. Usage rollups and sampler.
