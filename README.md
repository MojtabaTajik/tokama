# Tokama

Agent workbench for engineers. Your steps. Its checks. Your OK.

Tokama runs AI coding agents one step at a time, following templates you write. Each step names the agent that runs it and says when the step is done: the checks pass, a reviewer approves, or you approve. Tokama is a desktop app with its own local engine.

## Status

Alpha. Version 0.1.0 is the first release and has rough edges. Tokama works with Claude Code only for now. Codex CLI and local models come later.

| Platform | Download |
| --- | --- |
| macOS, Apple silicon | signed and notarized `.dmg`. Intel Macs are not supported yet. |
| Linux, x86_64 | `.deb` for Ubuntu 24.04 or newer and Debian 12 or newer; `.rpm` for the current and previous Fedora |
| Windows | later |

## Install

Download the file for your system from [tokama.dev/download](https://tokama.dev/download).

- macOS: open the `.dmg` and drag Tokama to Applications.
- Debian or Ubuntu: `sudo apt install ./Tokama-<version>-amd64.deb`
- Fedora: `sudo dnf install ./Tokama-<version>-x86_64.rpm`

Each release has a `SHA256SUMS.txt` with the SHA-256 hash of every file. On Linux, check a download with `sha256sum --ignore-missing -c SHA256SUMS.txt` in the folder that holds both files. On macOS, run `shasum -a 256` on the file and compare the result with its line in the list.

Tokama checks for updates by itself and shows a chip in the sidebar when one is ready. It installs the update only when you choose Restart now, never when you quit. On Linux the system asks for your password at that point, because it installs the package as root.

## Safety

Read this before you run a template.

- Tokama does its work in git worktrees, so your main checkout stays untouched while a task runs.
- It checks the shell commands an agent wants to run against rules, and it asks you before changes that leave your machine, such as a push or a pull request.
- The commands an agent runs are inside the AI CLI's own sandbox. They can write the item's worktree, the repo's shared git data (objects, branches and index, so `git commit` works, but not its hooks or config), a few package caches and the temp folder, and they can reach only package registries. Well-known secret files such as `~/.ssh` are closed to them. A step whose sandbox cannot start fails; it never runs without it. The sandbox limits hosts by name only, so a registry can still carry data out.
- The sandbox covers commands only. An agent with web turned on can also open any website with its web tools, and the file tools are limited by Tokama's rules, not by the sandbox.
- Checks and setup commands that Tokama runs itself (for example `pnpm test`) are not sandboxed yet. They run as you and can do anything your user can do.

Check commands and their output can go to a cloud agent whose step sends the repo and diff.

Review templates and check commands before you run them, especially ones you did not write.

To report a security problem, see [SECURITY.md](SECURITY.md).

## Requirements

- Claude Code 2.1.315 or newer, installed and logged in
- git 2.38 or newer (a repo that is a partial clone needs git 2.44 or newer)
- Linux only: `bubblewrap` and `socat`. The package installs them. On Ubuntu 24.04 an AppArmor rule can still stop bubblewrap, and the health check then reports it as blocked. Claude Code's sandbox documentation has the profile, or run `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0` until the next reboot.

## Add a repo

In the sidebar choose **+ Add repo**, then pick the top folder of a git repo. Tokama suggests an id, the base branch and the check commands it finds (for example `pnpm test`); change them if you want, then confirm. The repo is saved in `~/.tokama/repos.yaml`, and removing it from the sidebar never touches the folder itself.

## Built-in workflows

Five templates ship with Tokama:

- **Quick fix**: a builder makes the change, Tokama runs the repo's checks and sends back what fails, up to three attempts. Then it commits.
- **Quick change**: for repos without checks. You read the diff and approve it or ask for changes. Then it commits.
- **Plan and build**: an architect writes a plan and you approve it. A builder implements it until the checks pass, and a reviewer checks the change against the plan. Then it commits.
- **Ask**: an agent answers a question about the repo. It changes no file.
- **Review code**: a reviewer reads the code you point at and reports findings. It changes no file.

## Agents and templates

- Agents are files named `<id>.md` in `~/.tokama/agents/` (yours) or `.tokama/agents/` in a repo (shared with the team): YAML front matter, then the role text. **Settings > Agents** lists them, with the problems of any file that does not load.
- Templates are YAML files in `.tokama/templates/` in a repo. You can write your own or copy the built-in ones as a start. A template whose repo is `repos: read` gets no edit tools for its agents, and nothing is committed.

## Build from source

You need Node 22.18 or newer, and pnpm at the version in `packageManager` in `package.json`. Node 25 and later do not bundle corepack, so install it with the Node you use (`npm install -g corepack@latest`) and then run `corepack enable`. Clone this repository, then from its top folder:

```sh
pnpm install
pnpm build
pnpm dev
```

`pnpm dev` starts the desktop app with its own engine process, in real mode: work you start runs real agents on your repos. To look around first, run `pnpm dev:sample`. It uses sample repos and items that are not saved, and starts no agent.

On Linux, use a Node version manager that reads `.node-version`, for example fnm with `--use-on-cd`, and check that `which node` points to it and not to the distro Node. With the distro Node, `corepack enable` and a global `npm install` fail with `EACCES`.

## Tests

```sh
pnpm test                              # fast unit tests
pnpm test:all                          # also the integration tests
pnpm --filter @tokama/desktop e2e      # the desktop app, driven in a real window
pnpm e2e:real                          # local only, needs a real Claude Code login, costs a few cents (see e2e/README.md)
```

On Linux the end-to-end tests need a display: run them under `xvfb-run --auto-servernum`. Screenshots go to `apps/desktop/e2e-output`.

`pnpm typecheck`, `pnpm lint` and `pnpm removal-test` are the other checks CI runs.

## Licence

Apache-2.0. See [LICENSE](LICENSE). Third-party licences are listed in the app under About.

Website: [tokama.dev](https://tokama.dev)
