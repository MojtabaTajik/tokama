import { totalmem } from "node:os";
import { err, ok, type Result } from "../result/index.js";
import type { ProcessRunner } from "../process/index.js";
import type { MachineSource, MemoryReading, ProcessReading } from "./types.js";

/** `ps` prints CPU time as `M:SS.cc` (minutes can pass 59), and as `H:MM:SS` or `D-HH:MM:SS` on other builds. */
export function parseCpuTime(text: string): number | undefined {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(text);
  if (match === null) return undefined;
  const [, days = "0", middle, minutes, seconds] = match;
  // `H:MM:SS` has two colons: the optional group then holds the hours. With one colon it is absent.
  const hours = middle === undefined ? 0 : Number(middle);
  return Math.round((((Number(days) * 24 + hours) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000);
}

/** Parses `ps -A -o pid= -o ppid= -o pgid= -o rss= -o time=`. rss is in KiB. Lines that do not fit are skipped. */
export function parsePs(output: string): ProcessReading[] {
  const rows: ProcessReading[] = [];
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
    if (match === null) continue;
    const cpuMs = parseCpuTime(match[5] ?? "");
    if (cpuMs === undefined) continue;
    const row = { pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), cpuMs, rssBytes: Number(match[4]) * 1024 };
    if (Object.values(row).every(Number.isSafeInteger)) rows.push(row);
  }
  return rows;
}

/**
 * Parses `vm_stat`. Used memory follows Activity Monitor: app memory (anonymous pages without the
 * purgeable ones), wired memory and the compressor.
 */
export function parseVmStat(output: string, totalBytes: number): MemoryReading | undefined {
  const page = /page size of (\d+) bytes/.exec(output);
  const pages = new Map<string, number>();
  for (const line of output.split("\n")) {
    const match = /^([^:]+):\s+(\d+)\.\s*$/.exec(line);
    if (match !== null) pages.set(match[1] ?? "", Number(match[2]));
  }
  const anonymous = pages.get("Anonymous pages");
  const purgeable = pages.get("Pages purgeable");
  const wired = pages.get("Pages wired down");
  const compressor = pages.get("Pages occupied by compressor");
  if (page === null || anonymous === undefined || purgeable === undefined || wired === undefined || compressor === undefined) return undefined;
  const used = (Math.max(0, anonymous - purgeable) + wired + compressor) * Number(page[1]);
  return { totalBytes, usedBytes: Math.min(used, totalBytes) };
}

/** More rows than this are refused: no real process table is this long. */
const MAX_LINES = 20_000;

/** The process runner starts the two commands; it passes only allowlisted environment variables. */
export function createMacosSource(runner: ProcessRunner, total: () => number = totalmem): MachineSource {
  const capture = async (argv: [string, ...string[]], signal: AbortSignal | undefined): Promise<Result<string, string>> => {
    const lines: string[] = [];
    let tooLong = false;
    const result = await runner.run({
      command: { argv },
      cwd: "/",
      env: { LC_ALL: "C" },
      timeoutMs: 10_000,
      stdout: { onLine: (line) => (lines.length < MAX_LINES ? lines.push(line) : (tooLong = true)) },
      ...(signal !== undefined && { signal }),
    });
    if (result.kind === "not-started") return err(`${argv[0]} did not start: ${result.message}`);
    if (result.exitCode !== 0) return err(`${argv[0]} failed${result.timedOut ? " (timed out)" : ` with code ${String(result.exitCode)}`}`);
    if (tooLong) return err(`${argv[0]} printed more than ${MAX_LINES} lines`);
    return ok(lines.join("\n"));
  };
  return {
    async memory(signal) {
      const text = await capture(["/usr/bin/vm_stat"], signal);
      if (!text.ok) return text;
      const reading = parseVmStat(text.value, total());
      return reading === undefined ? err("vm_stat gave output in an unknown form") : ok(reading);
    },
    async processes(signal) {
      const text = await capture(["/bin/ps", "-A", "-o", "pid=", "-o", "ppid=", "-o", "pgid=", "-o", "rss=", "-o", "time="], signal);
      return text.ok ? ok(parsePs(text.value)) : text;
    },
  };
}
