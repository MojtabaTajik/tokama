// Claude Code PreToolUse hook: `node hook.js <rules.json>`, the tool call as JSON on stdin.
// Prints a deny for a Bash command the step's rules do not allow, and nothing otherwise.
// On any error it exits with code 2, which blocks the call.
import { readFileSync } from "node:fs";
import { hookReply } from "./permission-hook.js";

try {
  const rules: unknown = JSON.parse(readFileSync(process.argv[2] ?? "", "utf8"));
  const reply = hookReply(readFileSync(0, "utf8"), rules);
  if (reply !== undefined) process.stdout.write(reply);
} catch (error) {
  process.stderr.write(`Tokama denied the command: ${String(error)}\n`);
  process.exitCode = 2;
}
