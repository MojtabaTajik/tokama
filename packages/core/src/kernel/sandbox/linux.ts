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

const DOCS = "https://tokama.dev/docs/linux-sandbox";

/** Bubblewrap cannot start a sandbox at all (Ubuntu 24.04 with AppArmor's user namespace restriction). */
export const BWRAP_BLOCKED_HINT = `Ubuntu's AppArmor can stop bubblewrap from creating a user namespace. How to allow it: ${DOCS}`;

/** Bubblewrap starts, but the helper Claude Code's sandbox runs inside it cannot (Ubuntu 25.04 and newer). */
export const NESTED_BLOCKED_HINT = `Ubuntu's AppArmor profile for bubblewrap stops the helper that Claude Code's sandbox starts inside it. How to allow it: ${DOCS}`;

const PROBE_TIMEOUT_MS = 5_000;
// The programs the sandbox is built from: bubblewrap isolates, socat carries the proxied network.
const TOOLS: readonly (readonly [name: string, argv: readonly [string, ...string[]]])[] = [
  ["bwrap", ["bwrap", "--version"]],
  ["socat", ["socat", "-V"]],
];
// The sandbox Claude Code builds. The probes use the same options: `--version` passes where the
// kernel or AppArmor refuses these.
const BWRAP = ["bwrap", "--new-session", "--die-with-parent", "--unshare-user", "--unshare-pid", "--unshare-net", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc"] as const;
// Claude Code's `apply-seccomp` helper makes a user namespace of its own inside the sandbox.
const NESTED = [...BWRAP, "--", "unshare", "--user", "--map-root-user", "true"] as const;
// The AppArmor profile the sandbox's processes run under; Ubuntu's restricted one is `unpriv_bwrap`.
const PROFILE = [...BWRAP, "--", "cat", "/proc/self/attr/current"] as const;

/**
 * Linux needs `bwrap` and `socat` on the PATH, and a bubblewrap that can start the sandbox Claude
 * Code builds, with the nested user namespace its helper makes: AppArmor can block either while
 * `bwrap --version` still passes. Everything is started through the same runner and environment
 * as the call, so a PATH set for the packaged app applies.
 */
export function createLinuxSupport(runner: ProcessRunner, env?: Readonly<Record<string, string>>): SandboxSupport {
  const probe = async (argv: readonly [string, ...string[]], signal: AbortSignal) => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const result = await runner.run({
      command: { argv },
      cwd: tmpdir(),
      timeoutMs: PROBE_TIMEOUT_MS,
      signal,
      stdout: { onLine: (line) => stdout.push(line) },
      stderr: { onLine: (line) => stderr.push(line) },
      ...(env !== undefined && { env }),
    });
    const ran = result.kind === "finished" && !result.timedOut && result.exitCode === 0;
    return { result, ran, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
  };
  return {
    async check(signal): Promise<SandboxCheck> {
      const missing: string[] = [];
      for (const [name, argv] of TOOLS) {
        if (!(await probe(argv, signal)).ran) missing.push(name);
      }
      if (missing.length > 0) {
        const list = missing.map((name) => `\`${name}\``).join(" and ");
        return {
          ok: false,
          problem: `Steps that run commands need bubblewrap and socat for Claude Code's sandbox, and ${list} ${missing.length === 1 ? "is" : "are"} missing or not working.`,
          fix: "Install them (Ubuntu or Debian: `sudo apt install bubblewrap socat`; Fedora: `sudo dnf install bubblewrap socat`).",
        };
      }
      if (!(await probe([...BWRAP, "true"], signal)).ran) {
        return {
          ok: false,
          problem: "Steps that run commands need bubblewrap, which is installed but blocked: it could not start a sandbox on this machine.",
          fix: BWRAP_BLOCKED_HINT,
        };
      }
      const nested = await probe(NESTED, signal);
      // Without `unshare` the probe shows nothing: Claude Code's helper may still run.
      if (nested.ran || nested.result.kind !== "finished" || /execvp unshare/.test(nested.stderr)) return { ok: true };
      const restricted = (await probe(PROFILE, signal)).stdout.includes("unpriv_bwrap");
      return {
        ok: false,
        problem: `Steps that run commands need bubblewrap, which starts here but blocks the helper that Claude Code's sandbox runs inside it${restricted ? " (the AppArmor profile `unpriv_bwrap` is active)" : ""}, so every command would fail.`,
        fix: NESTED_BLOCKED_HINT,
      };
    },
  };
}
