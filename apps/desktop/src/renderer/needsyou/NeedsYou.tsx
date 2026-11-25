// The Needs you page: every decision waiting for the engineer across all items, oldest first.
// A row shows the kind of decision, the item, its workflow and step, the agent, how long ago the
// item started and the decision's own choice buttons; a choice sends the same `resolve_decision`
// command as the drawer. The title opens the drawer. A step you approve shows the first lines of
// what its agent wrote. Engine text (titles, questions, summaries, names, agent output) is
// rendered as React text only.
import type { ItemRecord, Setup } from "@tokama/core";
import { type MouseEvent, type ReactNode, useLayoutEffect, useRef, useState } from "react";
import type { ConnectionState, TokamaBridge } from "../../shared/bridge.js";
import { DecisionChoices } from "../drawer/DecisionChoices.js";
import { nextRunLine } from "../drawer/describe.js";
import { ChangedFiles, useDecisionDiff } from "../drawer/DiffView.js";
import { type Notice, problem, REFRESH_ON } from "../drawer/ItemDrawer.js";
import { previewOf, useStepOutput } from "../drawer/StepOutput.js";
import { ConnectionFailure } from "../shell/ConnectionStatus.js";
import { TemplateIcon } from "../shell/TemplateIcon.js";
import { type NeedsYouRow, needsYouRows } from "./rows.js";

const TEXT = {
  title: "Needs you",
  list: "Decisions waiting for you",
  empty: "Nothing is waiting for you",
  emptyHint: "When an agent needs a decision from you, it shows up here.",
  loading: "Loading",
  starting: "Starting the engine",
  reconnecting: "Reconnecting to the engine",
  loadFailed: "Could not load the setup and items",
  staleFailed: "Could not refresh the list. It may be out of date",
  retry: "Retry",
  noQuestion: "This item waits for you, but the engine sent no question yet.",
  willBeSent: "Will be sent",
  notSentYet: "Nothing has been sent yet",
  waiting: (count: number) => `${count} waiting`,
  oldest: (since: string) => `oldest item started ${since} ago`,
  started: (since: string) => `started ${since} ago`,
  review: "Review the diff",
  readPlan: "Read the plan",
  readOutput: "Read the output",
} as const;

export interface NeedsYouProps {
  readonly bridge: TokamaBridge;
  readonly connection: ConnectionState;
  readonly loadError: string | undefined;
  /** The last load failed and the items are from an earlier one. */
  readonly stale: boolean;
  /** Loads the setup and items again. */
  readonly onRetry: () => void;
  readonly onRetryConnection: () => void;
  /** Undefined until the first load. */
  readonly setup: Setup | undefined;
  readonly items: readonly ItemRecord[];
  readonly now: number;
  readonly selectedItemId: string | undefined;
  readonly onSelectItem: (itemId: string) => void;
  /** Opens the item's drawer on its Diff tab. */
  readonly onReviewDiff: (itemId: string) => void;
  /** Pinned below the list: the New work input, so it keeps working from this page. */
  readonly composer?: ReactNode;
}

export function NeedsYou(props: NeedsYouProps) {
  const { connection, loadError, stale, onRetry, onRetryConnection, setup, items, now, composer } = props;
  const rows = needsYouRows(items, setup, now);
  const page = useRef<HTMLElement>(null);
  const focusedAt = useRef<number | undefined>(undefined);
  // An answered row goes away with the button that had focus: focus moves to the row now at that
  // place, or to the page when none is left, instead of dropping to the document.
  useLayoutEffect(() => {
    if (focusedAt.current === undefined || (document.activeElement !== document.body && document.activeElement !== null)) return;
    const titles = [...(page.current?.querySelectorAll<HTMLElement>(".nr-title") ?? [])];
    (titles[Math.min(focusedAt.current, titles.length - 1)] ?? page.current)?.focus();
  });
  const track = (event: { readonly target: EventTarget }) => {
    const row = (event.target as Element).closest<HTMLElement>("[data-row]");
    focusedAt.current = row === null ? undefined : Number(row.dataset["row"]);
  };

  const loaded = setup !== undefined;
  const oldest = rows[0];
  return (
    <main className="main" tabIndex={-1} ref={page} onFocus={track}>
      <header className="main-header">
        <h1 className="ellipsis">{TEXT.title}</h1>
        {loaded && (
          <span className="summary mono">{oldest === undefined ? TEXT.waiting(0) : `${TEXT.waiting(rows.length)} · ${TEXT.oldest(oldest.since)}`}</span>
        )}
      </header>
      <section className="board" aria-label={TEXT.title}>
        {connection.status === "failed" ? (
          <ConnectionFailure state={connection} onRetry={onRetryConnection} />
        ) : (
          <>
            {loadError !== undefined && <LoadFailure message={loadError} text={stale ? TEXT.staleFailed : TEXT.loadFailed} onRetry={onRetry} />}
            {!loaded ? (
              loadError === undefined && <p className="placeholder">{connection.status === "starting" ? TEXT.starting : connection.status === "reconnecting" ? TEXT.reconnecting : TEXT.loading}</p>
            ) : rows.length === 0 ? (
              // An empty list from an earlier load is no all-clear.
              !stale && (
                <section className="state" aria-label={TEXT.empty}>
                  <h2 className="state-title">{TEXT.empty}</h2>
                  <p className="state-text">{TEXT.emptyHint}</p>
                </section>
              )
            ) : (
              <ol className="nr-list" aria-label={TEXT.list}>
                {rows.map((row, index) => (
                  <Row key={row.item.id} row={row} index={index} bridge={props.bridge} selected={row.item.id === props.selectedItemId} onSelect={props.onSelectItem} onReviewDiff={props.onReviewDiff} onRefresh={onRetry} />
                ))}
              </ol>
            )}
          </>
        )}
      </section>
      {composer}
    </main>
  );
}

function LoadFailure({ message, text, onRetry }: { readonly message: string; readonly text: string; readonly onRetry: () => void }) {
  return (
    <div className="failure" role="alert">
      <p className="failure-title">
        <span className="symbol" aria-hidden="true">
          ✕
        </span>
        {text}
      </p>
      <p className="detail">{message}</p>
      <button type="button" className="retry" onClick={onRetry}>
        {TEXT.retry}
      </button>
    </div>
  );
}

interface RowProps {
  readonly row: NeedsYouRow;
  readonly index: number;
  readonly bridge: TokamaBridge;
  readonly selected: boolean;
  readonly onSelect: (itemId: string) => void;
  readonly onReviewDiff: (itemId: string) => void;
  readonly onRefresh: () => void;
}

function Row({ row, index, bridge, selected, onSelect, onReviewDiff, onRefresh }: RowProps) {
  const { item, decision } = row;
  const [busy, setBusy] = useState(false);
  const diff = useDecisionDiff(bridge, item.id, decision);
  const approval = decision?.kind === "plan_approval" ? decision : undefined;
  const output = useStepOutput(bridge, item.id, approval?.stepIndex ?? 0, undefined, approval?.id);
  const preview = output?.kind === "loaded" ? previewOf(output.output.text) : "";
  const read = approval?.hasDiff === true ? TEXT.readOutput : TEXT.readPlan;
  const [notice, setNotice] = useState<Notice | undefined>(undefined);
  // The row can be gone when the reply arrives (the answer worked and the item moved on).
  const mounted = useRef(true);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const choose = async (choice: string, note?: string) => {
    if (decision === undefined) return;
    setBusy(true);
    setNotice(undefined);
    const reply = await bridge
      .command({ type: "resolve_decision", itemId: item.id, decisionId: decision.id, choice, ...(note !== undefined && { note }) })
      .catch((cause: unknown) => ({ ok: false as const, error: { code: "bridge_error", message: String(cause) } }));
    if (!mounted.current) return;
    setBusy(false);
    if (reply.ok) return;
    setNotice(problem(reply.error.code, reply.error.message));
    if (REFRESH_ON.has(reply.error.code)) onRefresh();
  };
  // A click on the row's free space selects it as the title does; buttons and the summary keep their own clicks.
  const onRowClick = (event: MouseEvent<HTMLElement>) => {
    if ((event.target as Element).closest("button, pre, textarea, form") === null) onSelect(item.id);
  };

  return (
    // The title button is the keyboard way in; the click on the row is a convenience for the pointer.
    <li className="nr-row" data-row={index} aria-current={selected ? "true" : undefined} onClick={onRowClick}>
      <p className="nr-top">
        <span className="nr-kind">
          <span aria-hidden="true">⏸</span> {row.kind}
        </span>
        <span className="nr-workflow">
          <TemplateIcon icon={row.workflow.icon} color={row.workflow.color} />
          <span className="ellipsis">{row.workflow.name}</span>
        </span>
        <span className="nr-time mono" title={row.sinceTitle}>
          {TEXT.started(row.since)}
        </span>
      </p>
      <button type="button" className="nr-title" data-item-id={item.id} aria-current={selected ? "true" : undefined} onClick={() => onSelect(item.id)}>
        {item.title}
      </button>
      <p className="nr-where">
        {row.stepLine !== undefined && <span className="mono">{row.stepLine}</span>}
        {row.agent !== undefined && (
          <span className="nr-agent">
            <span className="agent-dot" data-agent={row.agent.dot} aria-hidden="true" />
            {row.agent.name}
            {row.cli !== undefined && <span className="mono nr-cli">{row.cli}</span>}
          </span>
        )}
      </p>
      <p className="nr-question">{decision?.question ?? TEXT.noQuestion}</p>
      {decision?.summaryText !== undefined && (
        <div className="cloud-summary">
          <p className="cloud-summary-label">
            <span>{TEXT.willBeSent}</span>
            <span className="nr-muted">{TEXT.notSentYet}</span>
          </p>
          {/* Focusable, so a long summary can be scrolled with the keyboard. */}
          <pre className="cloud-summary-text mono" tabIndex={0} aria-label={`${TEXT.willBeSent}: ${item.title}`}>
            {decision.summaryText}
          </pre>
        </div>
      )}
      {preview !== "" && (
        <div className="nr-output">
          <p className="nr-preview">{preview}</p>
          <button type="button" className="nr-read" aria-label={`${read}: ${item.title}`} onClick={() => onSelect(item.id)}>
            {read}
          </button>
        </div>
      )}
      {diff !== undefined && <ChangedFiles state={diff} context={item.title} />}
      {notice !== undefined && (
        <p className="drawer-notice" data-tone={notice.tone} role="status">
          <span className="symbol" aria-hidden="true">
            {notice.tone === "warn" ? "!" : "✕"}
          </span>
          {notice.text}
        </p>
      )}
      {decision !== undefined && (
        <DecisionChoices
          key={decision.id}
          decision={decision}
          busy={busy}
          context={item.title}
          agent={row.agent?.name}
          run={nextRunLine(item.steps[decision.stepIndex])}
          extra={
            decision.hasDiff === true ? (
              <button type="button" className="link nr-review" aria-label={`${TEXT.review}: ${item.title}`} onClick={() => onReviewDiff(item.id)}>
                {TEXT.review}
              </button>
            ) : undefined
          }
          onChoose={(choice, note) => void choose(choice, note)}
        />
      )}
    </li>
  );
}
