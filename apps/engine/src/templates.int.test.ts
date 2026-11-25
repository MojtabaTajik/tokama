// The templates and template_detail queries through the real client and socket.
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { connect, type EngineClient } from "@tokama/client";
import type { ProcessTable } from "@tokama/core";
import { afterEach, describe, expect, it } from "vitest";
import { startEngine } from "./engine.js";
import type { HealthChecks } from "./real/health.js";
import { tempEngineDir } from "./testing/helpers.js";

let cleanups: (() => unknown)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups = [];
});

const table: ProcessTable = { list: async () => [], bootTime: () => Date.UTC(2026, 10, 1), signalGroup: () => undefined };
const healthy: HealthChecks = async () => ({ git: { ok: true, version: "git version 2.54.0" }, clis: [{ cliId: "claude-code", installed: true, loggedIn: true }] });

async function client(options: { sample?: boolean; home?: string; dir?: string } = {}): Promise<EngineClient> {
  const dir = options.dir ?? tempEngineDir(cleanups);
  const started = await startEngine({ dir, processTable: table, checks: healthy, ...options });
  if (!started.ok) throw new Error(started.error.message);
  cleanups.push(() => started.value.close());
  const connected = await connect({ dir, startTimeoutMs: 2_000 });
  if (!connected.ok) throw new Error(connected.error.message);
  cleanups.push(() => connected.value.close());
  return connected.value;
}

describe("the templates queries in sample mode", () => {
  it("lists the sample templates with their problem counts", async () => {
    const reply = await (await client({ sample: true })).query({ type: "templates" });
    expect(reply.ok && reply.data.templates.map((entry) => [entry.ref, entry.problemCount, entry.openable])).toEqual([
      ["orders-api/plan-and-build", 0, false],
      ["checkout-web/flaky-test-fix", 2, false],
    ]);
  });

  it("gives one file in full", async () => {
    const reply = await (await client({ sample: true })).query({ type: "template_detail", origin: "checkout-web", file: ".tokama/templates/flaky-test-fix.yaml" });
    expect(reply.ok).toBe(true);
    if (!reply.ok) return;
    expect(reply.data.problems.map((problem) => problem.line)).toEqual([20, 24]);
    expect(reply.data.text).toContain("agent: reviewr");
    expect(reply.data.path).toBeNull();
  });

  it("answers not_found for a file it does not have", async () => {
    const reply = await (await client({ sample: true })).query({ type: "template_detail", origin: "orders-api", file: ".tokama/templates/gone.yaml" });
    expect(reply).toMatchObject({ ok: false, error: { code: "not_found" } });
  });
});

const GOOD = `format: 1
name: Docs fix
uses:
  repos: edit
start:
  needs: [text, repo]
steps:
  - id: fix
    name: Fix
    agent: builder
    instructions: Fix the docs.
    done_when: checks pass
    checks: from-repo
    if_failed: retry
    max_attempts: 2
    data: repo-and-diff
finish: [commit]
`;

describe("the templates queries in real mode", () => {
  it("serves a configured repo's templates, valid or not, and the built-ins, with the files' paths", async () => {
    const dir = tempEngineDir(cleanups);
    const root = realpathSync(dirname(dir));
    const home = join(root, "tokama");
    const repo = join(root, "billing-api");
    mkdirSync(join(repo, ".tokama", "templates"), { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    writeFileSync(join(repo, ".tokama", "templates", "docs-fix.yaml"), GOOD);
    writeFileSync(join(repo, ".tokama", "templates", "broken.yaml"), GOOD.replace("agent: builder", "agent: buildr"));
    writeFileSync(join(repo, ".tokama", "templates", "asks.yaml"), GOOD.replace("needs: [text, repo]", "needs: [text, repo]\n  ask_before_cloud: true"));
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "repos.yaml"), `format: 1\nrepos:\n  - id: billing-api\n    path: ${repo}\n    base_branch: main\n    checks: ["true"]\n`);
    const engine = await client({ dir, home });

    const list = await engine.query({ type: "templates" });
    if (!list.ok) throw new Error(list.error.message);
    const byFile = new Map(list.data.templates.map((entry) => [`${entry.origin}:${entry.file}`, entry]));
    expect(byFile.get("billing-api:.tokama/templates/docs-fix.yaml")).toMatchObject({ ref: "billing-api/docs-fix", name: "Docs fix", problemCount: 0, openable: true });
    expect(byFile.get("billing-api:.tokama/templates/broken.yaml")).toMatchObject({ problemCount: 1, openable: true });
    expect(byFile.get("builtin:builtin/quick-fix")).toMatchObject({ problemCount: 0, openable: false });

    const broken = await engine.query({ type: "template_detail", origin: "billing-api", file: ".tokama/templates/broken.yaml" });
    if (!broken.ok) throw new Error(broken.error.message);
    expect(broken.data.problems).toEqual([{ line: 10, message: expect.stringContaining('"buildr"') }]);
    expect(broken.data.path).toBe(join(repo, ".tokama", "templates", "broken.yaml"));

    // A template that loads but cannot start now says why.
    const asks = await engine.query({ type: "template_detail", origin: "billing-api", file: ".tokama/templates/asks.yaml" });
    expect(asks.ok && asks.data.warnings).toEqual([expect.stringContaining("asks before each cloud step")]);

    // An edit shows on the next query, without a restart.
    writeFileSync(join(repo, ".tokama", "templates", "broken.yaml"), GOOD);
    const fixed = await engine.query({ type: "template_detail", origin: "billing-api", file: ".tokama/templates/broken.yaml" });
    expect(fixed.ok && fixed.data.problems).toEqual([]);
    expect(fixed.ok && fixed.data.template?.steps.map((step) => step.doneWhen)).toEqual(["checks pass"]);
  });
});
