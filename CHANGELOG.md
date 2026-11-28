# Changelog

One section per version, written for people who use Tokama.

## Unreleased

- A reviewer step now gets the check commands of the step it reviews, each with its result, next to the diff. Before, the Reviewer was told to judge the check output but never received it. A cloud reviewer gets them only when its step sends the repo and diff.
- Tokama now also comes for Linux on x86_64, as a `.deb` for Ubuntu 24.04 or newer and an `.rpm` for Fedora. Install with `sudo apt install ./Tokama-<version>-amd64.deb` or `sudo dnf install ./Tokama-<version>-x86_64.rpm`. The package brings `git`, `bubblewrap` and `socat` with it.
- Adding or editing a repo now checks that the base branch is a local branch of the repo. A name such as `origin/main` or `refs/heads/main` is refused with the local name to use instead. Before, every item of that repo stopped at start.
- In Settings, Diagnostics, the 7 days and 30 days filters now start at midnight of their first day also when the clocks changed inside the range. Before, they started an hour early or late.
- The Diff tab of an item that is stopped or failed no longer reads every new file in its worktree. A new file over 100 MB, and new files past the first 10,000 (or 1 GB together), are left out and named in the file list, for example `big file, not shown: dist/app.bin 2.1 GB`. Before, a very large new file could keep the tab busy for minutes each time it opened.

## 0.0.1 (2026-11-26)

Signing test build. Not for general use.

- The commands an agent runs now run inside Claude Code's own sandbox. They can write the item's worktree, the repo's shared git data (so `git commit` works, but not its hooks or config), a few package caches and the temp folder, they can reach only package registries, and they cannot read well-known secret files such as `~/.ssh`. A step whose sandbox cannot start fails with the reason. This needs Claude Code 2.1.315 or newer, and on Linux `bubblewrap` and `socat`.
- Notifications have a choice per kind: Banner + sound, Banner only, Sound only or Off. Tokama has its own short sounds for Needs you, Finished and Failed, and each row in Settings has a ▶ button to listen. Sound only plays even during Focus, but not while your Mac is locked. In About, click the gecko to hear the Tokay call. Your earlier on/off choices carry over.
- Tokama now comes as a macOS app for Apple silicon, as a disk image and as a zip. Both are signed with a Developer ID certificate and notarized by Apple.
- On Linux, Tokama checks for updates by itself and shows the update when it is ready. Restart now installs it and asks for your password (the system installs the package as root); Tokama never installs on quit. An update is offered only when its feed file carries Tokama's signature.
