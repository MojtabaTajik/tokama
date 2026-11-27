// What one AI CLI (Claude Code, Codex CLI, ...) gives the engine, as one object. The engine lists
// the adapters it was built with and loops over them; it never looks a CLI up by name.
import type { ProcessRunner } from "../process/index.js";
import { type AiCliId, AiCliIdSchema, type CliHealth, type PlanReading, type TokenUsage } from "../schemas/index.js";
import type { Result } from "../result/index.js";
import type { AgentRuntime } from "./index.js";

/** What a call on this CLI runs, for the AI CLIs page: argument groups with placeholders, never values. */
export interface AiCliLaunch {
  /** The executable, looked up on the allowlisted PATH. */
  readonly command: string;
  readonly headlessArgs: readonly string[];
  readonly modelArgs: readonly string[];
  /** For a read-only step. A step that may edit, run commands or use the web adds tools and rules. */
  readonly permissionArgs: readonly string[];
  /** Where the step's prompt goes. The agent's role is an argument. */
  readonly promptVia: "stdin" | "argument";
  readonly roleArgs: readonly string[];
  /** Names only. These are the only variables the CLI gets from Tokama's own environment. */
  readonly envNames: readonly string[];
}

/** One assistant message's usage, from a CLI's own session logs. */
export interface LocalUsageMessage {
  /** Counts the message once, in whichever log and however often it appears. */
  readonly key: string;
  readonly at: number;
  readonly model: string;
  /** A hash of the project folder's name: the folder name is a full path, so it is not kept. */
  readonly project: string;
  readonly tokens: TokenUsage;
}

/** Where the last read of a log file ended. */
export interface LogMark {
  readonly ino: number;
  readonly offset: number;
}

export interface LogScanOptions {
  readonly root: string;
  /** Messages before this time are skipped. */
  readonly since: number;
  /** The mark of each file read before, by file key. */
  readonly mark: (fileKey: string) => LogMark | undefined;
  /** Called once per file read, with its new mark and the messages found since the old one. */
  readonly onFile: (fileKey: string, mark: LogMark, messages: readonly LocalUsageMessage[]) => void;
  readonly signal?: AbortSignal;
}

export interface LogScanResult {
  /** False when the root folder does not exist or cannot be listed. */
  readonly found: boolean;
  /** False when the scan stopped early: `fileKeys` is then partial. */
  readonly complete: boolean;
  readonly files: number;
  readonly skippedFiles: number;
  readonly skippedLines: number;
  /** The key of every log file that exists now; marks of other files can go. */
  readonly fileKeys: readonly string[];
}

/** Reads every session log under the root from where its last read ended. */
export type LogScanFn = (options: LogScanOptions) => Promise<LogScanResult>;

export interface AiCliAdapter {
  readonly kind: "ai-cli";
  readonly id: AiCliId;
  /** The name people see: `Claude Code`. */
  readonly name: string;
  readonly description: string;
  /** What a person types in a terminal to sign in. */
  readonly loginCommand: string;
  readonly updateCommand?: string;
  /** The oldest version that runs everything Tokama asks of it. */
  readonly minimumVersion?: string;
  createRuntime(options: { runner: ProcessRunner; tokamaHome: string; closedDirs: readonly string[] }): AgentRuntime;
  /** Installed and logged in, read-only. */
  status(options: { runner: ProcessRunner; timeoutMs: number }): Promise<CliHealth>;
  launch(): AiCliLaunch;
  /** Plan windows. Absent: this CLI has no source. */
  readonly plan?: {
    /** Asks the CLI itself. Absent: never asked. */
    request?(signal?: AbortSignal): Promise<Result<PlanReading & { readonly version?: string }, string>>;
    /** Reads the CLI's cached copy of its last answer. */
    cache?(): Promise<Result<PlanReading, string>>;
  };
  /** Usage from the CLI's own session logs. Absent: the logs are not read. */
  readonly localUsage?: {
    /** The folder holding the logs, from the user's home folder. */
    root(home: string): string;
    scan: LogScanFn;
  };
}

const isAiCliAdapter = (value: unknown): value is AiCliAdapter => typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "ai-cli";

/**
 * The AI CLI adapters among `values` (the exports of `composition.ts`), in the order of
 * `AiCliIdSchema`. Other values are ignored. Two adapters with one id is a wiring mistake: it throws.
 */
export function collectAiCliAdapters(values: readonly unknown[]): readonly AiCliAdapter[] {
  const found = new Map<AiCliId, AiCliAdapter>();
  for (const value of values) {
    if (!isAiCliAdapter(value)) continue;
    if (found.has(value.id)) throw new Error(`Two AI CLI adapters have the id ${value.id}.`);
    found.set(value.id, value);
  }
  return AiCliIdSchema.options.flatMap((id) => found.get(id) ?? []);
}
