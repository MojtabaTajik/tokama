// Command-line entry of the engine service: `node dist/main.js [--dir <engine dir>] [--home <dir>] [--sample]`.
// `--home` is Tokama's home folder, where items are stored (default `~/.tokama`).
// `--sample` starts the fake engine mode with the sample data set (sample/sample.ts); it stores no
// items, but repo changes still go to `<home>/repos.yaml`.
// SIGINT and SIGTERM abort one root controller, which shuts the engine down gracefully;
// a second signal ends the process at once (default handling).
// Exit codes: 0 stopped (also when stopped while starting), 1 failed to start, 2 usage error, 3 an engine is already running.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { defaultEngineDir } from "@tokama/core";
import type { EngineDiagnostics } from "./diagnostics.js";
import { startEngine } from "./engine.js";

const log = (message: string) => process.stderr.write(`tokama-engine: ${message}\n`);

/** This engine's version, from its package.json; "0.0.0" when it cannot be read. */
function engineVersion(): string {
  try {
    const parsed: unknown = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return typeof parsed === "object" && parsed !== null && "version" in parsed && typeof parsed.version === "string" ? parsed.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

let diagnostics: EngineDiagnostics | undefined;
// An error nothing caught ends the process as before; the monitor only records it first. The
// write is synchronous, and the crash marker stays, so the next start records a crash too.
process.on("uncaughtExceptionMonitor", (error, origin) => {
  diagnostics?.store.error("engine", origin === "unhandledRejection" ? "unhandled_rejection" : "uncaught", error);
});

async function main(): Promise<number> {
  let dir: string;
  let home: string;
  let sample: boolean;
  try {
    const { values } = parseArgs({ options: { dir: { type: "string" }, home: { type: "string" }, sample: { type: "boolean" } }, strict: true });
    dir = values.dir ?? defaultEngineDir(process.env, homedir());
    home = values.home ?? join(homedir(), ".tokama");
    sample = values.sample ?? false;
  } catch (error) {
    log(String(error));
    return 2;
  }

  const root = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => root.abort());

  // Claude Code's session logs, read only for the "all on this Mac" usage view; never in sample mode.
  const claudeLogs = sample ? undefined : join(homedir(), ".claude", "projects");
  // Fake engine mode only: TOKAMA_SAMPLE_HISTORY=200 adds a long history of finished items.
  const history = sample ? Math.min(1500, Math.max(0, Number.parseInt(process.env["TOKAMA_SAMPLE_HISTORY"] ?? "0", 10) || 0)) : 0;
  const started = await startEngine({ dir, home, signal: root.signal, log, sample, sampleHistory: history, engineVersion: engineVersion(), onDiagnostics: (opened) => (diagnostics = opened), ...(claudeLogs !== undefined && { claudeLogs }) });
  if (!started.ok) {
    log(started.error.message);
    if (started.error.code === "stopped") return 0;
    return started.error.code === "already_running" ? 3 : 1;
  }
  await started.value.closed;
  return 0;
}

process.exitCode = await main();
