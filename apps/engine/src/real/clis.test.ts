import { type Agent, type AgentId, type AgentRuntime, type AiCliAdapter, aiCliAdapters, type CliHealth, type ProcessRunner } from "@tokama/core";
import { describe, expect, it } from "vitest";
import { fakeAiCli } from "../testing/fake-ai-cli.js";
import { cliName, cliState, defaultCli } from "./clis.js";
import { defaultRuntime } from "./real.js";

const claude: CliHealth = { cliId: "claude-code", installed: true, loggedIn: true, version: "2.1.331" };
const codex: CliHealth = { cliId: "codex-cli", installed: true, loggedIn: true, version: "0.169.0" };
const both: readonly AiCliAdapter[] = [...aiCliAdapters, fakeAiCli()];

describe("cliState", () => {
  it("maps a health check to how far the CLI can run agents", () => {
    expect([undefined, { ...claude, timedOut: true as const }, { ...claude, installed: false }, { ...claude, loggedIn: false }, claude].map(cliState)).toEqual([
      "not_checked",
      "no_answer",
      "not_installed",
      "not_logged_in",
      "ready",
    ]);
  });
});

describe("defaultCli", () => {
  it("is undefined when no CLI is ready", () => {
    expect(defaultCli([], both)).toBeUndefined();
    expect(defaultCli([{ ...claude, loggedIn: false }, { ...codex, installed: false }], both)).toBeUndefined();
  });

  it("is the first CLI of the list that is ready, so the second when only it is", () => {
    expect(defaultCli([claude, codex], both)).toBe("claude-code");
    expect(defaultCli([{ ...claude, loggedIn: false }, codex], both)).toBe("codex-cli");
  });

  it("skips a CLI whose check timed out and a CLI with no adapter", () => {
    expect(defaultCli([{ ...claude, timedOut: true }, codex], both)).toBe("codex-cli");
    expect(defaultCli([claude, codex], [fakeAiCli()])).toBe("codex-cli");
    expect(defaultCli([claude], [fakeAiCli()])).toBeUndefined();
  });
});

describe("cliName", () => {
  it("is the adapter's name, else the name Tokama knows, else the id", () => {
    expect(cliName("codex-cli", [fakeAiCli({ name: "Codex" })])).toBe("Codex");
    expect(cliName("claude-code", [])).toBe("Claude Code");
    expect(cliName("codex-cli", [])).toBe("Codex CLI");
    expect(cliName("ollama", [])).toBe("ollama");
  });
});

describe("defaultRuntime", () => {
  const runner: ProcessRunner = { run: async () => ({ kind: "not-started", reason: "spawn-error", message: "none", code: "ENOENT" }) };
  const agent = (cliId: Agent["cliId"]): Agent => ({ id: "reviewer" as AgentId, name: "Reviewer", cliId, model: "m", limits: { edit: false, commands: [], web: false }, role: "", owner: { kind: "personal" } });

  it("gives an agent the runtime of the adapter for its CLI, made once", () => {
    const runtime: AgentRuntime = { launch: () => (async function* () {})() };
    let made = 0;
    const adapter: AiCliAdapter = { ...fakeAiCli(), createRuntime: () => (made++, runtime) };
    const pick = defaultRuntime(runner, "/tokama-home", undefined, [adapter]);
    expect(pick(agent("codex-cli"))).toBe(runtime);
    expect(pick(agent("codex-cli"))).toBe(runtime);
    expect(made).toBe(1);
  });

  it("gives no runtime to an agent whose CLI has no adapter", () => {
    const pick = defaultRuntime(runner, "/tokama-home", undefined, [fakeAiCli()]);
    expect(pick(agent("claude-code"))).toBeUndefined();
    expect(pick(agent("ollama"))).toBeUndefined();
    expect(defaultRuntime(runner, "/tokama-home", undefined, [])(agent("codex-cli"))).toBeUndefined();
  });

  it("gives the Claude Code agent a runtime from the built-in list", () => {
    expect(defaultRuntime(runner, "/tokama-home")(agent("claude-code"))).toBeDefined();
  });
});
