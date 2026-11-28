# Tokama

Agent workbench for engineers. Your steps. Its checks. Your OK.

Tokama runs AI coding agents (Claude Code and Codex CLI) one step at a time, following templates you write. Each step names the agent that runs it and says when the step is done: the checks pass, a reviewer approves, or you approve. Tokama is a desktop app with its own local engine.

## Status

Early and pre-release. The first alpha download is planned for 6 December 2026 (macOS, Apple silicon). Until then, build it from source as described below. Expect rough edges and changes between commits.

## Safety

Read this before you run a template.

- Tokama does its work in git worktrees, so your main checkout stays untouched while a task runs.
- It checks the shell commands an agent wants to run against rules, and it asks you before changes that leave your machine, such as a push or a pull request.
- The commands an agent runs are inside the AI CLI's own sandbox. They can write the item's worktree, the repo's shared git data (objects, branches and index, so `git commit` works, but not its hooks or config), a few package caches and the temp folder, and they can reach only package registries. Well-known secret files such as `~/.ssh` are closed to them. A step whose sandbox cannot start fails; it never runs without it. The sandbox limits hosts by name only, so a registry can still carry data out.
- The sandbox covers commands only. An agent with web turned on can also open any website with its web tools, and the file tools are limited by Tokama's rules, not by the sandbox.
- Checks and setup commands that Tokama runs itself (for example `pnpm test`) are not sandboxed yet. They run as you and can do anything your user can do.

Check commands and their output can go to a cloud agent whose step sends the repo and diff.

Review templates and check commands before you run them, especially ones you did not write.

## Requirements

- Node 22.18 or newer
- pnpm, at the version in `packageManager` in `package.json`. Node 25 and later do not bundle corepack, so install it with the Node you use (`npm install -g corepack@latest`) and then run `corepack enable`. You can also install pnpm directly at that version.
- git 2.38 or newer (a repo that is a partial clone needs git 2.44 or newer)
- Claude Code 2.1.315 or newer, installed and logged in, to run real agent steps
- Linux only: `bubblewrap` and `socat`, for steps that run commands (Ubuntu or Debian: `sudo apt install bubblewrap socat`; Fedora: `sudo dnf install bubblewrap socat`). On Ubuntu, AppArmor can also stop bubblewrap or the helper Claude Code's sandbox runs inside it (Ubuntu 25.04 and newer ship a profile that does); the health check then reports it as blocked. How to allow it: https://tokama.dev/docs/linux-sandbox

macOS and Linux are supported. Windows is not yet.

## Build and run

Clone this repository, then from its top folder:

```sh
pnpm install
pnpm build
pnpm dev
```

`pnpm dev` starts the desktop app with its own engine process, in real mode: work you start runs real agents on your repos, so Claude Code must be installed and logged in. To look around first, run `pnpm dev:sample`. It uses sample repos and items that are not saved, and starts no agent.

## Add a repo

In the sidebar choose **+ Add repo**, then pick the top folder of a git repo. Tokama suggests an id, the base branch and the check commands it finds (for example `pnpm test`); change them if you want, then confirm. The repo is saved in `~/.tokama/repos.yaml`, and removing it from the sidebar never touches the folder itself.

## Agents and templates

- Agents are files named `<id>.md` in `~/.tokama/agents/` (yours) or `.tokama/agents/` in a repo (shared with the team): YAML front matter, then the role text. **Settings > Agents** lists them, with the problems of any file that does not load.
- Templates are YAML files in `.tokama/templates/` in a repo. Five ship with Tokama: Quick fix, Quick change, Plan and build, Ask and Review code. A template whose repo is `repos: read` gets no edit tools for its agents, and nothing is committed.

## Tests

```sh
pnpm test                              # fast unit tests
pnpm test:all                          # also the integration tests
pnpm --filter @tokama/desktop e2e      # the desktop app, driven in a real window
pnpm e2e:real                          # local only, needs a real Claude Code login, costs a few cents (see e2e/README.md)
```

On Linux the end-to-end tests need a display: run them under `xvfb-run --auto-servernum`. Screenshots go to `apps/desktop/e2e-output`.

`pnpm typecheck`, `pnpm lint` and `pnpm removal-test` are the other checks CI runs.

## Platform notes

- macOS: nothing else to install.
- Linux, Node: use a Node version manager that reads `.node-version`, for example fnm with `--use-on-cd`. Check that `which node` points to it and not to the distro Node. With the distro Node, `corepack enable` and a global `npm install` fail with `EACCES` (permission denied on system folders).
- Linux, git: Ubuntu 24.04 ships git 2.43, which works except for partial clones. Ubuntu 22.04 ships git 2.34, which is too old. The git-core PPA has a newer one.
- Linux: Electron needs the usual desktop libraries (GTK 3, NSS, ALSA). On Ubuntu 24.04 the Chromium sandbox needs unprivileged user namespaces; if the app will not start, see the Electron documentation on `kernel.apparmor_restrict_unprivileged_userns`.

## Licence

Apache-2.0. See [LICENSE](LICENSE). Third-party licences are listed in the app under About.

Website: [tokama.dev](https://tokama.dev)
