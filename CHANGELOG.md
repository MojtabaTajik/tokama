# Changelog

One section per version, written for people who use Tokama.

## Unreleased

- Tokama now also comes for Linux on x86_64, as a `.deb` for Ubuntu 24.04 or newer and an `.rpm` for Fedora. Install with `sudo apt install ./Tokama-<version>-amd64.deb` or `sudo dnf install ./Tokama-<version>-x86_64.rpm`. The package brings `git`, `bubblewrap` and `socat` with it.

## 0.0.1 (2026-11-26)

Signing test build. Not for general use.

- The commands an agent runs now run inside Claude Code's own sandbox. They can write the item's worktree, the repo's shared git data (so `git commit` works, but not its hooks or config), a few package caches and the temp folder, they can reach only package registries, and they cannot read well-known secret files such as `~/.ssh`. A step whose sandbox cannot start fails with the reason. This needs Claude Code 2.1.315 or newer, and on Linux `bubblewrap` and `socat`.
- Notifications have a choice per kind: Banner + sound, Banner only, Sound only or Off. Tokama has its own short sounds for Needs you, Finished and Failed, and each row in Settings has a ▶ button to listen. Sound only plays even during Focus, but not while your Mac is locked. In About, click the gecko to hear the Tokay call. Your earlier on/off choices carry over.
- Tokama now comes as a macOS app for Apple silicon, as a disk image and as a zip. Both are signed with a Developer ID certificate and notarized by Apple.