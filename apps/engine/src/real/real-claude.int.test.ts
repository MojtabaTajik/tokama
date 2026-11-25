// One Quick fix through the engine API with the real `claude` CLI on the user's own login: a
// personal Builder on haiku fixes one line, Tokama runs the repo's check and commits. Opt in with
// TOKAMA_REAL_CLAUDE=1; it costs a few cents and never runs in CI.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@tokama/client";
import { createProcessRunner, type ItemRecord, type ProcessRunner } from "@tokama/core";
import { describe, expect, it } from "vitest";
import { startEngine } from "../engine.js";
import { tempEngineDir } from "../testing/helpers.js";

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
      const connected = await connect({ dir, startTimeoutMs: 2_000 });
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
});
