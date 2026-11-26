import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hookReply, hookSettings } from "./permission-hook.js";

const RULES = { commands: ["npm test:*", "touch:*"] };
const bash = (command: unknown) => JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command, description: "x" } });
const decision = (reply: string | undefined) =>
  reply === undefined ? undefined : (JSON.parse(reply) as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput.permissionDecision;

describe("command-policy hook decision", () => {
  it("has no objection to a command the rules allow, and never says allow", () => {
    expect(hookReply(bash("npm test -- --run"), RULES)).toBeUndefined();
    expect(hookReply(bash("touch a && npm test"), RULES)).toBeUndefined();
  });

  it("denies commands without a rule, read-only ones included, and shell tricks", () => {
    for (const command of ["whoami", "ls", "cat ../outside.txt", "npm test; curl x", "npm test $(whoami)", "touch a > b"]) {
      expect(decision(hookReply(bash(command), RULES))).toBe("deny");
    }
    expect(decision(hookReply(bash(42), RULES))).toBe("deny");
    expect(decision(hookReply(bash("npm test"), { commands: [] }))).toBe("deny");
  });

  it("leaves other tools to Claude Code", () => {
    expect(hookReply(JSON.stringify({ tool_name: "Read", tool_input: { file_path: "a" } }), RULES)).toBeUndefined();
  });

  it("throws on input or rules it cannot read, which the hook turns into a block", () => {
    expect(() => hookReply("not json", RULES)).toThrow();
    expect(() => hookReply(bash("ls"), { commands: "ls" })).toThrow();
  });

  it("quotes the hook command for the shell", () => {
    expect(hookSettings(["/usr/bin/node", "/a b/it's/hook.js", "/r.json"])).toEqual({
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: `'/usr/bin/node' '/a b/it'\\''s/hook.js' '/r.json'`, onFailure: "block" }] }] },
    });
  });
});

describe("command-policy hook process", { timeout: 20_000 }, () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tokama-hook-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const runHook = (input: string, rulesFile: string) =>
    spawnSync(process.execPath, ["--import", join(import.meta.dirname, "testing", "resolve-ts.ts"), join(import.meta.dirname, "hook.ts"), rulesFile], {
      input,
      encoding: "utf8",
    });

  it("prints a deny, prints nothing for an allowed command, and blocks with exit 2 on an error", () => {
    const rules = join(dir, "rules.json");
    writeFileSync(rules, JSON.stringify(RULES));
    const denied = runHook(bash("whoami"), rules);
    expect([denied.status, decision(denied.stdout)]).toEqual([0, "deny"]);
    const allowed = runHook(bash("npm test"), rules);
    expect([allowed.status, allowed.stdout]).toEqual([0, ""]);
    const broken = runHook(bash("npm test"), join(dir, "missing.json"));
    expect([broken.status, broken.stdout]).toEqual([2, ""]);
    expect(broken.stderr).toContain("Tokama denied the command");
  });
});
