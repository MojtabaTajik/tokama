import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveToolsPath } from "./login-path.js";

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
      const started = Date.now();
      const found = await resolveToolsPath({ platform: process.platform, shell, inheritedPath: "/usr/bin:/bin", home: dir, parentEnv: { HOME: dir }, timeoutMs: 300 });
      expect(Date.now() - started).toBeLessThan(5_000);
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
      const started = Date.now();
      const found = await resolveToolsPath({ platform: process.platform, shell, inheritedPath: "/usr/bin:/bin", home: dir, parentEnv: { HOME: dir }, timeoutMs: 300 });
      expect(Date.now() - started).toBeLessThan(8_000);
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

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code !== "ESRCH" && code !== "EPERM";
  }
}
