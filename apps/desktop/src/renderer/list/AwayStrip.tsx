// "While you were away": one strip at the top of All work, shown when the user comes back after 15
// minutes or more and something asked, ended or failed since they last saw the list. Closed it is
// one line of counts; open it lists what asks, what finished and what failed, five lines each, and
// ends with what still runs. Every line is the item's own sentence (see away-model.ts); nothing is
// written here and no AI is used. Got it ends the strip until the user is away again. Engine text
// (titles, questions, names) is rendered as React text only.
import type { FinishAction, ItemRecord, Setup } from "@tokama/core";
import { Fragment, type ReactNode, useEffect, useState } from "react";
import type { TokamaBridge } from "../../shared/bridge.js";
import { AgentBadge } from "../agent/AgentBadge.js";
import { agentInfo } from "../agent/agent-info.js";
import { templateOf } from "../drawer/describe.js";
import { finishActions } from "../drawer/finish-view.js";
import { formatDuration } from "../format/duration.js";
import { clock } from "../format/time.js";
import { currentStep, type Filter, rowLine } from "../model.js";
import type { AgentTarget } from "../settings/describe.js";
import { AgentName } from "../ui/agent.js";
import { Button } from "../ui/Button.js";
import { Facts } from "../ui/Facts.js";
import { markOf, StatusMark } from "../ui/status.js";
import { type AwayGroup, awayLine, awayModel } from "./away-model.js";
import { RowFinish } from "./RowFinish.js";
import { useAway } from "./useAway.js";
import { useWorkList } from "./useWorkList.js";

const needsMark = markOf("needs_you");
const finishedMark = markOf("done", "finished");
const failedMark = markOf("failed");

const TEXT = {
  title: "While you were away",
  show: "Show",
  hide: "Hide",
  gotIt: "Got it",
  needsYou: "Needs you",
  finished: "Finished",
  failed: "Failed",
  stillRunning: "Still running:",
  to: (from: string, back: string) => `${from} to ${back}`,
  needCount: (count: number) => `${count} ${count === 1 ? "needs" : "need"} you`,
  finishedCount: (count: number) => `${count} finished`,
  failedCount: (count: number) => `${count} failed`,
  runningCount: (count: number) => `${count} still running`,
  more: (count: number) => `and ${count} more`,
  openQuestion: "Open the question",
  open: "Open",
} as const;

export interface AwayStripProps {
  readonly bridge: TokamaBridge;
  readonly connected: boolean;
  readonly setup: Setup;
  /** The open items of the board. */
  readonly open: readonly ItemRecord[];
  readonly now: number;
  /** Opens an item in the drawer. */
  readonly onSelectItem: (itemId: string) => void;
  /** "and N more" switches the list to the group. */
  readonly onFilter: (patch: Partial<Filter>) => void;
  readonly onFinish?: ((itemId: string, action: FinishAction) => void | Promise<void>) | undefined;
  readonly onDiscard?: ((itemId: string) => void) | undefined;
  readonly onOpenAgent?: ((agent: AgentTarget) => void) | undefined;
}

/** The strip, or nothing: the user was not away, pressed Got it, or nothing asked, ended or failed. */
export function AwayStrip(props: AwayStripProps) {
  const away = useAway(props.bridge);
  if (away.info === undefined || !away.info.due) return null;
  return <Strip {...props} seenUntil={away.info.seenUntil} backAt={away.info.backAt ?? props.now} onGotIt={away.close} />;
}

interface StripProps extends AwayStripProps {
  readonly seenUntil: number;
  readonly backAt: number;
  readonly onGotIt: () => void;
}

function Strip({ bridge, connected, setup, open: openItems, now, onSelectItem, onFilter, onFinish, onDiscard, onOpenAgent, seenUntil, backAt, onGotIt }: StripProps) {
  const [shown, setShown] = useState(false);
  // Finished and failed items come from the engine by the time they ended, not the day they started.
  const list = useWorkList(bridge, connected, [
    { group: "done", endedAfter: seenUntil },
    { group: "failed", endedAfter: seenUntil },
  ]);
  const done = list.pages.get("done");
  const failed = list.pages.get("failed");
  const model = awayModel({ seenUntil, open: openItems, done, failed });
  // Nothing asked, ended or failed once both lists are in: there is nothing to dismiss, so the due state ends here and
  // does not show news from a later time as if the user had been away for it.
  const loaded = [done, failed].every((page) => page !== undefined && page.total !== undefined && page.loading === undefined && page.failed === undefined);
  const empty = loaded && !model.news;
  useEffect(() => {
    if (empty) onGotIt();
  }, [empty, onGotIt]);
  if (!model.news) return null;
  const away = formatDuration(backAt - seenUntil, "coarse");
  const oldest = model.needs.shown[0]?.id;
  const counts = [
    model.needs.count > 0 && { key: "needs", mark: needsMark, text: TEXT.needCount(model.needs.count) },
    model.finished.count > 0 && { key: "finished", mark: finishedMark, text: TEXT.finishedCount(model.finished.count) },
    model.failed.count > 0 && { key: "failed", mark: failedMark, text: TEXT.failedCount(model.failed.count) },
  ].filter((entry) => entry !== false);
  const line = (item: ItemRecord, mark: typeof needsMark) => (
    <Line key={item.id} item={item} mark={mark} setup={setup} primary={item.id === oldest} onSelectItem={onSelectItem} onFinish={onFinish} onDiscard={onDiscard} />
  );
  const more = (count: number, status: "needs" | "done" | "failed") => (
    <Button variant="link" className="away-more" onClick={() => onFilter({ status, range: "all" })}>
      {TEXT.more(count)}
    </Button>
  );
  return (
    <section className="away" aria-label={TEXT.title}>
      <div className="away-head">
        <span className="away-title">{TEXT.title}</span>
        <span className="away-for mono">{shown ? TEXT.to(clock(seenUntil), clock(backAt)) + ` · ${away}` : away}</span>
        {!shown && (
          <>
            {counts.map((entry) => (
              <span key={entry.key} className="away-count" data-tone={entry.mark.tone}>
                <span aria-hidden="true">{entry.mark.symbol}</span> {entry.text}
              </span>
            ))}
            {model.running.count > 0 && <span className="away-count">{TEXT.runningCount(model.running.count)}</span>}
          </>
        )}
        <span className="away-actions">
          <Button variant={shown ? "secondary" : "primary"} aria-expanded={shown} onClick={() => setShown(!shown)}>
            {shown ? TEXT.hide : TEXT.show}
          </Button>
          <Button variant="secondary" onClick={onGotIt}>
            {TEXT.gotIt}
          </Button>
        </span>
      </div>
      {shown && (
        <div className="away-body">
          <Block name={TEXT.needsYou} mark={needsMark} group={model.needs} more={(count) => more(count, "needs")}>
            {model.needs.shown.map((item) => line(item, needsMark))}
          </Block>
          <Block name={TEXT.finished} mark={finishedMark} group={model.finished} more={(count) => more(count, "done")}>
            {model.finished.shown.map((item) => line(item, finishedMark))}
          </Block>
          <Block name={TEXT.failed} mark={failedMark} group={model.failed} more={(count) => more(count, "failed")}>
            {model.failed.shown.map((item) => line(item, failedMark))}
          </Block>
          {model.running.count > 0 && (
            <p className="away-running">
              {TEXT.stillRunning}{" "}
              {model.running.shown.map((item, index) => (
                <Fragment key={item.id}>
                  {index > 0 && <span aria-hidden="true"> · </span>}
                  <Running item={item} setup={setup} now={now} onOpenAgent={onOpenAgent} />
                </Fragment>
              ))}
              {model.running.count > model.running.shown.length && (
                <>
                  <span aria-hidden="true"> · </span>
                  <Button variant="link" className="away-more" onClick={() => onFilter({ status: "active" })}>
                    {TEXT.more(model.running.count - model.running.shown.length)}
                  </Button>
                </>
              )}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

/** One group: its heading with the count, its lines, and "and N more" when there are more. */
function Block({ name, mark, group, more, children }: { readonly name: string; readonly mark: typeof needsMark; readonly group: AwayGroup; readonly more: (count: number) => ReactNode; readonly children: ReactNode }) {
  if (group.count === 0) return null;
  return (
    <section className="away-group" aria-label={name}>
      <h3 className="away-group-heading">
        <span className="away-mark" data-tone={mark.tone} aria-hidden="true">
          {mark.symbol}
        </span>
        {name}
        <span className="away-group-count mono">{group.count}</span>
      </h3>
      <ul className="away-lines">{children}</ul>
      {group.count > group.shown.length && <div className="away-group-more">{more(group.count - group.shown.length)}</div>}
    </section>
  );
}

interface LineProps {
  readonly item: ItemRecord;
  readonly mark: typeof needsMark;
  readonly setup: Setup;
  /** The oldest question: the strip's one filled button. */
  readonly primary: boolean;
  readonly onSelectItem: (itemId: string) => void;
  readonly onFinish: ((itemId: string, action: FinishAction) => void | Promise<void>) | undefined;
  readonly onDiscard: ((itemId: string) => void) | undefined;
}

function Line({ item, mark, setup, primary, onSelectItem, onFinish, onDiscard }: LineProps) {
  const { text, facts } = awayLine(item);
  const asking = item.state === "needs_you";
  const merge = onFinish !== undefined && onDiscard !== undefined && finishActions(item).includes("merge");
  const repos = item.repoIds.join(", ");
  return (
    <li className="away-line">
      <StatusMark status={mark} className="away-mark" word="spoken" />
      <div className="away-line-body">
        <div className="away-line-top">
          <span className="away-line-title">{item.title}</span>
          <span className="away-line-src">
            {templateOf(item, setup)?.name ?? item.templateId}
            {repos === "" ? "" : ` · ${repos}`}
          </span>
        </div>
        {text !== undefined && <p className="away-line-text">{text}</p>}
        {facts.length > 0 && <Facts facts={facts} className="away-line-facts" />}
      </div>
      <div className="away-line-actions">
        {merge ? (
          <RowFinish item={item} setup={setup} onFinish={onFinish} onDiscard={onDiscard} />
        ) : (
          <Button variant={asking && primary ? "primary" : "secondary"} onClick={() => onSelectItem(item.id)} aria-label={`${asking ? TEXT.openQuestion : TEXT.open}: ${item.title}`}>
            {asking ? TEXT.openQuestion : TEXT.open}
          </Button>
        )}
      </div>
    </li>
  );
}

/** A running item in the closing sentence: the working agent's badge, the title, and where it is. */
function Running({ item, setup, now, onOpenAgent }: { readonly item: ItemRecord; readonly setup: Setup; readonly now: number; readonly onOpenAgent: ((agent: AgentTarget) => void) | undefined }) {
  const where = rowLine(item, setup.agents);
  const info = agentInfo(item, currentStep(item) ?? 0, setup);
  return (
    <span className="away-run">
      {info !== undefined && <AgentBadge info={info} stepName={where?.stepName} since={where?.since} className="away-badge" onOpen={onOpenAgent} />}
      <span className="away-run-title">{item.title}</span>
      {where !== undefined && (
        <>
          {" "}
          ({where.stepName}
          {where.since === undefined ? "" : `, ${formatDuration(now - where.since, "coarse")}`} · <AgentName name={where.agent.name} hue={where.agent.hue} />)
        </>
      )}
    </span>
  );
}
