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

/** What to do when AppArmor stops bubblewrap from creating a user namespace (Ubuntu 24.04 and newer). */
export const APPARMOR_HINT =
  "On Ubuntu, AppArmor may block bubblewrap: add an AppArmor profile for /usr/bin/bwrap (see Claude Code's sandbox docs), or run `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0` until the next reboot.";

const PROBE_TIMEOUT_MS = 5_000;
// The programs the sandbox is built from: bubblewrap isolates, socat carries the proxied network.
const TOOLS: readonly (readonly [name: string, argv: readonly [string, ...string[]]])[] = [
  ["bwrap", ["bwrap", "--version"]],
  ["socat", ["socat", "-V"]],
];
// A no-op in the namespaces Claude Code's sandbox needs: `--version` passes even where the kernel refuses these.
const BWRAP_NOOP = ["bwrap", "--ro-bind", "/", "/", "--dev", "/dev", "--unshare-user", "--unshare-pid", "--unshare-net", "--die-with-parent", "true"] as const;

/**
 * Linux needs `bwrap` and `socat` on the PATH, and a bubblewrap that can start: a no-op must run
 * inside it, because an AppArmor rule on user namespaces blocks it while `bwrap --version` still
 * passes. Everything is started through the same runner and environment as the call, so a PATH
 * set for the packaged app applies.
 */
export function createLinuxSupport(runner: ProcessRunner, env?: Readonly<Record<string, string>>): SandboxSupport {
  const works = async (argv: readonly [string, ...string[]], signal: AbortSignal): Promise<boolean> => {
    const result = await runner.run({ command: { argv }, cwd: tmpdir(), timeoutMs: PROBE_TIMEOUT_MS, signal, ...(env !== undefined && { env }) });
    return result.kind === "finished" && !result.timedOut && result.exitCode === 0;
  };
  return {
    async check(signal): Promise<SandboxCheck> {
      const missing: string[] = [];
      for (const [name, argv] of TOOLS) {
        if (!(await works(argv, signal))) missing.push(name);
      }
      if (missing.length > 0) {
        const list = missing.map((name) => `\`${name}\``).join(" and ");
        return {
          ok: false,
          problem: `Steps that run commands need bubblewrap and socat for Claude Code's sandbox, and ${list} ${missing.length === 1 ? "is" : "are"} missing or not working.`,
          fix: "Install them (Ubuntu or Debian: `sudo apt install bubblewrap socat`; Fedora: `sudo dnf install bubblewrap socat`).",
        };
      }
      if (await works(BWRAP_NOOP, signal)) return { ok: true };
      return {
        ok: false,
        problem: "Steps that run commands need bubblewrap, which is installed but blocked: it could not start a sandbox on this machine.",
        fix: APPARMOR_HINT,
      };
    },
  };
}
