// Settings > Repos: every repo Tokama works in, with its path, base branch and checks. A list on
// the left (with the sidebar's badges), the selected repo on the right. Add, Edit and Remove use
// the sidebar's dialogs and the engine's repo commands. Engine text (ids, paths, commands) is
// rendered as React text only, never as HTML.
import type { BoardCount, ItemRecord, RepoSummary, Setup } from "@tokama/core";
import { useEffect, useRef, useState } from "react";
import type { ConnectionState, TokamaBridge } from "../../shared/bridge.js";
import { badgesOf, finishedIn, inView, needsYouCount, runningCount } from "../model.js";
import { RemoveRepoDialog } from "../repos/RemoveRepoDialog.js";
import { RepoDialog } from "../repos/RepoDialog.js";
import { ConnectionFailure } from "../shell/ConnectionStatus.js";
import { RepoIcon } from "../ui/icons.js";
import { useRepoItems } from "./useRepoItems.js";
import { Button } from "../ui/Button.js";
import { StatusCounts } from "../ui/Badge.js";
import { EmptyState } from "../ui/EmptyState.js";

const TEXT = {
  heading: "Repos",
  hint: "The folders Tokama works in.",
  addHeader: "+ Add repo",
  list: "Repo list",
  noChecks: "no checks",
  path: "Path",
  baseBranch: "Base branch",
  baseBranchHint: "Work branches start from it.",
  setup: "Setup command",
  setupHint: "Runs once in every new worktree, before the checks. A template's own setup command replaces it.",
  noSetup: "None. The checks run in the worktree as it comes from git.",
  checks: "Checks",
  checksHint: "Tokama runs these in order after each change. A change passes when every one exits with 0.",
  noChecksNote: "Quick fix needs at least one check. Templates where you approve the change, like Quick change, work without checks.",
  edit: "Edit…",
  remove: "Remove…",
  emptyTitle: "No repos added yet",
  emptyText: "Add the folders of the repos you work on. Tokama reads each one and suggests the base branch and checks.",
  addEmpty: "Add repo",
  doneThisWeek: (count: number) => `${count} done this week`,
  starting: "Starting the engine",
  reconnecting: "Reconnecting to the engine",
  loading: "Loading",
} as const;

const checksLabel = (count: number) => (count === 0 ? TEXT.noChecks : count === 1 ? "1 check" : `${count} checks`);

/** "2 need you · 2 running · 6 done this week": the badges' counts, then what finished in the last 7 days. */
function itemsLine(items: readonly ItemRecord[], counts: readonly BoardCount[], now: number): string {
  const running = runningCount(items);
  const parts = [...badgesOf(items, counts, now).map((badge) => `${badge.count} ${badge.word}`), ...(running > 0 ? [`${running} running`] : [])];
  const done = finishedIn(counts, "7d", now).done;
  if (done > 0) parts.push(TEXT.doneThisWeek(done));
  return parts.join(" · ");
}

export interface ReposPageProps {
  readonly bridge: TokamaBridge;
  readonly connection: ConnectionState;
  readonly setup: Setup | undefined;
  /** A fixed time for tests; otherwise the clock. */
  readonly now?: number;
}

export function ReposPage({ bridge, connection, setup, now: fixedNow }: ReposPageProps) {
  const { items, counts } = useRepoItems(bridge, connection, setup);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  // The folder the picker returned, while the Add repo dialog is open.
  const [adding, setAdding] = useState<string | undefined>(undefined);
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const addButton = useRef<HTMLButtonElement>(null);
  const repos = setup?.repos ?? [];
  // A removed repo's buttons go with it: "+ Add repo" takes the focus instead of the page.
  const lastCount = useRef(repos.length);
  useEffect(() => {
    const shrank = repos.length < lastCount.current;
    lastCount.current = repos.length;
    if (shrank && (document.activeElement === null || document.activeElement === document.body)) addButton.current?.focus();
  }, [repos.length]);

  // A dialog does not wait for the engine to come back: a lost connection closes it.
  const connected = connection.status === "connected";
  useEffect(() => {
    if (connected) return;
    setAdding(undefined);
    setEditing(false);
    setRemoving(false);
  }, [connected]);

  if (connection.status === "failed") {
    return (
      <section className="rp-page" aria-label={TEXT.heading}>
        <div className="rp-state">
          <ConnectionFailure state={connection} onRetry={() => void bridge.retryConnection()} />
        </div>
      </section>
    );
  }
  if (connection.status !== "connected" || setup === undefined) {
    const words = connection.status === "starting" ? TEXT.starting : connection.status === "reconnecting" ? TEXT.reconnecting : TEXT.loading;
    return (
      <section className="rp-page" aria-label={TEXT.heading}>
        <p className="placeholder rp-state">{words}</p>
      </section>
    );
  }

  const now = fixedNow ?? Date.now();
  const index = repos.findIndex((repo) => repo.id === selectedId);
  const selected = repos[Math.max(index, 0)];
  const itemsOf = (repo: RepoSummary) => items.filter((item) => inView(item, { kind: "repo", id: repo.id }));
  const countsOf = (repo: RepoSummary) => counts.filter((row) => inView(row, { kind: "repo", id: repo.id }));
  const pickFolder = async () => {
    const path = await bridge.pickFolder().catch(() => null);
    if (path !== null) setAdding(path);
  };
  const removeSelected = async (repo: RepoSummary): Promise<string | undefined> => {
    const reply = await bridge.command({ type: "remove_repo", repoId: repo.id });
    if (!reply.ok) return reply.error.message;
    const at = repos.indexOf(repo);
    setSelectedId((repos[at + 1] ?? repos[at - 1])?.id);
    return undefined;
  };

  return (
    <section className="rp-page" aria-label={TEXT.heading}>
      <div className="rp-list-pane">
        <h2 className="settings-heading">{TEXT.heading}</h2>
        <p className="rp-list-hint">{TEXT.hint}</p>
        <Button variant="plain" ref={addButton} className="rp-add" onClick={() => void pickFolder()}>
          {TEXT.addHeader}
        </Button>
        <ul className="rp-list" aria-label={TEXT.list}>
          {repos.map((repo) => (
            <li key={repo.id}>
              <Button variant="plain" className="rp-row" aria-pressed={repo.id === selected?.id} onClick={() => setSelectedId(repo.id)}>
                <span className="rp-row-top">
                  <span className="rp-row-id mono ellipsis" title={repo.id}>
                    {repo.id}
                  </span>
                  <StatusCounts counts={badgesOf(itemsOf(repo), countsOf(repo), now)} />
                </span>
                {repo.path !== undefined && (
                  <span className="rp-row-path mono ellipsis" title={repo.path}>
                    {repo.path}
                  </span>
                )}
                <span className="rp-row-meta">
                  <span className="mono ellipsis" title={repo.baseBranch}>
                    {repo.baseBranch}
                  </span>
                  <span className="rp-row-checks">{` · ${checksLabel(repo.checks.length)}`}</span>
                </span>
              </Button>
            </li>
          ))}
        </ul>
      </div>
      <div className="rp-pane">
        {selected === undefined ? (
          <EmptyState
            className="rp-empty"
            icon={<RepoIcon size={22} />}
            title={TEXT.emptyTitle}
            text={TEXT.emptyText}
            action={
              <Button variant="primary" size="lg" onClick={() => void pickFolder()}>
                {TEXT.addEmpty}
              </Button>
            }
          />
        ) : (
          <Detail repo={selected} line={itemsLine(itemsOf(selected), countsOf(selected), now)} onEdit={() => setEditing(true)} onRemove={() => setRemoving(true)} />
        )}
      </div>
      {adding !== undefined && (
        <RepoDialog
          bridge={bridge}
          path={adding}
          onClose={() => setAdding(undefined)}
          onPickAnother={() => {
            setAdding(undefined);
            void pickFolder();
          }}
        />
      )}
      {editing && selected !== undefined && <RepoDialog bridge={bridge} repo={selected} onClose={() => setEditing(false)} />}
      {removing && selected !== undefined && (
        <RemoveRepoDialog name={selected.id} waiting={needsYouCount(itemsOf(selected))} onRemove={() => removeSelected(selected)} onClose={() => setRemoving(false)} />
      )}
    </section>
  );
}


interface DetailProps {
  readonly repo: RepoSummary;
  readonly line: string;
  readonly onEdit: () => void;
  readonly onRemove: () => void;
}

function Detail({ repo, line, onEdit, onRemove }: DetailProps) {
  return (
    <article className="rp-detail" aria-label={repo.id}>
      <header className="rp-head">
        <span className="rp-icon">
          <RepoIcon size={20} />
        </span>
        <div className="rp-head-text">
          <h2 className="mono ellipsis" title={repo.id}>
            {repo.id}
          </h2>
          {line !== "" && <p>{line}</p>}
        </div>
      </header>
      {repo.path !== undefined && (
        <div className="rp-field">
          <h3>{TEXT.path}</h3>
          <p className="rp-value mono ellipsis" title={repo.path}>
            {repo.path}
          </p>
        </div>
      )}
      <div className="rp-field">
        <h3>{TEXT.baseBranch}</h3>
        <p className="rp-hint">{TEXT.baseBranchHint}</p>
        <p className="rp-value mono ellipsis" title={repo.baseBranch}>
          {repo.baseBranch}
        </p>
      </div>
      <div className="rp-field">
        <h3>{TEXT.setup}</h3>
        {repo.setup !== undefined ? (
          <>
            <p className="rp-hint">{TEXT.setupHint}</p>
            <p className="rp-value rp-whole mono">{repo.setup}</p>
          </>
        ) : (
          <p className="rp-note">{TEXT.noSetup}</p>
        )}
      </div>
      <div className="rp-field">
        <h3>
          {TEXT.checks} <span className="rp-count">{checksLabel(repo.checks.length)}</span>
        </h3>
        {repo.checks.length > 0 ? (
          <>
            <p className="rp-hint">{TEXT.checksHint}</p>
            <ol className="rp-checks mono" aria-label={TEXT.checks}>
              {repo.checks.map((check, at) => (
                <li key={at}>
                  <span className="rp-check-n" aria-hidden="true">
                    {at + 1}
                  </span>
                  <span className="ellipsis" title={check}>
                    {check}
                  </span>
                </li>
              ))}
            </ol>
          </>
        ) : (
          <p className="rp-note">{TEXT.noChecksNote}</p>
        )}
      </div>
      {repo.sample !== true && (
        <div className="rp-actions">
          <Button variant="secondary" size="lg" onClick={onEdit}>
            {TEXT.edit}
          </Button>
          <Button variant="danger" size="lg" onClick={onRemove}>
            {TEXT.remove}
          </Button>
        </div>
      )}
    </article>
  );
}
