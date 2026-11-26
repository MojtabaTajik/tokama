// The Diff tab of an ended item: the header lines (where the work is now, what the diff is compared
// with) above the same file list and diff as a decision's. A discarded item and a merged commit
// that is gone show the header only. Engine text (paths, branches, the diff) is React text only.
import type { ItemRecord } from "@tokama/core";
import { Fragment } from "react";
import { DiffTab, type DiffLayout } from "../ui/DiffView.js";
import { StatusMark } from "../ui/status.js";
import { Text } from "./Finish.js";
import { diffHeader, type DiffHeader, type ItemDiffState } from "./item-diff-view.js";

const CODE = "mono dv-branch dv-strong";

function Header({ header }: { readonly header: DiffHeader }) {
  return (
    <div className="dv-head">
      <p className="dv-head-line">
        <StatusMark status={header.mark} />
        <span className="dv-strong">
          <Text parts={header.head} codeClass={CODE} />
        </span>
        {header.details.map((detail, index) => (
          <Fragment key={index}>
            <span aria-hidden="true">·</span>
            <span>
              <Text parts={detail} codeClass={CODE} />
            </span>
          </Fragment>
        ))}
      </p>
      {header.sub !== undefined && <p className="dv-head-sub">{header.sub}</p>}
    </div>
  );
}

export interface ItemDiffTabProps {
  readonly item: Pick<ItemRecord, "state" | "finish" | "outcome">;
  readonly state: ItemDiffState;
  /** The repo's base branch, for a change not merged yet. */
  readonly baseBranch: string | undefined;
  readonly layout: DiffLayout;
  readonly onExpand?: (() => void) | undefined;
}

export function ItemDiffTab({ item, state, baseBranch, layout, onExpand }: ItemDiffTabProps) {
  if (state.kind === "loading" || state.kind === "failed") return <DiffTab state={state} baseBranch={baseBranch} layout={layout} />;
  const header = diffHeader(item, state, baseBranch);
  if (header === undefined) return null;
  if (state.kind === "discarded" || (state.change.kind !== "worktree" && state.change.kind !== "merged")) {
    return (
      <div className="dv" data-layout={layout}>
        <Header header={header} />
      </div>
    );
  }
  const { change } = state;
  return (
    <DiffTab
      key={change.kind === "merged" ? change.commit : change.worktree.branch}
      state={{ kind: "loaded", diff: change }}
      baseBranch={baseBranch}
      layout={layout}
      onExpand={onExpand}
      header={<Header header={header} />}
      {...(header.columns !== undefined && { columns: header.columns })}
      where={change.kind === "merged" ? { repoId: change.repoId } : { repoId: change.worktree.repoId, dir: change.worktree.dir }}
    />
  );
}
