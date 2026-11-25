// The agents_list query over the engine API, on real files in Tokama's home and in a repo.
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { connect, type EngineClient } from "@tokama/client";
import { afterEach, describe, expect, it } from "vitest";
import { startEngine } from "./engine.js";
import { tempEngineDir } from "./testing/helpers.js";

let cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups = [];
});

async function setUp(options: { home?: boolean } = {}) {
  const dir = tempEngineDir(cleanups);
  const root = realpathSync(dirname(dir));
  const home = join(root, "tokama");
  const started = await startEngine({ dir, sample: true, ...(options.home === false ? {} : { home }) });
  if (!started.ok) throw new Error(started.error.message);
  cleanups.push(() => started.value.close());
  const connected = await connect({ dir, startTimeoutMs: 2_000 });
  if (!connected.ok) throw new Error(connected.error.message);
  cleanups.push(() => connected.value.close());
  return { root, home, client: connected.value };
}

const agentFile = (name: string, over: Record<string, string> = {}, body = "Do the work.") =>
  `---\nformat: 1\nname: ${name}\nruns_on: ${over["runs_on"] ?? "claude-code"}\nmodel: ${over["model"] ?? "sonnet"}\ntools: ${over["tools"] ?? "read-only"}\n---\n${body}\n`;

function write(folder: string, name: string, text: string) {
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, name), text);
}

async function list(client: EngineClient) {
  const reply = await client.query({ type: "agents_list" });
  if (!reply.ok) throw new Error(reply.error.message);
  return reply.data;
}

describe("agents_list", () => {
  it("lists the built-in agents, with their source, when no file exists", async () => {
    const { client } = await setUp();
    const { agents, broken, problems } = await list(client);
    expect(agents.map((agent) => [agent.id, agent.owner, agent.source, agent.cliId, agent.model, agent.runsOn, agent.limits.edit])).toEqual([
      ["architect", { kind: "builtin" }, "builtin/architect.md", "claude-code", "opus", "cloud", false],
      ["builder", { kind: "builtin" }, "builtin/builder.md", "claude-code", "sonnet", "cloud", true],
      ["reviewer", { kind: "builtin" }, "builtin/reviewer.md", "claude-code", "opus", "cloud", false],
    ]);
    expect(agents[1]).toMatchObject({ replacesBuiltin: false, name: "Builder", icon: "hammer", roleCut: false, role: expect.stringContaining("worktree") });
    expect([broken, problems]).toEqual([[], []]);
  });

  it("lists personal and each repo's shared agents with their owners, and broken files with their problems", async () => {
    const { root, home, client } = await setUp();
    const orders = join(root, "ledger-api");
    mkdirSync(orders);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: orders });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "first"], { cwd: orders });
    expect((await client.command({ type: "add_repo", path: orders })).ok).toBe(true);
    const agentsDir = join(home, "agents");
    write(agentsDir, "reviewer.md", agentFile("My reviewer", { runs_on: "ollama", model: "qwen3-coder:30b" }).replace("runs_on: ollama", "runs_on: ollama\ndriven_by: claude-code"));
    write(agentsDir, "scribe.md", agentFile("Scribe", { tools: "edit" }, "Write <b>docs</b>."));
    write(agentsDir, "broken.md", agentFile("Broken", { runs_on: "claud-code" }));
    write(agentsDir, "Bad Name.md", agentFile("Bad"));
    write(join(orders, ".tokama", "agents"), "triager.md", agentFile("Triager"));
    // The personal Reviewer hides this one, so it is not listed.
    write(join(orders, ".tokama", "agents"), "reviewer.md", agentFile("Team reviewer"));

    const { agents, broken, problems } = await list(client);
    expect(agents.map((agent) => [agent.id, agent.name, agent.owner, agent.source])).toEqual([
      ["architect", "Architect", { kind: "builtin" }, "builtin/architect.md"],
      ["builder", "Builder", { kind: "builtin" }, "builtin/builder.md"],
      ["reviewer", "My reviewer", { kind: "personal" }, "agents/reviewer.md"],
      ["scribe", "Scribe", { kind: "personal" }, "agents/scribe.md"],
      ["triager", "Triager", { kind: "repo", repoId: "ledger-api" }, "ledger-api/.tokama/agents/triager.md"],
    ]);
    expect(agents.find((agent) => agent.id === "reviewer")).toMatchObject({ replacesBuiltin: true, cliId: "ollama", drivenBy: "claude-code", runsOn: "local", model: "qwen3-coder:30b" });
    expect(agents.find((agent) => agent.id === "scribe")).toMatchObject({ role: "Write <b>docs</b>.", limits: { edit: true, commands: [], web: false } });
    expect(broken).toEqual([
      {
        id: "broken",
        owner: { kind: "personal" },
        source: "agents/broken.md",
        replacesBuiltin: false,
        problems: ["agents/broken.md line 4: runs_on 'claud-code' isn't known. Did you mean claude-code?"],
      },
    ]);
    expect(problems).toEqual([expect.stringContaining("Bad Name.md")]);
  });

  it("keeps the same agent id in two repos apart and never sends a machine path", async () => {
    const { root, client } = await setUp();
    for (const name of ["ledger-api", "billing-api"]) {
      const path = join(root, name);
      mkdirSync(path);
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: path });
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "first"], { cwd: path });
      expect((await client.command({ type: "add_repo", path })).ok).toBe(true);
      write(join(path, ".tokama", "agents"), "triager.md", agentFile(`Triager of ${name}`));
    }
    const data = await list(client);
    expect(data.agents.filter((agent) => agent.id === "triager").map((agent) => [agent.name, agent.source])).toEqual([
      ["Triager of ledger-api", "ledger-api/.tokama/agents/triager.md"],
      ["Triager of billing-api", "billing-api/.tokama/agents/triager.md"],
    ]);
    expect(JSON.stringify(data)).not.toContain(root);
  });

  it("keeps the reply valid for a file with 150 commands and 80 problems, and says how many were left out", async () => {
    const { home, client } = await setUp();
    const commands = Array.from({ length: 150 }, (_, i) => `  - tool${i} run`).join("\n");
    write(join(home, "agents"), "many.md", agentFile("Many", { tools: "edit" }).replace("tools: edit\n", `tools: edit\ncommands:\n${commands}\n`));
    const unknown = Array.from({ length: 80 }, (_, i) => `field${i}: 1`).join("\n");
    write(join(home, "agents"), "noisy.md", agentFile("Noisy").replace("tools: read-only\n", `tools: read-only\n${unknown}\n`));
    const data = await list(client);
    const many = data.agents.find((agent) => agent.id === "many");
    expect(many?.limits.commands).toHaveLength(100);
    expect(many?.limits.commands.at(-2)).toBe("tool98 run");
    expect(many?.limits.commands.at(-1)).toBe("+51 more");
    const noisy = data.broken.find((entry) => entry.id === "noisy");
    expect(noisy?.problems).toHaveLength(50);
    expect(noisy?.problems.at(-1)).toMatch(/^\+\d+ more$/);
    expect(data.problems).toEqual([]);
  });

  it("marks a personal or shared agent that replaces a built-in, loaded or broken", async () => {
    const { home, client } = await setUp();
    write(join(home, "agents"), "reviewer.md", agentFile("My reviewer"));
    write(join(home, "agents"), "builder.md", agentFile("Bad builder", { runs_on: "claud-code" }));
    write(join(home, "agents"), "scribe.md", agentFile("Scribe"));
    const data = await list(client);
    expect(data.agents.map((agent) => [agent.id, agent.replacesBuiltin])).toEqual([["architect", false], ["reviewer", true], ["scribe", false]]);
    expect(data.broken.map((entry) => [entry.id, entry.replacesBuiltin])).toEqual([["builder", true]]);
  });

  it("cuts a long role and says so", async () => {
    const { home, client } = await setUp();
    write(join(home, "agents"), "long.md", agentFile("Long", {}, "x".repeat(5000)));
    const long = (await list(client)).agents.find((agent) => agent.id === "long");
    expect(long?.role).toHaveLength(4000);
    expect(long?.roleCut).toBe(true);
  });

  it("answers not_implemented when the engine has no home folder", async () => {
    const { client } = await setUp({ home: false });
    expect(await client.query({ type: "agents_list" })).toMatchObject({ ok: false, error: { code: "not_implemented" } });
  });
});
