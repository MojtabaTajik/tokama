// The sidebar is navigation only: "+ New work", "All work", then WORKFLOWS and REPOS. Each row
// carries badges (needs you, failed today, running) that show only above zero, and a "+" that
// appears on hover or focus. Items are never listed here: they appear in the main area. The
// engine's health sits under "+ New work". Engine text (names) is rendered as React text only.
import type { ItemRecord, Setup } from "@tokama/core";
import type { ReactNode } from "react";
import type { ConnectionState } from "../../shared/bridge.js";
import { ALL_WORK, type Badge, badgesOf, inView, sameView, type View, viewKey } from "../model.js";
import type { Section } from "../useViewState.js";
import { EngineHealth } from "./ConnectionStatus.js";
import { AllWorkIcon, RepoIcon, WorkflowIcon } from "./icons.js";

const TEXT = {
  panel: "Sidebar",
  newWork: "+ New work",
  thisMachine: "This machine",
  allWork: "All work",
  workflows: "Workflows",
  repos: "Repos",
  collapse: (section: string) => `Collapse ${section}`,
  expand: (section: string) => `Expand ${section}`,
  start: (name: string) => `Start ${name}`,
  quickTask: (repo: string) => `Quick task in ${repo}`,
  stale: "Out of date: the last update failed",
} as const;

export interface SidebarProps {
  readonly id: string;
  readonly connection: ConnectionState;
  /** Undefined until the first load. */
  readonly setup: Setup | undefined;
  readonly items: readonly ItemRecord[];
  /** The items are from an earlier load: the last one failed. */
  readonly stale: boolean;
  readonly now: number;
  readonly view: View;
  readonly onSelectView: (view: View) => void;
  readonly collapsed: ReadonlySet<Section>;
  readonly onToggleSection: (section: Section) => void;
}

export function Sidebar(props: SidebarProps) {
  const { id, connection, setup, items, stale, now, view, onSelectView, collapsed, onToggleSection } = props;
  const workflows = (setup?.templates ?? []).map((template) => ({ view: { kind: "workflow", id: template.id } as const, name: template.name }));
  const repos = (setup?.repos ?? []).map((repo) => ({ view: { kind: "repo", id: repo.id } as const, name: repo.id }));
  const row = (entry: { readonly view: View; readonly name: string }, icon: ReactNode, startLabel: string, mono = false) => (
    <Row
      key={viewKey(entry.view)}
      name={entry.name}
      icon={icon}
      mono={mono}
      badges={badgesOf(items.filter((item) => inView(item, entry.view)), now)}
      selected={sameView(view, entry.view)}
      startLabel={startLabel}
      onSelect={() => onSelectView(entry.view.kind === "repo" && sameView(view, entry.view) ? ALL_WORK : entry.view)}
    />
  );
  return (
    <aside className="panel" id={id} aria-label={TEXT.panel} data-stale={stale || undefined}>
      <button type="button" className="new-work" aria-disabled="true">
        {TEXT.newWork}
      </button>
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
        badges={badgesOf(items, now)}
        selected={sameView(view, ALL_WORK)}
        onSelect={() => onSelectView(ALL_WORK)}
      />
      <SectionHeading section="workflows" title={TEXT.workflows} collapsed={collapsed} onToggle={onToggleSection} summary={badgesOf(items.filter((item) => workflows.some((w) => inView(item, w.view))), now)} />
      {!collapsed.has("workflows") && workflows.map((entry) => row(entry, <WorkflowIcon />, TEXT.start(entry.name)))}
      <SectionHeading section="repos" title={TEXT.repos} collapsed={collapsed} onToggle={onToggleSection} summary={badgesOf(items.filter((item) => repos.some((r) => inView(item, r.view))), now)} />
      {!collapsed.has("repos") && repos.map((entry) => row(entry, <RepoIcon />, TEXT.quickTask(entry.name), true))}
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
      <button
        type="button"
        className="section-toggle"
        aria-expanded={!closed}
        aria-label={closed ? TEXT.expand(title) : TEXT.collapse(title)}
        onClick={() => onToggle(section)}
      >
        <span aria-hidden="true">{closed ? "▸" : "▾"}</span>
        <span>{title}</span>
      </button>
      {closed && <Badges badges={summary} />}
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
  /** The label of the "+" shown on hover; the "+" is not wired yet. */
  readonly startLabel?: string;
}

function Row({ name, icon, badges, selected, onSelect, mono, startLabel }: RowProps) {
  return (
    <div className="sb-row" data-selected={selected || undefined}>
      <button type="button" className="sb-main" aria-current={selected ? "page" : undefined} onClick={onSelect}>
        <span className="sb-icon">{icon}</span>
        <span className={mono ? "ellipsis mono" : "ellipsis"}>{name}</span>
        <Badges badges={badges} />
      </button>
      {startLabel !== undefined && (
        <button type="button" className="sb-plus" aria-disabled="true" aria-label={startLabel} title={startLabel}>
          +
        </button>
      )}
    </div>
  );
}

/** Symbol and count per badge, with the word for assistive technology; colour is never the only signal. */
function Badges({ badges }: { readonly badges: readonly Badge[] }) {
  if (badges.length === 0) return null;
  return (
    <span className="sb-badges mono">
      {badges.map((badge) => (
        <span key={badge.kind} className="sb-badge" data-kind={badge.kind} title={`${badge.count} ${badge.word}`}>
          <span aria-hidden="true">
            {badge.symbol} {badge.count}
          </span>
          <span className="visually-hidden">
            {badge.count} {badge.word}
          </span>
        </span>
      ))}
    </span>
  );
}
