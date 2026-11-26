import { adapters, type CliHealth, type Health, MIN_GIT_VERSION, type RepoSummary, type TemplateSummary } from "@tokama/core";
import { describe, expect, it } from "vitest";
import { isWebsiteUrl } from "../../main/policy.js";
import { aiCliBlock, aiCliState, atLeast, type Checklist, checklist, type ChecklistInput, numberIn, QUICK_FIX_ID, type Row } from "./checklist.js";
import { CLAUDE_CODE_MIN, GIT_MIN, LINKS, SAMPLE_TASK } from "./words.js";

const claude = (overrides: Partial<CliHealth> = {}): CliHealth => ({ cliId: "claude-code", installed: true, loggedIn: true, version: "2.1.332", ...overrides });
const health = (parts: { git?: Health["git"]; cli?: CliHealth | undefined } = {}): Health => ({
  git: parts.git ?? { ok: true, version: "git version 2.47.1" },
  clis: "cli" in parts ? (parts.cli === undefined ? [] : [parts.cli]) : [claude()],
  config: [],
});
const repoId = (id: string) => id as RepoSummary["id"];
const repo = (overrides: Partial<RepoSummary> = {}): RepoSummary => ({ id: repoId("orders-api"), baseBranch: "main", checks: ["npm test", "npm run lint"], path: "~/code/orders-api", ...overrides });
const step = { name: "Fix", stage: "working" as const, data: "local" as const };
const template = (id: string, name: string, checksFromRepo: boolean): TemplateSummary =>
  ({
    id,
    name,
    kind: "task",
    connections: [],
    start: { needs: ["text", "repo"], askBeforeCloud: false },
    warnings: [],
    steps: checksFromRepo ? [step, { ...step, name: "Run checks", stage: "verifying", checks: { from: "repo" } }] : [step],
  }) as unknown as TemplateSummary;
const TEMPLATES = [template("builtin/quick-fix", "Quick fix", true), template("builtin/quick-change", "Quick change", false)];

const ready = (overrides: Partial<ChecklistInput> = {}): ChecklistInput => ({
  health: health(),
  checkFailed: false,
  checking: false,
  repos: [repo()],
  templates: TEMPLATES,
  started: false,
  firstItem: undefined,
  mac: true,
  ...overrides,
});
const rowOf = (list: Checklist, id: Row["id"]) => list.rows.find((entry) => entry.id === id)!;
const textOf = (row: Row) => row.detail.map((part) => (typeof part === "string" ? part : "strong" in part ? part.strong : "code" in part ? part.code : "quote" in part ? part.quote : "link" in part ? part.link.text : "act" in part ? part.act.text : "")).join("");

describe("the pinned numbers", () => {
  it("match the engine's: git minimum and the Claude Code minimum", () => {
    expect(GIT_MIN).toBe(`${MIN_GIT_VERSION.major}.${MIN_GIT_VERSION.minor}`);
    expect(CLAUDE_CODE_MIN).toBe((adapters as Record<string, unknown>)["SHELL_CALLS_FROM"]);
  });

  it("only link to pages the main process may open", () => {
    for (const href of Object.values(LINKS)) expect(isWebsiteUrl(href)).toBe(true);
  });
});

describe("version helpers", () => {
  it("compares dotted numbers part by part", () => {
    expect([atLeast("2.1.315", "2.1.315"), atLeast("2.1.332", "2.1.315"), atLeast("2.1.290", "2.1.315"), atLeast("2.10.0", "2.9.9"), atLeast("2.38", "2.38.0"), atLeast("2.37.1", "2.38")]).toEqual([true, true, false, true, true, false]);
  });

  it("finds the number in what a tool printed", () => {
    expect([numberIn("2.1.332"), numberIn("git version 2.47.1 (Apple Git-154)"), numberIn("git version unknown"), numberIn(undefined)]).toEqual(["2.1.332", "2.47.1", undefined, undefined]);
  });
});

describe("step 1: the AI CLI", () => {
  const first = (input: Partial<ChecklistInput>) => rowOf(checklist(ready(input)), "ai-cli");

  it("is ready when Claude Code is installed, logged in and new enough", () => {
    const row = first({});
    expect([row.mark.symbol, row.word, row.done]).toEqual(["✓", "Ready", true]);
    expect(textOf(row)).toBe("Claude Code 2.1.332 is installed and logged in.");
  });

  it("is ready at exactly the oldest version", () => {
    expect(first({ health: health({ cli: claude({ version: "2.1.315" }) }) }).done).toBe(true);
  });

  it("is not installed: says so, links to the install page and has no command", () => {
    const row = first({ health: health({ cli: claude({ installed: false, loggedIn: false, version: undefined }) }) });
    expect([row.mark.symbol, row.word]).toEqual(["✕", "Not installed"]);
    expect(textOf(row)).toBe("Tokama works through an AI CLI, such as Claude Code. None was found on this computer. Install it, log in, then come back: this row updates by itself.");
    expect(row.action).toEqual({ kind: "link", label: "Install Claude Code", href: "https://tokama.dev/docs/install-claude-code" });
    expect(row.command).toBeUndefined();
  });

  it("is logged out: names the version and gives the login command", () => {
    const row = first({ health: health({ cli: claude({ loggedIn: false }) }) });
    expect([row.mark.symbol, row.word, row.command]).toEqual(["✕", "Logged out", "claude auth login"]);
    expect(textOf(row)).toBe("Claude Code 2.1.332 is installed but not logged in. Run this in a terminal and follow the login steps:");
    expect(row.action).toBeUndefined();
  });

  it("is logged out without a version when the engine sent none", () => {
    expect(textOf(first({ health: health({ cli: claude({ loggedIn: false, version: undefined }) }) }))).toMatch(/^Claude Code is installed but not logged in/);
  });

  it("is too old: names both numbers and gives the update command", () => {
    const row = first({ health: health({ cli: claude({ version: "2.1.290", message: "Claude Code 2.1.290 is older than 2.1.315. Steps that run commands will fail until you update it (for example with `claude update`)." }) }) });
    expect([row.mark.symbol, row.word, row.command]).toEqual(["✕", "Too old", "claude update"]);
    expect(textOf(row)).toBe("Claude Code 2.1.290 is too old. Tokama needs 2.1.315 or newer. Run this in a terminal:");
    expect(row.engineText).toBeUndefined();
  });

  it("needs a fix when the sandbox cannot run: the engine's words as plain text, no command, no link", () => {
    const message = "Steps that run commands need bubblewrap and socat for Claude Code's sandbox, and bwrap is missing or not working. Install them (Ubuntu: `sudo apt-get install bubblewrap socat`).";
    const row = first({ health: health({ cli: claude({ message }) }), mac: false });
    expect([row.mark.symbol, row.word, row.done]).toEqual(["✕", "Needs a fix", false]);
    expect(textOf(row)).toBe("Claude Code 2.1.332 is installed and logged in, but its sandbox cannot run on this computer.");
    expect(row.engineText).toBe(message);
    expect(row.command).toBeUndefined();
    expect(row.action).toBeUndefined();
    expect(row.detail.some((part) => typeof part === "object" && "link" in part)).toBe(false);
  });

  it("needs a fix, in other words, when the version cannot be read", () => {
    const row = first({ health: health({ cli: claude({ version: undefined, message: "Tokama could not read the Claude Code version, so steps that run commands will not run." }) }) });
    expect(row.word).toBe("Needs a fix");
    expect(textOf(row)).toBe("Claude Code is installed and logged in, but Tokama cannot run it yet.");
  });

  it("is checking while Check again runs", () => {
    const row = first({ checking: true });
    expect([row.mark.symbol, row.word, row.done, textOf(row)]).toEqual(["◌", "Checking…", false, "Looking for an AI CLI on this computer."]);
  });

  it("could not be checked when the setup failed, the CLI did not answer in time (never stuck on Checking…), or the engine named no AI CLI: warns with ! and offers Check again", () => {
    const silent = health({ cli: claude({ installed: false, loggedIn: false, timedOut: true }) });
    for (const input of [{ checkFailed: true }, { health: silent }, { health: health({ cli: undefined }) }, { health: undefined }]) {
      const row = first(input);
      expect([row.mark.symbol, row.word]).toEqual(["!", "Could not check"]);
      expect(textOf(row)).toBe("Tokama could not look for an AI CLI, because its engine did not answer. Check again. If this stays, quit Tokama and open it again.");
      expect(row.action).toEqual({ kind: "check-again", label: "Check again" });
    }
  });

  it("stops new work only for a problem the user must fix", () => {
    expect(aiCliBlock(health())).toBeUndefined();
    expect(aiCliBlock(health({ cli: claude({ installed: false, loggedIn: false }) }))).toBe("Not installed");
    expect(aiCliBlock(health({ cli: claude({ loggedIn: false }) }))).toBe("Logged out");
    // Too old, or a sandbox that cannot run: work that runs no commands (a review) still runs, so only the row says so.
    expect(aiCliBlock(health({ cli: claude({ version: "2.1.1" }) }))).toBeUndefined();
    expect(aiCliBlock(health({ cli: claude({ message: "x" }) }))).toBeUndefined();
    // Not known yet: the engine answers a start for itself.
    expect(aiCliBlock(health({ cli: claude({ timedOut: true }) }))).toBeUndefined();
    expect(aiCliBlock(undefined)).toBeUndefined();
    expect(aiCliState(health({ cli: undefined })).kind).toBe("could_not_check");
  });
});

describe("step 2: git", () => {
  const second = (input: Partial<ChecklistInput>) => rowOf(checklist(ready(input)), "git");

  it("has a title that never changes, and the minimum in it", () => {
    expect(second({}).title).toBe("Install git 2.38 or newer");
    expect(second({ health: health({ git: { ok: false } }) }).title).toBe("Install git 2.38 or newer");
  });

  it("is ready, with the version the engine found", () => {
    const row = second({});
    expect([row.mark.symbol, row.word, textOf(row)]).toEqual(["✓", "Ready", "git 2.47.1."]);
  });

  it("is too old on macOS: the version, the minimum, brew with Copy and the other-ways link", () => {
    const row = second({ health: health({ git: { ok: false, version: "git version 2.37.1", message: "git 2.38 or newer is required; found: git version 2.37.1" } }) });
    expect([row.mark.symbol, row.word, row.command]).toEqual(["✕", "Too old", "brew install git"]);
    expect(textOf(row)).toBe("Found git 2.37.1. Tokama needs 2.38 or newer. Run this in a terminal, or see other ways to install git.");
    expect(row.detail).toContainEqual({ link: { text: "other ways to install git", href: "https://tokama.dev/docs/install-git" } });
  });

  it("is too old on Linux: the package manager, no command, and the row updates by itself", () => {
    const row = second({ mac: false, health: health({ git: { ok: false, version: "git version 2.34.1", message: "x" } }) });
    expect(row.command).toBeUndefined();
    expect(textOf(row)).toBe("Found git 2.34.1. Tokama needs 2.38 or newer. Install it with your system’s package manager, or see other ways to install git. This row updates by itself.");
    expect(row.detail).toContainEqual({ link: { text: "other ways to install git", href: "https://tokama.dev/docs/install-git" } });
  });

  it("is not found: macOS gets brew, Linux does not", () => {
    const git = health({ git: { ok: false, message: "git did not start" } });
    const mac = second({ health: git });
    expect([mac.word, mac.command, textOf(mac)]).toEqual(["Not found", "brew install git", "No git was found on this computer. Run this in a terminal, or see other ways to install git."]);
    const linux = second({ health: git, mac: false });
    expect(linux.command).toBeUndefined();
    expect(textOf(linux)).toBe("No git was found on this computer. Install it with your system’s package manager, or see other ways to install git. This row updates by itself.");
  });

  it("says it could not read a version it found but cannot parse", () => {
    expect(textOf(second({ health: health({ git: { ok: false, version: "git version unknown", message: "x" } }) }))).toMatch(/^Tokama could not read the version of the git it found\. Tokama needs 2\.38 or newer/);
  });

  it("is not called missing when the checks did not finish: the engine's checks threw", () => {
    const row = second({ health: health({ git: { ok: false, message: "The checks failed" }, cli: claude({ installed: false, loggedIn: false, timedOut: true }) }) });
    expect([row.word, row.command, row.action?.kind]).toEqual(["Could not check", undefined, "check-again"]);
  });

  it("could not be checked when the setup failed or has not come", () => {
    for (const input of [{ checkFailed: true }, { health: undefined }]) {
      const row = second(input);
      expect([row.mark.symbol, row.word, row.action?.kind]).toEqual(["!", "Could not check", "check-again"]);
    }
  });
});

describe("step 3: the first repo", () => {
  it("is to do without a repo, with Add repo", () => {
    const row = rowOf(checklist(ready({ repos: [] })), "repo");
    expect([row.mark.symbol, row.word, row.action]).toEqual(["○", "To do", { kind: "add-repo", label: "Add repo" }]);
    expect(textOf(row)).toBe("Choose the folder of a git repo you work on. Tokama looks for your test and lint commands, so it can check each change.");
  });

  it("is added: name, folder and checks", () => {
    const row = rowOf(checklist(ready()), "repo");
    expect([row.mark.symbol, row.word]).toEqual(["✓", "Added"]);
    expect(textOf(row)).toBe("orders-api · ~/code/orders-api · 2 checks: npm test, npm run lint");
  });

  it("says when the repo has no checks, and how many more repos there are", () => {
    expect(textOf(rowOf(checklist(ready({ repos: [repo({ checks: [], path: undefined }), repo({ id: repoId("b") }), repo({ id: repoId("c") })] })), "repo"))).toBe("orders-api · no checks · 2 more repos");
    expect(textOf(rowOf(checklist(ready({ repos: [repo({ checks: ["make"] })] })), "repo"))).toBe("orders-api · ~/code/orders-api · 1 check: make");
  });
});

describe("step 4: the first Quick fix", () => {
  const fourth = (input: Partial<ChecklistInput>) => rowOf(checklist(ready(input)), "quick-fix");

  it("stays off until steps 1 to 3 are done, and says why", () => {
    for (const input of [{ repos: [] }, { health: health({ git: { ok: false } }) }, { health: health({ cli: claude({ loggedIn: false }) }) }, { checkFailed: true }]) {
      const row = fourth(input);
      expect([row.mark.symbol, row.word, textOf(row)]).toEqual(["○", "To do", "Try one small change on your repo. Finish the three steps above first."]);
      expect(row.action).toMatchObject({ kind: "start", label: "Start a Quick fix", locked: true });
    }
  });

  it("unlocks when steps 1 to 3 are done, and fills New work with Quick fix, the first repo and the sample task", () => {
    const row = fourth({});
    expect(textOf(row)).toBe(`Opens New work with a sample task you can change: ${SAMPLE_TASK}. Tokama works on its own branch. At the end you merge, open a PR or discard.`);
    expect(row.action).toEqual({ kind: "start", label: "Start a Quick fix", locked: false, prefill: { templateId: QUICK_FIX_ID, repoId: "orders-api", text: "Fix typos and unclear sentences in README.md" } });
  });

  it("offers Quick change when the repo has no checks, and a way to add one", () => {
    const row = fourth({ repos: [repo({ checks: [] })] });
    expect(textOf(row)).toBe("Quick fix runs your checks after the change, and orders-api has none yet. Try Quick change instead: you look at the change and approve it yourself. Or add a check first.");
    expect(row.detail).toContainEqual({ act: { text: "add a check", id: "edit-repo" } });
    expect(row.action).toEqual({ kind: "start", label: "Start a Quick change", locked: false, prefill: { templateId: "builtin/quick-change", repoId: "orders-api", text: SAMPLE_TASK } });
  });

  it("has no button for a repo without checks when Quick change is not there", () => {
    expect(fourth({ repos: [repo({ checks: [] })], templates: [TEMPLATES[0]!] }).action).toBeUndefined();
  });

  it("is done once any item or count exists, with any workflow, and says what the first run was", () => {
    const row = fourth({ started: true, firstItem: { text: SAMPLE_TASK, repoId: "orders-api" } });
    expect([row.mark.symbol, row.word, row.done, row.action]).toEqual(["✓", "Done", true, undefined]);
    expect(textOf(row)).toBe("Fix typos and unclear sentences in README.md on orders-api was your first run.");
    expect(textOf(fourth({ started: true }))).toBe("Your first work has started.");
  });

  it("is done even when an earlier step went bad later: it never comes back by itself", () => {
    const list = checklist(ready({ started: true, health: health({ cli: claude({ loggedIn: false }) }) }));
    expect(rowOf(list, "quick-fix").done).toBe(true);
    expect(rowOf(list, "ai-cli").done).toBe(false);
  });
});

describe("the list", () => {
  it("counts the rows that are done and names the next one: the only filled button", () => {
    const fresh = checklist(ready({ health: health({ cli: claude({ installed: false, loggedIn: false }), git: { ok: false, version: "git version 2.37.1" } }), repos: [] }));
    expect([fresh.doneCount, fresh.next, fresh.rows.map((entry) => entry.id)]).toEqual([0, "ai-cli", ["ai-cli", "git", "repo", "quick-fix"]]);
    const partly = checklist(ready({ health: health({ cli: claude({ loggedIn: false }) }) }));
    expect([partly.doneCount, partly.next]).toEqual([2, "ai-cli"]);
    const set = checklist(ready());
    expect([set.doneCount, set.next]).toEqual([3, "quick-fix"]);
    const all = checklist(ready({ started: true }));
    expect([all.doneCount, all.next]).toEqual([4, undefined]);
  });

  it("says what the list is for, and when everything is set up", () => {
    expect(checklist(ready()).subtitle).toBe("Four steps to your first change. The list updates by itself as you go.");
    expect(checklist(ready({ started: true })).subtitle).toBe("Everything is set up. If a step breaks later, its row shows the fix.");
  });

  it("keeps the four titles whatever the state", () => {
    const titles = ["Set up an AI CLI", "Install git 2.38 or newer", "Add your first repo", "Start a Quick fix"];
    for (const input of [ready(), ready({ health: undefined, repos: [] }), ready({ started: true, mac: false })]) expect(checklist(input).rows.map((entry) => entry.title)).toEqual(titles);
  });

  it("uses glyph and word on every row, so colour is never the only signal", () => {
    for (const input of [ready(), ready({ health: undefined, repos: [] }), ready({ checking: true })]) {
      for (const entry of checklist(input).rows) expect([entry.mark.symbol, entry.word]).not.toContain("");
    }
  });
});
