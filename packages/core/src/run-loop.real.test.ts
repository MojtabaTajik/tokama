import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as composition from "./composition.js";
import { createRunLoop, ItemStore, loadHostId, parseTemplateRecord, posixProcessTable, systemClock, type RepoId, type RunLoopDeps } from "./index.js";
import { createGit } from "./kernel/git/index.js";
import type { AgentRuntime } from "./kernel/ports/index.js";
import { createProcessRunner, type ProcessRunner } from "./kernel/process/index.js";

// One item through the run loop with the real `claude` CLI on the user's own login: a haiku agent
// fixes one line, Tokama runs the check and commits. Opt in with TOKAMA_REAL_CLAUDE=1; it costs a
// few cents and never runs in CI.
//
// The runtime comes from composition by name, so this test still type-checks when the adapter
// removal test deletes the Claude Code adapter.

const enabled = process.env["TOKAMA_REAL_CLAUDE"] === "1";
const factories: Record<string, unknown> = { ...composition };
const createRuntime = factories["createClaudeCodeRuntime"] as ((options: { runner: ProcessRunner }) => AgentRuntime) | undefined;

describe.skipIf(!enabled || createRuntime === undefined)("run loop against the real Claude Code CLI", () => {
  it("fixes a file with haiku, passes the check, and commits on the item branch", { timeout: 300_000 }, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "tokama-real-run-loop-")));
    const path = join(root, "orders-api");
    mkdirSync(path);
    const runner = createProcessRunner();
    const git = createGit({ runner });
    const plain = async (...args: string[]) => {
      const out: string[] = [];
      await runner.run({ command: { argv: ["git", ...args] }, cwd: path, stdout: { onLine: (line) => out.push(line) } });
      return out.join("\n");
    };
    try {
      writeFileSync(join(path, "greeting.txt"), "helo world\n");
      writeFileSync(join(path, "check.sh"), "grep -qx 'hello world' greeting.txt\n");
      await plain("init", "-q", "-b", "main");
      await plain("add", "-A");
      await plain("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "-m", "seed");
      await plain("config", "user.name", "Test");
      await plain("config", "user.email", "test@example.com");

      const repo = { id: "orders-api" as RepoId, path, baseBranch: "main", worktreeFolder: ".tokama/wt", checks: ["sh check.sh"] };
      const agent: ReturnType<RunLoopDeps["agent"]> & object = {
        id: "builder" as never,
        name: "Builder",
        cliId: "claude-code",
        model: "haiku",
        limits: { edit: true, commands: [], web: false },
        role: "You fix small problems in this repository.",
        owner: { kind: "builtin" },
      };
      const template = parseTemplateRecord({
        schemaVersion: 1,
        ref: "builtin/quick-fix",
        id: "quick-fix",
        source: { kind: "builtin" },
        name: "Quick fix",
        uses: { repos: { picked: "edit", named: [] }, connections: [], commands: [] },
        start: { needs: ["text", "repo"], askBeforeCloud: false, notify: false },
        finish: ["commit"],
        steps: [
          {
            id: "fix",
            name: "Fix",
            agentId: "builder",
            instructions: { text: "Make the change described below. Edit only greeting.txt." },
            doneWhen: "checks pass",
            checks: { from: "repo" },
            ifFailed: { action: "retry" },
            maxAttempts: 2,
            data: "repo-and-diff",
            sees: [],
            connections: [],
            commands: [],
          },
        ],
      });
      if (!template.ok) throw new Error(JSON.stringify(template.error));

      const home = join(root, "tokama");
      const hostId = loadHostId(home);
      if (!hostId.ok) throw new Error(hostId.error);
      const store = ItemStore.open({ home, hostId: hostId.value }).store;
      // The CLI's result lines carry the cost, which the events leave out.
      let costUsd = 0;
      const counting: ProcessRunner = {
        run: (request) =>
          runner.run({
            ...request,
            stdout: {
              onLine: (line) => {
                const cost = /"total_cost_usd":\s*([0-9.]+)/.exec(line)?.[1];
                if (cost !== undefined) costUsd += Number(cost);
                request.stdout?.onLine?.(line);
              },
            },
          }),
      };
      const loop = createRunLoop({
        store,
        git,
        runner,
        clock: systemClock,
        processes: posixProcessTable,
        repo: (id) => (id === repo.id ? repo : undefined),
        agent: () => agent,
        runtime: () => createRuntime!({ runner: counting }),
        guard: { turnCap: 30, repeatLimit: 6, idleMs: 0, timeoutMs: 180_000 },
      });
      const started = await loop.startItem({ template: template.value, repoId: repo.id, text: "greeting.txt has a typo: it must say exactly `hello world`." });
      if (!started.ok) throw new Error(started.error.message);
      await loop.settled(started.value);

      const item = store.get(started.value)!;
      process.stdout.write(`real run loop: cost $${costUsd.toFixed(4)}, attempts ${JSON.stringify(item.steps[0]?.attempts.map((a) => ({ result: a.result, failure: a.failure, detail: a.detail })))}\n`);
      expect(item.state).toBe("done");
      const commit = item.outcome?.commits?.[0]?.commit;
      expect(await plain("show", `${commit}:greeting.txt`)).toBe("hello world");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
