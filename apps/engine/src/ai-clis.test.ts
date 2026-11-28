import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aiCliAdapters, type CliHealth } from "@tokama/core";
import { afterEach, describe, expect, it } from "vitest";
import { aiClis } from "./ai-clis.js";
import { KNOWN } from "./real/clis.js";
import { fakeAiCli } from "./testing/fake-ai-cli.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function binFolder(): string {
  const dir = mkdtempSync(join(tmpdir(), "tk-bin-"));
  dirs.push(dir);
  writeFileSync(join(dir, "claude"), "#!/bin/sh\n");
  chmodSync(join(dir, "claude"), 0o755);
  return dir;
}

const READY: CliHealth = { cliId: "claude-code", installed: true, loggedIn: true, version: "2.1.331" };
const claudeOf = (clis: readonly CliHealth[], env: Record<string, string | undefined> = {}, agents: { name: string; cliId: "claude-code" | "codex-cli" | "ollama" }[] = []) => {
  const result = aiClis({ clis, agents, env });
  const [first] = result.clis;
  if (first === undefined || !first.supported) throw new Error("Claude Code is not supported");
  return first;
};

describe("aiClis", () => {
  it("lists Claude Code, then Codex CLI, both supported", () => {
    const result = aiClis({ clis: [READY], agents: [], env: {} });
    expect(result.clis.map((cli) => [cli.cliId, cli.supported])).toEqual([["claude-code", true], ["codex-cli", true]]);
  });

  it("shows the real launch arguments, how instructions are passed and the login command", () => {
    const claude = claudeOf([READY]);
    expect(claude.headlessArgs).toEqual(["-p", "--input-format=stream-json", "--output-format=stream-json", "--verbose"]);
    expect(claude.modelArgs).toEqual(["--model={model}"]);
    expect(claude.permissionArgs).toContain("--permission-mode=dontAsk");
    expect(claude.promptVia).toBe("stdin");
    expect(claude.roleArgs).toEqual(["--append-system-prompt={role}"]);
    expect(claude.loginCommand).toBe("claude auth login");
  });

  it("maps the health checks to a state", () => {
    expect(claudeOf([READY]).state).toBe("ready");
    expect(claudeOf([{ cliId: "claude-code", installed: true, loggedIn: false, version: "2.1.331", message: "Claude Code is not logged in." }])).toMatchObject({ state: "not_logged_in", version: "2.1.331", message: "Claude Code is not logged in." });
    expect(claudeOf([{ cliId: "claude-code", installed: false, loggedIn: false, message: "Claude Code is not installed." }]).state).toBe("not_installed");
    expect(claudeOf([{ cliId: "claude-code", installed: true, loggedIn: false, timedOut: true }]).state).toBe("no_answer");
    expect(claudeOf([]).state).toBe("not_checked");
    expect(claudeOf([{ ...READY, message: "Claude Code 2.1.294 is older than 2.1.295." }])).toMatchObject({ state: "ready", message: "Claude Code 2.1.294 is older than 2.1.295." });
  });

  it("finds the path on the PATH a call gets, and leaves it out when there is none", () => {
    const dir = binFolder();
    expect(claudeOf([READY], { PATH: dir }).path).toBe(join(dir, "claude"));
    expect(claudeOf([READY], { PATH: "/nonexistent" })).not.toHaveProperty("path");
  });

  it("lists agents that run on Claude Code, by name", () => {
    const claude = claudeOf([READY], {}, [{ name: "Builder", cliId: "claude-code" }, { name: "Reviewer", cliId: "codex-cli" }, { name: "Architect", cliId: "claude-code" }]);
    expect(claude.usedBy).toEqual(["Builder", "Architect"]);
  });

  it("carries environment names only: no value of the environment reaches the answer", () => {
    const env = { PATH: binFolder(), HOME: "/home/secret-home-sentinel", USER: "secret-user-sentinel", ANTHROPIC_API_KEY: "sk-secret-key-sentinel", SSH_AUTH_SOCK: "/secret-socket-sentinel", OPENAI_API_KEY: "sk-other-sentinel" };
    const claude = claudeOf([READY], env);
    expect(claude.envNames).toEqual(expect.arrayContaining(["PATH", "HOME", "USER"]));
    expect(claude.envNames).not.toContain("ANTHROPIC_API_KEY");
    const text = JSON.stringify(aiClis({ clis: [READY], agents: [], env }));
    for (const secret of ["secret-home-sentinel", "secret-user-sentinel", "sk-secret-key-sentinel", "secret-socket-sentinel", "sk-other-sentinel"]) expect(text).not.toContain(secret);
  });

  it("lists Claude Code as not supported when its adapter is removed", () => {
    const result = aiClis({ clis: [READY], agents: [], env: {} }, []);
    expect(result.clis.map((cli) => [cli.cliId, cli.supported])).toEqual([["claude-code", false], ["codex-cli", false]]);
  });

  it("lists one supported row for each adapter, and no not-supported row for a CLI that has one", () => {
    const codex: CliHealth = { cliId: "codex-cli", installed: true, loggedIn: false, version: "0.169.0" };
    const result = aiClis({ clis: [READY, codex], agents: [{ name: "Reviewer", cliId: "codex-cli" }], env: {} }, [...aiCliAdapters.filter((adapter) => adapter.id === "claude-code"), fakeAiCli({ name: "Codex CLI" })]);
    expect(result.clis.map((cli) => [cli.cliId, cli.supported])).toEqual([["claude-code", true], ["codex-cli", true]]);
    expect(result.clis[1]).toMatchObject({ name: "Codex CLI", state: "not_logged_in", version: "0.169.0", loginCommand: "fake-cli login", command: "fake-cli", promptVia: "argument", usedBy: ["Reviewer"] });
  });

  it("names the adapters the same as the CLIs it lists without one", () => {
    expect(aiCliAdapters.map((adapter) => adapter.id)).toEqual(["claude-code", "codex-cli"]);
    for (const adapter of aiCliAdapters) expect(adapter).toMatchObject(KNOWN[adapter.id as keyof typeof KNOWN]);
    expect(aiClis({ clis: [], agents: [], env: {} }, []).clis).toEqual([{ supported: false, cliId: "claude-code", ...KNOWN["claude-code"] }, { supported: false, cliId: "codex-cli", ...KNOWN["codex-cli"] }]);
  });

  it("caps the names under a CLI at the schema's limit", () => {
    const agents = Array.from({ length: 250 }, (_, i) => ({ name: `Agent ${i}`, cliId: "claude-code" as const }));
    expect(claudeOf([READY], {}, agents).usedBy).toHaveLength(200);
  });
});
