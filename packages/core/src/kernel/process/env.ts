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

/**
 * Builds a child environment: the allowlisted variables of `parent`, then `extra` on top.
 * `extra` may override an allowlisted variable (e.g. PATH).
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
  return Object.assign(env, extra);
}
