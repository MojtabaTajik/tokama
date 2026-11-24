// Command-line entry of the engine service: `node dist/main.js [--dir <engine dir>] [--sample]`.
// `--sample` starts the fake engine mode with the sample data set (sample/sample.ts).
// SIGINT and SIGTERM abort one root controller, which shuts the engine down gracefully;
// a second signal ends the process at once (default handling).
// Exit codes: 0 stopped, 1 failed to start, 2 usage error, 3 an engine is already running.
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { defaultEngineDir } from "@tokama/core";
import { startEngine } from "./engine.js";

const log = (message: string) => process.stderr.write(`tokama-engine: ${message}\n`);

async function main(): Promise<number> {
  let dir: string;
  let sample: boolean;
  try {
    const { values } = parseArgs({ options: { dir: { type: "string" }, sample: { type: "boolean" } }, strict: true });
    dir = values.dir ?? defaultEngineDir(process.env, homedir());
    sample = values.sample ?? false;
  } catch (error) {
    log(String(error));
    return 2;
  }

  const root = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => root.abort());

  const started = await startEngine({ dir, signal: root.signal, log, sample });
  if (!started.ok) {
    log(started.error.message);
    return started.error.code === "already_running" ? 3 : 1;
  }
  await started.value.closed;
  return 0;
}

process.exitCode = await main();
