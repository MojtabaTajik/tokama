// The usage index in `<home>/tokama.db`, SQLite through Node's built-in node:sqlite: one row per
// recorded agent call. Only the engine writes it. The call rows are derived from the item logs, so
// the engine rebuilds them from the logs on every start, and a database of another schema version
// is simply recreated (version 3 only drops its old `items` table and keeps the rest). Plan
// samples (the windows an AI CLI reported on request) are kept only here: they are the CLI's data,
// read again when lost.
// Claude Code's usage from its session logs is a separate source (`claude_local_*`): numbers per
// message and where each log was read up to, never text or paths. The call rebuild leaves it
// alone; it is rebuilt by reading the logs again.
// Extension loading stays off (the default).
import { closeSync, constants, openSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  type AgentCallUsage,
  type AiCliId,
  localDate,
  type ItemId,
  type PlanReading,
  type RepoId,
  type StoredItem,
  type TokenUsage,
  type UsageRow,
} from "@tokama/core";

export const INDEX_SCHEMA_VERSION = 4;

// "items" stays so a database of version 1 or 2 loses that table too.

const TABLES = ["items", "usage_calls", "plan_samples", "claude_local_messages", "claude_local_files", "claude_local_projects"];

/** One message's usage from Claude Code's logs. */
export interface LocalMessage {
  /** Counts the message once, in whichever log and however often it appears. */
  readonly key: string;
  readonly at: number;
  readonly model: string;
  /** A hash of the project folder name. */
  readonly project: string;
  readonly tokens: TokenUsage;
}

/** Claude Code's usage per local day, model and project. */
export interface LocalDayRow {
  readonly day: string;
  readonly model: string;
  readonly project: string;
  /** Null: the project is outside the configured repos, or not matched yet. */
  readonly repoId: RepoId | null;
  readonly tokens: TokenUsage;
  readonly messages: number;
}

const CREATE = `
  CREATE TABLE usage_calls (
    call_id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL,
    title TEXT NOT NULL,
    template_ref TEXT NOT NULL,
    repo_id TEXT,
    ended_at INTEGER NOT NULL,
    record TEXT NOT NULL
  ) STRICT;
  CREATE INDEX usage_calls_ended_at ON usage_calls (ended_at);
  CREATE TABLE plan_samples (
    cli_id TEXT PRIMARY KEY,
    as_of INTEGER NOT NULL,
    record TEXT NOT NULL
  ) STRICT;
  CREATE TABLE claude_local_messages (
    key TEXT PRIMARY KEY,
    at INTEGER NOT NULL,
    day TEXT NOT NULL,
    model TEXT NOT NULL,
    project TEXT NOT NULL,
    input INTEGER NOT NULL,
    output INTEGER NOT NULL,
    cache_read INTEGER NOT NULL,
    cache_write INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX claude_local_messages_at ON claude_local_messages (at);
  CREATE TABLE claude_local_files (
    file_key TEXT PRIMARY KEY,
    ino INTEGER NOT NULL,
    offset INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE claude_local_projects (
    project TEXT PRIMARY KEY,
    repo_id TEXT
  ) STRICT;
`;

export class ItemIndex {
  private constructor(private readonly db: DatabaseSync) {}

  static open(file: string): ItemIndex {
    // Created 0600 before SQLite opens it; SQLite gives its -wal and -shm files the same mode.
    closeSync(openSync(file, constants.O_RDWR | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600));
    const db = new DatabaseSync(file);
    try {
      db.exec("PRAGMA journal_mode = WAL");
      const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
      if (version === 3) {
        // Only the items table is unused now; the plan samples and Claude Code usage stay.
        db.exec("BEGIN");
        db.exec("DROP TABLE IF EXISTS items");
        db.exec(`PRAGMA user_version = ${INDEX_SCHEMA_VERSION}`);
        db.exec("COMMIT");
      } else if (version !== INDEX_SCHEMA_VERSION) {
        db.exec("BEGIN");
        for (const table of TABLES) db.exec(`DROP TABLE IF EXISTS ${table}`);
        db.exec(CREATE);
        db.exec(`PRAGMA user_version = ${INDEX_SCHEMA_VERSION}`);
        db.exec("COMMIT");
      }
    } catch (error) {
      db.close();
      throw error;
    }
    return new ItemIndex(db);
  }

  /** Replaces every call row with rows for these items, in one transaction. */
  rebuild(items: readonly StoredItem[]): void {
    this.transaction(() => {
      this.db.exec("DELETE FROM usage_calls");
      for (const item of items) this.put(item);
    });
  }

  /** The recorded calls that ended at or after `since`, oldest first. */
  usageRows(since: number): UsageRow[] {
    const rows = this.db.prepare("SELECT item_id, title, template_ref, repo_id, record FROM usage_calls WHERE ended_at >= ? ORDER BY ended_at, call_id").all(since) as unknown as {
      item_id: string;
      title: string;
      template_ref: string;
      repo_id: string | null;
      record: string;
    }[];
    return rows.map((row) => ({
      itemId: row.item_id as ItemId,
      title: row.title,
      templateId: row.template_ref,
      ...(row.repo_id !== null && { repoId: row.repo_id as RepoId }),
      call: JSON.parse(row.record) as AgentCallUsage,
    }));
  }

  /** Where the last read of a Claude Code log ended. */
  localMark(fileKey: string): { ino: number; offset: number } | undefined {
    return this.db.prepare("SELECT ino, offset FROM claude_local_files WHERE file_key = ?").get(fileKey) as { ino: number; offset: number } | undefined;
  }

  /**
   * Stores what one read of a Claude Code log found, and where it ended, in one transaction. A
   * message seen before keeps one row: a later copy of it (the same message streamed further)
   * raises each count to the larger value, so a log read twice counts once.
   */
  saveLocalFile(fileKey: string, mark: { ino: number; offset: number }, messages: readonly LocalMessage[]): void {
    this.transaction(() => {
      const upsert = this.db.prepare(
        `INSERT INTO claude_local_messages (key, at, day, model, project, input, output, cache_read, cache_write) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET input = max(input, excluded.input), output = max(output, excluded.output),
           cache_read = max(cache_read, excluded.cache_read), cache_write = max(cache_write, excluded.cache_write)`,
      );
      for (const m of messages) upsert.run(m.key, m.at, localDate(m.at), m.model, m.project, m.tokens.input, m.tokens.output, m.tokens.cacheRead, m.tokens.cacheWrite);
      this.db.prepare("INSERT INTO claude_local_files (file_key, ino, offset) VALUES (?, ?, ?) ON CONFLICT (file_key) DO UPDATE SET ino = excluded.ino, offset = excluded.offset").run(fileKey, mark.ino, mark.offset);
    });
  }

  /** Forgets the marks of logs that are gone, and messages older than `before`. */
  pruneLocal(fileKeys: readonly string[] | undefined, before: number): void {
    this.transaction(() => {
      if (fileKeys !== undefined) {
        const keep = new Set(fileKeys);
        const drop = this.db.prepare("DELETE FROM claude_local_files WHERE file_key = ?");
        for (const { file_key } of this.db.prepare("SELECT file_key FROM claude_local_files").all() as { file_key: string }[]) if (!keep.has(file_key)) drop.run(file_key);
      }
      this.db.prepare("DELETE FROM claude_local_messages WHERE at < ?").run(before);
    });
  }

  /** Stores which repo each project hash belongs to (null: none), so it holds across restarts. */
  saveLocalProjects(repos: ReadonlyMap<string, string | null>): void {
    this.transaction(() => {
      const put = this.db.prepare("INSERT INTO claude_local_projects (project, repo_id) VALUES (?, ?) ON CONFLICT (project) DO UPDATE SET repo_id = excluded.repo_id");
      for (const [project, repoId] of repos) put.run(project, repoId);
    });
  }

  /** The time of the oldest message kept from the logs: Claude Code's calls before it are not in them. */
  localCoveredFrom(): number | undefined {
    const row = this.db.prepare("SELECT min(at) AS at FROM claude_local_messages").get() as { at: number | null };
    return row.at ?? undefined;
  }

  /** Claude Code's usage since `since`, summed per local day, model and project, with the project's repo. */
  localDays(since: number): LocalDayRow[] {
    const rows = this.db
      .prepare(
        `SELECT m.day, m.model, m.project, p.repo_id, sum(m.input) AS input, sum(m.output) AS output, sum(m.cache_read) AS cache_read, sum(m.cache_write) AS cache_write, count(*) AS messages
         FROM claude_local_messages m LEFT JOIN claude_local_projects p ON p.project = m.project
         WHERE m.at >= ? GROUP BY m.day, m.model, m.project ORDER BY m.day, m.model, m.project`,
      )
      .all(since) as unknown as { day: string; model: string; project: string; repo_id: string | null; input: number; output: number; cache_read: number; cache_write: number; messages: number }[];
    return rows.map((row) => ({
      day: row.day,
      model: row.model,
      project: row.project,
      repoId: row.repo_id as RepoId | null,
      tokens: { input: row.input, output: row.output, cacheRead: row.cache_read, cacheWrite: row.cache_write },
      messages: row.messages,
    }));
  }

  /** The last plan windows the AI CLI reported on request. */
  planSample(cliId: AiCliId): PlanReading | undefined {
    const row = this.db.prepare("SELECT record FROM plan_samples WHERE cli_id = ?").get(cliId) as { record: string } | undefined;
    return row === undefined ? undefined : (JSON.parse(row.record) as PlanReading);
  }

  savePlanSample(cliId: AiCliId, reading: PlanReading): void {
    this.db
      .prepare("INSERT INTO plan_samples (cli_id, as_of, record) VALUES (?, ?, ?) ON CONFLICT (cli_id) DO UPDATE SET as_of = excluded.as_of, record = excluded.record")
      .run(cliId, reading.asOf, JSON.stringify(reading));
  }

  close(): void {
    this.db.close();
  }

  /**
   * Writes the item's new call rows, or removes them once the item is deleted.
   * Returns how many calls were new.
   */
  put(item: StoredItem): number {
    if (item.deleted) {
      this.db.prepare("DELETE FROM usage_calls WHERE item_id = ?").run(item.id);
      return 0;
    }
    let added = 0;
    const insert = this.db.prepare("INSERT OR IGNORE INTO usage_calls (call_id, item_id, title, template_ref, repo_id, ended_at, record) VALUES (?, ?, ?, ?, ?, ?, ?)");
    const repoId = item.repoIds[0] ?? null;
    for (const call of item.calls ?? []) added += Number(insert.run(call.callId, item.id, item.title, item.templateRef, repoId, call.endedAt, JSON.stringify(call)).changes);
    return added;
  }

  private transaction(work: () => void): void {
    this.db.exec("BEGIN");
    try {
      work();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
