// The work list, as pure functions over the engine's item records, in real and sample mode alike.
// `listPage` answers the item_list query: one group, a range of local days, the sidebar's repo or
// workflow, a search, and pages newest start first, keyed on (start time, id) so a page boundary
// inside one millisecond loses no row. `boardCounts` counts the done and failed items for the
// board query, which serves only the open items in full. Both read the whole array on each call.
import {
  type BoardCount,
  type ItemId,
  type ItemRecord,
  type ItemState,
  type ListGroup,
  localDate,
  MAX_BOARD_COUNTS,
  MAX_MESSAGE_BYTES,
  type Setup,
} from "@tokama/core";

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
  /** Done and failed items that ended at or after this time (epoch ms), whenever they started; live groups ignore it. */
  readonly endedAfter?: number | undefined;
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

/** The search text as `listPage` compares it: trimmed and lowercased. Empty means no search. */
export const searchText = (q: string | undefined): string => (q ?? "").trim().toLowerCase();

const CURSOR = /^(\d{1,16}):(item_[0-9a-f-]{36})$/;

/** Whether the lowercase search text is in the item's title, repo ids or agent ids, or the names match. */
function matchesSearch(item: ItemRecord, text: string, names: NameHits): boolean {
  const agents = [...new Set(item.steps.flatMap((step) => (step.agentId === undefined ? [] : [step.agentId])))];
  if ([item.title, ...item.repoIds, ...agents].join("\n").toLowerCase().includes(text)) return true;
  return names.templates.includes(item.templateId) || agents.some((agent) => names.agents.includes(agent));
}

/** One page of the query over the items. A cursor that is not one `listPage` made reads as no cursor. */
export function listPage(items: readonly ItemRecord[], query: ListQuery, names: NameHits = NO_NAME_HITS): ListPage {
  const finished = query.group === "done" || query.group === "failed";
  const text = searchText(query.q);
  const matching = items.filter(
    (item) =>
      groupOf(item.state) === query.group &&
      !(finished && query.since !== undefined && localDate(item.createdAt) < query.since) &&
      !(finished && query.endedAfter !== undefined && (item.outcome?.at ?? -1) < query.endedAfter) &&
      (query.repo === undefined || (item.repoIds as readonly string[]).includes(query.repo)) &&
      (query.template === undefined || item.templateId === query.template) &&
      (text === "" || matchesSearch(item, text, names)),
  );
  matching.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));

  const cursor = CURSOR.exec(query.before ?? "");
  const rest = cursor === null ? matching : matching.filter((item) => item.createdAt < Number(cursor[1]) || (item.createdAt === Number(cursor[1]) && item.id < cursor[2]!));
  const more = rest.length > query.limit;
  const shown = rest.slice(0, query.limit);
  const last = shown.at(-1);

  let days: { day: string; count: number }[] = [];
  if (shown.length > 0 && finished) {
    const onPage = new Set(shown.map((item) => localDate(item.createdAt)));
    const counted = new Map<string, number>();
    for (const item of matching) {
      const day = localDate(item.createdAt);
      if (onPage.has(day)) counted.set(day, (counted.get(day) ?? 0) + 1);
    }
    days = [...counted].map(([day, count]) => ({ day, count })).sort((a, b) => (a.day < b.day ? 1 : -1));
  }
  return {
    ids: shown.map((item) => item.id),
    nextCursor: more && last !== undefined ? `${last.createdAt}:${last.id}` : null,
    total: matching.length,
    days,
  };
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The done and failed items counted by start day, template and repos. Items that started before
 * `firstDay` are counted together, under a null day. The rows stay within the budget: when they
 * are too many or too long, the oldest days join the null-day rows, as many days as needed.
 */
export function boardCounts(items: readonly ItemRecord[], firstDay: string, budget: CountsBudget = COUNTS_BUDGET): BoardCount[] {
  const rows = new Map<string, BoardCount>();
  for (const item of items) {
    const group = groupOf(item.state);
    if (group !== "done" && group !== "failed") continue;
    const started = localDate(item.createdAt);
    const day = started >= firstDay ? started : null;
    const key = `${day ?? ""}\t${item.templateId}\t${item.repoIds.join("\n")}`;
    let row = rows.get(key);
    if (row === undefined) {
      row = { day, templateId: item.templateId, repoIds: [...item.repoIds], done: 0, failed: 0 };
      rows.set(key, row);
    }
    row[group]++;
  }
  // Newest day first, the null day last, then by workflow and repos.
  const all = [...rows.values()].sort(
    (a, b) =>
      (a.day === b.day ? 0 : a.day === null ? 1 : b.day === null ? -1 : compare(b.day, a.day)) ||
      compare(a.templateId, b.templateId) ||
      compare(a.repoIds.join("\n"), b.repoIds.join("\n")),
  );
  return fits(all, budget) ? all : capCounts(all, budget);
}

/** The rows and bytes (as JSON) that the count rows of one board reply may take; it also holds the open items. */
export interface CountsBudget {
  readonly rows: number;
  readonly bytes: number;
}
/** Half the message limit, as for an item_list page, and never more rows than the schema takes. */
export const COUNTS_BUDGET: CountsBudget = { rows: MAX_BOARD_COUNTS, bytes: MAX_MESSAGE_BYTES / 2 };

const rowBytes = (row: BoardCount): number => Buffer.byteLength(JSON.stringify(row)) + 1;
const fits = (rows: readonly BoardCount[], budget: CountsBudget): boolean => rows.length <= budget.rows && rows.reduce((sum, row) => sum + rowBytes(row), 0) <= budget.bytes;

/**
 * Keeps the newest whole days that fit in the budget and adds the rest to the null-day rows, one
 * row for each template and repo set. Rows come newest day first, null day last. If the null-day
 * rows alone are too many, the first rows that fit stay.
 */
function capCounts(rows: BoardCount[], budget: CountsBudget): BoardCount[] {
  const days = [...new Set(rows.flatMap((row) => (row.day === null ? [] : [row.day])))];
  for (let keep = days.length; keep >= 0; keep--) {
    const kept = new Set(days.slice(0, keep));
    const shown = rows.filter((row) => row.day !== null && kept.has(row.day));
    const folded = new Map<string, BoardCount>();
    for (const row of rows) {
      if (row.day !== null && kept.has(row.day)) continue;
      const key = `${row.templateId}\n${row.repoIds.join("\n")}`;
      const total = folded.get(key);
      if (total === undefined) folded.set(key, { ...row, day: null });
      else {
        total.done += row.done;
        total.failed += row.failed;
      }
    }
    const capped = [...shown, ...folded.values()];
    if (fits(capped, budget)) return capped;
    if (keep === 0) return takeFitting(capped, budget);
  }
  return takeFitting(rows, budget);
}

function takeFitting(rows: readonly BoardCount[], budget: CountsBudget): BoardCount[] {
  const taken: BoardCount[] = [];
  let bytes = 0;
  for (const row of rows) {
    bytes += rowBytes(row);
    if (taken.length >= budget.rows || bytes > budget.bytes) break;
    taken.push(row);
  }
  return taken;
}
