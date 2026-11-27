// A PATH for the app and its engine that holds a fake `claude`, so a flow decides what the AI CLI
// checks find: missing, logged out, too old, or ready. The folder is made at every start of the
// app, inside the test's temp dir. Besides it, the PATH has only the system folders: `node` is a
// wrapper to the node that runs the tests, `git` comes from /usr/bin, and a fake `bwrap` and
// `socat` let Claude Code's sandbox check pass on Linux.
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type ClaudeMode = "missing" | "logged-out" | "old" | "ready";

const binOf = (tmp: string) => join(tmp, "bin");

const script = (body: string) => `#!/bin/sh\n${body}\n`;
// Shell builtins only: the PATH has no `cat` or `dirname` of its own to rely on.
const CLAUDE = script(`read -r mode < "\${0%/*}/mode"
case "$1" in
  --version)
    if [ "$mode" = old ]; then echo "2.1.290 (Claude Code)"; else echo "2.1.332 (Claude Code)"; fi ;;
  auth)
    if [ "$mode" = logged-out ]; then echo '{"loggedIn":false}'; else echo '{"loggedIn":true}'; fi ;;
  *)
    # A real run: hold the call open, so the first item stays running for a while.
    exec sleep 20 ;;
esac`);

function put(path: string, content: string): void {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

/** Sets what `claude` is on the PATH of this test: not there, or there with the given state. */
export function setClaude(tmp: string, mode: ClaudeMode): void {
  const bin = binOf(tmp);
  mkdirSync(bin, { recursive: true });
  if (mode === "missing") {
    rmSync(join(bin, "claude"), { force: true });
    return;
  }
  writeFileSync(join(bin, "mode"), `${mode}\n`);
  if (!existsSync(join(bin, "claude"))) put(join(bin, "claude"), CLAUDE);
}

/** The environment of a flow: the fake PATH. Claude Code is missing until the flow gives it a state with `setClaude`. */
export function fakeToolsEnv(tmp: string): Record<string, string> {
  const bin = binOf(tmp);
  mkdirSync(bin, { recursive: true });
  put(join(bin, "node"), script(`exec "${process.execPath}" "$@"`));
  put(join(bin, "bwrap"), script("echo bubblewrap 0.9.0"));
  put(join(bin, "socat"), script("echo socat 1.8.0.0"));
  return { PATH: `${bin}:/usr/bin:/bin` };
}
