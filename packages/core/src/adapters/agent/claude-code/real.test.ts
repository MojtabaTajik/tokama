import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createProcessRunner, type ProcessRunner } from "../../../kernel/process/index.js";
import type { AgentCallEvent } from "../../../kernel/schemas/index.js";
import { createClaudeCodeRuntime } from "./index.js";

// One call to the real `claude` CLI, on the user's own login. Opt in with TOKAMA_REAL_CLAUDE=1;
// it costs a few cents and never runs in CI. It checks the permission flags for real: an edit
// inside the working directory and a command with a rule work; an edit outside it and a command
// without a rule are denied. (Claude Code itself allows commands it judges read-only, such as
// `ls` or `whoami`, without a rule, so the denied command here is one that writes.)

const enabled = process.env["TOKAMA_REAL_CLAUDE"] === "1";

describe.skipIf(!enabled)("Claude Code runtime against the real CLI", () => {
  it("runs one guarded call and returns its events, usage and session id", { timeout: 180_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), "tokama-real-claude-"));
    const repo = join(root, "repo");
    mkdirSync(repo);
    writeFileSync(join(repo, "notes.txt"), "the word is gecko\n");
    // The CLI's raw lines, to print what the events leave out (cost, denials).
    const raw: string[] = [];
    const base = createProcessRunner();
    const runner: ProcessRunner = {
      run: (request) =>
        base.run({
          ...request,
          stdout: {
            onLine: (line) => {
              raw.push(line);
              request.stdout?.onLine?.(line);
            },
          },
        }),
    };
    try {
      const events: AgentCallEvent[] = [];
      const prompt = [
        "Do these steps in order, each with one tool call, and do not retry a step that is denied:",
        "1. Read notes.txt.",
        "2. Create inside.txt containing the word from notes.txt.",
        "3. Create ../outside.txt containing the same word.",
        "4. Run the shell command `touch made-by-touch`.",
        "5. Run the shell command `mkdir made-by-mkdir`.",
        "Then reply with one line: which steps worked.",
      ].join("\n");
      const runtime = createClaudeCodeRuntime({ runner });
      for await (const event of runtime.launch(
        { model: "haiku", prompt, cwd: repo, role: "You are terse.", limits: { edit: true, commands: ["touch:*"], web: false }, timeoutMs: 150_000 },
        new AbortController().signal,
      )) {
        events.push(event);
      }
      const lines = raw.map((line) => JSON.parse(line) as Record<string, unknown>);
      const result = lines.find((line) => line["type"] === "result");
      const rateLimits = lines.filter((line) => line["type"] === "rate_limit_event");
      console.log(JSON.stringify({ events, cost: result?.["total_cost_usd"], denials: result?.["permission_denials"], rateLimits }, null, 2));

      const end = events.at(-1);
      if (end?.type !== "end") throw new Error("no end event");
      expect(events[0]?.type).toBe("started");
      expect(end.outcome).toBe("completed");
      expect(end.sessionId).toEqual(expect.any(String));
      expect(end.usage.output).toBeGreaterThan(0);
      expect(end.usage.input + end.usage.cacheRead + end.usage.cacheWrite).toBeGreaterThan(0);
      expect(existsSync(join(repo, "inside.txt"))).toBe(true);
      expect(existsSync(join(root, "outside.txt"))).toBe(false);
      expect(existsSync(join(repo, "made-by-touch"))).toBe(true);
      expect(existsSync(join(repo, "made-by-mkdir"))).toBe(false);
      expect(events).toContainEqual({ type: "edit", tool: "Write", path: "inside.txt" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
