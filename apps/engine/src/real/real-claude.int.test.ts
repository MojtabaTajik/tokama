// One Quick fix through the engine API with the real `claude` CLI on the user's own login: a
// personal Builder on haiku fixes one line, Tokama runs the repo's check and commits. Opt in with
// TOKAMA_REAL_CLAUDE=1; it costs a few cents and never runs in CI.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@tokama/client";
import { type Agent, type AgentRuntime, cleanCliText, createProcessRunner, type HelperDefinition, type HelperRun, type ItemRecord, ok, type ProcessRunner, readAnswer } from "@tokama/core";
import { describe, expect, it } from "vitest";
import { startEngine } from "../engine.js";
import { tempEngineDir } from "../testing/helpers.js";
import { defaultRuntime } from "./real.js";

const enabled = process.env["TOKAMA_REAL_CLAUDE"] === "1";

describe.skipIf(!enabled)("real mode against the real Claude Code CLI", () => {
  it("runs Quick fix with haiku through the engine API and commits on the item branch", { timeout: 300_000 }, async () => {
    const cleanups: (() => unknown)[] = [];
    const root = realpathSync(mkdtempSync(join(tmpdir(), "tk-claude-")));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const home = join(root, "home");
    const repo = join(root, "orders-api");
    mkdirSync(join(home, "agents"), { recursive: true });
    mkdirSync(repo);
    const git = (...args: string[]) => {
      const run = spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
        cwd: repo,
        encoding: "utf8",
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
      });
      if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
      return run.stdout.trim();
    };
    try {
      writeFileSync(join(repo, "greeting.txt"), "helo world\n");
      writeFileSync(join(repo, "check.sh"), "grep -qx 'hello world' greeting.txt\n");
      git("init", "-q", "-b", "main");
      git("add", "-A");
      git("commit", "-q", "-m", "seed");
      // Tokama commits with the repo's identity.
      git("config", "user.name", "Test");
      git("config", "user.email", "test@example.com");
      writeFileSync(join(home, "repos.yaml"), `format: 1\nrepos:\n  - id: orders-api\n    path: ${repo}\n    base_branch: main\n    checks: ["sh check.sh"]\n`);
      // The personal Builder wins over the built-in one: the same role, on haiku.
      writeFileSync(join(home, "agents", "builder.md"), "---\nformat: 1\nname: Builder\nruns_on: claude-code\nmodel: haiku\ntools: edit\n---\nYou are Builder. Make the change the task asks for, in this worktree only. Do not commit.\n");

      // The CLI's result lines carry the cost, which the events leave out.
      let costUsd = 0;
      const plain = createProcessRunner();
      const runner: ProcessRunner = {
        run: (request) =>
          plain.run({
            ...request,
            stdout: {
              ...(request.stdout?.file !== undefined && { file: request.stdout.file }),
              onLine: (line) => {
                const cost = /"total_cost_usd":\s*([0-9.]+)/.exec(line)?.[1];
                if (cost !== undefined) costUsd += Number(cost);
                request.stdout?.onLine?.(line);
              },
            },
          }),
      };

      const dir = tempEngineDir(cleanups);
      const started = await startEngine({ dir, home, runner });
      if (!started.ok) throw new Error(started.error.message);
      cleanups.push(() => started.value.close());
      const connected = await connect({ dir, lockPath: started.value.endpoint.lockPath, startTimeoutMs: 2_000 });
      if (!connected.ok) throw new Error(connected.error.message);
      const client = connected.value;
      cleanups.push(() => client.close());

      const setup = await client.query({ type: "setup" });
      if (!setup.ok) throw new Error(setup.error.message);
      expect(setup.data.health.clis).toContainEqual(expect.objectContaining({ cliId: "claude-code", installed: true, loggedIn: true }));

      const reply = await client.command({ type: "start_item", templateId: "builtin/quick-fix", repoIds: ["orders-api"], text: "greeting.txt has a typo: it must say exactly `hello world`." });
      if (!reply.ok) throw new Error(reply.error.message);
      let item: ItemRecord | undefined;
      for (const deadline = Date.now() + 280_000; Date.now() < deadline; await new Promise((resolve) => setTimeout(resolve, 500))) {
        const current = await client.query({ type: "item", itemId: reply.data.itemId });
        if (!current.ok) throw new Error(current.error.message);
        item = current.data.item;
        if (item.state !== "running" && item.state !== "queued") break;
      }
      process.stdout.write(`real mode with claude: cost $${costUsd.toFixed(4)}, state ${item?.state}, attempts ${JSON.stringify(item?.steps[0]?.attempts)}\n`);
      expect(item?.state).toBe("done");
      const commit = item?.outcome?.commits?.[0]?.commit;
      expect(git("show", `${commit}:greeting.txt`)).toBe("hello world");
    } finally {
      for (const cleanup of cleanups.reverse()) await cleanup();
    }
  });

  // The helper's call runs in a folder inside the Tokama home, which the CLI is told not to read:
  // this checks that the CLI still starts and answers there.
  it("runs a helper on the built-in Helper agent (haiku) in the helper folder and gets a valid answer", { timeout: 120_000 }, async () => {
    const cleanups: (() => unknown)[] = [];
    const root = realpathSync(mkdtempSync(join(tmpdir(), "tk-claude-helper-")));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const home = join(root, "home");
    mkdirSync(home);
    const definition: HelperDefinition = {
      id: "suggest-checks",
      version: 1,
      name: "Suggest checks",
      inputs: ["repo-file-names", "repo-build-files"],
      maxTimeMs: 90_000,
      agentId: "helper" as HelperDefinition["agentId"],
      instructions: "Propose the commands that prove a change to this repository is correct. Use only commands that the build files show.",
      example: { checks: [{ command: "pnpm test", why: "Runs the unit tests.", minutes: 5 }] },
    };
    const gatherers = { "suggest-checks": async () => ok({ "repo-file-names": "package.json\nsrc/orders.ts\n", "repo-build-files": '{ "name": "orders-api", "scripts": { "test": "vitest run", "lint": "eslint ." } }' }) };
    try {
      const dir = tempEngineDir(cleanups);
      // Test only: shows each reply of the agent, cleaned, and what is wrong with it, so a failed run explains itself.
      const inner = defaultRuntime(createProcessRunner(), home, dir);
      const seen: string[] = [];
      const runtime = (agent: Agent): AgentRuntime | undefined => {
        const real = inner(agent);
        if (real === undefined) return undefined;
        return {
          async *launch(request, signal) {
            let last = "";
            for await (const event of real.launch(request, signal)) {
              if (event.type === "text") last = event.text;
              if (event.type === "end") {
                const problem = readAnswer(definition, last);
                const shown = cleanCliText(last, [[home, "~/.tokama"]], 1_500);
                seen.push(`try ${seen.length + 1}: ${problem.ok ? "valid" : JSON.stringify(problem.error)}; ended ${event.outcome}; reply ${JSON.stringify(shown)}`);
              }
              yield event;
            }
          },
        };
      };
      const started = await startEngine({ dir, home, planSources: {}, runtime, helpers: { definitions: [definition], gatherers } });
      if (!started.ok) throw new Error(started.error.message);
      cleanups.push(() => started.value.close());
      const connected = await connect({ dir, lockPath: started.value.endpoint.lockPath, startTimeoutMs: 2_000 });
      if (!connected.ok) throw new Error(connected.error.message);
      const client = connected.value;
      cleanups.push(() => client.close());

      const reply = await client.command({ type: "run_helper", run: { helperId: "suggest-checks", input: { path: "/work/orders-api" } }, cloud: "accepted" });
      if (!reply.ok) throw new Error(reply.error.message);
      let run: HelperRun | undefined;
      for (const deadline = Date.now() + 100_000; Date.now() < deadline && run?.state !== "done" && run?.state !== "failed"; await new Promise((resolve) => setTimeout(resolve, 300))) {
        const current = await client.query({ type: "helper_run", runId: reply.data.runId });
        if (current.ok) run = current.data.run;
      }
      process.stdout.write(`real helper: state ${run?.state}, usage ${JSON.stringify(run?.usage)}, error ${JSON.stringify(run?.error)}\n${seen.join("\n")}\n`);
      expect(run?.state).toBe("done");
      expect(run?.result?.value.checks.length).toBeGreaterThan(0);
      expect(readdirSync(join(home, "helper-scratch"))).toEqual([]);
    } finally {
      for (const cleanup of cleanups.reverse()) await cleanup();
    }
  });
});
