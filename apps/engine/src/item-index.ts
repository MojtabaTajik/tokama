// The board index: one row per item in `<home>/tokama.db`, SQLite through Node's built-in
// node:sqlite. Only the engine writes it. It is derived from the item logs, so the engine rebuilds
// it from them on every start, and a database of another schema version is simply recreated.
// Extension loading stays off (the default).
import { closeSync, constants, openSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { openDecisions, type ItemId, type ItemState, type StoredItem, type TemplateRef } from "@tokama/core";

export const INDEX_SCHEMA_VERSION = 1;

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
        db.exec("DROP TABLE IF EXISTS items");
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

  /** Replaces every row with rows for these items, in one transaction. */
  rebuild(items: readonly StoredItem[]): void {
    this.transaction(() => {
      this.db.exec("DELETE FROM items");
      for (const item of items) this.put(item);
    });
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

  /** Writes the item's row, or removes it once the item is deleted. */
  put(item: StoredItem): void {
    if (item.deleted) {
      this.db.prepare("DELETE FROM items WHERE id = ?").run(item.id);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO items (id, schema_version, template_ref, state, updated_at, needs_you, last_seq) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET schema_version = excluded.schema_version, template_ref = excluded.template_ref,
           state = excluded.state, updated_at = excluded.updated_at, needs_you = excluded.needs_you, last_seq = excluded.last_seq`,
      )
      .run(item.id, INDEX_SCHEMA_VERSION, item.templateRef, item.state, item.updatedAt, openDecisions(item).length > 0 ? 1 : 0, item.lastSeq);
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
