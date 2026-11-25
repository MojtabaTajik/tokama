// Tests only: a stand-in for an engine of an older API version, run as a real detached process
// from a file named like the engine entry (`.../engine/dist/main.js --dir <dir>`), so the identity
// check and the signals work on it as on a real one. Like an engine from before the shutdown
// request, it answers that request as a bad first message. It reports `runningItems` from the
// file `old-running` in its dir on each hello ("unknown": it does not say).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SCRIPT = String.raw`
const net = require("node:net"), fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const dir = process.argv[process.argv.indexOf("--dir") + 1];
const api = Number(process.env.OLD_API);
const note = (line) => fs.appendFileSync(path.join(dir, "old-engine.log"), line + "\n");
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const token = crypto.randomBytes(32).toString("hex");
fs.writeFileSync(path.join(dir, "engine.token"), token, { mode: 0o600 });
const socketPath = path.join(dir, "engine.sock");
try { fs.unlinkSync(socketPath); } catch {}
const running = () => { try { return fs.readFileSync(path.join(dir, "old-running"), "utf8").trim(); } catch { return "unknown"; } };
const server = net.createServer((socket) => {
  socket.on("error", () => {});
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk;
    const end = buffer.indexOf("\n");
    if (end < 0) return;
    let message = {};
    try { message = JSON.parse(buffer.slice(0, end)); } catch {}
    note("got " + message.kind);
    if (message.kind !== "hello") return socket.end(JSON.stringify({ kind: "connection_error", apiVersion: api, code: "bad_message", message: "the first message must be a hello" }) + "\n");
    const refusal = { kind: "connection_error", apiVersion: api, code: "unsupported_version", message: "engine speaks API version " + api + ", client sent " + message.apiVersion };
    if (running() !== "unknown") refusal.runningItems = Number(running());
    socket.end(JSON.stringify(refusal) + "\n");
  });
});
const stop = () => {
  server.close();
  for (const name of ["engine.lock", "engine.token", "engine.sock"]) try { fs.unlinkSync(path.join(dir, name)); } catch {}
  process.exit(0);
};
process.on("SIGTERM", () => { note("SIGTERM"); if (process.env.OLD_IGNORE_TERM !== "1") stop(); });
server.listen(socketPath, () => {
  fs.chmodSync(socketPath, 0o600);
  fs.writeFileSync(path.join(dir, "engine.lock"), process.pid + " old-" + process.pid + "\n", { mode: 0o600 });
  note("ready");
});
`;

export interface OldEngineOptions {
  /** Where the fake entry is written, as `<root>/apps/engine/dist/main.js`. */
  readonly root: string;
  readonly dir: string;
  readonly apiVersion: number;
  /** Items it reports; undefined: it does not say. */
  readonly runningItems?: number;
  /** Pass `--sample` after `--dir`, like the app's sample engine. */
  readonly sample?: boolean;
  /** It survives SIGTERM, so only SIGKILL stops it. */
  readonly ignoreTerm?: boolean;
}

/** Starts the fake engine and resolves to its pid once its lock is written. */
export async function startOldEngine(options: OldEngineOptions): Promise<number> {
  const entryDir = join(options.root, "apps", "engine", "dist");
  mkdirSync(entryDir, { recursive: true });
  // CommonJS whatever package.json may be above it.
  writeFileSync(join(entryDir, "package.json"), '{ "type": "commonjs" }\n');
  writeFileSync(join(entryDir, "main.js"), SCRIPT);
  mkdirSync(options.dir, { recursive: true, mode: 0o700 });
  setOldRunning(options.dir, options.runningItems);
  const child = spawn(process.execPath, [join(entryDir, "main.js"), "--dir", options.dir, ...(options.sample === true ? ["--sample"] : [])], {
    detached: true,
    stdio: "ignore",
    env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", OLD_API: String(options.apiVersion), ...(options.ignoreTerm === true && { OLD_IGNORE_TERM: "1" }) },
  });
  child.unref();
  const lockPath = join(options.dir, "engine.lock");
  const deadline = Date.now() + 10_000;
  while (!existsSync(lockPath)) {
    if (Date.now() > deadline) throw new Error("the old engine did not write its lock");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return Number.parseInt(readFileSync(lockPath, "utf8"), 10);
}

/** Changes how many items the fake engine reports from its next hello on. */
export function setOldRunning(dir: string, runningItems: number | undefined): void {
  writeFileSync(join(dir, "old-running"), runningItems === undefined ? "unknown" : String(runningItems));
}

/** What the fake engine noted: "ready", "got hello", "got shutdown", "SIGTERM". */
export function oldEngineNotes(dir: string): string[] {
  try {
    return readFileSync(join(dir, "old-engine.log"), "utf8").trim().split("\n");
  } catch {
    return [];
  }
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
