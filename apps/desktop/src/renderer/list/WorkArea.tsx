// The status switch with the search, and below it the pipeline list or the workflow's kanban.
// Needs you and Running come from the board's items, in full and without day headers. Done and
// Failed come from the engine a page at a time (Load older adds the next), under day headers when
// the range is longer than today; the kanban's Done column shows their first pages and counts them
// all. The switch counts finished work from the board's counts. While a search is typed, the engine decides the hits of every
// group, 200 ms after the last key; groups without a hit are hidden, and with no hit at all one
// message takes their place. Rows show the board's record of an item when it has one, so a row
// follows the item's events before its page loads again.
import type { BoardCount, FinishAction, ItemRecord, Setup } from "@tokama/core";
import { type ReactNode, useEffect, useState } from "react";
import type { TokamaBridge } from "../../shared/bridge.js";
import { Board } from "../board/Board.js";
import {
  effectiveRange,
  type Filter,
  type GroupKey,
  GROUPS_OF,
  groupItems,
  hasRange,
  type ItemGroup,
  RANGES,
  rangeWords,
  sinceOf,
  STATUS_FILTERS,
  type View,
  visibleItems,
} from "../model.js";
import type { AgentTarget } from "../settings/describe.js";
import { SearchIcon } from "../ui/icons.js";
import { StatusFilter } from "../shell/StatusFilter.js";
import type { Layout } from "../useViewState.js";
import { ItemList } from "./ItemList.js";
import { type GroupPage, type ListRequest, PAGE_SIZE, useWorkList } from "./useWorkList.js";
import { Button } from "../ui/Button.js";
import { markOf } from "../ui/status.js";

/** Wait after the last key before the search goes to the engine. */
export const SEARCH_DELAY_MS = 200;

const TEXT = {
  loadOlder: "Load older",
  loadingOlder: `${markOf("queued").symbol} Loading older…`,
  showing: (shown: number, total: number) => (
    <>
      Showing <span className="mono">{shown}</span> of <span className="mono">{total}</span>
    </>
  ),
  olderFailed: `${markOf("failed").symbol} Could not load older work. The engine did not answer.`,
  firstFailed: `${markOf("failed").symbol} Could not load this work. The engine did not answer.`,
  tryAgain: "Try again",
  everything: "That is everything.",
  everythingIn: (words: string) => `That is everything in the ${words}.`,
  showAllTime: "Show all time",
  noMatch: (q: string) => `No work matches ‘${q}’`,
  searched: (scope: string) => `Searched titles, repos, templates and agents in ${scope}.`,
  clearSearch: "Clear search",
  searchAllTime: "Search all time",
} as const;

export interface WorkAreaProps {
  readonly bridge: TokamaBridge;
  readonly connected: boolean;
  readonly setup: Setup;
  /** The open items of the view, from the board. */
  readonly scoped: readonly ItemRecord[];
  /** The finished items of the view, counted, from the board. */
  readonly counts: readonly BoardCount[];
  /** Every open item of the board by id: the freshest record of a row. */
  readonly items: ReadonlyMap<string, ItemRecord>;
  readonly view: View;
  readonly filter: Filter;
  readonly onFilter: (patch: Partial<Filter>) => void;
  readonly layout: Layout;
  readonly template: Setup["templates"][number] | undefined;
  readonly now: number;
  readonly selectedItemId: string | undefined;
  readonly onSelectItem: (itemId: string) => void;
  readonly onFinish?: ((itemId: string, action: FinishAction) => void | Promise<void>) | undefined;
  readonly onDiscard?: ((itemId: string) => void) | undefined;
  readonly onOpenAgent?: ((agent: AgentTarget) => void) | undefined;
}

const finished = (group: GroupKey) => group === "done" || group === "failed";

export function WorkArea(props: WorkAreaProps) {
  const { bridge, connected, setup, scoped, counts, items, view, filter, onFilter, layout, template, now } = props;
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setQ(text.trim()), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [text]);
  const clear = () => {
    setText("");
    setQ("");
  };

  const board = template !== undefined && layout === "board";
  const searching = !board && q !== "";
  const range = effectiveRange(filter);
  const since = sinceOf(range, now);
  const scope = view.kind === "repo" ? { repo: view.id } : view.kind === "workflow" ? { template: view.id } : {};
  const keys = GROUPS_OF[filter.status];
  const requests: ListRequest[] = keys.filter((group) => finished(group) || searching).map((group) => ({ group, ...scope, ...(finished(group) && { since }), ...(searching && { q }) }));
  const list = useWorkList(bridge, connected, requests);

  const fresh = (item: ItemRecord) => items.get(item.id) ?? item;
  const groups: ItemGroup[] = groupItems(scoped, filter, now).map((group) => {
    const page = list.pages.get(group.key);
    if (page === undefined) return group;
    return { ...group, items: page.items.map(fresh), count: page.total, days: finished(group.key) && range !== "today" ? page.days : undefined };
  });
  // While searching, a group shows only once it has a hit.
  const shown = searching ? groups.filter((group) => group.count !== undefined && group.count > 0) : groups;
  const totals = searching ? groups.map((group) => group.count) : [];
  const results = totals.every((count) => count !== undefined) ? totals.reduce<number>((sum, count) => sum + (count ?? 0), 0) : undefined;

  const footer = (group: GroupKey, page: GroupPage | undefined): ReactNode => {
    if (page === undefined || page.total === undefined) {
      if (page?.failed !== "first") return undefined;
      return (
        <div className="pl-more">
          <span className="pl-more-failed" role="alert">
            {TEXT.firstFailed}
          </span>
          <Button variant="secondary" onClick={() => list.retry(group)}>
            {TEXT.tryAgain}
          </Button>
        </div>
      );
    }
    if (page.cursor !== undefined) {
      if (page.loading === "older") {
        return (
          <div className="pl-more">
            <Button variant="secondary" disabled>
              {TEXT.loadingOlder}
            </Button>
          </div>
        );
      }
      return (
        <div className="pl-more">
          {page.failed === "older" ? (
            <>
              <span className="pl-more-failed" role="alert">
                {TEXT.olderFailed}
              </span>
              <Button variant="secondary" onClick={() => list.loadOlder(group)}>
                {TEXT.tryAgain}
              </Button>
            </>
          ) : (
            <>
              <Button variant="secondary" onClick={() => list.loadOlder(group)}>
                {TEXT.loadOlder}
              </Button>
              <span className="pl-more-note">{TEXT.showing(page.items.length, page.total)}</span>
            </>
          )}
        </div>
      );
    }
    // The end of a range that took more than one page.
    if (!finished(group) || range === "today" || page.items.length <= PAGE_SIZE) return undefined;
    return (
      <div className="pl-more">
        <span className="pl-more-note">{range === "all" ? TEXT.everything : TEXT.everythingIn(rangeWords(range))}</span>
        {range !== "all" && (
          <Button variant="secondary" onClick={() => onFilter({ range: "all" })}>
            {TEXT.showAllTime}
          </Button>
        )}
      </div>
    );
  };
  const footers = Object.fromEntries(keys.map((group) => [group, footer(group, list.pages.get(group))]));
  // The kanban: the open items, then the first pages of Done and Failed, which count in full.
  const finishedPages = keys.filter(finished).flatMap((group) => list.pages.get(group) ?? []);
  const boardItems = [...visibleItems(scoped, filter, now), ...finishedPages.flatMap((page) => page.items.map(fresh))];
  const notLoaded = finishedPages.reduce((sum, page) => sum + Math.max(0, (page.total ?? 0) - page.items.length), 0);

  const where = `${STATUS_FILTERS.find((status) => status.id === filter.status)?.label ?? filter.status}${hasRange(filter.status) ? ` · ${RANGES.find((r) => r.id === filter.range)?.label ?? filter.range}` : ""}`;
  return (
    <>
      <StatusFilter items={scoped} counts={counts} filter={filter} now={now} onChange={onFilter} search={board ? undefined : { text, onText: setText, onClear: clear, results: searching ? results : undefined }} />
      {board ? (
        <Board items={boardItems} notLoaded={notLoaded} agents={setup.agents} template={template} selectedItemId={props.selectedItemId} onSelect={props.onSelectItem} now={now} />
      ) : searching && results === 0 ? (
        <div className="pl-no-match" role="status">
          <span className="pl-no-match-title">
            <SearchIcon size={15} />
            {TEXT.noMatch(q)}
          </span>
          <span className="pl-more-note">{TEXT.searched(where)}</span>
          <span className="pl-no-match-actions">
            <Button variant="secondary" onClick={clear}>
              {TEXT.clearSearch}
            </Button>
            {hasRange(filter.status) && filter.range !== "all" && (
              <Button variant="secondary" onClick={() => onFilter({ range: "all" })}>
                {TEXT.searchAllTime}
              </Button>
            )}
          </span>
        </div>
      ) : (
        <ItemList
          groups={shown}
          setup={setup}
          now={now}
          selectedItemId={props.selectedItemId}
          onSelect={props.onSelectItem}
          repoId={view.kind === "repo" ? view.id : undefined}
          footers={footers}
          {...(props.onFinish !== undefined && { onFinish: props.onFinish })}
          {...(props.onDiscard !== undefined && { onDiscard: props.onDiscard })}
          {...(props.onOpenAgent !== undefined && { onOpenAgent: props.onOpenAgent })}
        />
      )}
    </>
  );
}
