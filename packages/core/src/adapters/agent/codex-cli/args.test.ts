import { describe, expect, it } from "vitest";
import type { AgentCallRequest, ToolLimits } from "../../../kernel/ports/index.js";
import { CREDENTIAL_PATHS } from "../../../kernel/sandbox/index.js";
import { buildArgs, COMMAND_LIST_PROBLEM, forbiddenIn, profileOverrides } from "./args.js";

const request = (extra: Partial<AgentCallRequest> = {}): AgentCallRequest => ({ model: "gpt-6.2-sol", prompt: "p", cwd: "/work/repo", ...extra });
const argv = (extra: Partial<AgentCallRequest> = {}, options = {}): string[] => {
  const built = buildArgs(request(extra), options);
  if (!built.ok) throw new Error(built.error);
  return built.value;
};
/** The value of the `-c` override named `key`. */
const setting = (args: readonly string[], key: string): string | undefined => {
  const at = args.findIndex((word, i) => args[i - 1] === "-c" && word.startsWith(`${key}=`));
  return at < 0 ? undefined : args[at]?.slice(key.length + 1);
};

describe("buildArgs", () => {
  it("builds the fixed headless call: no daemon, no user or repo config, strict, JSON events, the prompt on stdin", () => {
    const args = argv();
    expect(args.slice(0, 3)).toEqual(["--no-daemon", "exec", "--disable"]);
    expect(args.at(-1)).toBe("-");
    for (const flag of ["--ignore-user-config", "--ignore-rules", "--ephemeral", "--skip-git-repo-check", "--strict-config", "--json", "--cd=/work/repo", "--model=gpt-6.2-sol"]) {
      expect(args).toContain(flag);
    }
    const disabled = args.flatMap((word, i) => (args[i - 1] === "--disable" ? [word] : []));
    expect(disabled).toEqual(["daemon_auto_start", "hooks", "multi_agent", "network_proxy"]);
    expect(setting(args, "approval_policy")).toBe('"never"');
    expect(setting(args, "approvals_reviewer")).toBe('"user"');
    expect(setting(args, "project_doc_max_bytes")).toBe("0");
    expect(setting(args, "allow_login_shell")).toBe("false");
    expect(setting(args, "default_permissions")).toBe('"tokama"');
  });

  it("gives a read-only step the read-only profile, no network, no web, and the secret paths closed", () => {
    const args = argv();
    expect(setting(args, "permissions.tokama.extends")).toBe('":read-only"');
    expect(setting(args, "permissions.tokama.network.enabled")).toBe("false");
    expect(setting(args, "web_search")).toBe('"disabled"');
    const filesystem = setting(args, "permissions.tokama.filesystem") ?? "";
    expect(filesystem).toContain('"~/.ssh"="none"');
    expect(filesystem).toContain('"~/.tokama"="none"');
    expect(filesystem).toContain('":workspace_roots"={"**/*.env"="none"}');
    expect(filesystem).not.toContain("slash_tmp");
    for (const path of CREDENTIAL_PATHS) expect(filesystem).toContain(`"${path}"="none"`);
  });

  it("gives an editing step the workspace profile with /tmp read-only, still without network", () => {
    const args = argv({ limits: { edit: true, commands: [], web: false } });
    expect(setting(args, "permissions.tokama.extends")).toBe('":workspace"');
    expect(setting(args, "permissions.tokama.filesystem")).toContain('":slash_tmp"="read"');
    expect(setting(args, "permissions.tokama.filesystem")).not.toContain(":tmpdir");
    expect(setting(args, "permissions.tokama.network.enabled")).toBe("false");
  });

  it("turns web search on only for a step with web", () => {
    expect(setting(argv({ limits: { edit: false, commands: [], web: true } }), "web_search")).toBe('"live"');
    expect(setting(argv(), "web_search")).toBe('"disabled"');
  });

  it("closes Tokama's folder and the given folders once each, even when a path is listed twice", () => {
    const args = argv({}, { tokamaHome: "/home/u/.tokama", closedDirs: ["/run/engine", "/home/u/.tokama", "~/.ssh"] });
    const filesystem = setting(args, "permissions.tokama.filesystem") ?? "";
    expect(filesystem).toContain('"/home/u/.tokama"="none"');
    expect(filesystem).toContain('"/run/engine"="none"');
    expect(filesystem.match(/"\/home\/u\/\.tokama"=/g)).toHaveLength(1);
    expect(filesystem.match(/"~\/\.ssh"=/g)).toHaveLength(1);
  });

  it("refuses a closed folder that is not absolute", () => {
    expect(buildArgs(request(), { closedDirs: ["relative/dir"] })).toEqual({ ok: false, error: expect.stringContaining("not an absolute path") });
    expect(buildArgs(request(), { tokamaHome: "tokama" }).ok).toBe(false);
  });

  it("passes the role as developer instructions, escaped, as one argument", () => {
    const role = 'Review "carefully".\nNever -s or --trust';
    const args = argv({ role });
    expect(setting(args, "developer_instructions")).toBe('"Review \\"carefully\\".\\nNever -s or --trust"');
    expect(args.filter((word) => word.startsWith("developer_instructions="))).toHaveLength(1);
    expect(setting(argv(), "developer_instructions")).toBeUndefined();
    expect(setting(argv({ role: "" }), "developer_instructions")).toBeUndefined();
  });

  it("refuses a role it cannot write", () => {
    expect(buildArgs(request({ role: "x\ud800" })).ok).toBe(false);
  });

  it("refuses a model name that could be read as a flag", () => {
    expect(buildArgs(request({ model: "--dangerously-bypass-approvals-and-sandbox" })).ok).toBe(false);
    expect(buildArgs(request({ model: "" })).ok).toBe(false);
    expect(argv({ model: "gpt-6.2-sol" })).toContain("--model=gpt-6.2-sol");
  });

  it("refuses an agent with a list of commands, with the reason a person reads", () => {
    for (const edit of [false, true]) {
      expect(buildArgs(request({ limits: { edit, commands: ["npm test:*"], web: false } }))).toEqual({ ok: false, error: COMMAND_LIST_PROBLEM });
    }
    expect(COMMAND_LIST_PROBLEM).toMatch(/^Codex CLI can't limit commands to a list/);
  });
});

describe("what no call ever passes", () => {
  const FORBIDDEN_FLAGS = ["--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust", "--approve-for-me", "--trust", "--add-dir", "--yolo", "--full-auto", "-s", "--sandbox", "-a", "--ask-for-approval", "-p", "--profile"];

  const limitsList: ToolLimits[] = [];
  for (const edit of [false, true]) for (const web of [false, true]) limitsList.push({ edit, commands: [], web });
  const roles = [undefined, "", "plain role", "mentions --dangerously-bypass-approvals-and-sandbox, -s danger-full-access and sandbox_mode"];

  it("never has a forbidden flag, a second sandbox, a trusted folder or danger-full-access in any call", () => {
    let calls = 0;
    for (const limits of limitsList) {
      for (const role of roles) {
        for (const plain of [undefined, true, false]) {
          const args = argv({ limits, ...(role !== undefined && { role }), ...(plain !== undefined && { plain }) }, { closedDirs: ["/run/engine"] });
          calls++;
          for (const [i, word] of args.entries()) {
            // The role is a value of `-c developer_instructions=...`; it is text, never a flag.
            if (word.startsWith("developer_instructions=")) continue;
            expect(FORBIDDEN_FLAGS).not.toContain(word.split("=")[0]);
            expect(word).not.toMatch(/^--dangerously/);
            expect(word).not.toContain("danger-full-access");
            if (args[i - 1] === "-c") expect(word).not.toMatch(/^(?:sandbox_mode|sandbox_workspace_write|projects|trust_level)\b/);
          }
          // Every override is a `-c` followed by exactly its value.
          expect(args.filter((word) => word === "-c").length).toBe(args.filter((word, i) => args[i - 1] === "-c" && /^[a-z_.]+=/.test(word)).length);
        }
      }
    }
    expect(calls).toBe(4 * 4 * 3);
  });

  it("has a guard behind the argument groups that names any forbidden flag or setting in an argv", () => {
    for (const flag of FORBIDDEN_FLAGS) expect(forbiddenIn(["--no-daemon", "exec", flag, "-"])).toBe(flag);
    expect(forbiddenIn(["exec", "--model=x", "--trust=true"])).toBe("--trust");
    expect(forbiddenIn(["exec", "--dangerously-anything"])).toBe("--dangerously-anything");
    expect(forbiddenIn(["exec", "-c", 'sandbox_mode="danger-full-access"'])).toBe("sandbox_mode");
    expect(forbiddenIn(["exec", "-c", 'projects."/work".trust_level="trusted"'])).toBe("projects.\"/work\".trust_level");
    expect(forbiddenIn(["exec", "-c", "sandbox_workspace_write.network_access=true"])).toBe("sandbox_workspace_write.network_access");
    expect(forbiddenIn(["exec", "-c", 'developer_instructions="say --trust"', "-"])).toBeUndefined();
  });
});

describe("profileOverrides", () => {
  it("is the permission part of the call, to run a command under the same rules", () => {
    const edit = profileOverrides({ edit: true });
    const read = profileOverrides({ edit: false });
    if (!edit.ok || !read.ok) throw new Error("not built");
    expect(setting(read.value, "permissions.tokama.extends")).toBe('":read-only"');
    expect(setting(edit.value, "permissions.tokama.extends")).toBe('":workspace"');
    expect(setting(edit.value, "default_permissions")).toBe('"tokama"');
    const full = argv({ limits: { edit: true, commands: [], web: false } });
    for (const word of edit.value) expect(full).toContain(word);
  });
});
