// The sidebar is navigation only: "+ New work", "All work", then WORKFLOWS and REPOS. Each row
// carries badges (needs you, failed today, running) that show only above zero, and a "+" that
// appears on hover or focus. Items are never listed here: they appear in the main area. The
// engine's health sits under "+ New work". Engine text (names) is rendered as React text only.
import type { BoardCount, ItemRecord, Setup } from "@tokama/core";
import { type ReactNode, useEffect, useRef } from "react";
import type { ConnectionState } from "../../shared/bridge.js";
import { RepoMenu } from "../repos/RepoMenu.js";
import { ALL_WORK, type Badge, badgesOf, inView, needsYouCount, sameView, type View, viewKey } from "../model.js";
import type { Section } from "../useViewState.js";
import { EngineHealth } from "./ConnectionStatus.js";
import { AllWorkIcon, RepoIcon } from "../ui/icons.js";
import { TemplateIcon } from "./TemplateIcon.js";
import { Button } from "../ui/Button.js";
import { StatusCounts } from "../ui/Badge.js";

const TEXT = {
  panel: "Sidebar",
  newWork: "+ New work",
  noRepos: "No repos added yet.",
  thisMachine: "This machine",
  allWork: "All work",
  workflows: "Workflows",
  repos: "Repos",
  collapse: (section: string) => `Collapse ${section}`,
  expand: (section: string) => `Expand ${section}`,
  start: (name: string) => `Start ${name}`,
  quickTask: (repo: string) => `Quick task in ${repo}`,
  addRepo: "+ Add repo",
  stale: "Out of date: the last update failed",
} as const;

export interface SidebarProps {
  readonly id: string;
  readonly connection: ConnectionState;
  /** Undefined until the first load. */
  readonly setup: Setup | undefined;
  /** The open items. */
  readonly items: readonly ItemRecord[];
  /** The finished items, counted. */
  readonly counts: readonly BoardCount[];
  /** The items are from an earlier load: the last one failed. */
  readonly stale: boolean;
  readonly now: number;
  readonly view: View;
  readonly onSelectView: (view: View) => void;
  readonly collapsed: ReadonlySet<Section>;
  readonly onToggleSection: (section: Section) => void;
  /** "+ New work": opens the input as it is. */
  readonly onNewWork: () => void;
  /** The "+" on a workflow row (that template) or a repo row (that repo): opens the input filled in. */
  readonly onStartIn: (view: View) => void;
  /** "+ Add repo": opens the folder picker. */
  readonly onAddRepo: () => void;
  /** Opens the Edit repo dialog for a repo. */
  readonly onEditRepo: (repoId: string) => void;
  /** Removes a repo; resolves to the engine's message when it refused. */
  readonly onRemoveRepo: (repoId: string) => Promise<string | undefined>;
}

export function Sidebar(props: SidebarProps) {
  const { id, connection, setup, items, counts, stale, now, view, onSelectView, collapsed, onToggleSection, onNewWork, onStartIn, onAddRepo, onEditRepo, onRemoveRepo } = props;
  const workflows = (setup?.templates ?? []).map((template) => ({ view: { kind: "workflow", id: template.id } as const, name: template.name, icon: <TemplateIcon icon={template.icon} color={template.color} /> }));
  const repos = (setup?.repos ?? []).map((repo) => ({ view: { kind: "repo", id: repo.id } as const, name: repo.id, removable: repo.sample !== true }));
  // A removed repo's row takes the focus with it: "+ Add repo" gets it instead of the page.
  const addRepo = useRef<HTMLButtonElement>(null);
  const repoCount = repos.length;
  const lastRepoCount = useRef(repoCount);
  useEffect(() => {
    const shrank = repoCount < lastRepoCount.current;
    lastRepoCount.current = repoCount;
    if (shrank && (document.activeElement === null || document.activeElement === document.body)) addRepo.current?.focus();
  }, [repoCount]);
  const badges = (inScope: (entry: Pick<ItemRecord, "templateId" | "repoIds">) => boolean) => badgesOf(items.filter(inScope), counts.filter(inScope), now);
  const row = (entry: { readonly view: View; readonly name: string }, icon: ReactNode, startLabel: string, mono = false, menu?: ReactNode) => (
    <Row
      key={viewKey(entry.view)}
      name={entry.name}
      icon={icon}
      mono={mono}
      badges={badges((item) => inView(item, entry.view))}
      selected={sameView(view, entry.view)}
      startLabel={startLabel}
      onStart={() => onStartIn(entry.view)}
      onSelect={() => onSelectView(entry.view.kind === "repo" && sameView(view, entry.view) ? ALL_WORK : entry.view)}
      menu={menu}
    />
  );
  return (
    <aside className="panel" id={id} aria-label={TEXT.panel} data-stale={stale || undefined}>
      <Button variant="plain" className="new-work" disabled={setup !== undefined && setup.repos.length === 0} onClick={onNewWork}>
        {TEXT.newWork}
      </Button>
      <p className="engine-line">
        {TEXT.thisMachine}
        <EngineHealth state={connection} />
      </p>
      {stale && (
        <p className="stale" role="status">
          <span className="symbol" aria-hidden="true">
            !
          </span>
          {TEXT.stale}
        </p>
      )}
      <Row
        name={TEXT.allWork}
        icon={<AllWorkIcon />}
        badges={badges(() => true)}
        selected={sameView(view, ALL_WORK)}
        onSelect={() => onSelectView(ALL_WORK)}
      />
      <SectionHeading section="workflows" title={TEXT.workflows} collapsed={collapsed} onToggle={onToggleSection} summary={badges((item) => workflows.some((w) => inView(item, w.view)))} />
      {!collapsed.has("workflows") && workflows.map((entry) => row(entry, entry.icon, TEXT.start(entry.name)))}
      <SectionHeading section="repos" title={TEXT.repos} collapsed={collapsed} onToggle={onToggleSection} summary={badges((item) => repos.some((r) => inView(item, r.view)))} />
      {!collapsed.has("repos") && (
        <>
          {repos.map((entry) => row(entry, <RepoIcon />, TEXT.quickTask(entry.name), true, entry.removable && <RepoMenu name={entry.name} waiting={needsYouCount(items.filter((item) => inView(item, entry.view)))} onEdit={() => onEditRepo(entry.view.id)} onRemove={() => onRemoveRepo(entry.view.id)} />))}
          {setup !== undefined && repos.length === 0 && <p className="sb-empty">{TEXT.noRepos}</p>}
          <Button variant="plain" ref={addRepo} className="sb-add" onClick={onAddRepo}>
            {TEXT.addRepo}
          </Button>
        </>
      )}
    </aside>
  );
}

interface SectionHeadingProps {
  readonly section: Section;
  readonly title: string;
  readonly collapsed: ReadonlySet<Section>;
  readonly onToggle: (section: Section) => void;
  /** The section's badges, shown only while it is collapsed. */
  readonly summary: readonly Badge[];
}

function SectionHeading({ section, title, collapsed, onToggle, summary }: SectionHeadingProps) {
  const closed = collapsed.has(section);
  return (
    <h2 className="panel-heading">
      <Button
        variant="plain"
        className="section-toggle"
        aria-expanded={!closed}
        aria-label={closed ? TEXT.expand(title) : TEXT.collapse(title)}
        onClick={() => onToggle(section)}
      >
        <span aria-hidden="true">{closed ? "▸" : "▾"}</span>
        <span>{title}</span>
      </Button>
      {closed && <StatusCounts counts={summary} />}
    </h2>
  );
}

interface RowProps {
  readonly name: string;
  readonly icon: ReactNode;
  readonly badges: readonly Badge[];
  readonly selected: boolean;
  readonly onSelect: () => void;
  readonly mono?: boolean;
  /** The label of the "+" shown on hover. */
  readonly startLabel?: string;
  readonly onStart?: () => void;
  /** Row actions after the "+", such as the repo menu. */
  readonly menu?: ReactNode;
}

function Row({ name, icon, badges, selected, onSelect, mono, startLabel, onStart, menu }: RowProps) {
  return (
    <div className="sb-row" data-selected={selected || undefined}>
      <Button variant="plain" className="sb-main" aria-current={selected ? "page" : undefined} onClick={onSelect}>
        <span className="sb-icon">{icon}</span>
        <span className={mono ? "ellipsis mono" : "ellipsis"}>{name}</span>
        <StatusCounts counts={badges} />
      </Button>
      {startLabel !== undefined && (
        <Button variant="plain" className="sb-plus" aria-label={startLabel} title={startLabel} onClick={onStart}>
          +
        </Button>
      )}
      {menu}
    </div>
  );
}

