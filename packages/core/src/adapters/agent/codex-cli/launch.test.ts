import { describe, expect, it } from "vitest";
import { AiCliSchema } from "../../../kernel/schemas/index.js";
import { codexCliAdapter } from "./adapter.js";
import { codexCliLaunch } from "./launch.js";

describe("codexCliLaunch", () => {
  it("shows the arguments a read-only call starts with, placeholders for what a step supplies, and no values", () => {
    const launch = codexCliLaunch();
    expect(launch.command).toBe("codex");
    expect(launch.promptVia).toBe("stdin");
    expect(launch.headlessArgs.slice(0, 2)).toEqual(["--no-daemon", "exec"]);
    expect(launch.headlessArgs).toContain("--cd={cwd}");
    expect(launch.modelArgs).toEqual(["--model={model}"]);
    expect(launch.roleArgs).toEqual(["-c", 'developer_instructions="{role}"']);
    expect(launch.permissionArgs).toContain('permissions.tokama.extends=":read-only"');
    expect(launch.envNames).toContain("PATH");
    expect(launch.envNames).not.toContain("CODEX_HOME");
  });

  it("fits the AI CLIs page's limits for every word", () => {
    const launch = codexCliLaunch();
    const parsed = AiCliSchema.safeParse({
      supported: true,
      cliId: "codex-cli",
      name: codexCliAdapter.name,
      description: codexCliAdapter.description,
      state: "ready",
      loginCommand: codexCliAdapter.loginCommand,
      command: launch.command,
      headlessArgs: launch.headlessArgs,
      modelArgs: launch.modelArgs,
      permissionArgs: launch.permissionArgs,
      promptVia: launch.promptVia,
      roleArgs: launch.roleArgs,
      envNames: launch.envNames,
      usedBy: [],
    });
    expect(parsed.error?.message).toBeUndefined();
  });
});
