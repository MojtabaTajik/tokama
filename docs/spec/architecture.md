# Tokama architecture

Status: draft for v1. Product behavior is in `product.md`; this file says how it is built.

## 1. Principles

- TypeScript only, strict. No Python, no sidecars.
- The engine runs as its own background process (the engine service). Desktop, CLI and later mobile and remote clients all talk to it through the same versioned engine API. Runs keep going when the desktop window is closed.
- Platforms: macOS first, then Linux, then Windows. Every OS-specific piece (process control, shell parsing, secrets, machine metrics, paths) sits behind an interface with one implementation per OS. CI runs on macOS and Linux from the start.
- The engine (`core`) is headless and knows nothing about Electron. The desktop app is a client of the engine API.
- Vertical slices: one folder per capability with its use cases, schemas and tests. No cross-cutting `services/` or `utils/` layers.
- Security primitives exist once, in the kernel. Slices never re-implement them.
- Backends and connectors are removable adapters behind ports.
- Boundaries are enforced by lint and CI, not by convention.

## 2. Packages

```
tokama/
  packages/core/        engine: slices, kernel, adapters, engine API
  apps/engine/          engine service: the background process that hosts core and serves the engine API
  packages/client/      typed engine API client used by desktop, CLI and later mobile
  apps/desktop/         Electron app: UI only, a client of the engine service
  packages/cli/         later (not v1): thin CLI over the engine API
  tooling/              shared tsconfig, eslint, vitest presets
  .agent/                agent working files (git-ignored)
  docs/spec/            this spec
  docs/adr/             architecture decision records
```

pnpm workspaces, `tsc --build` with project references. `desktop` depends on `core` only through its public entry.

### Desktop stack

`apps/desktop` is Electron with a React renderer, built by electron-vite (Vite for all three bundles: main, preload, renderer). electron-vite was chosen over plain Vite plus a hand-written dev script because it builds the sandboxed preload as one CommonJS file, runs the renderer dev server and restarts Electron on main-process changes, with one small config; it adds one dev dependency and nothing at runtime.

- Main process: the only desktop code with Node and Electron. It connects through `@tokama/client` and starts the engine with absolute paths (the `node` found on PATH, `apps/engine/dist/main.js`), `--dir` set to the dir the client uses, and a reduced environment from core's `buildEnv` (the kernel allowlist; PATH without relative entries or package-manager tool folders), not `process.env`. A packaged app will ship its own engine and runtime (not yet).
- Preload: a typed bridge, `window.tokama` (`src/shared/bridge.ts`), over two IPC channels. Nothing else reaches the renderer. Main registers every channel through one `handle` helper that answers app pages only (not DevTools or any other frame).
- Renderer: React, rendered as text only. Every window has context isolation, sandbox, no Node, web security on, a strict Content-Security-Policy (no inline code, no remote content), and blocked navigation, `window.open`, webviews and permissions; the session refuses every request outside the app's own files (or, in dev, the loopback dev server).
- Colours and fonts are CSS tokens in `src/renderer/theme.css`; the logo lives only in `src/renderer/brand/`.

## 3. Engine API (host boundary)

The UI never calls slices directly. It talks to the engine through one typed API: commands (start item, approve step, stop, save template, add connection), queries (board, item, settings) and an event stream (item and step updates, usage, attention).

- v1 transport: a local socket (Unix domain socket on macOS and Linux, a named pipe on Windows later) owned by the user, with a per-session token. The desktop app starts the engine service if it is not running and reconnects if it restarts.
- Socket, token and single-instance lock live in one 0700 directory: `TOKAMA_ENGINE_DIR`, else `$XDG_RUNTIME_DIR/tokama` on Linux, else `~/.tokama/run`. The socket and token file are 0600; the token is new on each engine start. Messages are newline-delimited JSON, at most 1 MiB each.
- Each connection starts with a handshake: the client sends `hello` (its `apiVersion`, any integer, and the token); the engine answers `welcome` (with an `engineId` that is new on each start) or a `connection_error` (`unauthorized`, `unsupported_version`, ...) and closes. Handshake messages accept unknown fields, so any two versions can read them. Event `seq` restarts with the engine, so a client re-runs its queries after every reconnect.
- Built so far: queries `workspaces` (each workspace with its repos, connections, agents and template summaries with steps), `board`, `item` and `suggest_template`; commands `start_item` (with `options`: ask before cloud steps, notify), `resolve_decision` and `stop_item`; events `item_updated` (the full item record) and `usage_recorded`. Reply data is typed per query (`QueryResultSchemas`) and per command (`CommandResultSchemas`); command error codes are `COMMAND_ERROR_CODES`. An item's board column comes from one rule, `itemStage` in `kernel/schemas`.
- The item record carries only what the board card and the drawer header and Steps tab show. The drawer's Evidence, Findings, Log, Diff and Checks tabs will come from a separate `item_detail` query (not built yet), so events and board replies stay small.
- Fake engine mode (milestone C): `--sample` (or `startEngine({ sample: true })`) serves a sample data set from the in-memory store behind the same API, and its commands change that store and emit events. It lives in `apps/engine/src/sample/`, outside core, and is deleted when the real slices serve data.
- The API is versioned from the first release and fully serializable: no Electron, Node or OS types cross it. Every message is validated with the engine's schemas on both sides.
- Later: the same API over an authenticated network connection, to a remote host or through a relay for mobile and tablet clients (see product spec). A remote host keeps its own agents, models, repos and credentials; only API messages cross.

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

`api/` imports only the kernel and `slices/workflow-engine/index.ts`: clients reach the engine through workflow-engine, never through another slice or an adapter.

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
| `process` | Spawn, kill the whole process tree on stop/timeout (process groups on macOS and Linux, Job Objects on Windows later), env allowlist, stream stdout to disk as it arrives. |
| `git` | Every git call hardened (`core.hooksPath=/dev/null`, no fsmonitor, no external diff/textconv, `--no-verify`, no signing). |
| `command-policy` | Quote-aware allowlist parser for checks and step commands, one parser per shell (POSIX `sh` first, PowerShell later). Security boundary. |
| `egress` | The single path for any network call that carries user data; enforces data rules and local-only mode, logs what left. Plus a runtime guard in local-only mode, so it does not rely on lint alone. |
| `fs-safe` | Regular files only, no symlink following, size and line caps. |
| `secrets` | OS secret store behind one interface (macOS Keychain first; libsecret and Windows Credential Manager later); secrets never returned as plain text to slices that pass them to agents. |
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
- Secrets: the OS secret store (macOS Keychain in v1).
- Every stored file and record carries a schema version, so upgrades can migrate data.
- Items: `~/.tokama/items/<id>/` with an append-only event log, raw agent transcripts, evidence and findings; a local index for the board and search. (Store format to be settled before the `items` slice is built.)
- Worktrees: inside each repo's worktree folder (default `.tokama/wt/`).

## 9. Security model

Tokama v1 is a desktop app. The engine listens only on a local socket owned by the user; there is no network listener, so remote attackers are out of scope until remote hosts or a relay exist.

The real risks, in order, and their controls:

| Risk | Controls |
|---|---|
| 1. AI agents act on untrusted content they read (repo files, issues, logs, connection results) through prompt injection. | Command allowlists, step tool permissions, loop guards, worktrees, tamper checks, never a skip-all-permissions flag; later a sandbox. |
| 2. Data leaves the machine against a step's data rule. | Data rules, cloud-step approval, redaction, one egress path with a runtime guard, egress log. |
| 3. Connection credentials leak or are misused. | Least-privilege scopes, OS secret store, never given to agents as text. |
| 4. Model output rendered in the desktop app. | Text only, Electron hardening (section 11). |
| 5. Supply chain. | Exact pins, minimum release age, no install scripts. |

Low or out of scope: other software running as the same user, and contributors who deliberately hide code from lint (code review covers it).

Security work and review findings are rated against this model. Lint is a guardrail against honest mistakes, not a security boundary.

## 10. Boundaries in CI

- ESLint rules for `packages/core` (`.ts`, `.tsx`, `.mts`, `.cts`):
  - slices only through `slices/<name>/index.ts`, and only `workflow-engine` composes slices; slices and adapters never import each other, and adapters not each other; the kernel imports neither; only `src/index.ts` and `src/composition.ts` wire; `api/` imports only the kernel and `slices/workflow-engine/index.ts`;
  - no `electron` (or its subpaths) anywhere in core;
  - process and network modules only in `kernel/process`, `kernel/egress` and `adapters/*`: elsewhere only an allowlist of safe built-in modules, for imports, re-exports and literal `import()`; any other built-in, and any `node:` module a newer Node adds, is refused;
  - the globals `fetch`, `WebSocket` and `EventSource` only in `kernel/egress` and `adapters/*`;
  - `no-eval` and `no-new-func`.
- ESLint rules for `apps/desktop/src`: core through its public entry only, never the engine app or a workspace package by path; the renderer and `shared/` import no Node module, no Electron, no client or core values (core types are allowed) and nothing from `main/` or `preload/`; the preload imports only `electron` and `../shared`. Tests are exempt from the renderer and preload rules, since they run in Node.
- ESLint runs with the root config only (`eslint -c eslint.config.js`); a test fails if another `eslint.config.*` is committed.
- Lint catches honest mistakes by contributors and coding agents. It does not stop code written to get around it (computed names, aliases, reflection); code review covers that, and the kernel's runtime controls (section 9) are the security boundary.
- Fixture tests that prove each rule fires, run against the real ESLint config.
- Adapter removal test that never mutates the working tree.
- pnpm strict dependencies, exact version pins, lockfile committed, no install scripts allowed by default.
- GitHub Actions with read-only token, actions pinned by SHA.

## 11. Stability

- Validate every external input at the boundary: CLI event streams, connector results, files, API messages.
- Expected failures are values, not exceptions; the engine maps each to a step outcome explicitly.
- Abort signals through every long call; stopping always kills the process group and records the partial result.
- Injected clock and process spawner, so guard and timeout tests are fast and deterministic.
- Electron: context isolation, sandbox, no Node in the renderer, typed preload, model output rendered as text only.
- UI text lives in one place per screen so it can be translated later.
- Plug-in interfaces are versioned and kept stable, so third-party adapters are possible later.
- No telemetry by default; anything collected is opt-in and listed in settings.

## 12. What comes from ai-pipeline

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

## 13. v1 build order

Epics, each a GitHub milestone with small issues (1 to 3 days each). Claude Code is the first backend; local models and Codex follow as more adapters. Issues are written for the next one or two epics only.

- **A. Skeleton**: workspace and strict TypeScript, lint boundaries with fixture tests, adapter removal test, CI on macOS and Linux.
- **B. Kernel and engine service**: process control, command policy, hardened git, safe file reads, secrets, schemas and ports with contract tests, the engine service process with the versioned local-socket API and a typed client.
- **C. Desktop shell on a fake engine**: the Electron app as an engine client, with board, item drawer and new work running against a fake engine that serves sample data through the real engine API. Real engine data replaces the fake later without UI changes.
- **D0. First real task, end to end**: one thin path through D, E and F before either is complete: a built-in two-step quick-fix template, one guarded Claude Code call per step, a worktree per repo, checks run by Tokama, a commit on a branch, and the item moving live on the real board in place of the fake engine. From here Tokama is used to build Tokama; D, E and F then fill out around this path.
- **D. Claude Code agent**: the adapter, one agent call with usage capture, loop guards, stop and abort.
- **E. Templates and config**: template format and validation, agents, workspaces and repos, example templates.
- **F. Running a task**: item store, step sequencing and gates, worktrees, checks, review verdicts, retry, escalation and approval, commit or pull request, tamper checks.
- **G. Investigations**: connector port and MCP adapter, Postgres connector, data rules and egress, redaction and summaries, cloud-step approval, evidence and findings, investigation to fix task.
- **H. Local models**: Ollama host adapter, Claude Code runtime routed to Ollama.
- **I. Desktop, complete**: needs you and notifications, attention and usage rings, settings, template editor, first run, item full view, all wired to the real engine.
- **J. Codex CLI**: the adapter.
- **K. Usage**: rollups, quota windows, machine sampler.
