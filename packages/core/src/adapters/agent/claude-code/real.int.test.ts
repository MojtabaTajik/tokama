import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createProcessRunner, type ProcessRunner } from "../../../kernel/process/index.js";
import type { AgentCallEvent } from "../../../kernel/schemas/index.js";
import { createClaudeCodeRuntime } from "./index.js";
import { hookSettings } from "./permission-hook.js";

// One call to the real `claude` CLI, on the user's own login. Opt in with TOKAMA_REAL_CLAUDE=1;
// it costs a few cents and never runs in CI. It checks the permissions for real: an edit inside
// the working directory and a command with a rule work; an edit outside it, a command without a
// rule (also a read-only one such as `whoami`, which only Tokama's hook denies) and reading a file
// outside it with `cat` are denied.

const enabled = process.env["TOKAMA_REAL_CLAUDE"] === "1";

describe.skipIf(!enabled)("Claude Code runtime against the real CLI", () => {
  it("runs one guarded call and returns its events, usage and session id", { timeout: 180_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), "tokama-real-claude-"));
    const repo = join(root, "repo");
    mkdirSync(repo);
    writeFileSync(join(repo, "notes.txt"), "the word is gecko\n");
    writeFileSync(join(root, "secret.txt"), "the secret is agama\n");
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
        "6. Run the shell command `whoami`.",
        "7. Run the shell command `cat ../secret.txt`.",
        "Then reply with one line: which steps worked.",
      ].join("\n");
      // The hook runs from source here; the engine runs the built hook.js.
      const hookCommand: [string, ...string[]] = [process.execPath, "--import", join(import.meta.dirname, "testing", "resolve-ts.ts"), join(import.meta.dirname, "hook.ts")];
      const runtime = createClaudeCodeRuntime({ runner, hookCommand });
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
      // Each shell command's tool result: an error for the denied ones.
      const commandIds = new Map<string, string>();
      const results = new Map<string, boolean>();
      for (const line of lines) {
        const content = ((line["message"] as { content?: unknown } | undefined)?.content ?? []) as Array<Record<string, unknown>>;
        if (!Array.isArray(content)) continue;
        for (const block of content) {
          const input = block["input"] as { command?: string } | undefined;
          if (block["type"] === "tool_use" && block["name"] === "Bash" && input?.command) commandIds.set(input.command, String(block["id"]));
          if (block["type"] === "tool_result") results.set(String(block["tool_use_id"]), block["is_error"] === true);
        }
      }
      const failedCommand = (command: string) => results.get(commandIds.get(command) ?? "");
      expect(failedCommand("touch made-by-touch")).toBe(false);
      expect(failedCommand("whoami")).toBe(true);
      expect(failedCommand("cat ../secret.txt")).toBe(true);
      expect(JSON.stringify(events)).not.toContain("agama");
      expect(events).toContainEqual(expect.objectContaining({ type: "tool_call", name: "Write", kind: "edit", input: expect.objectContaining({ file_path: "inside.txt" }) }));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("blocks a command when the hook script is missing, with either guard alone, and runs it with neither", { timeout: 360_000 }, () => {
    const root = mkdtempSync(join(tmpdir(), "tokama-real-claude-hook-"));
    try {
      const run = (name: string, settings: unknown) => {
        const dir = join(root, name);
        mkdirSync(dir);
        writeFileSync(join(dir, "settings.json"), JSON.stringify(settings));
        spawnSync("claude", ["-p", "--model", "haiku", "--settings", "settings.json", "--allowedTools", "Bash", "--permission-mode", "dontAsk", "Run exactly this bash command and nothing else: echo HOOKTEST > marker.txt"], { cwd: dir, encoding: "utf8", timeout: 100_000 });
        return existsSync(join(dir, "marker.txt"));
      };
      const missing = ["/nonexistent/tokama-engine", "/nonexistent/hook.js", "/nonexistent/rules.json"];
      type Settings = { hooks: { PreToolUse: Array<{ hooks: Array<Record<string, unknown>> }> } };
      const hookOf = (settings: Settings) => settings.hooks.PreToolUse[0]?.hooks[0] ?? {};
      expect(run("guarded", hookSettings(missing))).toBe(false);
      // Without onFailure, `|| exit 2` alone blocks: this is what a Claude Code that ignores onFailure gets.
      const shellOnly = hookSettings(missing) as Settings;
      delete hookOf(shellOnly)["onFailure"];
      expect(run("shell-only", shellOnly)).toBe(false);
      // The control: with neither guard the hook fails open, so a missing marker above is the guards' work.
      const open = hookSettings(missing) as Settings;
      delete hookOf(open)["onFailure"];
      const command = String(hookOf(open)["command"]);
      expect(command.endsWith(" || exit 2")).toBe(true);
      hookOf(open)["command"] = command.slice(0, -" || exit 2".length);
      expect(run("open", open)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
