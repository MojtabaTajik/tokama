import { tmpdir } from "node:os";
import type { ProcessRunner } from "../process/index.js";
import type { SandboxCheck, SandboxSupport } from "./support.js";

/** Tool caches a build may write on Linux, `~/`-relative. Never a folder with programs on the PATH. */
export const LINUX_CACHE_DIRS: readonly string[] = [
  "~/.npm",
  "~/.local/share/pnpm/store",
  "~/.cache/pnpm",
  "~/.cache/yarn",
  "~/.nuget/packages",
  "~/.local/share/NuGet",
  "~/.cache/pip",
  "~/go/pkg/mod",
  "~/.cache/go-build",
  "~/.cargo/registry",
  "~/.cargo/git",
  "~/.m2/repository",
  "~/.gradle/caches",
  "~/.gradle/wrapper",
];

const PROBE_TIMEOUT_MS = 5_000;
// The programs the sandbox is built from: bubblewrap isolates, socat carries the proxied network.
const TOOLS: readonly (readonly [name: string, argv: readonly [string, ...string[]]])[] = [
  ["bwrap", ["bwrap", "--version"]],
  ["socat", ["socat", "-V"]],
];

/**
 * Linux needs `bwrap` and `socat` on the PATH. They are started through the same runner and
 * environment as the call, so a PATH set for the packaged app applies. Whether the kernel lets
 * bubblewrap run (an AppArmor rule on user namespaces) is left to the CLI's own startup check.
 */
export function createLinuxSupport(runner: ProcessRunner, env?: Readonly<Record<string, string>>): SandboxSupport {
  return {
    async check(signal): Promise<SandboxCheck> {
      const missing: string[] = [];
      for (const [name, argv] of TOOLS) {
        const result = await runner.run({ command: { argv }, cwd: tmpdir(), timeoutMs: PROBE_TIMEOUT_MS, signal, ...(env !== undefined && { env }) });
        const works = result.kind === "finished" && !result.timedOut && result.exitCode === 0;
        if (!works) missing.push(name);
      }
      if (missing.length === 0) return { ok: true };
      const list = missing.map((name) => `\`${name}\``).join(" and ");
      return {
        ok: false,
        problem: `Steps that run commands need bubblewrap and socat for Claude Code's sandbox, and ${list} ${missing.length === 1 ? "is" : "are"} missing or not working.`,
        fix: "Install them (Ubuntu: `sudo apt-get install bubblewrap socat`).",
      };
    },
  };
}
