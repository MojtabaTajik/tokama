import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentRuntime } from "../../kernel/ports/index.js";
import type { AiCliId } from "../../kernel/schemas/index.js";
import { type Agent, loadAgents } from "../config/index.js";
import { type CliStatus, chooseHelperAgent, HELPER_LOCAL_ONLY, HELPER_NO_CLI, HELPER_TARGETS } from "./helper-agent.js";

const RUNTIME: AgentRuntime = { async *launch() {} };

let home: string;
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "tk-helper-agent-")));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const agentFile = (runsOn: string, model: string, extra = "") => `---\nformat: 1\nname: My helper\nruns_on: ${runsOn}\n${extra}model: ${model}\ntools: edit\n---\nBe brief.\n`;
const personal = (id: string, text: string) => {
  mkdirSync(join(home, "agents"), { recursive: true });
  writeFileSync(join(home, "agents", `${id}.md`), text);
};

interface Setup {
  /** The CLIs with a runtime: this build has an adapter for each. */
  adapters?: readonly AiCliId[];
  status?: Partial<Record<AiCliId, CliStatus>>;
  localOnly?: boolean;
  repo?: boolean;
}
async function choose(setup: Setup = {}, id = "helper") {
  const { adapters = ["claude-code"], status = {}, localOnly = false } = setup;
  const agents = await loadAgents({ tokamaHome: home });
  const asked: AiCliId[] = [];
  const choice = await chooseHelperAgent(
    { agentId: id as Agent["id"] },
    {
      agents,
      cliStatus: async (cliId) => {
        asked.push(cliId);
        return status[cliId] ?? { ready: true };
      },
      runtime: (agent) => (adapters.includes(agent.cliId) ? RUNTIME : undefined),
      cliName: (cliId) => ({ "claude-code": "Claude Code", "codex-cli": "Codex CLI", ollama: "Ollama" })[cliId],
      localOnly,
    },
  );
  return { choice, asked };
}

describe("the built-in Helper agent", () => {
  it("holds the same CLI and model as the first target", async () => {
    const agents = await loadAgents({ tokamaHome: home });
    const builtin = agents.agents.find((agent) => agent.id === "helper");
    expect(builtin).toMatchObject({ cliId: HELPER_TARGETS[0]!.cliId, model: HELPER_TARGETS[0]!.model, owner: { kind: "builtin" }, role: "", limits: { edit: false, commands: [], web: false } });
  });

  it("runs on the first ready target and shows its CLI and model", async () => {
    const { choice } = await choose();
    expect(choice).toMatchObject({ ok: true, summary: { agentId: "helper", name: "Helper", cliId: "claude-code", model: "haiku", runsOn: "cloud" } });
  });

  it("refuses with the set-up words when no target is ready, and names no agent", async () => {
    const { choice } = await choose({ status: { "claude-code": { ready: false, problem: "Claude Code is installed but not logged in." } } });
    expect(choice).toEqual({ ok: false, problem: HELPER_NO_CLI });
    expect(HELPER_NO_CLI).toBe("No AI CLI is ready. Set up an AI CLI: install Claude Code and log in, then try again.");
  });

  it("skips a target whose CLI this build has no adapter for", async () => {
    expect((await choose({ adapters: [] })).choice).toEqual({ ok: false, problem: HELPER_NO_CLI });
  });

  it("ignores a ready CLI that has no row in the targets", async () => {
    const { choice, asked } = await choose({ adapters: ["claude-code", "codex-cli"], status: { "claude-code": { ready: false }, "codex-cli": { ready: true } } });
    expect(choice).toEqual({ ok: false, problem: HELPER_NO_CLI });
    expect(asked).toEqual(["claude-code"]);
  });

  it("accepts a CLI older than the one Tokama needs for commands: a helper runs none", async () => {
    // The status says ready for any installed and logged-in CLI; the version is not part of it.
    expect((await choose({ status: { "claude-code": { ready: true } } })).choice.ok).toBe(true);
  });

  it("refuses in local-only mode with its own words, since every target is a cloud one", async () => {
    expect((await choose({ localOnly: true })).choice).toEqual({ ok: false, problem: HELPER_LOCAL_ONLY });
  });

  it("is not changed by a repo's agent file of the same id", async () => {
    // loadAgents without a repo, as the runner calls it: a repo's helper.md is never read.
    const repoAgents = join(home, "repo", ".tokama", "agents");
    mkdirSync(repoAgents, { recursive: true });
    writeFileSync(join(repoAgents, "helper.md"), agentFile("claude-code", "opus"));
    expect((await choose()).choice).toMatchObject({ ok: true, agent: { model: "haiku", owner: { kind: "builtin" } } });
  });
});

describe("a personal agent file", () => {
  it("is used exactly as written, with its own model and role", async () => {
    personal("helper", agentFile("claude-code", "sonnet"));
    const { choice } = await choose();
    expect(choice).toMatchObject({ ok: true, agent: { model: "sonnet", role: "Be brief.", owner: { kind: "personal" } }, summary: { name: "My helper", model: "sonnet" } });
  });

  it("never falls back to another CLI when its own is not ready: it refuses with the CLI's words", async () => {
    personal("helper", agentFile("claude-code", "sonnet"));
    const { choice } = await choose({ status: { "claude-code": { ready: false, problem: "Claude Code is installed but not logged in." } } });
    expect(choice).toMatchObject({ ok: false, problem: "Claude Code is installed but not logged in.", summary: { cliId: "claude-code", model: "sonnet" } });
  });

  it("refuses an ollama agent", async () => {
    personal("helper", agentFile("ollama", "qwen3-coder:30b", "driven_by: claude-code\n"));
    const { choice } = await choose();
    expect(choice).toMatchObject({ ok: false, problem: expect.stringContaining("does not run local models yet") });
  });

  it("refuses a cloud agent in local-only mode, and an agent whose CLI has no adapter", async () => {
    personal("helper", agentFile("claude-code", "sonnet"));
    expect((await choose({ localOnly: true })).choice).toMatchObject({ ok: false, problem: HELPER_LOCAL_ONLY });
    expect((await choose({ adapters: [] })).choice).toMatchObject({ ok: false, problem: "Tokama cannot run Claude Code agents yet." });
  });

  it("names a broken file's problem and no agent", async () => {
    personal("helper", "not an agent file");
    const { choice } = await choose();
    expect(choice.ok).toBe(false);
    expect(choice).toMatchObject({ problem: expect.stringContaining("The agent helper does not load") });
    expect("summary" in choice).toBe(false);
  });

  it("is used for a helper that names another agent, and that agent is never replaced by a target", async () => {
    const { choice } = await choose({}, "reviewer");
    expect(choice).toMatchObject({ ok: true, agent: { id: "reviewer", model: "opus", owner: { kind: "builtin" } } });
  });

  it("refuses an agent that is not set up", async () => {
    expect((await choose({}, "nobody")).choice).toEqual({ ok: false, problem: "The agent nobody is not set up." });
  });
});
