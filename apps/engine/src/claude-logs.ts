// Claude Code's usage on this machine, for the `all` usage scope: the engine reads Claude Code's
// session logs in the background and keeps the numbers in the index. The first scan reads every
// log; later scans read only what was added. A query never waits for a scan: it answers with what
// is stored and the scan's progress, and `onChange` tells clients to ask again.
//
// The reader is Claude Code's adapter, looked up by name: the adapter may have been removed.
// Project folders are matched to repos after each scan, so a repo added later counts from the
// next scan on; the index keeps the match by a hash of each folder name, never the name.
import { realpath } from "node:fs/promises";
import { adapters, type Clock, type LogScan, pricedEntry, rangeStart, type RepoId, type UsageEntry } from "@tokama/core";
import type { ItemIndex, LocalMessage } from "./item-index.js";

interface Mark {
  readonly ino: number;
  readonly offset: number;
}

interface RepoPaths {
  readonly id: string;
  readonly paths: readonly string[];
  readonly worktreeFolder: string;
}

type Scan = (options: {
  root: string;
  since: number;
  mark: (fileKey: string) => Mark | undefined;
  onFile: (fileKey: string, mark: Mark, messages: readonly LocalMessage[]) => void;
  onProgress: (done: number, total: number) => void;
  signal?: AbortSignal;
}) => Promise<{ found: boolean; complete: boolean; files: number; skippedFiles: number; skippedLines: number; fileKeys: readonly string[]; projects: ReadonlyMap<string, string> }>;
type RepoOf = (folder: string, repos: readonly RepoPaths[]) => string | undefined;

export interface ClaudeLogsDeps {
  readonly index: ItemIndex;
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
  private readonly scan: Scan | undefined;
  private readonly repoOf: RepoOf | undefined;
  private running: Promise<void> | undefined;
  private endedAt: number | undefined;
  private progress = { done: 0, total: 0 };
  private note: string | undefined;
  private found = true;
  /** Project folder names by hash, from the last scan: in memory only. */
  private projects: ReadonlyMap<string, string> = new Map();

  constructor(private readonly deps: ClaudeLogsDeps) {
    const factories: Record<string, unknown> = { ...adapters };
    this.scan = factories["scanClaudeLogs"] as Scan | undefined;
    this.repoOf = factories["repoOfProject"] as RepoOf | undefined;
  }

  /** Starts a scan when none ran yet or the last one is old; never waits for it. */
  refresh(): void {
    if (this.scan === undefined || this.running !== undefined || this.deps.signal?.aborted) return;
    const now = this.deps.clock.now();
    if (this.endedAt !== undefined && now - this.endedAt < (this.deps.scanEveryMs ?? SCAN_EVERY_MS)) return;
    this.running = this.run(this.scan, now).finally(() => {
      this.running = undefined;
      this.deps.onChange();
    });
  }

  status(): LogScan {
    if (this.scan === undefined) return { state: "unavailable", filesDone: 0, filesTotal: 0, note: "The Claude Code adapter is not part of this engine." };
    const base = { filesDone: this.progress.done, filesTotal: this.progress.total, ...(this.endedAt !== undefined && { asOf: this.endedAt }) };
    if (this.running !== undefined || this.endedAt === undefined) return { state: "scanning", ...base };
    if (!this.found) return { state: "unavailable", ...base, note: "Claude Code has no session logs on this Mac yet." };
    return { state: "ready", ...base, ...(this.note !== undefined && { note: this.note }) };
  }

  /** Claude Code's usage since `since`, per day, model and repo, priced from the table. */
  entries(since: number): UsageEntry[] {
    if (this.scan === undefined) return [];
    return this.deps.index.localDays(since).map((row) =>
      pricedEntry({ day: row.day, model: row.model, cliId: "claude-code", repoId: row.repoId, tokens: row.tokens, calls: row.messages }),
    );
  }

  /** The time from which the logs hold Claude Code's calls; undefined while they hold none. */
  coveredFrom(): number | undefined {
    return this.scan === undefined ? undefined : this.deps.index.localCoveredFrom();
  }

  /** Waits for a scan in flight; for tests and shutdown. */
  async settled(): Promise<void> {
    await this.running;
  }

  private async run(scan: Scan, now: number): Promise<void> {
    const { index, signal } = this.deps;
    const since = rangeStart(now, KEEP_DAYS);
    let lastProgress = now;
    try {
      const result = await scan({
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
      this.projects = result.projects;
      this.note = result.skippedFiles > 0 ? `${result.skippedFiles} of Claude Code's log files could not be read: too large, a link, or unreadable.` : undefined;
      await this.matchRepos();
    } catch (error) {
      this.note = "Claude Code's logs could not be read this time.";
      this.deps.log?.(`reading Claude Code's logs failed: ${error instanceof Error ? error.name : "error"}`);
    } finally {
      this.endedAt = this.deps.clock.now();
    }
  }

  private async matchRepos(): Promise<void> {
    const repoOf = this.repoOf;
    if (repoOf === undefined) return;
    const repos: RepoPaths[] = [];
    for (const repo of await this.deps.repos()) {
      const real = await realpath(repo.path).catch(() => repo.path);
      repos.push({ id: repo.id, paths: real === repo.path ? [repo.path] : [repo.path, real], worktreeFolder: repo.worktreeFolder });
    }
    this.deps.index.saveLocalProjects(new Map([...this.projects].map(([project, folder]) => [project, repoOf(folder, repos) ?? null])));
  }
}
