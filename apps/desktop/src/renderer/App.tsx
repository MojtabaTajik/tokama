// The app shell: icon rail, sidebar, main area, and the item drawer when an item is open.
import type { FinishAction, UsageRange, UsageScope } from "@tokama/core";
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TokamaBridge } from "../shared/bridge.js";
import { DEFAULT_DESKTOP_STATE, type DesktopState, DRAWER_WIDTH, SECTIONS, SIDEBAR_WIDTH } from "../shared/desktop-state.js";
import { About } from "./about/About.js";
import { ItemDrawer } from "./drawer/ItemDrawer.js";
import { Insights } from "./insights/Insights.js";
import { fitPanels, sidebarMax } from "./layout/fit.js";
import { ResizeEdge } from "./layout/ResizeEdge.js";
import { useWindowWidth } from "./layout/useWindowWidth.js";
import { useUsage } from "./insights/useUsage.js";
import { ALL_WORK, type CliIssue, cliIssuesOf, healthProblemsOf, inView, needsYouCount, type View } from "./model.js";
import { isMac, NewWork, type NewWorkHandle } from "./newwork/NewWork.js";
import { RepoDialog, type SetUpNote } from "./repos/RepoDialog.js";
import { RepoNote } from "./repos/RepoNote.js";
import { Settings, type SettingsPage } from "./settings/Settings.js";
import { NeedsYou } from "./needsyou/NeedsYou.js";
import { MainArea } from "./shell/MainArea.js";
import { Rail } from "./shell/Rail.js";
import { Sidebar } from "./shell/Sidebar.js";
import { RETRY_DELAY_MS, useEngine } from "./useEngine.js";
import { useViewState } from "./useViewState.js";

const PANEL_ID = "sidebar";
/** How often the times in the list move on. */
const CLOCK_TICK_MS = 30_000;

export interface AppProps {
  readonly bridge: TokamaBridge;
  readonly retryDelayMs?: number;
  /** A fixed time for tests; otherwise the clock runs. */
  readonly now?: number;
  /** What the last run left on this machine: panel widths, view and filter. Default: nothing remembered. */
  readonly initial?: DesktopState;
  /** AI CLIs to sign in to again, for tests. Default: what the setup's health reports. */
  readonly cliIssues?: readonly CliIssue[];
}

export function App({ bridge, retryDelayMs = RETRY_DELAY_MS, now: fixedNow, initial = DEFAULT_DESKTOP_STATE, cliIssues }: AppProps) {
  const { connection, data, loadError, stale, retry, refreshSetup } = useEngine(bridge, retryDelayMs);
  const [panelOpen, setPanelOpen] = useState(!initial.sidebar.collapsed);
  // The widths the user chose; what shows also depends on the window (see fitPanels).
  const [chosen, setChosen] = useState({ sidebar: initial.sidebar.width, drawer: initial.drawer.width });
  const windowWidth = useWindowWidth();
  // What the main area shows: the board, the Needs you page, Insights or About; Settings takes the whole window.
  const [page, setPage] = useState<"board" | "needs-you" | "insights" | "about" | "settings">("board");
  // The Settings page to open on: the rail's Settings button opens the default, the tooltip AI CLIs.
  const [settingsPage, setSettingsPage] = useState<SettingsPage | undefined>(undefined);
  // The tooltip and the page share one report; the page's range picks its days.
  const [usageRange, setUsageRange] = useState<UsageRange>(14);
  // Whose usage the page counts: Tokama's own calls, or every Claude Code call on this machine.
  const [usageScope, setUsageScope] = useState<UsageScope>("tokama");
  // The report loads every minute only while someone looks at it: the page, or the rail tooltip.
  const [tipShown, setTipShown] = useState(false);
  const usage = useUsage(bridge, connection, usageRange, usageScope, page === "insights" || tipShown);
  const aboutOpen = page === "about";
  const [selectedItemId, setSelectedItemId] = useState<string | undefined>(undefined);
  // Counts each "Review the diff": the drawer shows the item's Diff tab, also when it shows the item already.
  const [diffAsked, setDiffAsked] = useState<number | undefined>(undefined);
  // What a Done row asked of the drawer: Discard… opens the item with its question, and a refused
  // finish command opens it with the refusal. `seq` makes each request new.
  const [rowRequest, setRowRequest] = useState<{ itemId: string; seq: number; discard?: true; notice?: string } | undefined>(undefined);
  const requests = useRef(0);
  // A row's request is for one showing of the drawer: leaving the work views drops it, so the drawer does not repeat it on return.
  useEffect(() => {
    if (page !== "board" && page !== "needs-you") setRowRequest(undefined);
  }, [page]);
  const selectItem = useCallback((itemId: string | undefined) => {
    setRowRequest(undefined);
    setSelectedItemId(itemId);
  }, []);
  // A finish action from a Done row; the result comes back as item updates.
  const finishFromRow = useCallback(
    async (itemId: string, action: FinishAction) => {
      const reply = await bridge.command({ type: "finish_item", itemId, action }).catch((cause: unknown) => ({ ok: false as const, error: { code: "bridge_error", message: String(cause) } }));
      if (reply.ok) return;
      setSelectedItemId(itemId);
      setRowRequest({ itemId, seq: ++requests.current, notice: reply.error.message });
    },
    [bridge],
  );
  const discardFromRow = useCallback((itemId: string) => {
    setSelectedItemId(itemId);
    setRowRequest({ itemId, seq: ++requests.current, discard: true });
  }, []);
  const composer = useRef<NewWorkHandle>(null);
  // New work asked for on a page that has no composer: the board opens, then the composer.
  const [openComposerOnBoard, setOpenComposerOnBoard] = useState(false);
  useEffect(() => {
    if (!openComposerOnBoard || page !== "board") return;
    composer.current?.open();
    setOpenComposerOnBoard(false);
  }, [openComposerOnBoard, page]);
  // The folder the picker returned, while the Add repo dialog is open.
  const [addingRepo, setAddingRepo] = useState<string | undefined>(undefined);
  const [editingRepo, setEditingRepo] = useState<string | undefined>(undefined);
  const [setUpNote, setSetUpNote] = useState<SetUpNote | undefined>(undefined);
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    if (fixedNow !== undefined) return;
    const timer = setInterval(() => setClock(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, [fixedNow]);
  const now = fixedNow ?? clock;
  // Without an engine the drawer has no setup to name things by: it closes.
  if (connection.status === "failed" && selectedItemId !== undefined) setSelectedItemId(undefined);

  const items = useMemo(() => [...(data?.items.values() ?? [])], [data]);
  const setup = data?.setup;
  // The engine's startup checks, unless a test gives the issues itself.
  const issues = useMemo(() => cliIssues ?? cliIssuesOf(setup?.health), [cliIssues, setup]);
  const problems = useMemo(() => healthProblemsOf(setup?.health), [setup]);
  const editedRepo = setup?.repos.find((repo) => repo.id === editingRepo);
  const views = useViewState((view) => view.kind === "all" || (view.kind === "workflow" ? setup?.templates : setup?.repos)?.some((entry) => entry.id === view.id) === true, {
    view: initial.lastView,
    filter: initial.lastFilter,
    collapsed: initial.collapsedSections,
  });
  // The view, its filter and the collapsed sections are saved when they change, and only once the
  // setup is known: before that the view shows as All work, which must not replace the remembered one.
  const savedViews = useRef(JSON.stringify([initial.lastView, initial.lastFilter, initial.collapsedSections]));
  useEffect(() => {
    if (setup === undefined) return;
    const collapsedSections = SECTIONS.filter((section) => views.collapsed.has(section));
    const next = JSON.stringify([views.view, views.filter, collapsedSections]);
    if (next === savedViews.current) return;
    savedViews.current = next;
    void bridge.saveLayout({ lastView: views.view, lastFilter: views.filter, collapsedSections }).catch(() => undefined);
  }, [bridge, setup, views.view, views.filter, views.collapsed]);
  const save = (patch: Parameters<TokamaBridge["saveLayout"]>[0]) => void bridge.saveLayout(patch).catch(() => undefined);

  // Cmd (macOS) or Ctrl (elsewhere) and N open New work from anywhere; the sidebar may be closed, so this lives here.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "n" || !(isMac() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey) || event.altKey || event.shiftKey || composer.current === null) return;
      event.preventDefault();
      composer.current.open();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  const pickRepoFolder = async () => {
    const path = await bridge.pickFolder().catch(() => null);
    if (path !== null) setAddingRepo(path);
  };
  const removeRepo = async (repoId: string) => {
    const reply = await bridge.command({ type: "remove_repo", repoId });
    return reply.ok ? undefined : reply.error.message;
  };
  const startIn = (target: View) => composer.current?.open(target.kind === "workflow" ? { templateId: target.id } : target.kind === "repo" ? { repoId: target.id } : undefined);

  // Pinned below the board and the Needs you page, so New work keeps working from either.
  const composerNode = setup !== undefined && setup.repos.length > 0 && connection.status !== "failed" && (
    <NewWork
      ref={composer}
      bridge={bridge}
      setup={setup}
      repoId={page === "board" && views.view.kind === "repo" ? views.view.id : undefined}
      onStarted={(itemId, started) => {
        // Show the new item where the user is, or in All work when this view would hide it.
        setPage("board");
        views.reveal(inView(started, views.view) ? views.view : ALL_WORK);
        setSelectedItemId(itemId);
      }}
    />
  );

  if (page === "settings") {
    return (
      <div className="shell">
        <Settings bridge={bridge} connection={connection} setup={setup} onBack={() => setPage("board")} {...(settingsPage !== undefined && { initialPage: settingsPage })} />
      </div>
    );
  }

  // The drawer belongs to the work views. Insights and About hide it; the item stays selected, so going back reopens it.
  const drawerOpen = (page === "board" || page === "needs-you") && selectedItemId !== undefined;
  const fit = fitPanels(windowWidth, { sidebarOpen: panelOpen, drawerOpen, sidebar: chosen.sidebar, drawer: chosen.drawer });
  const widths = { "--sidebar-w": `${fit.sidebar}px`, "--drawer-w": `${fit.drawer}px` } as CSSProperties;
  return (
    <div className="shell" style={widths} data-drawer-floating={fit.floating ? "true" : undefined}>
      <Rail
        panelOpen={panelOpen}
        panelId={PANEL_ID}
        onTogglePanel={() => {
          setPanelOpen(!panelOpen);
          save({ sidebar: { width: chosen.sidebar, collapsed: panelOpen } });
        }}
        needsYou={stale ? undefined : needsYouCount(items)}
        issues={issues}
        problems={problems}
        onAttention={refreshSetup}
        usage={usage.report}
        now={now}
        insightsOpen={page === "insights"}
        onInsights={() => setPage("insights")}
        onInsightsTip={(shown) => {
          setTipShown(shown);
          if (shown) usage.refresh();
        }}
        aboutOpen={aboutOpen}
        needsYouOpen={page === "needs-you"}
        onBoard={() => setPage("board")}
        onNeedsYou={() => setPage("needs-you")}
        onAbout={() => setPage(aboutOpen ? "board" : "about")}
        onSettings={() => {
          setSettingsPage(undefined);
          setPage("settings");
        }}
        setup={setup}
        onSelectItem={(itemId) => {
          // About hides the drawer: leave it, so the chosen item shows now.
          if (aboutOpen) setPage("board");
          setSelectedItemId(itemId);
        }}
        onCliSettings={() => {
          setSettingsPage("ai-clis");
          setPage("settings");
        }}
      />
      {panelOpen && (
        <Sidebar
          id={PANEL_ID}
          connection={connection}
          setup={setup}
          items={items}
          stale={stale}
          now={now}
          view={views.view}
          onSelectView={(view) => {
            setPage("board");
            views.setView(view);
          }}
          collapsed={views.collapsed}
          onToggleSection={views.toggleSection}
          onNewWork={() => composer.current?.open()}
          onStartIn={startIn}
          onAddRepo={() => void pickRepoFolder()}
          onEditRepo={setEditingRepo}
          onRemoveRepo={removeRepo}
        />
      )}
      {aboutOpen ? (
        <About bridge={bridge} connection={connection.status} onClose={() => setPage("board")} />
      ) : page === "insights" ? (
        <Insights
          bridge={bridge}
          connection={connection}
          onRetryConnection={() => void bridge.retryConnection()}
          usage={usage}
          range={usageRange}
          onRange={setUsageRange}
          scope={usageScope}
          onScope={setUsageScope}
          setup={setup}
          items={items}
          issues={issues}
          now={now}
          onSelectItem={(itemId) => {
            setPage("board");
            setSelectedItemId(itemId);
          }}
          onNewWork={() => {
            setPage("board");
            setOpenComposerOnBoard(true);
          }}
        />
      ) : page === "needs-you" ? (
        <NeedsYou
          bridge={bridge}
          connection={connection}
          loadError={loadError}
          stale={stale}
          onRetry={retry}
          onRetryConnection={() => void bridge.retryConnection()}
          setup={setup}
          items={items}
          now={now}
          selectedItemId={selectedItemId}
          onSelectItem={setSelectedItemId}
          onReviewDiff={(itemId) => {
            setSelectedItemId(itemId);
            setDiffAsked((count) => (count ?? 0) + 1);
          }}
          composer={composerNode}
        />
      ) : (
        <MainArea
          connection={connection}
          loadError={loadError}
          onRetry={retry}
          onRetryConnection={() => void bridge.retryConnection()}
          setup={setup}
          items={items}
          now={now}
          views={views}
          selectedItemId={selectedItemId}
          onSelectItem={selectItem}
          onFinish={finishFromRow}
          onDiscard={discardFromRow}
          composer={composerNode}
        />
      )}
      {addingRepo !== undefined && (
        <RepoDialog
          bridge={bridge}
          path={addingRepo}
          onClose={() => setAddingRepo(undefined)}
          onSetUp={setSetUpNote}
          onPickAnother={() => {
            setAddingRepo(undefined);
            void pickRepoFolder();
          }}
        />
      )}
      {setUpNote !== undefined && <RepoNote note={setUpNote} onStart={() => startIn({ kind: "repo", id: setUpNote.id })} onDismiss={() => setSetUpNote(undefined)} />}
      {editedRepo !== undefined && <RepoDialog bridge={bridge} repo={editedRepo} onClose={() => setEditingRepo(undefined)} />}
      {drawerOpen && (
        <ItemDrawer
          bridge={bridge}
          itemId={selectedItemId}
          setup={setup}
          diffAsked={diffAsked}
          onClose={() => selectItem(undefined)}
          onCheckAgain={refreshSetup}
          request={rowRequest?.itemId === selectedItemId ? rowRequest : undefined}
        />
      )}
      {panelOpen && (
        <ResizeEdge
          label="Resize sidebar"
          side="sidebar"
          value={fit.sidebar}
          chosen={chosen.sidebar}
          min={SIDEBAR_WIDTH.min}
          max={sidebarMax(windowWidth)}
          defaultValue={SIDEBAR_WIDTH.default}
          grow={1}
          onChange={(width) => setChosen((now) => ({ ...now, sidebar: width }))}
          onCommit={(width) => save({ sidebar: { width, collapsed: false } })}
        />
      )}
      {drawerOpen && (
        <ResizeEdge
          label="Resize drawer"
          side="drawer"
          value={fit.drawer}
          chosen={chosen.drawer}
          min={DRAWER_WIDTH.min}
          max={DRAWER_WIDTH.max}
          defaultValue={DRAWER_WIDTH.default}
          grow={-1}
          onChange={(width) => setChosen((now) => ({ ...now, drawer: width }))}
          onCommit={(width) => save({ drawer: { width } })}
        />
      )}
    </div>
  );
}
