// Startup checks: git is new enough, and each AI CLI Tokama drives is installed and logged in.
// Read-only commands only. The result is kept for a short time, so the setup query can ask for it
// often without starting processes each time.
import { adapters, type CliHealth, createGit, type Health, type ProcessRunner } from "@tokama/core";

export type HealthChecks = () => Promise<Omit<Health, "config">>;

/**
 * The checks against this machine. Each adapter is looked up by name: it may have been removed.
 * The setup reply waits for them, so a hung CLI is cut off well inside a client's request timeout.
 */
export function machineChecks(runner: ProcessRunner): HealthChecks {
  const git = createGit({ runner, timeoutMs: 10_000 });
  const factories: Record<string, unknown> = { ...adapters };
  const claudeCodeStatus = factories["claudeCodeStatus"] as ((options: { runner: ProcessRunner; timeoutMs: number }) => Promise<CliHealth>) | undefined;
  return async () => {
    const [version, claude] = await Promise.all([git.checkGitVersion(), claudeCodeStatus?.({ runner, timeoutMs: 5_000 })]);
    return {
      git: version.ok ? { ok: true, version: version.value.slice(0, 100) } : { ok: false, message: version.error.message.slice(0, 1000) },
      clis: claude === undefined ? [] : [claude],
    };
  };
}

/** Runs the checks at most once per `maxAgeMs`; callers share a run in progress. */
export function cachedChecks(checks: HealthChecks, now: () => number, maxAgeMs = 30_000): { get(): Promise<Omit<Health, "config">> } {
  let last: { at: number; result: Promise<Omit<Health, "config">> } | undefined;
  return {
    get() {
      if (last === undefined || now() - last.at > maxAgeMs) {
        const result = checks().catch((error: unknown) => ({ git: { ok: false, message: `The checks failed: ${String(error)}`.slice(0, 1000) }, clis: [] }));
        last = { at: now(), result };
      }
      return last.result;
    },
  };
}
