import { compareVersions } from "../../../kernel/version/index.js";

/**
 * The first Codex CLI version Tokama runs. It is the version the permission profile, the strict
 * config check, the no-daemon flags and the sandbox command were tested on; an older one may read
 * a profile differently, so it does not run.
 */
export const CODEX_MIN = "0.172.0";

/** What a person types to sign in. */
export const LOGIN_COMMAND = "codex login";

/** What a person types to update Codex CLI. */
export const UPDATE_COMMAND = "npm install -g @openai/codex@latest";

/** The version in `codex --version` output: `codex-cli 0.172.0`. */
export function parseVersion(out: string): string | undefined {
  return /^codex-cli (\d+\.\d+\.\d+)(?:[-+][\w.+-]+)?(?:\s|$)/.exec(out.trim())?.[1];
}

/** Why Codex CLI cannot run steps on this version, or undefined when it can. An unreadable version fails closed. */
export function versionProblem(version: string | undefined): string | undefined {
  if (version === undefined) {
    return `Tokama could not read the Codex CLI version, and it needs Codex CLI ${CODEX_MIN} or newer. Check that \`codex --version\` works.`;
  }
  if (compareVersions(version, CODEX_MIN) >= 0) return undefined;
  return `Codex CLI ${CODEX_MIN} or newer is needed; this is Codex CLI ${version}. Update it (for example with \`${UPDATE_COMMAND}\`), then check again.`;
}
