// Claude Code's usage on this machine, to split a plan limit between Tokama and the user's own
// sessions: the engine reads Claude Code's session logs in the background and keeps the numbers in
// the index. The first scan reads every log; later scans read only what was added. A query never
// waits for a scan: it answers with what is stored, and `onChange` tells clients to ask again.
//
// The reader is the log scan of an AI CLI adapter that has one, passed in by the engine.
import { type AiCliAdapter, type AiCliId, aiCliAdapters, type Clock, type LogScanFn, type TokenUsage } from "@tokama/core";
import type { ItemIndex } from "./item-index.js";
import { cliName } from "./real/clis.js";

/** The log scan of one AI CLI. */
export interface LogReader {
  readonly cliId: AiCliId;
  /** The folder holding the logs, from the user's home folder. */
  readonly root: (home: string) => string;
  readonly scan: LogScanFn;
}

/** The reader of the first adapter in `list` that has session logs; undefined when none has. */
export function logReader(list: readonly AiCliAdapter[] = aiCliAdapters): LogReader | undefined {
  for (const adapter of list) if (adapter.localUsage !== undefined) return { cliId: adapter.id, root: adapter.localUsage.root, scan: adapter.localUsage.scan };
  return undefined;
}

export interface ClaudeLogsDeps {
  readonly index: ItemIndex;
  readonly reader: LogReader;
  /** Claude Code's projects folder, `~/.claude/projects`. */
  readonly root: string;
  readonly clock: Clock;
  readonly onChange: () => void;
  readonly log?: (message: string) => void;
  readonly signal?: AbortSignal;
  /** A query starts a new scan when the last one ended longer ago than this. Default: 1 minute. */
  readonly scanEveryMs?: number;
}

const SCAN_EVERY_MS = 60_000;
// How far back the report looks, so older messages are not kept.
const KEEP_MS = 90 * 24 * 60 * 60_000;

export class ClaudeLogs {
  private running: Promise<void> | undefined;
  private endedAt: number | undefined;
  /** The last scan that ended read every log and found logs. A scan that runs now does not change it. */
  private completed = false;

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
    const since = now - KEEP_MS;
    try {
      const result = await this.deps.reader.scan({
        root: this.deps.root,
        since,
        mark: (fileKey) => index.localMark(fileKey),
        onFile: (fileKey, mark, messages) => index.saveLocalFile(fileKey, mark, messages),
        ...(signal !== undefined && { signal }),
      });
      index.pruneLocal(result.complete && result.found ? result.fileKeys : undefined, since);
      this.completed = result.complete && result.found;
    } catch (error) {
      const name = cliName(this.deps.reader.cliId);
      this.completed = false;
      this.deps.log?.(`reading ${name}'s logs failed: ${error instanceof Error ? error.name : "error"}`);
    } finally {
      this.endedAt = this.deps.clock.now();
    }
  }
}
