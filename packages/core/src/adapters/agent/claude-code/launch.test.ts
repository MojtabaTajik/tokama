import { describe, expect, it } from "vitest";
import { ENV_ALLOWLIST } from "../../../kernel/process/index.js";
import { READ_ONLY } from "../../../kernel/ports/index.js";
import { buildArgs } from "./args.js";
import { claudeCodeLaunch } from "./launch.js";

describe("claudeCodeLaunch", () => {
  it("describes the same argv that buildArgs gives a read-only call, with placeholders for the step's values", () => {
    const launch = claudeCodeLaunch();
    const real = buildArgs({ model: "{model}", prompt: "", cwd: "", role: "{role}", limits: READ_ONLY });
    expect(real.ok).toBe(true);
    expect([...launch.headlessArgs, ...launch.modelArgs, ...launch.permissionArgs, ...launch.roleArgs]).toEqual(real.ok ? real.value : []);
    expect(launch.modelArgs).toEqual(["--model={model}"]);
    expect(launch.roleArgs).toEqual(["--append-system-prompt={role}"]);
  });

  it("puts the prompt on stdin and never carries a skip-permissions flag", () => {
    const launch = claudeCodeLaunch();
    expect(launch.promptVia).toBe("stdin");
    expect(launch.permissionArgs).toContain("--permission-mode=dontAsk");
    expect(JSON.stringify(launch)).not.toMatch(/dangerously|skip-permissions|bypassPermissions/i);
  });

  it("lists the allowlisted environment names and nothing else", () => {
    expect(claudeCodeLaunch().envNames).toEqual([...ENV_ALLOWLIST]);
  });

  it("names the login command", () => {
    expect(claudeCodeLaunch().loginCommand).toBe("claude auth login");
  });
});
