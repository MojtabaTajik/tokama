// The Machine tab of Insights: the whole machine first (memory and CPU, each as Tokama, the other
// apps and what is left), then what Tokama runs right now by item, then the last 30 minutes as
// Tokama's line and the all-apps line. CPU of a process is shown as a share of all cores, like the
// machine's own. Engine text (item titles) renders as React text only.
import type { ItemRecord, MachineReport, Setup } from "@tokama/core";
import type { ConnectionState, TokamaBridge } from "../../shared/bridge.js";
import { agentInfo, type AgentInfo } from "../agent/agent-info.js";
import { AgentBadge } from "../agent/AgentBadge.js";
import { backendOf } from "../brand/backends/index.js";
import { currentStep } from "../model.js";
import { ConnectionFailure } from "../shell/ConnectionStatus.js";
import { MachineChart } from "./MachineChart.js";
import { clock, clockSeconds } from "../format/time.js";
import { chartModel, cpuSplit, formatBytes, formatSize, groupItems, isLow, isOneRow, memorySplit, ofAllCores, onePercent, sharePercent, tokamaTotal, type ItemGroup, type Split } from "./machine-model.js";
import { useMachine } from "./useMachine.js";
import { workflowName } from "./usage-model.js";
import { Button } from "../ui/Button.js";
import { AgentName } from "../ui/agent.js";
import { Placeholder } from "../ui/EmptyState.js";
import { SplitBar, SplitSwatch, type SplitTone } from "../ui/SplitBar.js";

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

const TEXT = {
  panel: "Machine",
  loading: "Reading this machine",
  failed: "Could not read this machine",
  refreshFailed: (why: string) => `Could not refresh: ${why}. The numbers below are from the last reading.`,
  now: "This machine now",
  specs: (cores: number, memory: string, seconds: number) => `${plural(cores, "core", "cores")} · ${memory} · read every ${seconds} s while this tab is open · as of`,
  list: "Whole machine now",
  memory: "Memory",
  cpu: "CPU",
  tokama: "Tokama",
  other: "Other apps",
  free: "Free",
  idle: "Idle",
  low: "! low",
  ofMemory: (total: string) => `of ${total}`,
  ofCores: (cores: number) => `of ${plural(cores, "core", "cores")}`,
  load: ([one, five, fifteen]: readonly number[]) => `Load average ${[one, five, fifteen].map((value) => (value ?? 0).toFixed(2)).join(" · ")} (1, 5 and 15 min)`,
  chartTitle: "Last 30 minutes",
  chartNote: "Tokama and all apps · not kept after you close this tab",
  noReadingsFrom: (from: string) => `You opened this tab at ${from}, so the hatched part has no readings.`,
  noReadings: "The hatched parts have no readings.",
  tableTitle: "Running now, by item",
  tableNote: (cores: number) => `· CPU is a share of all ${plural(cores, "core", "cores")} · heaviest memory first`,
  itemOrProcess: "Item or process",
  cpuHead: "CPU",
  memoryHead: "Memory",
  engine: "Tokama engine",
  engineKind: "background service",
  checks: "Checks",
  agent: "Agent",
  total: (items: number, processes: number) => `Tokama in total · ${plural(items, "item", "items")} · ${plural(processes, "process", "processes")}`,
  noItems: "No items running.",
  noItemsHint: "Agents and checks show here, under their item, while they run.",
  newWork: "+ New work",
} as const;

export interface MachineTabProps {
  readonly bridge: TokamaBridge;
  readonly connection: ConnectionState;
  readonly onRetryConnection: () => void;
  readonly setup: Setup | undefined;
  readonly items: readonly ItemRecord[];
  /** Ids of items the board has, which the drawer can open. */
  readonly onSelectItem: (itemId: string) => void;
  readonly onNewWork: () => void;
}

export function MachineTab({ bridge, connection, onRetryConnection, setup, items, onSelectItem, onNewWork }: MachineTabProps) {
  const { report, error } = useMachine(bridge, connection);
  return (
    <section className="ins-body mc-body" role="tabpanel" aria-label={TEXT.panel}>
      {connection.status === "failed" ? (
        <ConnectionFailure state={connection} onRetry={onRetryConnection} />
      ) : report === undefined ? (
        <Placeholder>{error === undefined ? TEXT.loading : `${TEXT.failed}: ${error}`}</Placeholder>
      ) : (
        <>
          {error !== undefined && <p className="muted mc-hint">{TEXT.refreshFailed(error)}</p>}
          <WholeMachine report={report} />
          <RunningNow report={report} setup={setup} items={items} onSelectItem={onSelectItem} onNewWork={onNewWork} />
          <ChartSection report={report} />
        </>
      )}
    </section>
  );
}

interface KeyProps {
  readonly tone: SplitTone;
  readonly name: string;
  readonly value: string;
  /** A warning word beside the value. */
  readonly warning?: string;
}

function Key({ tone, name, value, warning }: KeyProps) {
  return (
    <span className="mc-key">
      <SplitSwatch tone={tone} />
      <span className="muted">{name}</span>
      <b className="mono">{value}</b>
      {warning !== undefined && (
        <span className="ins-tone" data-tone="warn">
          {warning}
        </span>
      )}
    </span>
  );
}

interface SummaryRowProps {
  readonly name: string;
  readonly split: Split;
  readonly format: (amount: number) => string;
  /** The third part: "Free" for memory, "Idle" for CPU. */
  readonly rest: string;
  readonly of: string;
  readonly warning?: string;
  /** What the legend says on hover. */
  readonly hint?: string | undefined;
}

function SummaryRow({ name, split, format, rest, of, warning, hint }: SummaryRowProps) {
  const label = `${name}: ${TEXT.tokama} ${format(split.tokama)}, ${TEXT.other.toLowerCase()} ${format(split.other)}, ${rest.toLowerCase()} ${format(split.rest)} ${of}`;
  return (
    <div role="listitem" className="mc-sum-row">
      <span className="mc-name">{name}</span>
      <SplitBar
        label={label}
        total={split.total}
        parts={[
          { tone: "tokama", value: split.tokama },
          { tone: "other", value: split.other },
          { tone: "rest", value: split.rest },
        ]}
      />
      <span className="mc-keys" title={hint}>
        <Key tone="tokama" name={TEXT.tokama} value={format(split.tokama)} />
        <Key tone="other" name={TEXT.other} value={format(split.other)} />
        <Key tone="rest" name={rest} value={format(split.rest)} {...(warning !== undefined && { warning })} />
        <span className="muted mc-of">{of}</span>
      </span>
    </div>
  );
}

function WholeMachine({ report }: { readonly report: MachineReport }) {
  const now = report.points.at(-1);
  if (now === undefined) return null;
  const memory = memorySplit(now, report.memoryTotalBytes);
  const loaded = report.load.some((value) => value > 0);
  return (
    <section className="ins-section" aria-labelledby="mc-now-title">
      <header className="ins-section-head">
        <h2 id="mc-now-title" className="ins-h2">
          {TEXT.now}
        </h2>
        <span className="muted">
          {TEXT.specs(report.cores, formatSize(report.memoryTotalBytes), Math.round(report.everyMs / 1000))} <span className="mono">{clockSeconds(report.asOf)}</span>
        </span>
      </header>
      <div role="list" aria-label={TEXT.list} className="mc-summary">
        <SummaryRow name={TEXT.memory} split={memory} format={formatBytes} rest={TEXT.free} of={TEXT.ofMemory(formatSize(report.memoryTotalBytes))} {...(isLow(memory) && { warning: TEXT.low })} />
        <SummaryRow name={TEXT.cpu} split={cpuSplit(now, report.cores)} format={sharePercent} rest={TEXT.idle} of={TEXT.ofCores(report.cores)} hint={loaded ? TEXT.load(report.load) : undefined} />
      </div>
    </section>
  );
}

function ChartSection({ report }: { readonly report: MachineReport }) {
  const { start, unsampled } = chartModel(report);
  const first = report.points.find((p) => p.at >= start);
  // A stretch with no reading at the start of the window is the only one when this tab was opened late.
  const leading = unsampled[0]?.from === start;
  const gaps = unsampled.length > (leading ? 1 : 0);
  return (
    <section className="ins-section" aria-labelledby="mc-chart-title">
      <header className="ins-section-head">
        <h2 id="mc-chart-title" className="ins-h2">
          {TEXT.chartTitle}
        </h2>
        <span className="muted">{TEXT.chartNote}</span>
      </header>
      {(leading || gaps) && <p className="muted mc-hint">{gaps || first === undefined ? TEXT.noReadings : TEXT.noReadingsFrom(clock(first.at))}</p>}
      <MachineChart report={report} />
    </section>
  );
}

interface RowContext {
  readonly setup: Setup | undefined;
  readonly items: readonly ItemRecord[];
  readonly cores: number;
  readonly onSelectItem: (itemId: string) => void;
}

const cpuText = (percent: number, cores: number) => onePercent(ofAllCores(percent, cores));

function RunningNow({ report, setup, items, onSelectItem, onNewWork }: Omit<RowContext, "cores"> & { readonly report: MachineReport; readonly onNewWork: () => void }) {
  const groups = groupItems(report.items);
  const total = tokamaTotal(report, groups);
  const context: RowContext = { setup, items, cores: report.cores, onSelectItem };
  return (
    <section className="ins-section" aria-labelledby="mc-table-title">
      <div className="ins-table-wrap">
        <table className="ins-table mc-table">
          <caption>
            <span id="mc-table-title" className="mc-caption">
              {TEXT.tableTitle}
            </span>{" "}
            <span className="muted">{TEXT.tableNote(report.cores)}</span>
          </caption>
          <thead>
            <tr>
              <th scope="col">{TEXT.itemOrProcess}</th>
              <th scope="col" className="num">
                {TEXT.cpuHead}
              </th>
              <th scope="col" className="num">
                {TEXT.memoryHead}
              </th>
            </tr>
          </thead>
          <tbody>
            {groups.map((group) => (
              <ItemRows key={group.itemId} group={group} {...context} />
            ))}
            <tr className="mc-item">
              <td>
                <span className="mc-item-title">
                  <span className="mc-kind">{TEXT.engine}</span>
                  <span className="muted">
                    {TEXT.engineKind} · {plural(report.engine.processes, "process", "processes")}
                  </span>
                </span>
              </td>
              <td className="num mono">{cpuText(report.engine.cpuPercent, report.cores)}</td>
              <td className="num mono">{formatBytes(report.engine.memoryBytes)}</td>
            </tr>
            {groups.length === 0 ? (
              <tr>
                <td colSpan={3} className="mc-empty">
                  <p>{TEXT.noItems}</p>
                  <p className="muted">{TEXT.noItemsHint}</p>
                  <Button variant="link" className="mc-new" onClick={onNewWork}>
                    {TEXT.newWork}
                  </Button>
                </td>
              </tr>
            ) : (
              <tr className="mc-total">
                <td className="muted">{TEXT.total(total.items, total.processes)}</td>
                <td className="num mono">{cpuText(total.cpuPercent, report.cores)}</td>
                <td className="num mono">{formatBytes(total.memoryBytes)}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** The agent as the row shows it: the blue ring that says it works now, and its name in grey. */
function Agent({ info, stepName }: { readonly info: AgentInfo; readonly stepName: string | undefined }) {
  return (
    <span className="mc-agent">
      <AgentBadge info={info} stepName={stepName} />
      <AgentName name={info.name} hue={info.hue} />
    </span>
  );
}

function ItemRows({ group, items, setup, cores, onSelectItem }: RowContext & { readonly group: ItemGroup }) {
  const item = items.find((candidate) => candidate.id === group.itemId);
  const stepIndex = item === undefined ? undefined : currentStep(item);
  const step = stepIndex === undefined ? undefined : item?.steps[stepIndex];
  const info = item === undefined || stepIndex === undefined ? undefined : agentInfo(item, stepIndex, setup);
  const tool = info?.cliId === undefined ? undefined : backendOf(info.cliId).shortName;
  const workflow = item === undefined ? undefined : workflowName(item.templateId, setup);
  const title = item === undefined ? <span>{group.title}</span> : <Button variant="link" onClick={() => onSelectItem(item.id)}>{group.title}</Button>;
  const facts = (...parts: (string | undefined)[]) => parts.filter((part) => part !== undefined && part !== "").join(" · ");

  if (isOneRow(group)) {
    return (
      <tr className="mc-item">
        <td>
          <span className="mc-item-title">
            {title}
            {info !== undefined && <Agent info={info} stepName={step?.name} />}
            <span className="muted mc-facts">{facts(workflow, step?.name, tool, plural(group.processes, "process", "processes"))}</span>
          </span>
        </td>
        <td className="num mono">{cpuText(group.cpuPercent, cores)}</td>
        <td className="num mono">{formatBytes(group.memoryBytes)}</td>
      </tr>
    );
  }
  return (
    <>
      <tr className="mc-item">
        <td>
          <span className="mc-item-title">
            {title}
            <span className="muted mc-facts">{facts(workflow, step?.name)}</span>
          </span>
        </td>
        <td className="num mono">{cpuText(group.cpuPercent, cores)}</td>
        <td className="num mono">{formatBytes(group.memoryBytes)}</td>
      </tr>
      {group.rows.map((row, index) => (
        <tr key={`${row.role}-${group.rows.slice(0, index).filter((earlier) => earlier.role === row.role).length}`} className="mc-child-row">
          <td>
            <span className="mc-child">
              {row.role === "agent" && info !== undefined ? <Agent info={info} stepName={step?.name} /> : <span className="mc-ring-gap" aria-hidden="true" />}
              {row.role === "agent" ? info === undefined && <span className="mc-kind">{TEXT.agent}</span> : <span className="mc-kind">{TEXT.checks}</span>}
              <span className="muted">{facts(row.role === "agent" ? tool : undefined, plural(row.processes, "process", "processes"))}</span>
            </span>
          </td>
          <td className="num mono">{cpuText(row.cpuPercent, cores)}</td>
          <td className="num mono">{formatBytes(row.memoryBytes)}</td>
        </tr>
      ))}
    </>
  );
}
