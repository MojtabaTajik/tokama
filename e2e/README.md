# Real end-to-end tests

Two tests run a real task with the real Claude Code CLI on your own login, in a temp fixture repo
(a tiny JS project with a failing `node --test` and one bug). They cost a few cents per run and
never run in CI; no API key is needed or stored anywhere.

```sh
pnpm e2e:real
```

It builds first, then runs:

- `real-task.e2e.ts`: starts the built engine in real mode, starts `builtin/quick-fix` through the
  engine API and waits for Done. It asserts a commit on the `tokama/...` branch, `node --test`
  passing on that commit (run in a separate copy), the fixture's main working tree untouched, the
  item log events, and that the real `~/.tokama` did not change.
- `real-app.e2e.ts`: the same task through the desktop app: add the repo with **+ Add repo**,
  start Quick fix from New work, watch it reach Done, and check the commit in the drawer.
  Screenshots go to `e2e/e2e-output/real/`.

Both skip with a message when `claude` is not installed or not logged in (the engine's own
`setup` health check decides). The agent is a personal Builder on `haiku`, written into the temp
Tokama home, and every item has a 240 s limit; on timeout the item is stopped and the engine ended.

Tokama's home is `<temp>/h/.tokama`, never `~/.tokama`. The engine process keeps your real `HOME`
on purpose: Claude Code finds its login there (on macOS in the login keychain), so a temp `HOME`
would always read as logged out. Claude Code writes its usual session files under `~/.claude`.
The engine stores no usage, so each run prints the tokens from Claude Code's session transcript.

