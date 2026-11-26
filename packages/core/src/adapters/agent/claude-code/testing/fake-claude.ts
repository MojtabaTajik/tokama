// A fake `claude -p --input-format stream-json --output-format stream-json` for the adapter tests.
// It reads the stream-json user message on stdin; the prompt names the scenario.
//
// Fixtures: `success` (Claude Code 2.1.330 on a local model, plus a rate_limit_event in the shape
// 2.1.331 emits) and `logged-out` (2.1.331 with an empty config dir) are recorded and trimmed.
// `quota`, `rate-limited` and `execution-error` are constructed from those and from the error
// values the CLI uses, since a real quota or rate-limit failure cannot be produced on demand.
//
// `--version` prints FAKE_CLAUDE_VERSION (default "2.1.332 (Claude Code)"), or exits 3 with no
// output when it is `exit-3`.
//
// Run with `node fake-claude.ts <claude args...>`; Node runs the TypeScript as is.
import { spawn } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

const FIXTURES = join(import.meta.dirname, "fixtures");
const SESSION = "44444444-4444-4444-8444-444444444444";

const emit = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const replay = (name: string) => process.stdout.write(readFileSync(join(FIXTURES, `${name}.jsonl`), "utf8"));
const hang = () => setInterval(() => {}, 1_000);
const init = () => emit({ type: "system", subtype: "init", cwd: process.cwd(), session_id: SESSION, tools: [], model: "fake" });
const text = (value: string) => emit({ type: "assistant", message: { id: "msg_fake", content: [{ type: "text", text: value }] }, session_id: SESSION });
const success = () => emit({ type: "result", subtype: "success", is_error: false, result: "done", session_id: SESSION, usage: { input_tokens: 1, output_tokens: 1 } });

/** The `--settings` file, if any: its text, its folder's mode, and whether it is outside the cwd. */
function settings() {
  const path = process.argv.find((arg) => arg.startsWith("--settings="))?.slice("--settings=".length);
  if (path === undefined) return undefined;
  const folder = dirname(path);
  return { text: readFileSync(path, "utf8"), mode: statSync(folder).mode & 0o777, outside: !realpathSync(folder).startsWith(realpathSync(process.cwd())) };
}

const REPLAYS: Record<string, number> = { success: 0, "logged-out": 1, quota: 1, "rate-limited": 1, "execution-error": 1 };

function run(prompt: string): void {
  const exit = REPLAYS[prompt];
  if (exit !== undefined) {
    process.stdout.write("warning: a line that is not JSON\n");
    replay(prompt);
    process.exitCode = exit;
    return;
  }
  switch (prompt) {
    case "echo":
      init();
      text(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env: Object.keys(process.env).sort(), settings: settings() }));
      success();
      return;
    case "crash":
      init();
      process.stderr.write("Error: something broke\n");
      process.exitCode = 3;
      return;
    case "hang":
      init();
      hang();
      return;
    case "hang-with-child": {
      // A tool the agent started, in the same process group.
      const child = spawn("sleep", ["30"], { stdio: "ignore" });
      init();
      text(`child ${child.pid ?? 0}`);
      hang();
      return;
    }
    case "result-then-hang":
      replay("success");
      hang();
      return;
    case "error-then-hang":
      replay("logged-out");
      hang();
      return;
    case "trap-term":
      // Reports the SIGTERM it gets, as Claude Code stops its own tools on one.
      process.on("SIGTERM", () => {
        text("got SIGTERM");
        process.exit(143);
      });
      init();
      text("ready");
      hang();
      return;
    default:
      process.stderr.write(`fake-claude: unknown scenario "${prompt}"\n`);
      process.exitCode = 2;
  }
}

if (process.argv.includes("--version")) {
  const version = process.env["FAKE_CLAUDE_VERSION"] ?? "2.1.332 (Claude Code)";
  if (version === "exit-3") process.exit(3);
  process.stdout.write(`${version}\n`);
  process.exit(0);
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => (input += chunk));
process.stdin.on("end", () => {
  const message = JSON.parse(input.split("\n")[0] ?? "") as { message: { content: Array<{ text: string }> } };
  run(message.message.content[0]?.text ?? "");
});
