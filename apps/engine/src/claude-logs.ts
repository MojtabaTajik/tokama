// Claude Code's usage on this machine, for the `all` usage scope: the engine reads Claude Code's
// session logs in the background and keeps the numbers in the index. The first scan reads every
// log; later scans read only what was added. A query never waits for a scan: it answers with what
// is stored and the scan's progress, and `onChange` tells clients to ask again.
//
// The reader is the log scan of an AI CLI adapter that has one, passed in by the engine.
// Project folders are matched to repos after each scan, so a repo added later counts from the
// next scan on; the index keeps the match by a hash of each folder name, never the name.
import { realpath } from "node:fs/promises";
import { type AiCliAdapter, type AiCliId, aiCliAdapters, type Clock, type LogScan, type LogScanFn, pricedEntry, rangeStart, type RepoId, type RepoOfFn, type RepoPaths, type TokenUsage, type UsageEntry } from "@tokama/core";
import type { ItemIndex } from "./item-index.js";
import { cliName } from "./real/clis.js";

/** The log scan of one AI CLI. */
export interface LogReader {
  readonly cliId: AiCliId;
  /** The folder holding the logs, from the user's home folder. */
  readonly root: (home: string) => string;
  readonly scan: LogScanFn;
  readonly repoOf: RepoOfFn;
}

/** The reader of the first adapter in `list` that has session logs; undefined when none has. */
export function logReader(list: readonly AiCliAdapter[] = aiCliAdapters): LogReader | undefined {
  for (const adapter of list) if (adapter.localUsage !== undefined) return { cliId: adapter.id, root: adapter.localUsage.root, scan: adapter.localUsage.scan, repoOf: adapter.localUsage.repoOf };
  return undefined;
}

export interface ClaudeLogsDeps {
  readonly index: ItemIndex;
  readonly reader: LogReader;
  /** Claude Code's projects folder, `~/.claude/projects`. */
  readonly root: string;
  /** The configured repos, to match project folders to. */
  readonly repos: () => Promise<readonly { readonly id: RepoId; readonly path: string; readonly worktreeFolder: string }[]>;
  readonly clock: Clock;
  readonly onChange: () => void;
  readonly log?: (message: string) => void;
  readonly signal?: AbortSignal;
  /** A query starts a new scan when the last one ended longer ago than this. Default: 1 minute. */
  readonly scanEveryMs?: number;
}

const SCAN_EVERY_MS = 60_000;
// While a scan runs, clients hear about its progress at most this often.
const PROGRESS_EVERY_MS = 2_000;
// The longest range a report covers, so older messages are not kept.
const KEEP_DAYS = 90;

export class ClaudeLogs {
  private running: Promise<void> | undefined;
  private endedAt: number | undefined;
  private progress = { done: 0, total: 0 };
  private note: string | undefined;
  private found = true;
  /** The last scan that ended read every log and found logs. A scan that runs now does not change it. */
  private completed = false;
  /** Project folder names by hash, from the last scan: in memory only. */
  private projects: ReadonlyMap<string, string> = new Map();

  constructor(private readonly deps: ClaudeLogsDeps) {}

  /** Starts a scan when none ran yet or the last one is old; never waits for it. */
  refresh(): void {
    if (this.running !== undefined || this.deps.signal?.aborted) return;
    const now = this.deps.clock.now();
    if (this.endedAt !== undefined && now - this.endedAt < (this.deps.scanEveryMs ?? SCAN_EVERY_MS)) return;
    this.running = this.run(now).finally(() => {
      this.running = undefined;
      this.deps.onChange();
    });
  }

  status(): LogScan {
    const base = { filesDone: this.progress.done, filesTotal: this.progress.total, ...(this.endedAt !== undefined && { asOf: this.endedAt }) };
    if (this.running !== undefined || this.endedAt === undefined) return { state: "scanning", ...base };
    if (!this.found) return { state: "unavailable", ...base, note: `${cliName(this.deps.reader.cliId)} has no session logs on this Mac yet.` };
    return { state: "ready", ...base, ...(this.note !== undefined && { note: this.note }) };
  }

  /** Claude Code's usage since `since`, per day, model and repo, priced from the table. */
  entries(since: number): UsageEntry[] {
    return this.deps.index.localDays(since).map((row) =>
      pricedEntry({ day: row.day, model: row.model, cliId: this.deps.reader.cliId, repoId: row.repoId, tokens: row.tokens, calls: row.messages }),
    );
  }

  /** Whether the last scan that ended read every log and found logs; a scan in progress does not undo it. */
  complete(): boolean {
    return this.completed;
  }

  /** The AI CLI whose logs these are. */
  get cliId(): AiCliId {
    return this.deps.reader.cliId;
  }

  /** Claude Code's tokens per model between two times, Tokama's own calls included. */
  totals(from: number, to: number): { model: string; tokens: TokenUsage }[] {
    return this.deps.index.localTotals(from, to);
  }

  /** The time from which the logs hold Claude Code's calls; undefined while they hold none. */
  coveredFrom(): number | undefined {
    return this.deps.index.localCoveredFrom();
  }

  /** Waits for a scan in flight; for tests and shutdown. */
  async settled(): Promise<void> {
    await this.running;
  }

  private async run(now: number): Promise<void> {
    const { index, signal } = this.deps;
    const since = rangeStart(now, KEEP_DAYS);
    let lastProgress = now;
    try {
      const result = await this.deps.reader.scan({
        root: this.deps.root,
        since,
        mark: (fileKey) => index.localMark(fileKey),
        onFile: (fileKey, mark, messages) => index.saveLocalFile(fileKey, mark, messages),
        onProgress: (done, total) => {
          this.progress = { done, total };
          const at = this.deps.clock.now();
          if (at - lastProgress >= PROGRESS_EVERY_MS) {
            lastProgress = at;
            this.deps.onChange();
          }
        },
        ...(signal !== undefined && { signal }),
      });
      index.pruneLocal(result.complete && result.found ? result.fileKeys : undefined, since);
      this.found = result.found;
      this.completed = result.complete && result.found;
      this.projects = result.projects;
      this.note = result.skippedFiles > 0 ? `${result.skippedFiles} of ${cliName(this.deps.reader.cliId)}'s log files could not be read: too large, a link, or unreadable.` : undefined;
      await this.matchRepos();
    } catch (error) {
      const name = cliName(this.deps.reader.cliId);
      this.completed = false;
      this.note = `${name}'s logs could not be read this time.`;
      this.deps.log?.(`reading ${name}'s logs failed: ${error instanceof Error ? error.name : "error"}`);
    } finally {
      this.endedAt = this.deps.clock.now();
    }
  }

  private async matchRepos(): Promise<void> {
    const repoOf = this.deps.reader.repoOf;
    const repos: RepoPaths[] = [];
    for (const repo of await this.deps.repos()) {
      const real = await realpath(repo.path).catch(() => repo.path);
      repos.push({ id: repo.id, paths: real === repo.path ? [repo.path] : [repo.path, real], worktreeFolder: repo.worktreeFolder });
    }
    this.deps.index.saveLocalProjects(new Map([...this.projects].map(([project, folder]) => [project, repoOf(folder, repos) ?? null])));
  }
}
