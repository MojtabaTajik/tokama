# codex-cli

AI CLI adapter (`codexCliAdapter`, in `adapter.ts`, the one export `composition.ts` wires): the CLI's name, login and update commands, minimum version, health check, launch description and runtime as one object the engine loops over.

Codex CLI 0.172.0 or newer (`CODEX_MIN`). `status.ts` runs `codex --version` and `codex login status`, read-only; the exit code of the second is the answer, its text is never read. Every `codex` call carries `--no-daemon` and `--disable daemon_auto_start`, so Tokama's calls are plain children of Tokama and never clients of Codex's background daemon.

`args.ts` builds the argv of one headless `codex exec` call (prompt on stdin). Rules it holds, checked by its tests:
- No user config, no rules, no hooks, no repo `.codex/` (never `--trust`), no repo agent instructions, `--ephemeral`, `--strict-config` (an unknown setting fails the call instead of being ignored).
- `approval_policy="never"`: a command the sandbox refuses stays refused.
- One permission profile, `tokama`, set with `default_permissions` and never with `-s` (with a profile the legacy sandbox settings are silently ignored). A read-only step extends `:read-only`; a step that edits extends `:workspace` with `/tmp` read-only (the writable temp folder is the `TMPDIR` the runtime sets). Network is off in both, whatever hosts a step lists: Codex cannot filter by host. Well-known secret paths, Tokama's folder and the given folders are closed with `"none"`, and so is every `.env` file under the working directory.
- It never passes `--dangerously-bypass-approvals-and-sandbox`, `--dangerously-bypass-hook-trust`, `--approve-for-me`, `--trust`, `--add-dir` or `-s`, nor a setting that sets another sandbox or trusts a folder. `buildArgs` refuses an argv that holds one.
- An agent with a list of commands is refused (`COMMAND_LIST_PROBLEM`): Codex runs any command inside its sandbox or none, and cannot limit commands to a list.

`toml.ts` writes the `-c key=value` values. Codex reads a value that is not valid TOML as a plain string, so a wrongly built value would not fail; every value is built there, with escaping, and a text with a broken character is refused.

The runtime refuses every call for now.

`real.int.test.ts` runs the profile through the real `codex sandbox` (no login, no model call, a decoy home folder). Opt in with `TOKAMA_REAL_CODEX=<absolute path of codex>`.
