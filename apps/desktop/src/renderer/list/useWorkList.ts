// The work list's pages from the engine's item_list query: one page set per group asked for. A
// changed request (filter, range, view or search) starts its group again at the first page; Load
// older adds the next page below. An item_updated event for an item of a group, or for an item
// already listed in it, loads the group again shortly after, as many rows as it shows, so a newly
// finished item appears and Load older keeps what it loaded. A reply for a request that was
// replaced in the meantime is dropped.
import type { ItemRecord } from "@tokama/core";
import { useCallback, useEffect, useRef, useState } from "react";
import type { TokamaBridge } from "../../shared/bridge.js";
import { bucketOf, type GroupKey } from "../model.js";

/** Rows per page. */
export const PAGE_SIZE = 50;
/** The most rows the engine gives in one page (its MAX_LIST_PAGE); a reload of more rows asks for this many. */
const MAX_PAGE = 1000;
/** Wait after an item event before loading again, so a burst of events loads once. */
export const REFRESH_DELAY_MS = 150;

export interface ListRequest {
  readonly group: GroupKey;
  /** The first local day of done and failed items; undefined for all time. */
  readonly since?: string | undefined;
  /** Only done and failed items that ended at or after this time (epoch ms), whenever they started. */
  readonly endedAfter?: number | undefined;
  readonly repo?: string | undefined;
  readonly template?: string | undefined;
  /** The search text; undefined or empty for none. */
  readonly q?: string | undefined;
}

export interface GroupPage {
  readonly request: ListRequest;
  /** In the engine's order, newest start first. */
  readonly items: readonly ItemRecord[];
  /** Every matching item, loaded or not; undefined until the first page is in. */
  readonly total: number | undefined;
  /** Each local day's matching items, loaded or not. */
  readonly days: ReadonlyMap<string, number>;
  /** Where the next page starts; undefined on the last page. */
  readonly cursor: string | undefined;
  /** What is on its way: the first page, or the next with Load older. */
  readonly loading: "first" | "older" | undefined;
  /** What did not load. */
  readonly failed: "first" | "older" | undefined;
}

export interface WorkList {
  /** One page set per request, for that request: a group whose request changed reads as loading, never as the old rows. */
  readonly pages: ReadonlyMap<GroupKey, GroupPage>;
  readonly loadOlder: (group: GroupKey) => void;
  /** Loads a group again from its first page, after a failed load. */
  readonly retry: (group: GroupKey) => void;
}

const keyOf = (request: ListRequest) => JSON.stringify([request.group, request.since, request.endedAfter, request.repo, request.template, request.q ?? ""]);

const empty = (request: ListRequest): GroupPage => ({ request, items: [], total: undefined, days: new Map(), cursor: undefined, loading: "first", failed: undefined });

type Mode = "first" | "refresh" | "older";

export function useWorkList(bridge: TokamaBridge, connected: boolean, requests: readonly ListRequest[]): WorkList {
  const [pages, setPages] = useState<ReadonlyMap<GroupKey, GroupPage>>(() => new Map());
  const current = useRef(pages);
  current.current = pages;
  // The last request sent per group: a reply to an older one is dropped. One counter for all
  // groups, so a group asked for again never reuses the token of a reply still on its way.
  const tokens = useRef(new Map<GroupKey, number>());
  const sent = useRef(0);

  const update = useCallback((group: GroupKey, change: (page: GroupPage) => GroupPage | undefined) => {
    setPages((before) => {
      const page = before.get(group);
      const next = page === undefined ? undefined : change(page);
      if (next === undefined) return before;
      current.current = new Map(before).set(group, next);
      return current.current;
    });
  }, []);

  const load = useCallback(
    (group: GroupKey, mode: Mode) => {
      const page = current.current.get(group);
      if (page === undefined) return;
      const token = ++sent.current;
      tokens.current.set(group, token);
      const { request } = page;
      // A refresh during Load older replaces it, so it takes the older page's rows too.
      const wanted = page.items.length + (page.loading === "older" ? PAGE_SIZE : 0);
      const limit = mode === "refresh" ? Math.min(MAX_PAGE, Math.max(PAGE_SIZE, wanted)) : PAGE_SIZE;
      const before = mode === "older" ? page.cursor : undefined;
      if (mode === "first") update(group, () => empty(request));
      if (mode === "older") update(group, (p) => ({ ...p, loading: "older", failed: undefined }));
      void bridge
        .query({
          type: "item_list",
          group,
          limit,
          ...(request.since !== undefined && { since: request.since }),
          ...(request.endedAfter !== undefined && { endedAfter: request.endedAfter }),
          ...(request.repo !== undefined && { repo: request.repo }),
          ...(request.template !== undefined && { template: request.template }),
          ...(request.q !== undefined && request.q !== "" && { q: request.q }),
          ...(before !== undefined && { before }),
        })
        .catch(() => undefined)
        .then((reply) => {
          if (tokens.current.get(group) !== token) return;
          update(group, (p) => {
            if (reply === undefined || !reply.ok) {
              // A failed refresh keeps the rows there are; it is tried again on the next change.
              if (mode === "refresh" && p.total !== undefined) return { ...p, loading: undefined };
              return { ...p, loading: undefined, failed: mode === "older" ? "older" : "first" };
            }
            const { items, nextCursor, total, days } = reply.data;
            const cursor = nextCursor ?? undefined;
            if (mode !== "older") return { request: p.request, items, total, days: new Map(days.map((d) => [d.day, d.count])), cursor, loading: undefined, failed: undefined };
            const listed = new Set(p.items.map((item) => item.id));
            const merged = new Map(p.days);
            for (const d of days) merged.set(d.day, d.count);
            return { ...p, items: [...p.items, ...items.filter((item) => !listed.has(item.id))], total, days: merged, cursor, loading: undefined, failed: undefined };
          });
        });
    },
    [bridge, update],
  );

  // A changed request starts its group again; groups no longer asked for are dropped. Back on a
  // connection, the groups kept load again too (events may have been missed while away).
  const key = JSON.stringify(requests.map(keyOf));
  const wasConnected = useRef(false);
  useEffect(() => {
    const reconnected = connected && !wasConnected.current;
    wasConnected.current = connected;
    if (!connected) return;
    const wanted = new Map(requests.map((request) => [request.group, request]));
    const before = current.current;
    const next = new Map<GroupKey, GroupPage>();
    const fresh: GroupKey[] = [];
    for (const [group, request] of wanted) {
      const page = before.get(group);
      if (page !== undefined && keyOf(page.request) === keyOf(request) && page.failed !== "first") next.set(group, page);
      else {
        next.set(group, empty(request));
        fresh.push(group);
      }
    }
    for (const group of before.keys()) if (!wanted.has(group)) tokens.current.delete(group);
    current.current = next;
    setPages(next);
    for (const group of next.keys()) {
      if (fresh.includes(group)) load(group, "first");
      else if (reconnected) load(group, "refresh");
    }
    // `requests` is read through `key`, which holds every field.
  }, [key, connected, load]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const due = new Set<GroupKey>();
    const later = (groups: Iterable<GroupKey>) => {
      for (const group of groups) due.add(group);
      if (due.size === 0 || timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        for (const group of due) load(group, "refresh");
        due.clear();
      }, REFRESH_DELAY_MS);
    };
    const stop = bridge.onEvent(({ event }) => {
      if (event.type === "setup_changed") return later(current.current.keys());
      if (event.type !== "item_updated") return;
      const { item } = event;
      const group: GroupKey = bucketOf(item) === "active" ? "running" : (bucketOf(item) as GroupKey);
      later([...current.current].flatMap(([key, page]) => (key === group || page.items.some((listed) => listed.id === item.id) ? [key] : [])));
    });
    return () => {
      stop();
      clearTimeout(timer);
    };
  }, [bridge, load]);

  const shown = new Map(
    requests.map((request): [GroupKey, GroupPage] => {
      const page = pages.get(request.group);
      return [request.group, page !== undefined && keyOf(page.request) === keyOf(request) ? page : empty(request)];
    }),
  );
  return {
    pages: shown,
    loadOlder: useCallback((group: GroupKey) => load(group, "older"), [load]),
    retry: useCallback((group: GroupKey) => load(group, "first"), [load]),
  };
}
