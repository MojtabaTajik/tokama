# Tokama product spec

Status: draft for v1. Owner: Moji. Design: the canvas linked in CLAUDE.md (page "Tokama v2").

## 1. What Tokama is

Tokama is a desktop engineering companion. An engineer gives it work, and Tokama runs that work with AI agents, step by step, following a template the engineer wrote. There are two kinds of work:

- **Tasks**: code work in one or more repos (build a feature, fix a bug, review a branch). A task works in its own git worktree and ends in commits or a pull request.
- **Investigations**: read-only work against live systems (an alert fired, an API returns 500s, a deploy failed). An investigation queries logs, metrics and databases through connections and ends in findings. It can hand off a fix task.

Agents run on whatever the engineer already has: Claude Code or Codex CLI on their subscription plans, or local models through Ollama. Each step of a template picks its own agent, so private data can stay with a local model while a cloud model does planning or review on a summary the engineer approves.

Tokama is meant to stay open all day. The board shows everything that is running, which step it is in, which agent runs it, and what is waiting for the engineer.

## 2. Users

Software and platform engineers who run AI coding agents daily and are on call for production systems. They are comfortable with git, terminals and YAML, and they want to see exactly what an agent did and what data left their machine.

## 3. Concepts

| Concept | Meaning |
|---|---|
| Host | A machine running the Tokama engine. v1: the local Mac only. |
| Workspace | One system's world on a host: its repos, connections and templates. Example: "Northwind prod". |
| Repo | A local git folder in a workspace, with a base branch and a worktree folder. |
| Connection | An MCP server or built-in connector that gives agents tools on an outside system (App Insights, Postgres, Azure, Grafana, log files), with credentials and a scope (read-only, reader, peek only). |
| AI CLI | An installed agent program Tokama can drive headless: Claude Code, Codex CLI. Configured once per host. |
| Model host | What serves local models: Ollama in v1. |
| Agent | A named combination of AI CLI + model (+ model host for local) + permissions. Example: "Architect · Claude Code · opus", "Local investigator · Claude Code runtime · qwen3-coder:30b on Ollama". |
| Template | A versioned file, written by the engineer, that defines one kind of work as ordered steps (section 6). |
| Item | One run of a template: a task or an investigation. |
| Step | One stage of an item, run by one agent (or by Tokama itself for checks), with a gate before the next step. |
| Stage | The board column a step counts as: queued, working, verifying, review, done. |
| Needs you | A step waiting for the engineer: approve a plan, approve a cloud step, decide after repeated failure, a quota limit. |
| Attention | Health problems that are not tied to one item: expiring token, quota near its limit, Ollama down, CLI logged out. |

## 4. v1 scope

In v1:

- One local host, macOS. The engine runs as a background service, so items keep running when the app window is closed.
- Workspaces with repos and connections.
- Templates as files, a template editor, built-in example templates (plan and build, quick fix, review only, emergency investigator, DB slow query check).
- Agents on Claude Code, Codex CLI, and local models via Ollama driven through Claude Code.
- Tasks and investigations on one board, item drawer and full view.
- Gates: checks, verdict, the engineer's approval. Retry, escalate to another agent, stop.
- Data rules per step, cloud-step approval with redaction, local-only mode.
- Loop guards for every agent call.
- Usage per call and per item (tokens, plan quota where the CLI reports it, API-equivalent cost, time, local machine load), usage rings per AI CLI, attention popup.
- First-run setup, settings (AI CLIs, local models, workspace repos, connections, templates, agents, privacy, loop guards).
- Desktop notifications when an item needs the engineer or finishes.

Not in v1:

- Remote hosts (the engine API is ready for them, see architecture).
- CLI package for scripting and CI.
- Insights page beyond per-item usage, history search, benchmark mode.
- Direct API keys, Gemini CLI, LM Studio, MLX, llama.cpp.
- Team features, sharing, sync.
- Linux and Windows builds (the architecture keeps them possible; macOS ships first).
- Mobile and tablet: later, as a remote client of a host (board, needs you, approvals, notifications) through the engine API and a relay. Agents never run on the phone.

## 5. Main flows

### 5.1 First run

1. Tokama detects installed AI CLIs (path, version, login state, plan where readable) and model hosts (Ollama running, models pulled, memory fit).
2. The engineer creates the first workspace: names it, picks repos found on disk (filterable list, or "Choose folder…").
3. Tokama creates default agents from what it found and offers the example templates. Connections are added later in settings.

### 5.2 Add a connection

The engineer picks a type (MCP server by command or URL, Postgres, SQL Server, Azure, Kubernetes, log files), enters credentials and a scope, and runs "Test". Credentials go to the OS secret store (macOS Keychain in v1). Tokama shows the scope it got and the health of each connection.

### 5.3 Write or edit a template

In the template editor (or the YAML file directly): add steps, set each step's fields (section 6), validate, and dry-run against a past alert or a sample task. Templates live in a repo of the workspace (`.tokama/templates/`) so they are versioned with the code.

### 5.4 Start work

From the floating "New work" input on the board: describe the work or paste an alert, pick a template (Tokama suggests one from the text), pick repos (multi-select). The template's connections show as read-only badges and its steps on one line. Options: ask before cloud steps, notify. Start (⌘↵).

### 5.5 Run

- Each step runs its agent with the step's prompt, the outputs of earlier steps, and only the tools, commands and connections the step allows.
- Loop guards watch every agent call (section 8). A guard stop is not an error: the gate decides what happens next.
- The gate runs: checks run by Tokama itself, a verdict from a reviewer step, or the engineer's approval.
- On failure: retry with the feedback, escalate to another agent, or stop and ask, as the step says.
- A step whose data rule sends anything to a cloud agent waits for cloud-step approval unless the engineer turned that off for the template.
- Tasks: each repo gets a worktree and branch. The final step commits or opens a pull request. Repos are never changed outside the worktree.
- Investigations: no worktree, no file edits. Evidence (each query and its result) and findings are kept on the machine. A finding can create a fix task with a link back.

### 5.6 Needs you

Items waiting for the engineer show an amber line on the card, appear under "Needs you" in the rail and the workspaces panel, and send a desktop notification. The drawer shows the question and the decision buttons.

### 5.7 Control

Per item: add a hint for the next attempt, rerun a step, hand the step to another agent, open the worktree, stop. Stopping kills the agent's process group and keeps everything recorded so far.

## 6. Templates

A template is one YAML file plus prompt files next to it.

```yaml
name: Emergency investigator
kind: investigation            # investigation | task
connections:                   # what the template may use, and how
  app-insights: query
  postgres-main: read-only
  azure-prod: reader
steps:
  - name: Triage
    stage: working
    agent: local-investigator
    prompt: prompts/triage.md
    output: scope
  - name: Query logs and metrics
    stage: working
    agent: local-investigator
    prompt: prompts/query.md
    uses: [app-insights, postgres-main]
    limits: { max_queries: 10, timeout: 5m }
    output: evidence
    gate: { min_queries: 3 }
    on_fail: { retry: 1, then: ask }
  - name: Find the cause
    stage: working
    agent: local-investigator
    prompt: prompts/cause.md
    output: findings
  - name: Propose a fix
    stage: review
    agent: architect
    prompt: prompts/fix.md
    input: findings.summary
    data: summary-after-approval
    gate: approval
    on_done: { create_task: plan-and-build }
```

Step fields:

| Field | Meaning |
|---|---|
| `name`, `stage` | Label and board stage. |
| `agent` | Agent id from the workspace's agents. |
| `prompt` | Prompt file. Can reference inputs (`{{ alert }}`, `{{ scope }}`, `{{ findings.summary }}`). |
| `input` | Which earlier outputs the step sees (default: all). |
| `uses` | Connections this step may use (subset of the template's). |
| `tools`, `commands` | File edit permission and allowed shell commands (allowlist, same rules as checks). |
| `limits` | Turn cap, query cap, timeout; loop guard overrides. |
| `output` | Name of what the step produces, for later steps. |
| `checks` | Commands Tokama runs itself after the step (tasks). |
| `gate` | `checks`, `verdict`, `approval`, or a condition on the output. |
| `on_fail` | `retry: n`, `escalate: <agent>`, `then: ask | stop`. |
| `data` | What may leave the machine: `none` (default for local agents), `summary-after-approval`, `repo-and-diff`. |
| `on_done` | Follow-up, e.g. create a task from a template. |

The engine validates templates before a run: unknown agents, connections the template does not declare, a cloud agent on a step with `data: none`, missing prompts. The board's per-template view uses the step names; the default view uses `stage`.

## 7. Privacy

- Every step has a data rule. A step run by a local agent sends nothing out. A step run by a cloud agent sends only what its rule allows.
- `summary-after-approval`: Tokama builds the summary from the step's inputs, redacts it (hostnames, IPs, customer names, secrets, by workspace rules), and shows the engineer the exact text before sending. The engineer can edit it, send it, run the step locally instead, or stop. Nothing is sent before that.
- Local-only mode (per workspace or per run): only local agents are allowed; a template with a cloud step fails validation.
- Raw connection results, logs and query output stay on the machine. The item view shows what left the machine, when, and to which provider.
- Credentials stay in the Keychain and are never given to an agent as text; connections expose tools, not secrets.
- Every egress goes through one place in the engine, which enforces these rules.

## 8. Safety

Carried over from ai-pipeline, where each was learned from real runs:

- Loop guards on every agent call: turn cap, same-call repeat limit, idle stop (only after file changes and passing checks), timeout. Guards must not cut legitimate edit/test cycles or long file writes. Time burned in loops is measured and excluded from comparisons.
- Agents never get a skip-all-permissions flag. Tools and commands come from the step.
- Child processes get an environment allowlist (no other API keys, no SSH agent socket) and run in their own process group, killed on stop or timeout.
- Commands in checks and step allowlists are parsed quote-aware; shell metacharacters that could escape the allowlist are refused.
- Git runs hardened (no hooks, no fsmonitor, no external diff or textconv, no signing prompts).
- Tamper checks: git config, hooks, attributes and ignore files are hashed per step; a change aborts the item.
- Agent output and repo content are untrusted: rendered as text, fenced in prompts.
- Known gap: agents run as the user. A sandbox (separate user, container or macOS sandbox profile) is future work.

## 9. Measurement

Per agent call: tokens by type, plan quota used (where the CLI reports it), API-equivalent cost at list prices (labelled as an estimate on plans), wall time, guard stops, wasted time. Per local call: GPU, power, temperature, model memory (macmon on macOS, fallback elsewhere). Rolled up per step, item, template and AI CLI. The rail's usage rings show each CLI's current plan window.

## 10. Decisions and open questions

- Decided: pull requests are opened with the user's logged-in `gh` CLI (no token in Tokama; GitHub first, other hosts through their CLIs later).
- Decided: release work (signing and notarisation, auto-update, the tokama.dev landing page) starts once the first real task runs end to end.

Open:


- Codex CLI: exact headless flags, event format and usage reporting, to be checked against the installed version.
- Redaction: built-in rules plus per-workspace patterns; how to preview what was removed without showing it.
- Where item history lives long-term and how long evidence is kept.
