# Changelog

One section per version, written for people who use Tokama.

## 0.0.1 (2026-11-26)

Signing test build. Not for general use.

- The commands an agent runs now run inside Claude Code's own sandbox. They can write only in the item's worktree, a few package caches and the temp folder, they can reach only package registries (none in a local-only run), and they cannot read well-known secret files such as `~/.ssh`. A step whose sandbox cannot start fails with the reason. This needs Claude Code 2.1.315 or newer, and on Linux `bubblewrap` and `socat`.
- Notifications have a choice per kind: Banner + sound, Banner only, Sound only or Off. Tokama has its own short sounds for Needs you, Finished and Failed, and each row in Settings has a ▶ button to listen. Sound only plays even during Focus, but not while your Mac is locked. In About, click the gecko to hear the Tokay call. Your earlier on/off choices carry over.
- Tokama now comes as a macOS app for Apple silicon, as a disk image and as a zip. Both are signed with a Developer ID certificate and notarized by Apple.
