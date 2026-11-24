import { delimiter, isAbsolute } from "node:path";

// The only parent variables a child process gets. Everything else (session and messaging
// variables of an outer agent CLI, SSH_AUTH_SOCK, *_API_KEY, cloud credentials, ...) is dropped.
// Callers add what a call needs explicitly, e.g. a local-model base URL.
export const ENV_ALLOWLIST: readonly string[] = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "TERM",
];

// A PATH entry that is a package-manager tool folder, with or without a trailing separator.
const TOOL_DIR = /(?:^|[\\/])(?:node_modules[\\/]\.bin|node-gyp-bin)[\\/]?$/;

/**
 * Builds a child environment: the allowlisted variables of `parent`, then `extra` on top.
 * `extra` may override an allowlisted variable (e.g. PATH). PATH keeps only absolute entries:
 * an empty entry or `.` means the child's cwd (an agent-written repo), and an unexpanded `~/...`
 * is relative too. Package-manager tool folders (`node_modules/.bin`, pnpm's `node-gyp-bin`) are
 * dropped too: when Tokama itself runs from a package script, they would put Tokama's own dev
 * tools first on the child's PATH. PATH is left out if nothing remains, never set to "" (which
 * also means cwd).
 */
export function buildEnv(
  parent: Readonly<Record<string, string | undefined>>,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ENV_ALLOWLIST) {
    const value = parent[name];
    if (value !== undefined) env[name] = value;
  }
  Object.assign(env, extra);
  if (env["PATH"] !== undefined) {
    const path = env["PATH"]
      .split(delimiter)
      .filter((entry) => isAbsolute(entry) && !TOOL_DIR.test(entry))
      .join(delimiter);
    if (path === "") delete env["PATH"];
    else env["PATH"] = path;
  }
  return env;
}
