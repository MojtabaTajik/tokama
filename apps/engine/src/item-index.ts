// The board and usage index in `<home>/tokama.db`, SQLite through Node's built-in node:sqlite:
// one row per item, and one row per recorded agent call. Only the engine writes it. Both are
// derived from the item logs, so the engine rebuilds them from the logs on every start, and a
// database of another schema version is simply recreated. Plan samples (the windows an AI CLI
// reported on request) are kept only here: they are the CLI's data, read again when lost.
// Extension loading stays off (the default).
import { closeSync, constants, openSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { type AgentCallUsage, type AiCliId, openDecisions, type ItemId, type ItemState, type PlanReading, type StoredItem, type TemplateRef, type UsageRow } from "@tokama/core";

export const INDEX_SCHEMA_VERSION = 2;

export interface IndexRow {
  readonly id: ItemId;
  readonly templateRef: TemplateRef;
  readonly state: ItemState;
  readonly updatedAt: number;
  readonly needsYou: boolean;
}

interface RawRow {
  id: string;
  template_ref: string;
  state: string;
  updated_at: number;
  needs_you: number;
}

const CREATE = `
  CREATE TABLE items (
    id TEXT PRIMARY KEY,
    schema_version INTEGER NOT NULL,
    template_ref TEXT NOT NULL,
    state TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    needs_you INTEGER NOT NULL,
    last_seq INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX items_updated_at ON items (updated_at DESC);
  CREATE TABLE usage_calls (
    call_id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL,
    title TEXT NOT NULL,
    template_ref TEXT NOT NULL,
    ended_at INTEGER NOT NULL,
    record TEXT NOT NULL
  ) STRICT;
  CREATE INDEX usage_calls_ended_at ON usage_calls (ended_at);
  CREATE TABLE plan_samples (
    cli_id TEXT PRIMARY KEY,
    as_of INTEGER NOT NULL,
    record TEXT NOT NULL
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
      if (version !== INDEX_SCHEMA_VERSION) {
        db.exec("BEGIN");
        for (const table of ["items", "usage_calls", "plan_samples"]) db.exec(`DROP TABLE IF EXISTS ${table}`);
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

  /** Replaces every item and call row with rows for these items, in one transaction. */
  rebuild(items: readonly StoredItem[]): void {
    this.transaction(() => {
      this.db.exec("DELETE FROM items");
      this.db.exec("DELETE FROM usage_calls");
      for (const item of items) this.put(item);
    });
  }

  /** The recorded calls that ended at or after `since`, oldest first. */
  usageRows(since: number): UsageRow[] {
    const rows = this.db.prepare("SELECT item_id, title, template_ref, record FROM usage_calls WHERE ended_at >= ? ORDER BY ended_at, call_id").all(since) as unknown as {
      item_id: string;
      title: string;
      template_ref: string;
      record: string;
    }[];
    return rows.map((row) => ({ itemId: row.item_id as ItemId, title: row.title, templateId: row.template_ref, call: JSON.parse(row.record) as AgentCallUsage }));
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

  /** Newest first. */
  list(): IndexRow[] {
    const rows = this.db.prepare("SELECT id, template_ref, state, updated_at, needs_you FROM items ORDER BY updated_at DESC, id").all() as unknown as RawRow[];
    return rows.map((row) => ({
      id: row.id as ItemId,
      templateRef: row.template_ref as TemplateRef,
      state: row.state as ItemState,
      updatedAt: row.updated_at,
      needsYou: row.needs_you === 1,
    }));
  }

  close(): void {
    this.db.close();
  }

  /**
   * Writes the item's row and its new call rows, or removes them once the item is deleted.
   * Returns how many calls were new.
   */
  put(item: StoredItem): number {
    if (item.deleted) {
      this.db.prepare("DELETE FROM items WHERE id = ?").run(item.id);
      this.db.prepare("DELETE FROM usage_calls WHERE item_id = ?").run(item.id);
      return 0;
    }
    let added = 0;
    const insert = this.db.prepare("INSERT OR IGNORE INTO usage_calls (call_id, item_id, title, template_ref, ended_at, record) VALUES (?, ?, ?, ?, ?, ?)");
    for (const call of item.calls ?? []) added += Number(insert.run(call.callId, item.id, item.title, item.templateRef, call.endedAt, JSON.stringify(call)).changes);
    this.db
      .prepare(
        `INSERT INTO items (id, schema_version, template_ref, state, updated_at, needs_you, last_seq) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET schema_version = excluded.schema_version, template_ref = excluded.template_ref,
           state = excluded.state, updated_at = excluded.updated_at, needs_you = excluded.needs_you, last_seq = excluded.last_seq`,
      )
      .run(item.id, INDEX_SCHEMA_VERSION, item.templateRef, item.state, item.updatedAt, openDecisions(item).length > 0 ? 1 : 0, item.lastSeq);
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
