import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CREDENTIAL_PATHS, PACKAGE_REGISTRY_HOSTS, toolCacheDirs, type SandboxSpec } from "../../../kernel/sandbox/index.js";
import { mentionsSandbox, sandboxSettings, sandboxStartProblem, SANDBOX_REQUIRED } from "./sandbox.js";

const worktree = "/Users/northwind-dev/src/orders-api/.tokama/wt/item-0b9f3c1e";
const callDir = "/var/folders/xx/T/tokama-claude-call-AbC123";
const callFiles = [`${callDir}/rules.json`, `${callDir}/settings.json`];

const net = (...allow: string[]) => ({ allow, unlisted: "deny" as const });
const worktreeSpec: SandboxSpec = { writableRoot: worktree, readOnlyRoots: [], network: net(...PACKAGE_REGISTRY_HOSTS) };

describe("sandboxSettings", () => {
  it("is exactly this for a worktree on macOS", () => {
    const cacheDirs = toolCacheDirs("darwin");
    expect(sandboxSettings(worktreeSpec, { callDirs: [callDir], callFiles, tokamaHome: "~/.tokama", cacheDirs })).toEqual({
      permissions: { deny: ["Bash(dangerouslyDisableSandbox:true)"] },
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        allowUnsandboxedCommands: false,
        autoAllowBashIfSandboxed: false,
        excludedCommands: [],
        enableWeakerNestedSandbox: false,
        enableWeakerNetworkIsolation: false,
        allowNestedUserNamespaces: false,
        allowAppleEvents: false,
        filesystem: {
          allowWrite: [...cacheDirs],
          denyWrite: ["~/.tokama", callDir],
          denyRead: ["~/.tokama", ...callFiles, ...CREDENTIAL_PATHS],
        },
        network: { allowedDomains: [...PACKAGE_REGISTRY_HOSTS], strictAllowlist: true, allowLocalBinding: false, allowAllUnixSockets: false },
      },
    });
  });

  it("lists the Linux caches, without the worktree, which is writable as the working directory", () => {
    const cacheDirs = toolCacheDirs("linux");
    const { sandbox } = sandboxSettings(worktreeSpec, { callDirs: [callDir], callFiles, tokamaHome: "~/.tokama", cacheDirs }) as { sandbox: { filesystem: { allowWrite: string[] } } };
    expect(sandbox.filesystem.allowWrite).toEqual(cacheDirs);
    expect(sandbox.filesystem.allowWrite).toContain("~/.local/share/pnpm/store");
    expect(JSON.stringify(sandbox)).not.toContain(worktree);
  });

  it("closes a read-only repo to writes and to the Edit tool, and passes the hosts, for a scratch folder", () => {
    const scratch = "/home/northwind-dev/.local/share/tokama-scratch/item-0b9f3c1e";
    const spec: SandboxSpec = { writableRoot: scratch, readOnlyRoots: ["/home/northwind-dev/src/orders-api"], network: net("northwind.example.com", "*.blob.example.net:443") };
    expect(sandboxSettings(spec, { callDirs: [callDir], callFiles, tokamaHome: "/home/northwind-dev/.tokama", cacheDirs: [] })).toEqual({
      permissions: { deny: ["Bash(dangerouslyDisableSandbox:true)", "Edit(//home/northwind-dev/src/orders-api/**)"] },
      sandbox: expect.objectContaining({
        filesystem: {
          allowWrite: [],
          denyWrite: ["/home/northwind-dev/.tokama", callDir, "/home/northwind-dev/src/orders-api"],
          denyRead: ["/home/northwind-dev/.tokama", ...callFiles, ...CREDENTIAL_PATHS],
        },
        network: { allowedDomains: ["northwind.example.com", "*.blob.example.net:443"], strictAllowlist: true, allowLocalBinding: false, allowAllUnixSockets: false },
      }),
    });
  });

  it("closes the engine's own folder, which holds its socket and token, to reads and writes", () => {
    const { sandbox } = sandboxSettings(worktreeSpec, { callDirs: [callDir], callFiles, tokamaHome: "~/.tokama", closedDirs: ["/run/user/1000/tokama"], cacheDirs: [] }) as {
      sandbox: { filesystem: { denyRead: string[]; denyWrite: string[] } };
    };
    expect(sandbox.filesystem.denyRead).toContain("/run/user/1000/tokama");
    expect(sandbox.filesystem.denyWrite).toContain("/run/user/1000/tokama");
  });

  it("keeps the network closed, and still strict, with no hosts", () => {
    const { sandbox } = sandboxSettings({ ...worktreeSpec, network: net() }, { callDirs: [callDir], callFiles, tokamaHome: "~/.tokama", cacheDirs: [] }) as { sandbox: { network: unknown } };
    expect(sandbox.network).toEqual({ allowedDomains: [], strictAllowlist: true, allowLocalBinding: false, allowAllUnixSockets: false });
  });

  it("closes every folder of the call to writes and every file in it to reads, the real path of a linked temp folder too", () => {
    const real = "/private/var/folders/xx/T/tokama-claude-call-AbC123";
    const realFiles = [`${real}/rules.json`, `${real}/settings.json`];
    const { sandbox } = sandboxSettings(worktreeSpec, { callDirs: [callDir, real], callFiles: [...callFiles, ...realFiles], tokamaHome: "~/.tokama", cacheDirs: [] }) as {
      sandbox: { filesystem: { denyRead: string[]; denyWrite: string[] } };
    };
    expect(sandbox.filesystem.denyWrite).toEqual(expect.arrayContaining([callDir, real]));
    expect(sandbox.filesystem.denyRead).toEqual(expect.arrayContaining([...callFiles, ...realFiles]));
  });

  // Linux hides a folder in denyRead behind an empty, writable scratch folder, so a write into the
  // call's folder would seem to work. The folder must be denied for writes, and only its files for reads.
  it("never lists the call's folder in denyRead, on either system", () => {
    for (const platform of ["darwin", "linux"] as const) {
      const { sandbox } = sandboxSettings(worktreeSpec, { callDirs: [callDir], callFiles, tokamaHome: "~/.tokama", cacheDirs: toolCacheDirs(platform) }) as {
        sandbox: { filesystem: { denyRead: string[]; denyWrite: string[] } };
      };
      expect(sandbox.filesystem.denyRead, platform).not.toContain(callDir);
      expect(sandbox.filesystem.denyWrite, platform).toContain(callDir);
      expect(sandbox.filesystem.denyRead, platform).toEqual(expect.arrayContaining(callFiles));
    }
  });

  it("sets every weakening key to false in words, and never turns a safeguard off", () => {
    const { sandbox } = sandboxSettings(worktreeSpec, { callDirs: [callDir], callFiles, tokamaHome: "~/.tokama", cacheDirs: [] }) as { sandbox: Record<string, unknown> & { network: Record<string, unknown> } };
    for (const key of ["enableWeakerNestedSandbox", "enableWeakerNetworkIsolation", "allowNestedUserNamespaces", "allowAppleEvents", "allowUnsandboxedCommands", "autoAllowBashIfSandboxed"]) {
      expect(sandbox[key], key).toBe(false);
    }
    expect(sandbox.network["allowLocalBinding"]).toBe(false);
    expect(sandbox.network["allowAllUnixSockets"]).toBe(false);
    expect([sandbox["enabled"], sandbox["failIfUnavailable"], sandbox.network["strictAllowlist"]]).toEqual([true, true, true]);
    expect(sandbox["excludedCommands"]).toEqual([]);
  });
});

describe("sandboxStartProblem", () => {
  const apparmor = "Ubuntu's AppArmor restriction on user namespaces stops bubblewrap here";

  it("quotes what the CLI said, scrubbed by the caller", () => {
    expect(sandboxStartProblem(`Error: sandbox.failIfUnavailable is set but the sandbox cannot start: ${apparmor}\n`, "darwin")).toBe(
      `Claude Code could not start its sandbox: Error: sandbox.failIfUnavailable is set but the sandbox cannot start: ${apparmor}.`,
    );
  });

  it("adds the AppArmor fix on Linux only", () => {
    expect(sandboxStartProblem(apparmor, "linux")).toBe(
      `Claude Code could not start its sandbox: ${apparmor}. Ubuntu's AppArmor can stop bubblewrap from creating a user namespace. How to allow it: https://tokama.dev/docs/linux-sandbox`,
    );
    expect(sandboxStartProblem(apparmor, "darwin")).not.toContain("tokama.dev");
  });

  it("cuts a long message", () => {
    expect(sandboxStartProblem("x".repeat(1_000), "darwin").length).toBeLessThan(400);
  });
});

describe("the refusal texts recorded from the real CLI", () => {
  const refusal = (name: string) => readFileSync(join(import.meta.dirname, "testing", "fixtures", "refusals", `${name}.txt`), "utf8");

  it("name the blocked host, and the OS error of a blocked write or read, with no path of the recording machine", () => {
    expect(refusal("blocked-host")).toMatch(/deny network-outbound example\.com:443 \(host is not on the allow list\)/);
    expect(refusal("write-outside")).toMatch(/EPERM: operation not permitted, open/);
    expect(refusal("secret-read")).toMatch(/EPERM: operation not permitted, scandir '~\/\.ssh'/);
    for (const name of ["blocked-host", "write-outside", "secret-read"]) expect(refusal(name)).not.toMatch(/\/Users\/|\/home\/|\/var\/folders/);
  });

  it("are not taken for a sandbox that stopped working", () => {
    for (const name of ["blocked-host", "write-outside", "secret-read"]) expect(SANDBOX_REQUIRED.test(refusal(name))).toBe(false);
  });
});

describe("what says the sandbox is the problem", () => {
  it("matches the two documented tool-result texts at their start", () => {
    for (const text of [
      "Sandbox is required but failed to initialize: bwrap not found",
      "Sandbox is required (sandbox.failIfUnavailable) and stopped being available in this session: socat went away",
    ]) {
      expect(SANDBOX_REQUIRED.test(text)).toBe(true);
    }
    expect(SANDBOX_REQUIRED.test("The sandbox is required here")).toBe(false);
    expect(SANDBOX_REQUIRED.test("echo Sandbox is required")).toBe(false);
  });

  it("matches the apply-seccomp error at its start, and not output that only contains it", () => {
    expect(SANDBOX_REQUIRED.test("apply-seccomp: write /proc/self/setgroups (nested userns is capability-restricted; caller must provide CAP_SYS_ADMIN)")).toBe(true);
    // The helper's non-fatal warning: the command still runs.
    expect(SANDBOX_REQUIRED.test("apply-seccomp: could not set user.max_user_namespaces (Permission denied); the seccomp filter alone keeps the command from making namespaces")).toBe(false);
    expect(SANDBOX_REQUIRED.test("make: apply-seccomp: not found")).toBe(false);
    expect(SANDBOX_REQUIRED.test("the apply-seccomp: helper")).toBe(false);
  });

  it("finds the word in stderr whatever its case", () => {
    expect(mentionsSandbox("Error: Sandbox failed")).toBe(true);
    expect(mentionsSandbox("Error: something broke")).toBe(false);
  });
});
