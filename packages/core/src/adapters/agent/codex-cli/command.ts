/** The executable every Codex CLI call and check starts, found on the allowlisted PATH. */
export const CODEX_CLI_COMMAND = "codex";

/**
 * Words that go on every Codex CLI call, before the subcommand and after it: Codex starts a
 * managed background daemon of its own on some calls, and Tokama's calls must stay out of it.
 */
export const NO_DAEMON = ["--no-daemon"] as const;
export const NO_DAEMON_FEATURE = ["--disable", "daemon_auto_start"] as const;
