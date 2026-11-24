// What the shell remembers while it runs, in renderer state only: the current view, each view's
// status filter and time range, each workflow's List or Board choice, and which sidebar sections
// are collapsed. Nothing is stored on disk.
import { useState } from "react";
import { ALL_WORK, DEFAULT_FILTER, type Filter, type View, viewKey } from "./model.js";

export type Layout = "list" | "board";
export type Section = "workflows" | "repos";

export interface ViewState {
  readonly view: View;
  readonly setView: (view: View) => void;
  /** Shows a view and makes sure its status switch is on a filter that lists live items (a new item must not be hidden). */
  readonly reveal: (view: View) => void;
  readonly filter: Filter;
  readonly setFilter: (patch: Partial<Filter>) => void;
  /** Repo and All work views are always lists. */
  readonly layout: Layout;
  readonly setLayout: (layout: Layout) => void;
  readonly collapsed: ReadonlySet<Section>;
  readonly toggleSection: (section: Section) => void;
}

/** `exists` says whether a workflow or repo is still in the setup: a view that is gone falls back to All work. */
export function useViewState(exists: (view: View) => boolean): ViewState {
  const [chosen, setView] = useState<View>(ALL_WORK);
  const [filters, setFilters] = useState<ReadonlyMap<string, Filter>>(new Map());
  const [layouts, setLayouts] = useState<ReadonlyMap<string, Layout>>(new Map());
  const [collapsed, setCollapsed] = useState<ReadonlySet<Section>>(new Set());

  const view = exists(chosen) ? chosen : ALL_WORK;
  const key = viewKey(view);
  const filter = filters.get(key) ?? DEFAULT_FILTER;
  return {
    view,
    setView,
    reveal: (target) => {
      setView(target);
      const targetKey = viewKey(target);
      const current = filters.get(targetKey) ?? DEFAULT_FILTER;
      if (current.status !== "active" && current.status !== "all") setFilters(new Map(filters).set(targetKey, { ...current, status: "active" }));
    },
    filter,
    setFilter: (patch) => setFilters(new Map(filters).set(key, { ...filter, ...patch })),
    layout: view.kind === "workflow" ? (layouts.get(key) ?? "list") : "list",
    setLayout: (layout) => setLayouts(new Map(layouts).set(key, layout)),
    collapsed,
    toggleSection: (section) => {
      const next = new Set(collapsed);
      if (!next.delete(section)) next.add(section);
      setCollapsed(next);
    },
  };
}
