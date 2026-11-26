// Claude Code's usage on this machine, from its session logs: one JSON line per event in
// `~/.claude/projects/<project folder>/**/*.jsonl`, the folder named after the session's working
// folder. Only the usage fields of assistant messages are taken: the model, the four token counts,
// the time and an id to count each message once. Message text, tool inputs and tool outputs are
// parsed with the line and dropped at once: they are never kept, returned or logged.
//
// Read-only through fs-safe: real folders only (a link is skipped, never followed), no link as a
// file, a size cap per file and per line. Reads resume where the last read of a file ended.
import { homedir } from "node:os";
import { join, posix } from "node:path";
import { listFiles, listFolders, readLinesFrom } from "../../../kernel/fs-safe/index.js";
import { sha256Hex } from "../../../kernel/hash/index.js";
import { parseJsonLine } from "../../../kernel/json-line/index.js";
import type { TokenUsage } from "../../../kernel/schemas/index.js";

/** One assistant message's usage. */
export interface LoggedUsage {
  /** The request id, else the message id: the same message logged twice has the same key. */
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

export interface ScanLogsOptions {
  /** Default: `~/.claude/projects`. */
  readonly root?: string;
  /** Messages before this time are skipped. */
  readonly since: number;
  /** The mark of each file read before, by file key. */
  readonly mark: (fileKey: string) => LogMark | undefined;
  /** Called once per file read, with its new mark and the messages found since the old one. */
  readonly onFile: (fileKey: string, mark: LogMark, messages: readonly LoggedUsage[]) => void;
  /** Files done of the files found. */
  readonly onProgress?: (done: number, total: number) => void;
  /** Stops between files and between chunks of a file. */
  readonly signal?: AbortSignal;
  /** Default: 512 MiB. A larger file is skipped. */
  readonly maxFileBytes?: number;
  /** Default: 50,000 files; the rest are skipped. */
  readonly maxFiles?: number;
}

export interface ScanLogsResult {
  /** False when the root folder does not exist or cannot be listed. */
  readonly found: boolean;
  readonly files: number;
  /** Files refused: a link, too large, unreadable. */
  readonly skippedFiles: number;
  /** Lines skipped: too long, not UTF-8, not JSON, or an assistant line without valid usage. */
  readonly skippedLines: number;
  /** False when the scan stopped early: `fileKeys` is then partial. */
  readonly complete: boolean;
  /** The key of every log file that exists now; marks of other files can go. */
  readonly fileKeys: readonly string[];
  /** Project folder names by project hash, to match them to repos. Kept in memory only. */
  readonly projects: ReadonlyMap<string, string>;
}

const MAX_FILE_BYTES = 512 * 1024 * 1024;
// An assistant line holds the tool inputs the model wrote, a whole file for a write.
const MAX_LINE_BYTES = 16 * 1024 * 1024;
const MAX_FILES = 50_000;
const MAX_ENTRIES = 50_000;
// The session files of a project, and its subagents' files two folders down.
const MAX_DEPTH = 3;
const MAX_TOKENS = 1_000_000_000;
const MAX_ID = 200;

const hash = (text: string): string => sha256Hex(text, 32);

/** The hash a project folder is known by; the same for the same folder name. */
export const projectKey = (folder: string): string => hash(`project:${folder}`);

/**
 * The project folder name Claude Code gives a working folder: every character other than an
 * ASCII letter or digit becomes `-`, so `/Users/someone/orders-api` is `-Users-someone-orders-api`.
 */
export const claudeProjectFolder = (path: string): string => path.replace(/[^A-Za-z0-9]/g, "-");

export interface RepoPaths {
  readonly id: string;
  /** The repo's folder; also its real path when that differs. */
  readonly paths: readonly string[];
  /** The repo's worktree folder, relative to the repo, e.g. `.tokama-wt`. */
  readonly worktreeFolder: string;
}

/**
 * The repo a project folder belongs to: the repo's own folder, or a worktree in the repo's
 * worktree folder. A folder name cannot be decoded (`-` stands for `/`, `.` and `-` alike), so the
 * repos' paths are encoded and compared. Not a prefix match on the repo alone: that would give
 * `orders-api-v2` to `orders-api`. Undefined for any other folder.
 */
export function repoOfProject(folder: string, repos: readonly RepoPaths[]): string | undefined {
  for (const repo of repos) {
    for (const path of repo.paths) {
      if (folder === claudeProjectFolder(path)) return repo.id;
      const worktrees = claudeProjectFolder(join(path, repo.worktreeFolder));
      if (folder.startsWith(`${worktrees}-`) && folder.length > worktrees.length + 1) return repo.id;
    }
  }
  return undefined;
}

const count = (value: unknown): number | undefined =>
  value === undefined || value === null ? 0 : typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_TOKENS ? value : undefined;
const id = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 && value.length <= MAX_ID ? value : undefined);

/**
 * The usage of one log line, or undefined for a line that is not an assistant message with usage.
 * `bad` is true for a line that should have had usage but did not parse.
 */
export function parseLogLine(line: string, project: string): { usage?: LoggedUsage; bad?: true } {
  // Cheap checks first: most lines are user turns, tool output and bookkeeping.
  if (!line.includes('"type":"assistant"') || !line.includes('"usage"')) return {};
  const json = parseJsonLine(line);
  if (!json.ok) return { bad: true };
  const value = json.value;
  if (typeof value !== "object" || value === null) return { bad: true };
  const entry = value as { type?: unknown; timestamp?: unknown; requestId?: unknown; message?: unknown };
  if (entry.type !== "assistant") return {};
  const message = (typeof entry.message === "object" && entry.message !== null ? entry.message : {}) as { id?: unknown; model?: unknown; usage?: unknown };
  const usage = (typeof message.usage === "object" && message.usage !== null ? message.usage : undefined) as Record<string, unknown> | undefined;
  const key = id(entry.requestId) ?? id(message.id);
  const model = id(message.model);
  const at = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
  if (usage === undefined || key === undefined || model === undefined || !Number.isFinite(at)) return { bad: true };
  const input = count(usage["input_tokens"]);
  const output = count(usage["output_tokens"]);
  const cacheRead = count(usage["cache_read_input_tokens"]);
  const cacheWrite = count(usage["cache_creation_input_tokens"]);
  if (input === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined) return { bad: true };
  // Claude Code's own placeholder turns (an error shown as a message) used no tokens.
  if (input + output + cacheRead + cacheWrite === 0) return {};
  return { usage: { key, at, model, project, tokens: { input, output, cacheRead, cacheWrite } } };
}

/** Reads every session log under the root from where its last read ended. Never throws, except what the callbacks throw. */
export async function scanClaudeLogs(options: ScanLogsOptions): Promise<ScanLogsResult> {
  const root = options.root ?? join(homedir(), ".claude", "projects");
  const maxFiles = options.maxFiles ?? MAX_FILES;
  const folders = await listFolders(root, "", { max: MAX_ENTRIES });
  const projects = new Map<string, string>();
  if (!folders.ok) return { found: false, complete: true, files: 0, skippedFiles: 0, skippedLines: 0, fileKeys: [], projects };

  // Find the files first, so progress has a total.
  const files: { rel: string; project: string }[] = [];
  let skippedFiles = 0;
  const walk = async (rel: string, project: string, depth: number): Promise<void> => {
    const names = await listFiles(root, rel, { max: MAX_ENTRIES });
    if (names.ok) {
      for (const name of names.value) {
        if (!name.endsWith(".jsonl")) continue;
        if (files.length >= maxFiles) skippedFiles++;
        else files.push({ rel: posix.join(rel, name), project });
      }
    }
    if (depth >= MAX_DEPTH) return;
    const subs = await listFolders(root, rel, { max: MAX_ENTRIES });
    if (subs.ok) for (const sub of subs.value) await walk(posix.join(rel, sub), project, depth + 1);
  };
  for (const folder of folders.value) {
    if (options.signal?.aborted) break;
    const project = projectKey(folder);
    projects.set(project, folder);
    await walk(folder, project, 1);
  }

  let done = 0;
  let skippedLines = 0;
  const fileKeys: string[] = [];
  options.onProgress?.(0, files.length);
  for (const file of files) {
    if (options.signal?.aborted) break;
    const fileKey = hash(`file:${file.rel}`);
    fileKeys.push(fileKey);
    const messages: LoggedUsage[] = [];
    const resume = options.mark(fileKey);
    const read = await readLinesFrom(
      join(root, ...file.rel.split("/")),
      {
        maxFileBytes: options.maxFileBytes ?? MAX_FILE_BYTES,
        maxLineBytes: MAX_LINE_BYTES,
        // A log untouched since before the range holds nothing to count.
        modifiedSince: options.since,
        ...(resume !== undefined && { resume }),
        ...(options.signal !== undefined && { signal: options.signal }),
      },
      (line) => {
        const parsed = parseLogLine(line, file.project);
        if (parsed.bad) skippedLines++;
        else if (parsed.usage !== undefined && parsed.usage.at >= options.since) messages.push(parsed.usage);
      },
    );
    if (read.ok) {
      skippedLines += read.value.skipped;
      options.onFile(fileKey, { ino: read.value.ino, offset: read.value.end }, messages);
    } else {
      skippedFiles++;
    }
    options.onProgress?.(++done, files.length);
  }
  return { found: true, complete: options.signal?.aborted !== true, files: files.length, skippedFiles, skippedLines, fileKeys, projects };
}
