// Settings > Diagnostics: the entries kept on this machine, read-only, with exactly what Send all
// sends for each, and the actions Send all, Clear all, Save as file and the collect switch. The
// filters change only what shows; Send all and Save as file take every waiting entry. Entry text
// is rendered as React text only, never as HTML.
import { useState } from "react";
import type { ConnectionState, DiagnosticsItem, DiagnosticsSendFailure, DiagnosticsSendResult, TokamaBridge } from "../../shared/bridge.js";
import { ConnectionFailure } from "../shell/ConnectionStatus.js";
import { DATE_FILTERS, type DateFilter, failedLine, inDateRange, sendingLine, sendLabel, sentLine, shownType, sizeLabel, summary, TYPE_FILTERS, TYPE_WORD, type TypeFilter, timeLabel, type ShownType } from "./diagnosticsText.js";
import { useDiagnostics } from "./useDiagnostics.js";
import { Button } from "../ui/Button.js";
import { ErrorRetry } from "../ui/ErrorRetry.js";

const TEXT = {
  heading: "Diagnostics",
  introBefore: "Errors, warnings and a daily usage summary, kept on this Mac until you send them. Before an entry is saved, paths, repo names and item titles are replaced with placeholders like ",
  introAfter: ".",
  cap: "Kept on this Mac: last 30 days, up to 2 MB.",
  type: "Type",
  date: "Date",
  filterNote: "Filters only change what you see; Send all sends everything.",
  columns: ["Time", "Type", "Summary"],
  entries: "Entries",
  entry: "Entry",
  exact: "Exactly what is sent",
  clear: "Clear all",
  save: "Save as file…",
  collect: "Collect diagnostics",
  on: "On",
  off: "Off",
  empty: "Nothing waiting",
  emptyHint: "New errors, warnings and the daily usage summary show up here.",
  loading: "Loading",
  starting: "Waiting for the engine",
  loadFailed: "Could not load the diagnostics",
  saveFailed: "Couldn’t save the file.",
  clearFailed: "Couldn’t clear the entries.",
} as const;

/** The symbol of each type: a crossed circle, a warning triangle, a bar chart. The word always goes with it. */
const TYPE_PATH: Record<ShownType, string> = {
  error: "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18zM9 9l6 6M15 9l-6 6",
  warning: "M12 3L2 20h20zM12 10v4M12 17h.01",
  usage: "M4 20V10M10 20V4M16 20v-7M22 20H2",
};

type Bar =
  | { readonly status: "idle" }
  | { readonly status: "sending"; readonly count: number }
  | { readonly status: "sent"; readonly count: number; readonly kept: number }
  | { readonly status: "failed"; readonly count: number; readonly reason: DiagnosticsSendFailure; readonly detail?: string }
  | { readonly status: "notice"; readonly text: string };

export interface DiagnosticsPageProps {
  readonly bridge: TokamaBridge;
  readonly connection: ConnectionState;
  /** A fixed time for tests; otherwise the clock. */
  readonly now?: number;
}

export function DiagnosticsPage({ bridge, connection, now: fixedNow }: DiagnosticsPageProps) {
  const { state, reload } = useDiagnostics(bridge, connection);
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [dateFilter, setDateFilter] = useState<DateFilter>("7d");
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [bar, setBar] = useState<Bar>({ status: "idle" });
  const [busy, setBusy] = useState(false);
  const [collectPending, setCollectPending] = useState(false);
  const now = fixedNow ?? Date.now();

  const head = (
    <div className="dg-head">
      <h1 className="dg-title">{TEXT.heading}</h1>
      <p className="dg-intro">
        {TEXT.introBefore}
        <code className="mono">&lt;path&gt;</code>
        {TEXT.introAfter}
      </p>
      <p className="dg-cap">{TEXT.cap}</p>
    </div>
  );

  if (connection.status !== "connected" || state.status !== "loaded") {
    return (
      <section className="dg" aria-label={TEXT.heading}>
        {head}
        <div className="dg-state">
          {connection.status === "failed" ? (
            <ConnectionFailure state={connection} onRetry={() => void bridge.retryConnection()} />
          ) : connection.status !== "connected" ? (
            <p className="placeholder">{TEXT.starting}</p>
          ) : state.status === "loading" ? (
            <p className="placeholder">{TEXT.loading}</p>
          ) : (
            <ErrorRetry title={TEXT.loadFailed} onRetry={() => void reload()} />
          )}
        </div>
      </section>
    );
  }

  const { items, collect } = state;
  const ids = items.map((item) => item.entry.id);
  const dated = items.filter((item) => inDateRange(item.entry.at, dateFilter, now));
  const shown = dated.filter((item) => typeFilter === "all" || shownType(item.entry) === typeFilter);
  const selected = shown.find((item) => item.entry.id === selectedId) ?? shown[0];
  const count = (type: TypeFilter) => dated.filter((item) => type === "all" || shownType(item.entry) === type).length;

  const sendAll = async () => {
    setBusy(true);
    setBar({ status: "sending", count: ids.length });
    const result: DiagnosticsSendResult = await bridge.sendDiagnostics(ids).catch(() => ({ ok: false, reason: "network", count: ids.length }));
    setBar(result.ok ? { status: "sent", count: result.sent, kept: result.kept ?? 0 } : { status: "failed", count: result.count, reason: result.reason, ...(result.detail !== undefined && { detail: result.detail }) });
    await reload();
    setBusy(false);
  };
  const clearAll = async () => {
    setBusy(true);
    const reply = await bridge.command({ type: "diagnostics_delete", all: true }).catch(() => ({ ok: false as const }));
    setBar(reply.ok ? { status: "idle" } : { status: "notice", text: TEXT.clearFailed });
    // The buttons wait for the list after the clear, so Send all never names cleared entries.
    await reload();
    setBusy(false);
  };
  const saveAll = async () => {
    setBusy(true);
    const result = await bridge.saveDiagnostics(ids).catch(() => ({ ok: false as const, reason: "failed" as const }));
    if (!result.ok && result.reason === "failed") setBar({ status: "notice", text: TEXT.saveFailed });
    setBusy(false);
  };
  const flipCollect = async () => {
    if (collect === undefined) return;
    setCollectPending(true);
    await bridge.command({ type: "diagnostics_settings", collect: !collect }).catch(() => undefined);
    await reload();
    setCollectPending(false);
  };

  const collectSwitch = <CollectSwitch on={collect} pending={collectPending} onFlip={() => void flipCollect()} />;
  const empty = items.length === 0;

  return (
    <section className="dg" aria-label={TEXT.heading}>
      {head}
      {empty ? (
        <div className="dg-empty">
          <span className="dg-empty-icon" aria-hidden="true">
            <PulseIcon />
          </span>
          <h2 className="dg-empty-title">{TEXT.empty}</h2>
          <p className="dg-empty-text">{TEXT.emptyHint}</p>
        </div>
      ) : (
        <>
          <div className="dg-filters">
            <div className="dg-types" role="radiogroup" aria-label={TEXT.type}>
              {TYPE_FILTERS.map(({ id, label }) => (
                <Button variant="plain" key={id} role="radio" aria-checked={typeFilter === id} className="dg-type" onClick={() => setTypeFilter(id)}>
                  {id !== "all" && <TypeIcon type={id} />}
                  {label}
                  <span className="dg-count mono">{count(id)}</span>
                </Button>
              ))}
            </div>
            <label className="dg-date">
              {TEXT.date}
              <select value={dateFilter} onChange={(event) => setDateFilter(event.target.value as DateFilter)}>
                {DATE_FILTERS.map(({ id, label }) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <span className="dg-note">{TEXT.filterNote}</span>
          </div>
          <div className="dg-panes">
            <div className="dg-list">
              <div className="dg-row dg-columns" aria-hidden="true">
                {TEXT.columns.map((column) => (
                  <span key={column}>{column}</span>
                ))}
              </div>
              <ul className="dg-rows" aria-label={TEXT.entries}>
                {shown.map((item) => (
                  <li key={item.entry.id}>
                    <EntryRow item={item} now={now} selected={item === selected} onSelect={() => setSelectedId(item.entry.id)} />
                  </li>
                ))}
              </ul>
            </div>
            <section className="dg-detail" aria-label={TEXT.entry}>
              {selected !== undefined && <EntryDetail item={selected} now={now} />}
            </section>
          </div>
        </>
      )}
      {empty && bar.status !== "sent" ? (
        <div className="dg-bar dg-bar-end">{collectSwitch}</div>
      ) : (
        <div className="dg-bar">
          <BarStatus bar={bar} />
          <Button variant="primary" size="lg" disabled={busy || empty} onClick={() => void sendAll()}>
            {sendLabel(items.length)}
          </Button>
          <Button variant="danger" size="lg" disabled={busy || empty} onClick={() => void clearAll()}>
            {TEXT.clear}
          </Button>
          <Button variant="secondary" size="lg" disabled={busy || empty} onClick={() => void saveAll()}>
            {TEXT.save}
          </Button>
          <span className="dg-bar-end">{collectSwitch}</span>
        </div>
      )}
    </section>
  );
}

function EntryRow({ item, now, selected, onSelect }: { readonly item: DiagnosticsItem; readonly now: number; readonly selected: boolean; readonly onSelect: () => void }) {
  const type = shownType(item.entry);
  return (
    <Button variant="plain" className="dg-row dg-entry" aria-pressed={selected} onClick={onSelect}>
      <span className="dg-time mono">{timeLabel(item.entry.at, now)}</span>
      <TypeLabel type={type} />
      <span className="dg-summary ellipsis">{summary(item.entry)}</span>
    </Button>
  );
}

function EntryDetail({ item, now }: { readonly item: DiagnosticsItem; readonly now: number }) {
  return (
    <>
      <p className="dg-detail-meta">
        <TypeLabel type={shownType(item.entry)} />
        <span className="dg-time mono">{timeLabel(item.entry.at, now)}</span>
        <span className="dg-size mono">{sizeLabel(item.text)}</span>
      </p>
      <h2 className="dg-detail-title">{summary(item.entry)}</h2>
      <h3 className="dg-exact">{TEXT.exact}</h3>
      <pre className="dg-text mono">{item.text}</pre>
    </>
  );
}

function TypeLabel({ type }: { readonly type: ShownType }) {
  return (
    <span className="dg-type-label" data-type={type}>
      <TypeIcon type={type} />
      {TYPE_WORD[type]}
    </span>
  );
}

function TypeIcon({ type }: { readonly type: ShownType }) {
  return (
    <svg className="dg-symbol" data-type={type} aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d={TYPE_PATH[type]} />
    </svg>
  );
}

function BarStatus({ bar }: { readonly bar: Bar }) {
  if (bar.status === "idle") return null;
  const [symbol, tone, text] =
    bar.status === "sending" ? ["◐", "live", sendingLine(bar.count)] : bar.status === "sent" ? ["✓", "pass", sentLine(bar.count, bar.kept)] : bar.status === "failed" ? ["✕", "fail", failedLine(bar.count, bar.reason, bar.detail)] : ["✕", "fail", bar.text];
  return (
    <p className="dg-status" role="status">
      <span className="dg-status-symbol" data-tone={tone} aria-hidden="true">
        {symbol}
      </span>
      <span>{text}</span>
    </p>
  );
}

function CollectSwitch({ on, pending, onFlip }: { readonly on: boolean | undefined; readonly pending: boolean; readonly onFlip: () => void }) {
  return (
    <span className="dg-collect">
      <span id="dg-collect-label">{TEXT.collect}</span>
      <Button variant="plain" className="dg-switch" role="switch" aria-checked={on === true} aria-labelledby="dg-collect-label" disabled={on === undefined || pending} onClick={onFlip}>
        <span className="dg-switch-word">{on === true ? TEXT.on : TEXT.off}</span>
        <span className="dg-switch-track" data-on={on === true || undefined}>
          <span className="dg-switch-knob" />
        </span>
      </Button>
    </span>
  );
}

function PulseIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12h4l3-8 4 16 3-8h4" />
    </svg>
  );
}
