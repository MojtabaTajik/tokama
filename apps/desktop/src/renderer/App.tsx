// The app shell: icon rail, sidebar, main area, and the item drawer when an item is open. An open
// item can fill the main area instead of the drawer (the full view); the sidebar stays.
import type { AiCliId, BoardCount, FinishAction, UsageWindow } from "@tokama/core";
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ToolsPathInfo, TokamaBridge } from "../shared/bridge.js";
import { DEFAULT_DESKTOP_STATE, type DesktopState, DRAWER_WIDTH, type GetStartedState, RAIL_WIDTH, SECTIONS, SIDEBAR_WIDTH } from "../shared/desktop-state.js";
import { About } from "./about/About.js";
import { SIDE_BY_SIDE_MIN_WIDTH } from "./ui/DiffView.js";
import { ItemDrawer } from "./drawer/ItemDrawer.js";
import { aiCliBlock, checklist } from "./getstarted/checklist.js";
import { GetStarted } from "./getstarted/GetStarted.js";
import { SetupDoneLine } from "./getstarted/SetupDoneLine.js";
import { Insights } from "./insights/Insights.js";
import { fitPanels, sidebarMax } from "./layout/fit.js";
import { ResizeEdge } from "./layout/ResizeEdge.js";
import { useWindowWidth } from "./layout/useWindowWidth.js";
import { useUsage } from "./insights/useUsage.js";
import { ALL_WORK, type CliIssue, cliIssuesOf, healthProblemsOf, inView, needsYouCount, type View } from "./model.js";
import { isMac, NewWork, type NewWorkHandle, type NewWorkPrefill } from "./newwork/NewWork.js";
import { RepoDialog, type SetUpNote } from "./repos/RepoDialog.js";
import { RepoNote } from "./repos/RepoNote.js";
import type { AgentTarget } from "./settings/describe.js";
import { Settings, type SettingsPage } from "./settings/Settings.js";
import { useDiagnosticsWaiting } from "./settings/useDiagnostics.js";
import { NeedsYou } from "./needsyou/NeedsYou.js";
import { CrashPrompt, useCrashPrompt } from "./shell/CrashPrompt.js";
import { MainArea } from "./shell/MainArea.js";
import { Rail } from "./shell/Rail.js";
import { runningItems } from "./update/running.js";
import { UpdateChip } from "./update/UpdateChip.js";
import { useUpdate } from "./update/useUpdate.js";
import { updateChip } from "../shared/update.js";
import { Sidebar } from "./shell/Sidebar.js";
import { CHIP_PRIORITY, type SidebarChipCandidate } from "./shell/sidebar-chip.js";
import { UpdatedChip } from "./whatsnew/UpdatedChip.js";
import { useWhatsNew } from "./whatsnew/useWhatsNew.js";
import { WhatsNewCard } from "./whatsnew/WhatsNewCard.js";
import { RETRY_DELAY_MS, useEngine } from "./useEngine.js";
import { useViewState } from "./useViewState.js";

const PANEL_ID = "sidebar";
const TEXT = { allWork: "All work", needsYou: "Needs you" } as const;
/** How often the times in the list move on. */
const CLOCK_TICK_MS = 30_000;
const NO_COUNTS: readonly BoardCount[] = [];
/** How often the Get started list asks the engine for fresh checks while it is on screen. Longer than the engine's 5 s answer cache, so each ask runs the checks once, not more. */
const CHECK_POLL_MS = 10_000;
/** Check again shows "Checking…" at least this long, so the click is seen. */
const CHECKING_MIN_MS = 600;

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
  // The agent Settings selects on its Agents page: the one an agent tooltip linked to.
  const [settingsAgent, setSettingsAgent] = useState<AgentTarget | undefined>(undefined);
  const openAgent = useCallback((target: AgentTarget) => {
    setSettingsPage("agents");
    setSettingsAgent(target);
    setPage("settings");
  }, []);
  // The tooltip and the page share one report. The page picks the week it shows (kept while the app runs; it opens on this week) and the AI tool (kept across restarts).
  const [usageWindow, setUsageWindow] = useState<UsageWindow>("current");
  const [usageTool, setUsageTool] = useState<AiCliId | undefined>(initial.usageTool);
  const chooseUsageTool = useCallback(
    (tool: AiCliId | undefined) => {
      setUsageTool(tool);
      void bridge.saveLayout({ usageTool: tool }).catch(() => undefined);
    },
    [bridge],
  );
  // The report loads every minute only while someone looks at it: the page, or the rail tooltip.
  const [tipShown, setTipShown] = useState(false);
  const usage = useUsage(bridge, connection, usageWindow, page === "insights" || tipShown);
  const crashEntryWaiting = useDiagnosticsWaiting(bridge, connection);
  const whatsNew = useWhatsNew(bridge);
  // The release note About opens on (a row starts open): set by the card's See all and by the chip, dropped once About is left.
  const [aboutVersion, setAboutVersion] = useState<string | undefined>(undefined);
  const openNotes = useCallback((version: string) => {
    setAboutVersion(version);
    setPage("about");
  }, []);
  const crash = useCrashPrompt(bridge, connection, initial.askAfterCrash);
  const crashPrompt = crash.open && (
    <CrashPrompt
      onReview={() => {
        crash.review();
        setSettingsPage("diagnostics");
        setSettingsAgent(undefined);
        setPage("settings");
      }}
      onNotNow={crash.notNow}
      onDontAsk={crash.dontAsk}
    />
  );
  // The "!" on Settings: a crash entry waits for the user's answer and asking after a crash is still on.
  const crashMark = crashEntryWaiting && crash.asking;
  const aboutOpen = page === "about";
  const [selectedItemId, setSelectedItemId] = useState<string | undefined>(undefined);
  // Counts each "Review the diff": the drawer shows the item's Diff tab, also when it shows the item already.
  const [diffAsked, setDiffAsked] = useState<number | undefined>(undefined);
  // What a Done row asked of the drawer: Discard… opens the item with its question, and a refused
  // finish command opens it with the refusal. `seq` makes each request new.
  const [rowRequest, setRowRequest] = useState<{ itemId: string; seq: number; discard?: true; notice?: string } | undefined>(undefined);
  const requests = useRef(0);
  // The item shown in the full view, and the work page it was opened on. Like the drawer, it waits
  // behind Insights, About and Settings and is there again on return.
  // `reader` shows one step's document instead of the tabs; `from` is where closing it returns to:
  // the drawer on the item, or the Needs you list.
  const [expanded, setExpanded] = useState<
    { readonly itemId: string; readonly page: "board" | "needs-you"; readonly reader?: { readonly stepIndex: number; readonly from: "drawer" | "page" } } | undefined
  >(undefined);
  // The item whose "Read the plan" button on the Needs you list takes focus when the list returns.
  const [returnToRead, setReturnToRead] = useState<string | undefined>(undefined);
  // A row's request is for one showing of the drawer: leaving the work views drops it, so the drawer does not repeat it on return.
  useEffect(() => {
    if (page !== "board" && page !== "needs-you") setRowRequest(undefined);
    if (page !== "about") setAboutVersion(undefined);
  }, [page]);
  const selectItem = useCallback((itemId: string | undefined) => {
    setRowRequest(undefined);
    setSelectedItemId(itemId);
  }, []);
  // Any item shown ends the pending focus return; only the list coming back claims it.
  useEffect(() => {
    if (selectedItemId !== undefined) setReturnToRead(undefined);
  }, [selectedItemId]);
  const openReader = (itemId: string, stepIndex: number, from: "drawer" | "page") => {
    selectItem(itemId);
    setExpanded({ itemId, page: page === "needs-you" ? "needs-you" : "board", reader: { stepIndex, from } });
  };
  const closeReader = () => {
    const reader = expanded?.reader;
    if (reader?.from === "page") {
      // An item answered in the reader has no row to return to; a later question of it must not take focus.
      setReturnToRead(items.find((item) => item.id === expanded?.itemId)?.state === "needs_you" ? expanded?.itemId : undefined);
      setSelectedItemId(undefined);
    }
    setExpanded(undefined);
  };
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
  // New work asked for where no composer shows (Insights, the full view): the list comes back in
  // the same update, and the composer opens once it is there. Each ask is used once, also when
  // no composer can show (no repos yet).
  const [composerAsked, setComposerAsked] = useState<{ readonly prefill: NewWorkPrefill | undefined } | undefined>(undefined);
  useEffect(() => {
    if (composerAsked === undefined) return;
    composer.current?.open(composerAsked.prefill);
    setComposerAsked(undefined);
  }, [composerAsked]);
  // Why no work can start (the AI CLI row's word), set once the setup is known; read when New work is asked for.
  const workBlock = useRef<string | undefined>(undefined);
  const openComposer = (prefill?: NewWorkPrefill) => {
    if (workBlock.current !== undefined) return;
    if (composer.current !== null) return composer.current.open(prefill);
    setExpanded(undefined);
    setPage((current) => (current === "needs-you" ? current : "board"));
    setComposerAsked({ prefill });
  };
  // The work page shows the item in the full view in place of the list and its composer.
  const itemShown = (page === "board" || page === "needs-you") && selectedItemId !== undefined;
  // The main process shows no notification about the item the window shows now.
  const shownItemId = itemShown ? selectedItemId : undefined;
  useEffect(() => {
    void bridge.setViewedItem(shownItemId).catch(() => undefined);
  }, [bridge, shownItemId]);
  // A click on a notification: leave the pages that hide the drawer, then show the item. Settings,
  // Insights and About give way to the board; the Needs you page stays.
  useEffect(
    () =>
      bridge.onOpenItem((itemId) => {
        setPage((current) => (current === "needs-you" ? current : "board"));
        selectItem(itemId);
      }),
    [bridge, selectItem],
  );
  const full = itemShown && expanded?.page === page;
  // Read by the Cmd+N listener, which is set up once: it opens New work where a composer shows, and from the full view.
  const newWorkKey = useRef({ open: openComposer, full });
  newWorkKey.current = { open: openComposer, full };
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
  // The full view belongs to one item: closing it or choosing another one ends it.
  if (expanded !== undefined && expanded.itemId !== selectedItemId) setExpanded(undefined);

  const items = useMemo(() => [...(data?.items.values() ?? [])], [data]);
  const counts = data?.counts ?? NO_COUNTS;
  const setup = data?.setup;
  // The engine's startup checks, unless a test gives the issues itself.
  const issues = useMemo(() => cliIssues ?? cliIssuesOf(setup?.health), [cliIssues, setup]);
  // Read once the engine is up: the app's main process may still be reading the login shell's PATH before that.
  const [toolsPath, setToolsPath] = useState<ToolsPathInfo | undefined>(undefined);
  const connected = connection.status === "connected";
  useEffect(() => {
    if (connected) void bridge.getToolsPath().then(setToolsPath, () => undefined);
  }, [bridge, connected]);
  const problems = useMemo(() => healthProblemsOf(setup?.health, toolsPath), [setup, toolsPath]);
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

  // Get started. The checklist takes the place of the empty board until the first item starts (or
  // at once for a user who has work already), and comes back only from Help.
  const [started, setStarted] = useState<GetStartedState>(initial.getStarted);
  // The latest saved value, also between a save and the render that shows it: the item's own event and
  // the window's onStarted can both save in one tick, and neither may drop what the other wrote.
  const startedNow = useRef(started);
  const saveStarted = (next: GetStartedState) => {
    startedNow.current = next;
    setStarted(next);
    save({ getStarted: next });
  };
  const hasWork = items.length > 0 || counts.some((row) => row.done + row.failed > 0);
  const setupDone = started.done || hasWork;
  // Work that exists marks setup done for good, so the list never comes back when the work is gone
  // from the board (the counts reach back 31 days). A user who had work before this version gets
  // it on the first load, with no "Setup done" line; work that appears later (started from the CLI)
  // leaves the line to the first item the window starts itself.
  const firstLoadSeen = useRef(false);
  useEffect(() => {
    if (setup === undefined || stale) return;
    const first = !firstLoadSeen.current;
    firstLoadSeen.current = true;
    if (!startedNow.current.done && hasWork) saveStarted({ ...startedNow.current, done: true, lineClosed: first });
    // `saveStarted` only sets state and saves: it need not re-run this.
  }, [setup, stale, started.done, hasWork]);
  // Opened again from Help > Get started, over the list of work.
  const [helpOpen, setHelpOpen] = useState(false);
  const openHelp = useRef<() => void>(() => undefined);
  useEffect(() => bridge.onOpenGetStarted(() => openHelp.current()), [bridge]);
  useEffect(() => {
    if (page !== "board" || views.view.kind !== "all") setHelpOpen(false);
  }, [page, views.view.kind]);
  const checklistShown = setup !== undefined && page === "board" && (!setupDone || helpOpen);
  // The checks: Check again shows "Checking…" for a moment; the poll while the list is on screen is silent.
  const [checking, setChecking] = useState(false);
  const [checkFailed, setCheckFailed] = useState(false);
  const checkAgain = useCallback(async () => {
    setChecking(true);
    const [answered] = await Promise.all([refreshSetup(), new Promise((done) => setTimeout(done, CHECKING_MIN_MS))]);
    setCheckFailed(!answered);
    setChecking(false);
  }, [refreshSetup]);
  openHelp.current = () => {
    setExpanded(undefined);
    setPage("board");
    views.setView(ALL_WORK);
    setHelpOpen(true);
    void checkAgain();
  };
  useEffect(() => {
    if (!checklistShown) return;
    const timer = setInterval(() => void refreshSetup().then((answered) => setCheckFailed(!answered)), CHECK_POLL_MS);
    return () => clearInterval(timer);
  }, [checklistShown, refreshSetup]);
  // What the first item was, for step 4: from the open items, or asked of the engine once it has ended.
  const [firstRun, setFirstRun] = useState<{ readonly itemId: string; readonly text: string; readonly repoId: string | undefined } | undefined>(undefined);
  const firstId = started.firstItemId;
  const firstOpen = firstId === undefined ? undefined : items.find((item) => item.id === firstId);
  useEffect(() => {
    if (!checklistShown || firstId === undefined || firstRun?.itemId === firstId) return;
    if (firstOpen !== undefined) return setFirstRun({ itemId: firstId, text: firstOpen.text, repoId: firstOpen.repoIds[0] });
    void bridge.query({ type: "item", itemId: firstId }).then(
      (reply) => {
        if (reply.ok) setFirstRun({ itemId: firstId, text: reply.data.item.text, repoId: reply.data.item.repoIds[0] });
      },
      () => undefined,
    );
  }, [bridge, checklistShown, firstId, firstOpen, firstRun?.itemId]);
  // The "Setup done" line stays until it is closed or the first item ends. An item that started in
  // this session may not be in the list yet, so it counts as ended only after it was seen there.
  const lineWatch = useRef<{ readonly itemId: string; seen: boolean } | undefined>(undefined);
  useEffect(() => {
    if (setup === undefined || stale || firstId === undefined || started.lineClosed) return;
    if (lineWatch.current?.itemId !== firstId) lineWatch.current = { itemId: firstId, seen: true };
    const watch = lineWatch.current;
    if (firstOpen !== undefined) watch.seen = true;
    else if (watch.seen) saveStarted({ ...started, lineClosed: true });
  }, [setup, stale, firstId, firstOpen, started.lineClosed]);
  const aiBlock = aiCliBlock(setup?.health);
  workBlock.current = aiBlock;
  const checklistNode =
    checklistShown && setup !== undefined ? (
      <GetStarted
        list={checklist({
          health: setup.health,
          checkFailed,
          checking,
          repos: setup.repos,
          templates: setup.templates,
          started: setupDone,
          firstItem: firstRun === undefined || firstRun.itemId !== firstId ? undefined : { text: firstRun.text, repoId: firstRun.repoId },
          mac: isMac(),
        })}
        checking={checking}
        onCheckAgain={() => void checkAgain()}
        onAddRepo={() => void pickRepoFolder()}
        onStart={(prefill) => openComposer({ ...(prefill.templateId !== undefined && { templateId: prefill.templateId }), repoId: prefill.repoId, text: prefill.text })}
        onAct={(id) => {
          if (id === "open-templates") {
            setSettingsPage("templates");
            setSettingsAgent(undefined);
            setPage("settings");
          } else setEditingRepo(setup.repos[0]?.id);
        }}
        onClose={setupDone ? () => setHelpOpen(false) : undefined}
      />
    ) : undefined;
  const showLine = started.done && !started.lineClosed && firstId !== undefined && page === "board" && !helpOpen;

  // A ready update: a chip at the sidebar's foot, or an icon in the rail while the sidebar is closed.
  // Running items block the restart, so the chip's panel lists them.
  const update = useUpdate(bridge);
  const runningNow = useMemo(() => runningItems(items, setup?.templates), [items, setup]);
  const updateView = update === undefined ? undefined : updateChip(update, runningNow.length);
  const [updatePanel, setUpdatePanel] = useState(false);
  const updateReady = updateView?.kind === "ready";
  useEffect(() => {
    if (!updateReady) setUpdatePanel(false);
  }, [updateReady]);
  // The refusal belongs to the open panel: closing it lets the next click ask again.
  useEffect(() => {
    if (!updatePanel) setUpdateBusy(undefined);
  }, [updatePanel]);
  const openSidebar = () => {
    if (panelOpen) return;
    setPanelOpen(true);
    save({ sidebar: { width: chosen.sidebar, collapsed: false } });
  };
  // Restart now asks the main process, which counts the running items itself. When it finds
  // something running that the window did not list (or cannot tell), the panel says so.
  const [updateBusy, setUpdateBusy] = useState<{ readonly running?: number } | undefined>(undefined);
  const restartForUpdate = async () => {
    const result = await bridge.installUpdate().catch(() => ({ ok: false as const, reason: "failed" as const }));
    if (!result.ok && result.reason === "busy") {
      setUpdateBusy(result.running === undefined ? {} : { running: result.running });
      openSidebar();
      setUpdatePanel(true);
    }
  };
  const activateUpdate = () => {
    // A click on the chip or the rail icon only opens something; restarting is a second, clear button.
    // The installer did not answer: the notice in the sidebar has Restart Tokama, which quits the app.
    openSidebar();
    if (updateView?.kind === "stalled") return;
    setUpdatePanel((open) => (panelOpen ? !open : true));
  };
  const openUpdateNotes = () => void bridge.openUpdateNotes().catch(() => undefined);
  const closeUpdatePanel = useCallback(() => setUpdatePanel(false), []);
  const updateChips: readonly SidebarChipCandidate[] =
    updateView === undefined
      ? []
      : [
          {
            id: "update",
            priority: CHIP_PRIORITY.update,
            node: <UpdateChip view={updateView} running={runningNow} busy={updateBusy} panelOpen={updatePanel} onActivate={activateUpdate} onRestartNow={() => void restartForUpdate()} onClosePanel={closeUpdatePanel} onOpenNotes={openUpdateNotes} />,
          },
        ];

  // Cmd (macOS) or Ctrl (elsewhere) and N open New work from anywhere; the sidebar may be closed, so this lives here.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "n" || !(isMac() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey) || event.altKey || event.shiftKey) return;
      if (composer.current === null && !newWorkKey.current.full) return;
      event.preventDefault();
      newWorkKey.current.open();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  const pickRepoFolder = async () => {
    const path = await bridge.pickFolder().catch(() => null);
    if (path !== null) setAddingRepo(path);
  };
  // The repo dialog's "No AI CLI is ready" line: the dialog closes and the checklist opens, as from Help.
  const openGetStarted = () => {
    setAddingRepo(undefined);
    setEditingRepo(undefined);
    openHelp.current();
  };
  const removeRepo = async (repoId: string) => {
    const reply = await bridge.command({ type: "remove_repo", repoId });
    return reply.ok ? undefined : reply.error.message;
  };
  const startIn = (target: View) => openComposer(target.kind === "workflow" ? { templateId: target.id } : target.kind === "repo" ? { repoId: target.id } : undefined);

  // Pinned below the board and the Needs you page, so New work keeps working from either.
  const composerNode = setup !== undefined && setup.repos.length > 0 && connection.status !== "failed" && aiBlock === undefined && (
    <NewWork
      ref={composer}
      bridge={bridge}
      setup={setup}
      repoId={page === "board" && views.view.kind === "repo" ? views.view.id : undefined}
      onStarted={(itemId, begun) => {
        // The first item ends the checklist; the "Setup done" line follows it until it ends.
        // (The item's own event may have marked setup done already, without a line.)
        if (startedNow.current.firstItemId === undefined && !startedNow.current.lineClosed) {
          lineWatch.current = { itemId, seen: false };
          saveStarted({ done: true, lineClosed: false, firstItemId: itemId });
        }
        // Show the new item where the user is, or in All work when this view would hide it.
        setPage("board");
        views.reveal(inView(begun, views.view) ? views.view : ALL_WORK);
        setSelectedItemId(itemId);
      }}
    />
  );

  if (page === "settings") {
    return (
      <div className="shell">
        <Settings key={settingsPage} bridge={bridge} connection={connection} setup={setup} onBack={() => setPage("board")} {...(settingsPage !== undefined && { initialPage: settingsPage })} {...(settingsAgent !== undefined && { initialAgent: settingsAgent })} />
        {crashPrompt}
      </div>
    );
  }

  // The card and the chip show only inside the sidebar: with it closed, or on the Settings page, nothing shows and nothing is marked as seen.
  const { card, chip } = whatsNew;
  const chips: readonly SidebarChipCandidate[] = [
    ...updateChips,
    ...(chip === undefined
      ? []
      : [
          {
            id: "updated-to",
            priority: CHIP_PRIORITY.updatedTo,
            node: <UpdatedChip key={chip.note.version} version={chip.note.version} kind={chip.kind} onShown={whatsNew.chipShown} onGone={whatsNew.chipGone} onOpen={() => openNotes(chip.note.version)} />,
          },
        ]),
  ];
  // The drawer belongs to the work views. Insights and About hide it; the item stays selected, so
  // going back reopens it. On the page it was opened on, the full view takes the drawer's place.
  const drawerOpen = itemShown && !full;
  const fit = fitPanels(windowWidth, { sidebarOpen: panelOpen, drawerOpen, sidebar: chosen.sidebar, drawer: chosen.drawer });
  const { view } = views;
  const backTo = page === "needs-you" ? TEXT.needsYou : view.kind === "all" ? TEXT.allWork : view.kind === "workflow" ? (setup?.templates.find((entry) => entry.id === view.id)?.name ?? view.id) : view.id;
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
          setSettingsPage(crashMark ? "diagnostics" : undefined);
          setSettingsAgent(undefined);
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
        crashWaiting={crashMark}
        {...(!panelOpen && (updateView?.kind === "ready" || updateView?.kind === "stalled") && { update: { view: updateView, onActivate: activateUpdate, onOpenNotes: openUpdateNotes } })}
      />
      {panelOpen && (
        <Sidebar
          id={PANEL_ID}
          connection={connection}
          setup={setup}
          items={items}
          counts={counts}
          stale={stale}
          now={now}
          view={views.view}
          onSelectView={(view) => {
            setPage("board");
            setExpanded(undefined);
            views.setView(view);
          }}
          collapsed={views.collapsed}
          onToggleSection={views.toggleSection}
          onNewWork={() => openComposer()}
          newWorkBlock={aiBlock}
          onStartIn={startIn}
          onAddRepo={() => void pickRepoFolder()}
          onEditRepo={setEditingRepo}
          onRemoveRepo={removeRepo}
          chips={chips}
          foot={
            card === undefined ? undefined : (
              <WhatsNewCard
                note={card}
                onGotIt={whatsNew.closeCard}
                onSeeAll={() => {
                  whatsNew.closeCard();
                  openNotes(card.version);
                }}
              />
            )
          }
        />
      )}
      {full ? null : aboutOpen ? (
        <About bridge={bridge} connection={connection.status} running={runningNow.length} now={now} onClose={() => setPage("board")} whatsNew={whatsNew.info} openVersion={aboutVersion} />
      ) : page === "insights" ? (
        <Insights
          bridge={bridge}
          connection={connection}
          onRetryConnection={() => void bridge.retryConnection()}
          usage={usage}
          window={usageWindow}
          onWindow={setUsageWindow}
          tool={usageTool}
          onTool={chooseUsageTool}
          setup={setup}
          items={items}
          issues={issues}
          now={now}
          onSelectItem={(itemId) => {
            setPage("board");
            setSelectedItemId(itemId);
          }}
          onNewWork={() => openComposer()}
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
          onRead={(itemId, stepIndex) => openReader(itemId, stepIndex, "page")}
          returnFocusTo={returnToRead}
          onFocusReturned={() => setReturnToRead(undefined)}
          composer={composerNode}
        />
      ) : (
        <MainArea
          bridge={bridge}
          connection={connection}
          loadError={loadError}
          onRetry={retry}
          onRetryConnection={() => void bridge.retryConnection()}
          onRestartEngine={() => void bridge.restartEngine()}
          setup={setup}
          items={items}
          counts={counts}
          now={now}
          views={views}
          selectedItemId={selectedItemId}
          onSelectItem={selectItem}
          onFinish={finishFromRow}
          onDiscard={discardFromRow}
          onOpenAgent={openAgent}
          composer={composerNode}
          checklist={checklistNode === undefined ? undefined : { node: setupDone ? <div className="gs-above">{checklistNode}</div> : checklistNode, where: setupDone ? "above" : "instead" }}
          doneLine={showLine ? <SetupDoneLine workflow={setup?.templates.find((template) => template.id === firstOpen?.templateId)?.name} onClose={() => saveStarted({ ...started, lineClosed: true })} /> : undefined}
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
          onOpenGetStarted={openGetStarted}
        />
      )}
      {crashPrompt}
      {setUpNote !== undefined && <RepoNote note={setUpNote} onStart={() => startIn({ kind: "repo", id: setUpNote.id })} onDismiss={() => setSetUpNote(undefined)} />}
      {editedRepo !== undefined && <RepoDialog bridge={bridge} repo={editedRepo} onClose={() => setEditingRepo(undefined)} onOpenGetStarted={openGetStarted} />}
      {itemShown && (
        <ItemDrawer
          bridge={bridge}
          itemId={selectedItemId}
          setup={setup}
          diffAsked={diffAsked}
          onClose={() => selectItem(undefined)}
          onCheckAgain={refreshSetup}
          onOpenAgent={openAgent}
          request={rowRequest?.itemId === selectedItemId ? rowRequest : undefined}
          onExpand={() => {
            void bridge.countUsage("expand_view").catch(() => undefined);
            setExpanded({ itemId: selectedItemId, page: page === "needs-you" ? "needs-you" : "board" });
          }}
          onRead={(stepIndex) => openReader(selectedItemId, stepIndex, "drawer")}
          expanded={
            full
              ? {
                  back: backTo,
                  wide: windowWidth - RAIL_WIDTH - fit.sidebar >= SIDE_BY_SIDE_MIN_WIDTH,
                  reader: expanded?.reader,
                  onCollapse: closeReader,
                  onShowAll: () => setExpanded((current) => current && { itemId: current.itemId, page: current.page }),
                }
              : undefined
          }
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
