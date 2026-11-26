import { describe, expect, it } from "vitest";
import type { AgentCallRequest, ToolLimits } from "../../../kernel/ports/index.js";
import { argGroups, buildArgs, userMessage, usesShell } from "./args.js";

const request = (limits?: ToolLimits, extra: Partial<AgentCallRequest> = {}): AgentCallRequest => ({
  model: "claude-haiku-5-5",
  prompt: "hi",
  cwd: "/tmp/repo",
  ...(limits !== undefined && { limits }),
  ...extra,
});

function args(req: AgentCallRequest): string[] {
  const result = buildArgs(req);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

/** The words after `flag` up to the next flag. */
function list(argv: string[], flag: string): string[] {
  const start = argv.indexOf(flag);
  if (start === -1) return [];
  const end = argv.findIndex((word, i) => i > start && word.startsWith("--"));
  return argv.slice(start + 1, end === -1 ? undefined : end);
}

const value = (argv: string[], flag: string) => argv.find((word) => word.startsWith(`${flag}=`))?.slice(flag.length + 1);

describe("Claude Code args", () => {
  it("runs headless with stream-json in and out, the model, and no settings files", () => {
    const argv = args(request());
    expect(argv.slice(0, 4)).toEqual(["-p", "--input-format=stream-json", "--output-format=stream-json", "--verbose"]);
    expect(value(argv, "--model")).toBe("claude-haiku-5-5");
    expect(value(argv, "--permission-mode")).toBe("dontAsk");
    expect(argv).toContain("--restricted");
    expect(argv).toContain("--strict-mcp-config");
  });

  it("denies the file tools an absolute Tokama folder with the double slash, which a single slash would turn project-relative", () => {
    const result = buildArgs(request(), undefined, "/home/northwind-dev/.tokama");
    if (!result.ok) throw new Error(result.error);
    expect(list(result.value, "--disallowedTools")).toEqual(["Read(//home/northwind-dev/.tokama/**)", "Edit(//home/northwind-dev/.tokama/**)", "WebFetch", "WebSearch"]);
  });

  it("is read only by default: read tools, no allow rules, web and Tokama's data denied", () => {
    const argv = args(request());
    expect(value(argv, "--tools")).toBe("Read,Glob,Grep");
    expect(argv).not.toContain("--allowedTools");
    expect(list(argv, "--disallowedTools")).toEqual(["Read(~/.tokama/**)", "Edit(~/.tokama/**)", "WebFetch", "WebSearch"]);
  });

  it("allows edits inside the working directory only", () => {
    const argv = args(request({ edit: true, commands: [], web: false }));
    expect(value(argv, "--tools")).toBe("Read,Glob,Grep,Edit,Write");
    expect(list(argv, "--allowedTools")).toEqual(["Edit(./**)"]);
  });

  it("maps command-policy rules to Bash rules and adds Bash only when a rule exists", () => {
    const argv = args(request({ edit: false, commands: ["npm test:*", "  git   diff ", "", ":*"], web: false }));
    expect(value(argv, "--tools")).toBe("Read,Glob,Grep,Bash");
    expect(list(argv, "--allowedTools")).toEqual(["Bash(npm test:*)", "Bash(git diff:*)"]);
    expect(value(args(request({ edit: false, commands: ["", ":*"], web: false })), "--tools")).toBe("Read,Glob,Grep");
  });

  it("allows web tools only when the step does", () => {
    const argv = args(request({ edit: false, commands: [], web: true }));
    expect(value(argv, "--tools")).toBe("Read,Glob,Grep,WebFetch,WebSearch");
    expect(list(argv, "--allowedTools")).toEqual(["WebFetch", "WebSearch"]);
    expect(list(argv, "--disallowedTools")).toEqual(["Read(~/.tokama/**)", "Edit(~/.tokama/**)"]);
  });

  it("appends the role to the system prompt as one value, even when it starts with a dash", () => {
    const argv = args(request(undefined, { role: "--dangerously-skip-permissions\nYou review code." }));
    expect(argv.at(-1)).toBe("--append-system-prompt=--dangerously-skip-permissions\nYou review code.");
    expect(args(request()).some((word) => word.startsWith("--append-system-prompt"))).toBe(false);
  });

  it("passes the hook settings file when given, and says when the shell is on", () => {
    const shell = request({ edit: false, commands: ["npm test:*"], web: false });
    const result = buildArgs(shell, "/tmp/call/settings.json");
    expect(result.ok && value(result.value, "--settings")).toBe("/tmp/call/settings.json");
    expect(args(shell).some((word) => word.startsWith("--settings"))).toBe(false);
    expect(usesShell(shell)).toBe(true);
    expect(usesShell(request())).toBe(false);
    expect(usesShell(request({ edit: true, commands: ["", ":*"], web: true }))).toBe(false);
  });

  it("never passes a flag that skips permission checks", () => {
    const all = { edit: true, commands: ["npm test:*"], web: true };
    for (const argv of [args(request()), args(request(all, { role: "x" }))]) {
      for (const word of argv) {
        expect(word).not.toMatch(/^--(dangerously-skip-permissions|allow-dangerously-skip-permissions)/);
        expect(word).not.toMatch(/bypassPermissions/);
      }
    }
  });

  it("refuses rules and models that could be read as flags or break a permission rule", () => {
    const refused = (req: AgentCallRequest) => expect(buildArgs(req).ok).toBe(false);
    refused(request({ edit: false, commands: ["--dangerously-skip-permissions"], web: false }));
    refused(request({ edit: false, commands: ["npm test) Edit(*"], web: false }));
    refused(request({ edit: false, commands: ["git log --format=%h,%s"], web: false }));
    refused(request(undefined, { model: "--dangerously-skip-permissions" }));
    refused(request(undefined, { model: "" }));
  });

  it("sends the prompt as one stream-json user message line", () => {
    const line = userMessage("fix the bug\nplease");
    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1)).not.toContain("\n");
    expect(JSON.parse(line)).toEqual({ type: "user", message: { role: "user", content: [{ type: "text", text: "fix the bug\nplease" }] } });
  });
});

describe("argGroups", () => {
  it("flattens in group order into the argv buildArgs returns, for every kind of limits", () => {
    for (const limits of [{ edit: false, commands: [], web: false }, { edit: true, commands: ["git diff"], web: true }]) {
      const req = request(limits, { role: "Be brief." });
      const groups = argGroups(req, "/tmp/s.json");
      const whole = buildArgs(req, "/tmp/s.json");
      if (!groups.ok || !whole.ok) throw new Error("expected both to build");
      const { headless, model, permission, instructions } = groups.value;
      expect([...headless, ...model, ...permission, ...instructions]).toEqual(whole.value);
      expect(instructions).toEqual(["--append-system-prompt=Be brief."]);
      expect(permission).toContain("--settings=/tmp/s.json");
    }
  });

  it("leaves the instructions empty without a role", () => {
    const groups = argGroups(request());
    expect(groups.ok && groups.value.instructions).toEqual([]);
  });
});
