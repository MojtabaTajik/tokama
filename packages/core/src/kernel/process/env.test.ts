import { describe, expect, it } from "vitest";
import { ENV_ALLOWLIST, buildEnv } from "./env.js";

// Ported from ai-pipeline tests/test_claude_call.py: test_env_is_allowlisted.
const LEAKS = {
  ANTHROPIC_BASE_URL: "http://x",
  CLAUDE_CODE_SESSION_ID: "s",
  CLAUDECODE: "1",
  CLAUDE_CODE_MESSAGING_SOCKET: "/s",
  CLAUDE_EFFORT: "high",
  SSH_AUTH_SOCK: "/a",
  OPENAI_API_KEY: "k",
  ANTHROPIC_API_KEY: "k",
};

describe("buildEnv", () => {
  it("keeps only allowlisted parent variables", () => {
    const env = buildEnv({ ...LEAKS, PATH: "/bin", HOME: "/home/a", TERM: "xterm", UNSET: undefined });
    expect(env).toEqual({ PATH: "/bin", HOME: "/home/a", TERM: "xterm" });
  });

  it("allowlists exactly the documented names", () => {
    expect(ENV_ALLOWLIST).toEqual(["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TMPDIR", "TERM"]);
  });

  it("adds explicit extra variables, which may override allowlisted ones", () => {
    const env = buildEnv(
      { ...LEAKS, PATH: "/bin" },
      { ANTHROPIC_BASE_URL: "http://local", ANTHROPIC_API_KEY: "", PATH: "/opt/bin" },
    );
    expect(env).toEqual({ PATH: "/opt/bin", ANTHROPIC_BASE_URL: "http://local", ANTHROPIC_API_KEY: "" });
  });

  it("keeps only absolute PATH entries, from the parent and from extras", () => {
    expect(buildEnv({ PATH: "/usr/bin:~/.dotnet/tools::.:bin:/opt/bin:" })).toEqual({ PATH: "/usr/bin:/opt/bin" });
    expect(buildEnv({ PATH: "/usr/bin" }, { PATH: ".:/opt/bin:node_modules/.bin" })).toEqual({ PATH: "/opt/bin" });
  });

  it("drops package-manager tool folders from PATH", () => {
    const path = [
      "/repo/node_modules/.bin",
      "/repo/apps/desktop/node_modules/.bin/",
      "/usr/local/lib/node_modules/pnpm/dist/node-gyp-bin",
      "/usr/bin",
      "/opt/node_modules/.binary",
      "/opt/node-gyp-bin-extra",
    ].join(":");
    expect(buildEnv({ PATH: path })).toEqual({ PATH: "/usr/bin:/opt/node_modules/.binary:/opt/node-gyp-bin-extra" });
    expect(buildEnv({}, { PATH: "/x/node_modules/.bin:/opt/bin" })).toEqual({ PATH: "/opt/bin" });
  });

  it("leaves PATH out rather than empty when no entry is absolute", () => {
    expect(buildEnv({ PATH: ".:~/bin:" })).toEqual({});
    expect(buildEnv({ PATH: "/usr/bin" }, { PATH: "" })).toEqual({});
  });

  it("does not change its inputs", () => {
    const parent = { PATH: "/bin", SECRET: "s" };
    const extra = { X: "1" };
    buildEnv(parent, extra);
    expect(parent).toEqual({ PATH: "/bin", SECRET: "s" });
    expect(extra).toEqual({ X: "1" });
  });
});
