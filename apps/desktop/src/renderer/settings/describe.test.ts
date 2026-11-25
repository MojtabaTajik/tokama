import type { AgentDetail, BrokenAgentDetail } from "@tokama/core";
import { describe, expect, it } from "vitest";
import { agentRows, filterRows, limitsNotes, limitsTitle, monogram, ownerLabel, rowName, runsOnName, summaryLine } from "./describe.js";

const agent = (over: Record<string, unknown> = {}): AgentDetail =>
  ({
    id: "builder",
    name: "Builder",
    cliId: "claude-code",
    model: "sonnet",
    runsOn: "cloud",
    limits: { edit: true, commands: [], web: false },
    role: "Build.",
    roleCut: false,
    owner: { kind: "builtin" },
    source: "builtin/builder.md",
    ...over,
  }) as unknown as AgentDetail;

const brokenEntry = (over: Record<string, unknown> = {}): BrokenAgentDetail =>
  ({ id: "scribe", owner: { kind: "personal" }, source: "agents/scribe.md", problems: ["agents/scribe.md line 4: runs_on 'x' isn't known."], ...over }) as unknown as BrokenAgentDetail;

describe("agent words", () => {
  it("names each CLI by a text monogram", () => {
    expect(["claude-code", "codex-cli", "ollama"].map((id) => monogram(id as AgentDetail["cliId"]))).toEqual(["CC", "CX", "OL"]);
  });

  it("sums an agent up in one line", () => {
    expect(summaryLine(agent())).toBe("CC · sonnet · cloud");
    expect(summaryLine(agent({ cliId: "ollama", drivenBy: "claude-code", model: "qwen3-coder:30b", runsOn: "local" }))).toBe("OL · qwen3-coder:30b · this machine · via CC");
  });

  it("names what an agent runs on", () => {
    expect(runsOnName(agent({ cliId: "codex-cli" }))).toBe("Codex CLI");
    expect(runsOnName(agent({ cliId: "ollama", drivenBy: "codex-cli" }))).toBe("Ollama, driven by Codex CLI");
  });

  it("says what the limits allow", () => {
    expect(limitsTitle(agent())).toBe("Edits in the worktree");
    expect(limitsTitle(agent({ limits: { edit: false, commands: [], web: false } }))).toBe("Read-only");
    expect(limitsNotes(agent({ limits: { edit: false, commands: ["pnpm test:*", "git diff"], web: true } }))).toEqual([
      "Reads files. Cannot edit or write anywhere.",
      "May run: pnpm test:*, git diff",
      "May search and fetch from the web.",
    ]);
  });

  it("names the owner", () => {
    expect([{ kind: "builtin" }, { kind: "personal" }, { kind: "repo", repoId: "orders-api" }].map((owner) => ownerLabel(owner as never))).toEqual(["Built-in", "Personal", "Shared in orders-api"]);
  });
});

describe("agent rows", () => {
  const shared = (repoId: string) => agent({ id: "triager", name: `Triager ${repoId}`, owner: { kind: "repo", repoId } as never });

  it("lists loaded agents, then broken files, and keys the same id in two places apart", () => {
    const rows = agentRows([agent(), shared("orders-api"), shared("billing-api")], [brokenEntry()]);
    expect(rows.map((row) => [row.key, row.broken, rowName(row)])).toEqual([
      ["builtin::builder", false, "Builder"],
      ["repo:orders-api:triager", false, "Triager orders-api"],
      ["repo:billing-api:triager", false, "Triager billing-api"],
      ["personal::scribe", true, "scribe"],
    ]);
  });

  it("filters by every word, over name, id, model, source and monogram, ignoring case", () => {
    const rows = agentRows([agent(), agent({ id: "reviewer", name: "Reviewer", model: "opus", source: "builtin/reviewer.md", cliId: "codex-cli" })], [brokenEntry()]);
    const names = (query: string) => filterRows(rows, query).map(rowName);
    expect(names("")).toEqual(["Builder", "Reviewer", "scribe"]);
    expect(names("OPUS")).toEqual(["Reviewer"]);
    expect(names("cx opus")).toEqual(["Reviewer"]);
    expect(names("cx sonnet")).toEqual([]);
    expect(names("agents/scribe")).toEqual(["scribe"]);
    expect(names("  builtin  ")).toEqual(["Builder", "Reviewer"]);
  });
});
