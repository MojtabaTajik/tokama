// The work list's index: one row per item the engine serves, in an in-memory SQLite database
// (node:sqlite) that follows the engine's item store, in real and sample mode alike. It answers
// the item_list query: one group, a range of local days, the sidebar's repo or workflow, a search,
// and pages newest start first, keyed on (start time, id) so a page boundary inside one
// millisecond loses no row. Every value reaches SQL as a bound parameter; the search text is
// escaped for LIKE, so `%`, `_` and `\` match themselves. A `%text%` search cannot use an index and
// scans the rows of the group; the group, day and page order are index-backed. It also counts
// the done and failed items for the board query, which serves only the open items in full.
import { DatabaseSync } from "node:sqlite";
import { type BoardCount, type ItemId, type ItemRecord, type ItemState, type ListGroup, localDate, type RepoId, type Setup, type TemplateRef } from "@tokama/core";

/** The work-list group of an item state. A stopped item counts as done. */
export function groupOf(state: ItemState): ListGroup {
  switch (state) {
    case "needs_you":
      return "needs";
    case "failed":
      return "failed";
    case "done":
    case "stopped":
      return "done";
    case "queued":
    case "running":
      return "running";
  }
}

export interface ListQuery {
  readonly group: ListGroup;
  /** The first local day (`YYYY-MM-DD`) of done and failed items; live groups ignore it. */
  readonly since?: string | undefined;
  readonly repo?: string | undefined;
  readonly template?: string | undefined;
  /** The search text, as the engineer typed it. */
  readonly q?: string | undefined;
  /** The `nextCursor` of the page before. */
  readonly before?: string | undefined;
  readonly limit: number;
}

/** What else a search matches by name: template refs and agent ids whose names hold the text. */
export interface NameHits {
  readonly templates: readonly string[];
  readonly agents: readonly string[];
}

export const NO_NAME_HITS: NameHits = { templates: [], agents: [] };

/** The templates and agents of the setup whose names hold the search text, ignoring case. */
export function nameHits(setup: Pick<Setup, "templates" | "agents">, q: string | undefined): NameHits {
  const text = searchText(q);
  if (text === "") return NO_NAME_HITS;
  const holds = (name: string) => name.toLowerCase().includes(text);
  return {
    templates: setup.templates.filter((template) => holds(template.name)).map((template) => template.id),
    agents: setup.agents.filter((agent) => holds(agent.name)).map((agent) => agent.id),
  };
}

export interface ListPage {
  readonly ids: ItemId[];
  /** Null on the last page. */
  readonly nextCursor: string | null;
  /** Every matching item, on all pages. */
  readonly total: number;
  /** For done and failed pages: each local day on the page, with all its matching items counted. */
  readonly days: { day: string; count: number }[];
}

/** The search text as the index compares it: trimmed and lowercased. Empty means no search. */
export const searchText = (q: string | undefined): string => (q ?? "").trim().toLowerCase();

/** The text as a LIKE pattern that matches it anywhere, with `\` as the escape character. */
export const likePattern = (text: string): string => `%${text.replace(/[\\%_]/g, "\\$&")}%`;

// Repo and agent ids are kept between newlines, so `instr` finds a whole id only.
const between = (ids: readonly string[]): string => `\n${ids.join("\n")}\n`;

const CREATE = `
  CREATE TABLE list_items (
    id TEXT PRIMARY KEY,
    grp TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    day TEXT NOT NULL,
    template_ref TEXT NOT NULL,
    repos TEXT NOT NULL,
    agents TEXT NOT NULL,
    search TEXT NOT NULL
  ) STRICT;
  CREATE INDEX list_items_page ON list_items (grp, created_at DESC, id DESC);
  CREATE INDEX list_items_day ON list_items (grp, day);
`;

const CURSOR = /^(\d{1,16}):(item_[0-9a-f-]{36})$/;

export class ItemList {
  private constructor(private readonly db: DatabaseSync) {}

  static open(): ItemList {
    const db = new DatabaseSync(":memory:");
    db.exec(CREATE);
    return new ItemList(db);
  }

  /** Adds or replaces the item's row. The day is the local day the item started on. */
  put(item: ItemRecord): void {
    const agents = [...new Set(item.steps.flatMap((step) => (step.agentId === undefined ? [] : [step.agentId])))];
    const search = [item.title, ...item.repoIds, ...agents].join("\n").toLowerCase();
    this.db
      .prepare(
        `INSERT INTO list_items (id, grp, created_at, day, template_ref, repos, agents, search) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET grp = excluded.grp, created_at = excluded.created_at, day = excluded.day,
           template_ref = excluded.template_ref, repos = excluded.repos, agents = excluded.agents, search = excluded.search`,
      )
      .run(item.id, groupOf(item.state), item.createdAt, localDate(item.createdAt), item.templateId, between(item.repoIds), between(agents), search);
  }

  /** One page of the query. A cursor that is not one this index made reads as no cursor. */
  page(query: ListQuery, names: NameHits = NO_NAME_HITS): ListPage {
    const where = ["grp = ?"];
    const params: (string | number)[] = [query.group];
    if (query.since !== undefined && (query.group === "done" || query.group === "failed")) {
      where.push("day >= ?");
      params.push(query.since);
    }
    if (query.repo !== undefined) {
      where.push("instr(repos, ?) > 0");
      params.push(between([query.repo]));
    }
    if (query.template !== undefined) {
      where.push("template_ref = ?");
      params.push(query.template);
    }
    const text = searchText(query.q);
    if (text !== "") {
      where.push(
        `(search LIKE ? ESCAPE '\\'
          OR template_ref IN (SELECT value FROM json_each(?))
          OR EXISTS (SELECT 1 FROM json_each(?) AS hit WHERE instr(agents, char(10) || hit.value || char(10)) > 0))`,
      );
      params.push(likePattern(text), JSON.stringify(names.templates), JSON.stringify(names.agents));
    }
    const filter = where.join(" AND ");
    const total = (this.db.prepare(`SELECT count(*) AS n FROM list_items WHERE ${filter}`).get(...params) as { n: number }).n;

    const pageWhere = [filter];
    const pageParams = [...params];
    const cursor = CURSOR.exec(query.before ?? "");
    if (cursor !== null) {
      pageWhere.push("(created_at < ? OR (created_at = ? AND id < ?))");
      pageParams.push(Number(cursor[1]), Number(cursor[1]), cursor[2]!);
    }
    const rows = this.db
      .prepare(`SELECT id, created_at, day FROM list_items WHERE ${pageWhere.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(...pageParams, query.limit + 1) as unknown as { id: string; created_at: number; day: string }[];
    const more = rows.length > query.limit;
    const shown = more ? rows.slice(0, query.limit) : rows;
    const last = shown.at(-1);

    let days: { day: string; count: number }[] = [];
    if (shown.length > 0 && (query.group === "done" || query.group === "failed")) {
      const onPage = [...new Set(shown.map((row) => row.day))];
      const counted = this.db
        .prepare(`SELECT day, count(*) AS n FROM list_items WHERE ${filter} AND day IN (SELECT value FROM json_each(?)) GROUP BY day ORDER BY day DESC`)
        .all(...params, JSON.stringify(onPage)) as unknown as { day: string; n: number }[];
      days = counted.map((row) => ({ day: row.day, count: row.n }));
    }
    return {
      ids: shown.map((row) => row.id as ItemId),
      nextCursor: more && last !== undefined ? `${last.created_at}:${last.id}` : null,
      total,
      days,
    };
  }

  /**
   * The done and failed items counted by start day, template and repos. Items that started before
   * `firstDay` are counted together, under a null day.
   */
  counts(firstDay: string): BoardCount[] {
    const rows = this.db
      .prepare(
        `SELECT CASE WHEN day >= ? THEN day END AS d, template_ref, repos, sum(grp = 'done') AS done, sum(grp = 'failed') AS failed
         FROM list_items WHERE grp IN ('done', 'failed') GROUP BY d, template_ref, repos ORDER BY d DESC, template_ref, repos`,
      )
      .all(firstDay) as unknown as { d: string | null; template_ref: string; repos: string; done: number; failed: number }[];
    return rows.map((row) => ({
      day: row.d,
      templateId: row.template_ref as TemplateRef,
      repoIds: row.repos.split("\n").filter((repo) => repo !== "") as RepoId[],
      done: row.done,
      failed: row.failed,
    }));
  }

  close(): void {
    this.db.close();
  }
}
