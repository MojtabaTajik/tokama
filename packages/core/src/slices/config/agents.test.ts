import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentIdSchema, RepoIdSchema } from "../../kernel/schemas/index.js";
import { BUILTIN_AGENT_FILES, parseAgentFile } from "./agents.js";
import { formatProblem, loadAgents, type Agent, type LoadedAgents } from "./index.js";

let root: string;
let home: string;
let repoPath: string;
const repo = () => ({ id: RepoIdSchema.parse("orders-api"), path: repoPath });

beforeEach(() => {
  // realpath: on macOS the temp folder is behind the /var -> /private/var link.
  root = realpathSync(mkdtempSync(join(tmpdir(), "tokama-config-")));
  home = join(root, "tokama-home");
  repoPath = join(root, "orders-api");
  mkdirSync(home);
  mkdirSync(repoPath);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function agentFile(fields: Record<string, string>, role = "Review the diff."): string {
  const front = Object.entries({ format: "1", name: "Reviewer", runs_on: "claude-code", model: "sonnet", tools: "read-only", ...fields })
    .filter(([, value]) => value !== "")
    .map(([key, value]) => `${key}: ${value}`);
  return ["---", ...front, "---", role, ""].join("\n");
}

function writeAgent(folder: string, id: string, content: string): string {
  mkdirSync(folder, { recursive: true });
  const path = join(folder, `${id}.md`);
  writeFileSync(path, content);
  return path;
}
const personal = () => join(home, "agents");
const shared = () => join(repoPath, ".tokama", "agents");

/** The agents of a load that must have no problems. */
function value(loaded: LoadedAgents): readonly Agent[] {
  if (loaded.problems.length > 0) throw new Error(loaded.problems.map(formatProblem).join("\n"));
  return loaded.agents;
}
function messages(loaded: LoadedAgents): string[] {
  if (loaded.problems.length === 0) throw new Error("expected problems");
  return loaded.problems.map(formatProblem);
}
const ids = (agents: readonly { id: string }[]) => agents.map((agent) => agent.id);

describe("loadAgents", () => {
  it("loads an agent file into a record", async () => {
    writeAgent(personal(), "reviewer", agentFile({ commands: '["pnpm test:*", "git diff"]', web: "true", icon: "eye" }, "\nReview the diff.\nBe strict.\n"));
    const agents = value(await loadAgents({ tokamaHome: home }));
    expect(agents.find((agent) => agent.id === "reviewer")).toEqual({
      id: "reviewer",
      name: "Reviewer",
      cliId: "claude-code",
      model: "sonnet",
      limits: { edit: false, commands: ["pnpm test:*", "git diff"], web: true },
      icon: "eye",
      role: "Review the diff.\nBe strict.",
      owner: { kind: "personal" },
    });
  });

  it("has the built-in Builder when no folder exists", async () => {
    const agents = value(await loadAgents({ tokamaHome: join(root, "missing"), repo: { ...repo(), path: join(root, "gone") } }));
    expect(agents).toEqual([
      expect.objectContaining({
        id: "builder",
        name: "Builder",
        cliId: "claude-code",
        model: "sonnet",
        limits: { edit: true, commands: [], web: false },
        owner: { kind: "builtin" },
      }),
    ]);
    expect(agents[0]!.role).toContain("worktree");
  });

  it("prefers personal over the repo's shared agents, and both over built-ins", async () => {
    writeAgent(personal(), "reviewer", agentFile({ name: "My reviewer" }));
    writeAgent(shared(), "reviewer", agentFile({ name: "Team reviewer" }));
    writeAgent(shared(), "builder", agentFile({ name: "Team builder", tools: "edit" }));
    writeAgent(shared(), "architect", agentFile({ name: "Architect" }));
    const agents = value(await loadAgents({ tokamaHome: home, repo: repo() }));
    expect(agents.map((agent) => [agent.id, agent.name, agent.owner])).toEqual([
      ["architect", "Architect", { kind: "repo", repoId: "orders-api" }],
      ["builder", "Team builder", { kind: "repo", repoId: "orders-api" }],
      ["reviewer", "My reviewer", { kind: "personal" }],
    ]);
  });

  it("leaves a repo's shared agents out when no repo is given", async () => {
    writeAgent(shared(), "architect", agentFile({}));
    expect(ids(value(await loadAgents({ tokamaHome: home })))).toEqual(["builder"]);
  });

  it("reads only .md files, and skips READMEs and dotfiles", async () => {
    writeAgent(personal(), "reviewer", agentFile({}));
    writeFileSync(join(personal(), "notes.txt"), "not an agent");
    writeFileSync(join(personal(), ".DS_Store"), "");
    writeFileSync(join(personal(), "README.md"), "# My agents\n");
    writeFileSync(join(personal(), "readme.md"), "# My agents\n");
    writeFileSync(join(personal(), ".draft.md"), "unfinished");
    expect(ids(value(await loadAgents({ tokamaHome: home })))).toEqual(["builder", "reviewer"]);
  });

  it("takes driven_by for ollama and refuses it otherwise", async () => {
    writeAgent(personal(), "local", agentFile({ runs_on: "ollama", driven_by: "claude-code", model: "qwen3-coder:30b" }));
    const local = value(await loadAgents({ tokamaHome: home })).find((agent) => agent.id === "local");
    expect(local).toMatchObject({ cliId: "ollama", drivenBy: "claude-code", model: "qwen3-coder:30b" });

    writeAgent(personal(), "local", agentFile({ runs_on: "ollama" }));
    expect(messages(await loadAgents({ tokamaHome: home }))).toEqual([
      "agents/local.md line 4: runs_on is ollama, so driven_by is needed: claude-code or codex-cli, the CLI that drives the local model",
    ]);
    writeAgent(personal(), "local", agentFile({ driven_by: "codex-cli" }));
    expect(messages(await loadAgents({ tokamaHome: home }))).toEqual(["agents/local.md line 7: driven_by only applies when runs_on is ollama"]);
  });

  it("names the file and line of an unknown value, with a suggestion", async () => {
    writeAgent(personal(), "reviewer", agentFile({ runs_on: "claud-code" }));
    expect(messages(await loadAgents({ tokamaHome: home }))).toEqual([
      "agents/reviewer.md line 4: runs_on 'claud-code' isn't known. Did you mean claude-code?",
    ]);
    writeAgent(personal(), "reviewer", agentFile({ runs_on: "codex" }));
    expect(messages(await loadAgents({ tokamaHome: home }))).toEqual(["agents/reviewer.md line 4: runs_on 'codex' isn't known. Did you mean codex-cli?"]);
    writeAgent(personal(), "reviewer", agentFile({ tools: "everything" }));
    expect(messages(await loadAgents({ tokamaHome: home }))).toEqual([
      "agents/reviewer.md line 6: tools 'everything' isn't known. Use read-only or edit.",
    ]);
  });

  it("gives the file line of a front matter field", async () => {
    writeAgent(personal(), "reviewer", "---\nname: Reviewer\nruns_on: claud-code\nmodel: sonnet\ntools: read-only\nformat: 1\n---\nReview.\n");
    expect(messages(await loadAgents({ tokamaHome: home }))).toEqual([
      "agents/reviewer.md line 3: runs_on 'claud-code' isn't known. Did you mean claude-code?",
    ]);
  });

  it("matches the line numbers of the file with CRLF line breaks", async () => {
    writeAgent(personal(), "reviewer", agentFile({ runs_on: "claud-code" }).replaceAll("\n", "\r\n"));
    expect(messages(await loadAgents({ tokamaHome: home }))).toEqual([
      "agents/reviewer.md line 4: runs_on 'claud-code' isn't known. Did you mean claude-code?",
    ]);
  });

  it("reports every problem in every file, each at its line", async () => {
    writeAgent(personal(), "a", agentFile({ format: "2", model: "", modle: "sonnet" }));
    writeAgent(shared(), "b", agentFile({ web: "yes", commands: '["pnpm test", ":*"]' }));
    expect(messages(await loadAgents({ tokamaHome: home, repo: repo() }))).toEqual([
      "agents/a.md line 2: format 2 isn't supported. Use 1.",
      "agents/a.md line 2: model is missing",
      "agents/a.md line 6: 'modle' isn't a known field. Did you mean model?",
      "orders-api/.tokama/agents/b.md line 7: web must be true or false",
      "orders-api/.tokama/agents/b.md line 8: commands item 2 has no command words",
    ]);
  });

  it("refuses a file without closed front matter", async () => {
    writeAgent(personal(), "none", "Just a role.\n");
    writeAgent(personal(), "open", "---\nname: Open\n");
    writeAgent(personal(), "empty", "---\n---\nRole.\n");
    expect(messages(await loadAgents({ tokamaHome: home }))).toEqual([
      "agents/empty.md line 2: is empty",
      "agents/none.md line 1: must start with a '---' line, then the settings (name, runs_on, model, tools), then '---'",
      "agents/open.md line 1: the settings at the top are never closed: add a '---' line after them",
    ]);
  });

  it("refuses YAML that does not parse, at its line", async () => {
    writeAgent(personal(), "bad", "---\nformat: 1\nname: Bad\nname: Again\n---\n");
    expect(messages(await loadAgents({ tokamaHome: home }))).toEqual(["agents/bad.md line 4: isn't valid YAML: Map keys must be unique"]);
  });

  it("refuses a file name that is not an agent id", async () => {
    writeAgent(personal(), "Reviewer", agentFile({}));
    expect(messages(await loadAgents({ tokamaHome: home }))).toEqual([
      "agents/Reviewer.md: 'Reviewer' isn't a valid agent id: use lowercase letters, digits and hyphens (at most 64)",
    ]);
  });

  it("refuses a linked agents folder in the personal folder", async () => {
    writeAgent(join(root, "dotfiles", "agents"), "reviewer", agentFile({}));
    symlinkSync(join(root, "dotfiles", "agents"), personal());
    const loaded = await loadAgents({ tokamaHome: home });
    expect(ids(loaded.agents)).toEqual(["builder"]);
    expect(messages(loaded)).toEqual(["agents: Tokama doesn't follow links in config folders"]);

    // A link that leads nowhere is refused the same way, not taken for a missing folder.
    rmSync(personal());
    symlinkSync(join(root, "gone"), personal());
    expect(messages(await loadAgents({ tokamaHome: home }))).toEqual(["agents: Tokama doesn't follow links in config folders"]);
  });

  it("refuses a linked agent file in the personal folder, which still claims its id", async () => {
    const target = writeAgent(join(root, "dotfiles"), "reviewer", agentFile({}));
    mkdirSync(personal());
    symlinkSync(target, join(personal(), "reviewer.md"));
    symlinkSync(join(root, "gone.md"), join(personal(), "dangling.md"));
    const loaded = await loadAgents({ tokamaHome: home });
    expect(ids(loaded.agents)).toEqual(["builder"]);
    expect(ids(loaded.broken)).toEqual(["dangling", "reviewer"]);
    expect(messages(loaded)).toEqual([
      "agents/dangling.md: Tokama doesn't follow links in config folders",
      "agents/reviewer.md: Tokama doesn't follow links in config folders",
    ]);
  });

  it("refuses a linked agent file in a repo", async () => {
    writeAgent(shared(), "real", agentFile({}));
    symlinkSync(join(shared(), "real.md"), join(shared(), "reviewer.md"));
    const loaded = await loadAgents({ tokamaHome: home, repo: repo() });
    expect(messages(loaded)).toEqual(["orders-api/.tokama/agents/reviewer.md: Tokama doesn't follow links in config folders"]);
    expect(ids(loaded.broken)).toEqual(["reviewer"]);
  });

  it("refuses a linked agents or .tokama folder in a repo, also one that stays inside the repo", async () => {
    writeAgent(join(repoPath, "team-agents"), "architect", agentFile({ name: "Architect" }));
    mkdirSync(join(repoPath, ".tokama"));
    symlinkSync(join(repoPath, "team-agents"), shared());
    const loaded = await loadAgents({ tokamaHome: home, repo: repo() });
    expect(ids(loaded.agents)).toEqual(["builder"]);
    expect(messages(loaded)).toEqual(["orders-api/.tokama/agents: Tokama doesn't follow links in config folders"]);

    rmSync(join(repoPath, ".tokama"), { recursive: true });
    writeAgent(join(root, "elsewhere", "agents"), "reviewer", agentFile({}));
    symlinkSync(join(root, "elsewhere"), join(repoPath, ".tokama"));
    expect(messages(await loadAgents({ tokamaHome: home, repo: repo() }))).toEqual(["orders-api/.tokama: Tokama doesn't follow links in config folders"]);
  });

  it("loads the valid agents next to an invalid file, which still claims its id", async () => {
    writeAgent(personal(), "builder", agentFile({ runs_on: "claud-code" }));
    writeAgent(shared(), "reviewer", agentFile({ tools: "all" }));
    writeAgent(shared(), "architect", agentFile({ name: "Architect" }));
    writeAgent(shared(), "Bad Name", agentFile({}));
    const loaded = await loadAgents({ tokamaHome: home, repo: repo() });
    expect(ids(loaded.agents)).toEqual(["architect"]);
    // The broken personal builder hides the built-in one: a step that uses it fails with its problem.
    expect(loaded.broken).toEqual([
      {
        id: "builder",
        owner: { kind: "personal" },
        problems: [{ file: "agents/builder.md", line: 4, message: "runs_on 'claud-code' isn't known. Did you mean claude-code?" }],
      },
      { id: "reviewer", owner: { kind: "repo", repoId: "orders-api" }, problems: [expect.objectContaining({ line: 6 })] },
    ]);
    expect(messages(loaded)).toEqual([
      "agents/builder.md line 4: runs_on 'claud-code' isn't known. Did you mean claude-code?",
      "orders-api/.tokama/agents/Bad Name.md: 'Bad Name' isn't a valid agent id: use lowercase letters, digits and hyphens (at most 64)",
      "orders-api/.tokama/agents/reviewer.md line 6: tools 'all' isn't known. Use read-only or edit.",
    ]);
  });

  it("reports a shadowed invalid file but uses the agent that wins", async () => {
    writeAgent(personal(), "reviewer", agentFile({}));
    writeAgent(shared(), "reviewer", agentFile({ tools: "all" }));
    const loaded = await loadAgents({ tokamaHome: home, repo: repo() });
    expect(loaded.agents.find((agent) => agent.id === "reviewer")?.owner).toEqual({ kind: "personal" });
    expect(loaded.broken).toEqual([]);
    expect(loaded.problems).toHaveLength(1);
  });

  it("strips a byte order mark and keeps '---' lines in the role", async () => {
    writeAgent(personal(), "reviewer", `\uFEFF${agentFile({}, "First part.\n---\nSecond part.")}`);
    expect(value(await loadAgents({ tokamaHome: home })).find((agent) => agent.id === "reviewer")?.role).toBe("First part.\n---\nSecond part.");
  });

  it("prints raw values escaped and cut short", async () => {
    writeAgent(personal(), "a", agentFile({ runs_on: '"claude\\u001b[31mcode"', ["x".repeat(100)]: "1" }));
    writeAgent(personal(), "b", agentFile({ name: '"Line one\\nLine two"' }));
    expect(messages(await loadAgents({ tokamaHome: home }))).toEqual([
      "agents/a.md line 4: runs_on 'claude\\u001b[31mcode' isn't known. Use claude-code, codex-cli or ollama.",
      `agents/a.md line 7: '${"x".repeat(60)}…' isn't a known field.`,
      "agents/b.md line 3: name must be one line, with no control characters",
    ]);
  });

  it("escapes bidi characters in values and file names", async () => {
    writeAgent(personal(), "a", agentFile({ runs_on: "claude\u202Ecode" }));
    writeAgent(personal(), "evil\u202Eb\nx", agentFile({}));
    expect(messages(await loadAgents({ tokamaHome: home }))).toEqual([
      "agents/a.md line 4: runs_on 'claude\\u202ecode' isn't known. Did you mean claude-code?",
      "agents/evil\\u202eb\\nx.md: 'evil\\u202eb\\nx' isn't a valid agent id: use lowercase letters, digits and hyphens (at most 64)",
    ]);
  });

  it("refuses an oversized file, a folder named like an agent, and an agents path that is a file", async () => {
    writeAgent(personal(), "big", agentFile({}, "x".repeat(70 * 1024)));
    mkdirSync(join(personal(), "dir.md"));
    writeFileSync(join(repoPath, ".tokama"), "");
    expect(messages(await loadAgents({ tokamaHome: home, repo: repo() }))).toEqual([
      "agents/big.md: is larger than 64 KB",
      "agents/dir.md: isn't a regular file",
      "orders-api/.tokama/agents: isn't a folder",
    ]);
  });
});

describe("built-in agents", () => {
  it("pass the same validation as agent files", () => {
    for (const [id, content] of Object.entries(BUILTIN_AGENT_FILES)) {
      expect(parseAgentFile(content, AgentIdSchema.parse(id), { kind: "builtin" }, id).ok).toBe(true);
    }
  });
});
