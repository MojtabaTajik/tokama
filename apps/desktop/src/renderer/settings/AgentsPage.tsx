// Settings > Agents, read-only: every agent (personal, each repo's shared ones and the built-ins)
// with its role, what it runs on, model and limits, and the files that do not load with their
// problems. A list with a filter on the left, the selected agent on the right. Engine text (names,
// roles, models, file names, problems) is rendered as React text only, never as HTML.
import type { AgentDetail, AgentsListResult, BrokenAgentDetail, Setup } from "@tokama/core";
import { type ReactNode, useState } from "react";
import type { ConnectionState, TokamaBridge } from "../../shared/bridge.js";
import { TemplateIcon } from "../shell/TemplateIcon.js";
import { agentRows, filterRows, limitsNotes, limitsTitle, monogram, ownerLabel, rowLine, rowName, runsOnName, summaryLine } from "./describe.js";
import { useAgents } from "./useAgents.js";

const TEXT = {
  heading: "Agents",
  hint: "Who runs a step. Tokama's own definitions, not tied to one CLI.",
  filter: "Filter agents",
  list: "Agents",
  noMatch: "No agent matches",
  empty: "No agents",
  broken: "✕ broken",
  loading: "Loading",
  starting: "Waiting for the engine",
  loadFailed: "Could not load the agents",
  retry: "Retry",
  problemsHeading: "Files that did not load",
  stored: "Stored in",
  runsOn: "Runs on",
  model: "Model",
  whereItRuns: "Where it runs",
  limits: "Tool limits",
  role: "Role",
  roleCut: "The role is longer; only the start is shown.",
  owner: "Kept by",
  cloud: "Your plan at the provider (cloud)",
  local: "This machine; nothing leaves it",
  brokenTitle: "This file does not load",
  brokenHint: "Steps that use this agent fail until the file is fixed. It still holds its id, so a built-in agent of the same name does not take its place.",
  edit: "Agent files are edited in your own editor. Tokama re-reads them when this page opens.",
  select: "Select an agent",
} as const;

export interface AgentsPageProps {
  readonly bridge: TokamaBridge;
  readonly connection: ConnectionState;
  readonly setup: Setup | undefined;
}

export function AgentsPage({ bridge, connection, setup }: AgentsPageProps) {
  const { state, reload } = useAgents(bridge, connection, setup);
  const [query, setQuery] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | undefined>(undefined);
  const data = state.status === "loaded" ? state.data : undefined;
  const rows = data === undefined ? [] : agentRows(data.agents, data.broken);
  const shown = filterRows(rows, query);
  const selected = shown.find((row) => row.key === selectedKey) ?? shown[0];

  return (
    <section className="agents" aria-label={TEXT.heading}>
      <div className="agents-list-pane">
        <h2 className="settings-heading">{TEXT.heading}</h2>
        <p className="agents-hint">{TEXT.hint}</p>
        <input type="text" className="agents-filter" aria-label={TEXT.filter} placeholder="Filter agents…" value={query} onChange={(event) => setQuery(event.target.value)} />
        <Body state={state} connected={connection.status === "connected"} onRetry={reload} />
        {data !== undefined && (
          <>
            <ul className="agents-list" aria-label={TEXT.list}>
              {shown.map((row) => (
                <li key={row.key}>
                  <button type="button" className="agent-row" aria-pressed={row.key === selected?.key} data-broken={row.broken || undefined} onClick={() => setSelectedKey(row.key)}>
                    <span className="agent-row-name ellipsis">{row.broken ? <span className="agent-row-flag">{TEXT.broken}</span> : null}{rowName(row)}</span>
                    <span className="agent-row-line mono ellipsis">{rowLine(row)}</span>
                  </button>
                </li>
              ))}
            </ul>
            {shown.length === 0 && <p className="placeholder">{rows.length === 0 ? TEXT.empty : TEXT.noMatch}</p>}
            <Problems data={data} />
          </>
        )}
        <p className="agents-note">{TEXT.edit}</p>
      </div>
      <div className="agent-detail">{selected === undefined ? <p className="placeholder">{data === undefined ? "" : TEXT.select}</p> : selected.broken ? <BrokenDetail entry={selected.entry} /> : <Detail agent={selected.agent} />}</div>
    </section>
  );
}

function Body({ state, connected, onRetry }: { readonly state: ReturnType<typeof useAgents>["state"]; readonly connected: boolean; readonly onRetry: () => void }) {
  if (!connected) return <p className="placeholder">{TEXT.starting}</p>;
  if (state.status === "loading") return <p className="placeholder">{TEXT.loading}</p>;
  if (state.status === "loaded") return null;
  return (
    <div className="failure" role="alert">
      <p className="failure-title">
        <span className="symbol" aria-hidden="true">
          ✕
        </span>
        {TEXT.loadFailed}
      </p>
      <p className="detail">{state.message}</p>
      <button type="button" className="retry" onClick={onRetry}>
        {TEXT.retry}
      </button>
    </div>
  );
}

/** Problems that belong to no listed agent: a bad file name, a refused link. */
function Problems({ data }: { readonly data: AgentsListResult }) {
  if (data.problems.length === 0) return null;
  return (
    <div className="agents-problems" role="group" aria-label={TEXT.problemsHeading}>
      <p className="agents-problems-title">
        <span className="symbol" aria-hidden="true">
          ✕
        </span>
        {TEXT.problemsHeading}
      </p>
      <ul>
        {data.problems.map((problem) => (
          <li key={problem}>{problem}</li>
        ))}
      </ul>
    </div>
  );
}

function Field({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="agent-field">
      <h3 className="agent-field-label">{label}</h3>
      {children}
    </div>
  );
}

function Detail({ agent }: { readonly agent: AgentDetail }) {
  return (
    <article aria-label={agent.name}>
      <header className="agent-head">
        <span className="agent-head-icon">
          <TemplateIcon icon={agent.icon} color={undefined} size={20} />
        </span>
        <div className="agent-head-text">
          <h2 className="ellipsis">{agent.name}</h2>
          <p className="mono">{summaryLine(agent)}</p>
        </div>
      </header>
      <p className="agent-stored">
        {TEXT.stored} <span className="mono">{agent.source}</span>
      </p>
      <Field label={TEXT.runsOn}>
        <p className="agent-value">
          <span className="monogram mono" aria-hidden="true">
            {monogram(agent.cliId)}
          </span>
          {runsOnName(agent)}
        </p>
      </Field>
      <Field label={TEXT.model}>
        <p className="agent-value mono">{agent.model}</p>
      </Field>
      <Field label={TEXT.whereItRuns}>
        <p className="agent-value">{agent.runsOn === "local" ? TEXT.local : TEXT.cloud}</p>
      </Field>
      <Field label={TEXT.limits}>
        <p className="agent-value">{limitsTitle(agent)}</p>
        <ul className="agent-notes">
          {limitsNotes(agent).map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      </Field>
      <Field label={TEXT.role}>
        <pre className="agent-role">{agent.role}</pre>
        {agent.roleCut && <p className="agents-note">{TEXT.roleCut}</p>}
      </Field>
      <Field label={TEXT.owner}>
        <p className="agent-value">{ownerLabel(agent.owner, agent.replacesBuiltin)}</p>
      </Field>
    </article>
  );
}

function BrokenDetail({ entry }: { readonly entry: BrokenAgentDetail }) {
  return (
    <article aria-label={entry.id}>
      <header className="agent-head">
        <div className="agent-head-text">
          <h2 className="ellipsis">{entry.id}</h2>
          <p className="agent-broken-title">
            <span className="symbol" aria-hidden="true">
              ✕
            </span>
            {TEXT.brokenTitle}
          </p>
        </div>
      </header>
      <p className="agent-stored">
        {TEXT.stored} <span className="mono">{entry.source}</span> · {ownerLabel(entry.owner, entry.replacesBuiltin)}
      </p>
      <p className="agents-note">{TEXT.brokenHint}</p>
      <ul className="agent-problems">
        {entry.problems.map((problem) => (
          <li key={problem}>{problem}</li>
        ))}
      </ul>
    </article>
  );
}
