import { tmpdir } from "node:os";
import type { ProcessRunner } from "../../../kernel/process/index.js";

/**
 * The first Claude Code version that honours a hook's `onFailure`, so a command-policy hook that
 * cannot start blocks the call.
 */
export const COMMAND_RULES_FROM = "2.1.295";

const VERSION_TIMEOUT_MS = 10_000;
const VERSION_LINES = 20;

/** Negative when `a` is older than `b`; versions are `major.minor.patch`. */
export function compareVersions(a: string, b: string): number {
  const parts = (version: string) => version.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** The leading `major.minor.patch` of `claude --version` output, e.g. `2.1.332` from `2.1.332 (Claude Code)`. */
export function parseVersion(out: string): string | undefined {
  return /^\d+\.\d+\.\d+/.exec(out.trim())?.[0];
}

/**
 * Why a call with command rules cannot run on this Claude Code version, or undefined when it can.
 * An undefined version fails closed.
 */
export function commandRulesProblem(version: string | undefined, why = "it printed no version"): string | undefined {
  if (version === undefined) {
    return `Tokama could not read the Claude Code version (${why}), and steps that run commands need Claude Code ${COMMAND_RULES_FROM} or newer. Check that \`claude --version\` works, then retry the step.`;
  }
  if (compareVersions(version, COMMAND_RULES_FROM) >= 0) return undefined;
  return `Claude Code ${COMMAND_RULES_FROM} or newer is needed for Tokama's command rules; this is Claude Code ${version}. Update Claude Code (for example with \`claude update\`), then retry the step.`;
}

export type VersionRead = { readonly kind: "version"; readonly version: string } | { readonly kind: "aborted" } | { readonly kind: "unknown"; readonly why: string };

export interface ReadVersionOptions {
  readonly command: readonly [string, ...string[]];
  readonly runner: ProcessRunner;
  readonly env?: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
  readonly timeoutMs?: number;
}

/** Runs `claude --version` the way the call itself will start the CLI. */
export async function readClaudeVersion(options: ReadVersionOptions): Promise<VersionRead> {
  const timeoutMs = options.timeoutMs ?? VERSION_TIMEOUT_MS;
  const lines: string[] = [];
  const result = await options.runner.run({
    command: { argv: [...options.command, "--version"] },
    cwd: tmpdir(),
    timeoutMs,
    signal: options.signal,
    ...(options.env !== undefined && { env: options.env }),
    stdout: { onLine: (line) => void (lines.length < VERSION_LINES && lines.push(line)) },
  });
  if (result.kind === "not-started") return result.reason === "aborted" ? { kind: "aborted" } : { kind: "unknown", why: "`claude --version` did not start" };
  if (result.aborted || options.signal.aborted) return { kind: "aborted" };
  if (result.timedOut) return { kind: "unknown", why: `it did not answer within ${Math.round(timeoutMs / 1000)} s` };
  if (result.exitCode !== 0) return { kind: "unknown", why: `it exited with code ${result.exitCode ?? "none"}` };
  const version = parseVersion(lines.join("\n"));
  return version === undefined ? { kind: "unknown", why: "it printed no version" } : { kind: "version", version };
}
