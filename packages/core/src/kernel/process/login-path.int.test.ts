import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { manualClock } from "../clock/index.js";
import { resolveToolsPath, type ToolsPath } from "./login-path.js";
import { createProcessRunner } from "./runner.js";

// Real runner and real child processes. The "shell" is a script of the test's own, and HOME is a
// temp folder, so nothing here reads the developer's dotfiles. POSIX only.
const SLOW = { timeout: 20_000 };

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tokama-login-path-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fakeShell(name: string, body: string): string {
  const file = join(dir, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

describe.skipIf(process.platform === "win32")("resolveToolsPath with a real runner", () => {
  it(
    "reads the PATH the shell builds and passes it only the allowlisted variables",
    SLOW,
    async () => {
      const tools = join(dir, "tools");
      mkdirSync(tools);
      const envFile = join(dir, "env.txt");
      // A startup file that prints noise and changes PATH, then runs the script it was given (-i -l -c <script>).
      const shell = fakeShell("zsh", `echo "welcome to the shell"\nenv > "${envFile}"\nPATH="${tools}:$PATH"\nexport PATH\nexec /bin/sh -c "$4"`);
      const found = await resolveToolsPath({
        platform: process.platform,
        shell,
        inheritedPath: "/usr/bin:/bin",
        home: dir,
        parentEnv: { HOME: dir, USER: "a", SSH_AUTH_SOCK: "/tmp/agent.sock", ANTHROPIC_API_KEY: "sk-secret", TOKAMA_ENGINE_DIR: "/tmp/x", ELECTRON_RUN_AS_NODE: "1" },
      });
      expect(found.source).toBe("login-shell");
      expect(found.shell).toBe("zsh");
      expect(found.path?.startsWith(`${tools}:`)).toBe(true);
      expect(found.path?.split(":")).toContain("/usr/bin");
      const seen = readFileSync(envFile, "utf8");
      expect(seen).toContain(`HOME=${dir}`);
      expect(seen).toContain("PATH=/usr/bin:/bin:/usr/sbin:/sbin");
      for (const leaked of ["SSH_AUTH_SOCK", "ANTHROPIC_API_KEY", "TOKAMA_ENGINE_DIR", "ELECTRON_RUN_AS_NODE"]) expect(seen).not.toContain(leaked);
    },
  );

  it(
    "gives up on a shell that hangs, within the timeout, and leaves nothing running",
    SLOW,
    async () => {
      const pidFile = join(dir, "sleep.pid");
      const shell = fakeShell("zsh", `/bin/sleep 60 &\necho $! > "${pidFile}"\nwait`);
      const found = await resolveStuck(shell, pidFile, 300);
      expect(found.source).toBe("inherited");
      expect(found.path).toBe("/usr/bin:/bin");
      expect(found.problem).toContain("did not answer within");
      const pid = Number(readFileSync(pidFile, "utf8").trim());
      const deadline = Date.now() + 5_000;
      while (alive(pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      expect(alive(pid)).toBe(false);
    },
  );

  it(
    "kills a shell that ignores SIGTERM, as an interactive shell does, and still gives up",
    SLOW,
    async () => {
      const pidFile = join(dir, "sleep.pid");
      const shell = fakeShell("zsh", `trap '' TERM\n/bin/sleep 60 &\necho $! > "${pidFile}"\nwhile :; do /bin/sleep 1; done`);
      const found = await resolveStuck(shell, pidFile, 300);
      expect(found.source).toBe("inherited");
      expect(found.problem).toContain("did not answer within");
      const pid = Number(readFileSync(pidFile, "utf8").trim());
      const deadline = Date.now() + 5_000;
      while (alive(pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      expect(alive(pid)).toBe(false);
    },
  );

  it(
    "keeps the PATH of a shell that answered and then hung",
    SLOW,
    async () => {
      const shell = fakeShell("zsh", `/bin/sh -c "$4"\ntrap '' TERM\nwhile :; do /bin/sleep 1; done`);
      const found = await resolveToolsPath({ platform: process.platform, shell, inheritedPath: "/usr/bin:/bin", home: dir, parentEnv: { HOME: dir }, timeoutMs: 1_000 });
      expect(found.source).toBe("login-shell");
    },
  );

  it(
    "reports a slow shell that ignores SIGTERM: the stuck command dies, the shell still answers",
    SLOW,
    async () => {
      // Like an interactive zsh: the timeout's SIGTERM ends the foreground command only (a handler,
      // not an ignored signal, which a child would inherit).
      const shell = fakeShell("zsh", `trap : TERM\n/bin/sleep 20\n/bin/sh -c "$4"`);
      const found = await resolveToolsPath({ platform: process.platform, shell, inheritedPath: "/usr/bin:/bin", home: dir, parentEnv: { HOME: dir }, timeoutMs: 400 });
      expect(found).toMatchObject({ source: "login-shell", shell: "zsh", slow: true });
    },
  );

  it.skipIf(!existsSync("/bin/zsh"))(
    "runs the real zsh against an empty home",
    SLOW,
    async () => {
      // An empty startup file keeps zsh's first-run setup from starting.
      writeFileSync(join(dir, ".zshrc"), "");
      const found = await resolveToolsPath({ platform: process.platform, shell: "/bin/zsh", inheritedPath: undefined, home: dir, parentEnv: { HOME: dir } });
      expect(found.source).toBe("login-shell");
      expect(found.path?.split(":")).toContain("/usr/bin");
    },
  );
});

/**
 * `resolveToolsPath` with a runner on a manual clock: time moves only after the fake shell wrote
 * its pid file, when its setup is done. A timeout on the real clock can fire while the shell is
 * still starting under load, before the shell has set its trap or started its child.
 */
async function resolveStuck(shell: string, pidFile: string, timeoutMs: number): Promise<ToolsPath> {
  const base = manualClock();
  const delays: number[] = [];
  const clock = { ...base, setTimeout: (callback: () => void, ms: number) => (delays.push(ms), base.setTimeout(callback, ms)) };
  const runner = createProcessRunner({ clock, parentEnv: { HOME: dir }, drainMs: 200 });
  let found: ToolsPath | undefined;
  const run = resolveToolsPath({ platform: process.platform, shell, inheritedPath: "/usr/bin:/bin", home: dir, parentEnv: { HOME: dir }, runner, timeoutMs }).then((result) => (found = result));
  const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
  // Bounded: a shell that never writes the file still gets stopped below, and the test then fails on the missing file.
  const deadline = Date.now() + 10_000;
  while (found === undefined && Date.now() < deadline && (!existsSync(pidFile) || readFileSync(pidFile, "utf8").trim() === "")) await tick();
  base.advance(timeoutMs);
  // The stop's SIGKILL grace and the drain after the exit are on the manual clock too.
  while (found === undefined) {
    base.advance(2_000);
    await tick();
  }
  await run;
  // The timeout the caller gave is the one the runner was set to.
  expect(delays).toContain(timeoutMs);
  return found;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code !== "ESRCH" && code !== "EPERM";
  }
}
