# Tokama

Tokama is a desktop engineering companion. It runs AI agents (Claude Code, Codex CLI or local models) on code tasks and investigations, following templates you write. Every step of a template names the agent that runs it and says when the step is done: checks pass, a reviewer approves, or you approve.

## Status

Early and pre-release. There are no installers yet: you build and run it from source. Expect rough edges and changes between commits.

## Requirements

- Node 22.18 or newer
- pnpm, at the version in `packageManager` in `package.json`. Node 25 and later do not bundle corepack, so install it with the Node you use (`npm install -g corepack@latest`) and then run `corepack enable`. You can also install pnpm directly at that version.
- git 2.44 or newer
- Claude Code, installed and logged in, to run real agent steps

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
- Templates are YAML files in `.tokama/templates/` in a repo. Three ship with Tokama: Quick fix, Plan and build, and Review only.

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
- Linux, Node: use a Node version manager that reads `.node-version`, for example fnm with `--use-on-cd`. Check that `which node` points to it and not to the distro Node. With the distro Node, `corepack enable` and a global `npm install` fail with `EACCES` on `/usr/bin`.
- Linux, git: Ubuntu 22.04 and 24.04 ship a git older than 2.44. The git-core PPA has a newer one.
- Linux: Electron needs the usual desktop libraries (GTK 3, NSS, ALSA). On Ubuntu 24.04 the Chromium sandbox needs unprivileged user namespaces; if the app will not start, see the Electron documentation on `kernel.apparmor_restrict_unprivileged_userns`.

## Licence

Apache-2.0. See [LICENSE](LICENSE). Third-party licences are listed in the app under About.

Website: [tokama.dev](https://tokama.dev)
