// The Machine tab of Insights: CPU, memory and load of this computer now, the last 30 minutes as
// two lines, and the processes Tokama itself runs, grouped by item. CPU of a process is shown as a
// share of all cores, like the machine's own. Local-model readings (GPU, power, temperature) come
// with local models; a note says so. Engine text (item titles) renders as React text only.
import type { ItemProcessSetUsage, ItemRecord, MachineReport, Setup } from "@tokama/core";
import type { ConnectionState, TokamaBridge } from "../../shared/bridge.js";
import { stepAgent } from "../drawer/describe.js";
import { currentStep } from "../model.js";
import { ConnectionFailure } from "../shell/ConnectionStatus.js";
import { MachineChart } from "./MachineChart.js";
import { clock, clockSeconds } from "../format/time.js";
import { chartModel, formatBytes, formatSize, ofAllCores, onePercent, wholePercent } from "./machine-model.js";
import { useMachine } from "./useMachine.js";
import { workflowName } from "./usage-model.js";
import { Button } from "../ui/Button.js";
import { AgentChip, AgentDotMark } from "../ui/agent.js";

const CLI_SHORT = { "claude-code": "CC", "codex-cli": "CX", ollama: "OL" } as const;

const TEXT = {
  panel: "Machine",
  loading: "Reading this machine",
  failed: "Could not read this machine",
  refreshFailed: (why: string) => `Could not refresh: ${why}. The numbers below are from the last reading.`,
  nowTitle: "This machine · now",
  specs: (cores: number, memory: string) => `${cores} ${cores === 1 ? "core" : "cores"} · ${memory}`,
  asOf: "as of",
  cpu: "CPU",
  memory: "Memory",
  load: "Load",
  cpuNote: (cores: number, tokama: string) => `all ${cores} ${cores === 1 ? "core" : "cores"} · Tokama ${tokama}`,
  memoryNote: (total: string, percent: string, tokama: string) => `of ${total} · ${percent} · Tokama ${tokama}`,
  min: (n: number) => `${n} min`,
  loadNote: (cores: number) => `runnable processes; ${cores} or less keeps up on ${cores} ${cores === 1 ? "core" : "cores"}`,
  chartTitle: "Last 30 minutes",
  sampled: (seconds: number) => `sampled every ${seconds} s while this tab is open`,
  noSamplesFrom: (from: string) => `Sampling started at ${from}, so the hatched part has no samples.`,
  noSamples: "The hatched parts have no samples.",
  tableTitle: "Tokama processes now",
  tableNote: (cores: number) => `· CPU is a share of all ${cores} ${cores === 1 ? "core" : "cores"} · memory is resident`,
  process: "Process",
  agentOrCheck: "Agent or check",
  processes: "Processes",
  cpuHead: "CPU",
  memoryHead: "Memory",
  engine: "Engine",
  engineName: "tokama-engine",
  engineKind: "background service",
  agent: "Agent",
  check: "Check",
  tokama: "Tokama",
  total: (items: number, processes: number) => `Tokama in total · ${items} ${items === 1 ? "item" : "items"} running · ${processes} ${processes === 1 ? "process" : "processes"}`,
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
        <p className="placeholder">{error === undefined ? TEXT.loading : `${TEXT.failed}: ${error}`}</p>
      ) : (
        <>
          {error !== undefined && <p className="muted mc-hint">{TEXT.refreshFailed(error)}</p>}
          <NowMeters report={report} />
          <ChartSection report={report} />
          <ProcessTable report={report} setup={setup} items={items} onSelectItem={onSelectItem} onNewWork={onNewWork} />
        </>
      )}
    </section>
  );
}

function Meter({ label, percent, valueText }: { readonly label: string; readonly percent: number; readonly valueText: string }) {
  const shown = Math.min(100, Math.max(0, Math.round(percent)));
  return (
    <svg className="meter" width="100%" height="6" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={shown} aria-valuetext={valueText}>
      <rect className="meter-track" width="100%" height="6" rx="3" />
      {shown > 0 && <rect className="meter-fill mc-fill" width={`${Math.max(1, shown)}%`} height="6" rx="3" />}
    </svg>
  );
}

function NowMeters({ report }: { readonly report: MachineReport }) {
  const now = report.points.at(-1);
  if (now === undefined) return null;
  const memoryPercent = report.memoryTotalBytes === 0 ? 0 : (now.memoryUsedBytes / report.memoryTotalBytes) * 100;
  const [one, five, fifteen] = report.load;
  return (
    <section className="ins-section" aria-labelledby="mc-now-title">
      <header className="ins-section-head">
        <h2 id="mc-now-title" className="ins-h2">
          {TEXT.nowTitle}
        </h2>
        <span className="muted">
          {TEXT.specs(report.cores, formatSize(report.memoryTotalBytes))} · {TEXT.asOf} <span className="mono">{clockSeconds(report.asOf)}</span>
        </span>
      </header>
      <div className="mc-meters">
        <div className="mc-meter">
          <div className="ins-window-head">
            <span>{TEXT.cpu}</span>
            <span className="mono mc-big">{wholePercent(now.cpuPercent)}</span>
          </div>
          <Meter label={TEXT.cpu} percent={now.cpuPercent} valueText={`${wholePercent(now.cpuPercent)} of all cores`} />
          <p className="muted mc-note">{TEXT.cpuNote(report.cores, wholePercent(ofAllCores(now.tokamaCpuPercent, report.cores)))}</p>
        </div>
        <div className="mc-meter">
          <div className="ins-window-head">
            <span>{TEXT.memory}</span>
            <span className="mono mc-big">{formatBytes(now.memoryUsedBytes)}</span>
          </div>
          <Meter label={TEXT.memory} percent={memoryPercent} valueText={`${wholePercent(memoryPercent)} of ${formatSize(report.memoryTotalBytes)}`} />
          <p className="muted mc-note">{TEXT.memoryNote(formatSize(report.memoryTotalBytes), wholePercent(memoryPercent), formatBytes(now.tokamaMemoryBytes))}</p>
        </div>
        <div className="mc-meter">
          <div className="ins-window-head">
            <span>{TEXT.load}</span>
            <span className="mono mc-big">{one.toFixed(2)}</span>
          </div>
          <div className="mc-loads">
            {([[1, one], [5, five], [15, fifteen]] as const).map(([minutes, value]) => (
              <span key={minutes} className="muted">
                {TEXT.min(minutes)} <span className="mono mc-load">{value.toFixed(2)}</span>
              </span>
            ))}
          </div>
          <p className="muted mc-note">{TEXT.loadNote(report.cores)}</p>
        </div>
      </div>
    </section>
  );
}

function ChartSection({ report }: { readonly report: MachineReport }) {
  const { start, unsampled } = chartModel(report);
  const first = report.points.find((p) => p.at >= start);
  // A stretch with no reading at the start of the window is the only one when sampling began late.
  const leading = unsampled[0]?.from === start;
  const gaps = unsampled.length > (leading ? 1 : 0);
  return (
    <section className="ins-section" aria-labelledby="mc-chart-title">
      <header className="ins-section-head">
        <h2 id="mc-chart-title" className="ins-h2">
          {TEXT.chartTitle}
        </h2>
        <span className="muted">{TEXT.sampled(Math.round(report.everyMs / 1000))}</span>
      </header>
      {(leading || gaps) && <p className="muted mc-hint">{gaps || first === undefined ? TEXT.noSamples : TEXT.noSamplesFrom(clock(first.at))}</p>}
      <MachineChart report={report} />
    </section>
  );
}

const sum = (key: "cpuPercent" | "memoryBytes" | "processes", rows: readonly Pick<ItemProcessSetUsage, typeof key>[]) => rows.reduce((total, row) => total + row[key], 0);

interface Group {
  readonly itemId: string;
  readonly rows: readonly ItemProcessSetUsage[];
}

function groupByItem(rows: readonly ItemProcessSetUsage[]): Group[] {
  const groups = new Map<string, ItemProcessSetUsage[]>();
  for (const row of rows) groups.set(row.itemId, [...(groups.get(row.itemId) ?? []), row]);
  return [...groups].map(([itemId, grouped]) => ({ itemId, rows: grouped }));
}

function ProcessTable({ report, setup, items, onSelectItem, onNewWork }: { readonly report: MachineReport; readonly setup: Setup | undefined; readonly items: readonly ItemRecord[]; readonly onSelectItem: (itemId: string) => void; readonly onNewWork: () => void }) {
  const groups = groupByItem(report.items);
  const cpu = (percent: number) => onePercent(ofAllCores(percent, report.cores));
  const all = [report.engine, ...report.items];
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
              <th scope="col">{TEXT.process}</th>
              <th scope="col">{TEXT.agentOrCheck}</th>
              <th scope="col" className="num">
                {TEXT.processes}
              </th>
              <th scope="col" className="num">
                {TEXT.cpuHead}
              </th>
              <th scope="col" className="num">
                {TEXT.memoryHead}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="mc-proc">
                <span className="mc-kind">{TEXT.engine}</span> <span className="mono muted">{TEXT.engineName}</span>
              </td>
              <td className="muted">{TEXT.engineKind}</td>
              <td className="num mono muted">{report.engine.processes}</td>
              <td className="num mono">{cpu(report.engine.cpuPercent)}</td>
              <td className="num mono">{formatBytes(report.engine.memoryBytes)}</td>
            </tr>
            {groups.map((group) => (
              <ItemRows key={group.itemId} group={group} item={items.find((item) => item.id === group.itemId)} setup={setup} cpu={cpu} onSelectItem={onSelectItem} />
            ))}
            {groups.length === 0 ? (
              <tr>
                <td colSpan={5} className="mc-empty">
                  <p>{TEXT.noItems}</p>
                  <p className="muted">{TEXT.noItemsHint}</p>
                  <Button variant="link" className="mc-new" onClick={onNewWork}>
                    {TEXT.newWork}
                  </Button>
                </td>
              </tr>
            ) : (
              <tr className="mc-total">
                <td colSpan={2} className="muted">
                  {TEXT.total(groups.length, sum("processes", all))}
                </td>
                <td className="num mono muted">{sum("processes", all)}</td>
                <td className="num mono">{cpu(sum("cpuPercent", all))}</td>
                <td className="num mono">{formatBytes(sum("memoryBytes", all))}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ItemRows({ group, item, setup, cpu, onSelectItem }: { readonly group: Group; readonly item: ItemRecord | undefined; readonly setup: Setup | undefined; readonly cpu: (percent: number) => string; readonly onSelectItem: (itemId: string) => void }) {
  const title = group.rows[0]?.title ?? "";
  const stepIndex = item === undefined ? undefined : currentStep(item);
  const step = stepIndex === undefined ? undefined : item?.steps[stepIndex];
  const subtitle = item === undefined ? undefined : [workflowName(item.templateId, setup), step?.name].filter(Boolean).join(" · ");
  const agent = step === undefined ? undefined : stepAgent(step, setup?.agents ?? []);
  const cli = step?.agentId === undefined ? undefined : setup?.agents.find((a) => a.id === step.agentId)?.cliId;
  return (
    <>
      <tr className="mc-item">
        <td colSpan={3}>
          <span className="mc-item-title">
            <span className="mc-live" aria-hidden="true">
              ●
            </span>
            {item === undefined ? (
              <span>{title}</span>
            ) : (
              <Button variant="link" onClick={() => onSelectItem(item.id)}>
                {title}
              </Button>
            )}
            {subtitle !== undefined && subtitle !== "" && <span className="muted">· {subtitle}</span>}
          </span>
        </td>
        <td className="num mono">{cpu(sum("cpuPercent", group.rows))}</td>
        <td className="num mono">{formatBytes(sum("memoryBytes", group.rows))}</td>
      </tr>
      {group.rows.map((row, index) => (
        <tr key={`${row.role}-${index}`}>
          <td className="mc-proc mc-child">
            <span className="mc-branch" aria-hidden="true">
              └
            </span>
            <span className="mc-kind">{row.role === "agent" ? TEXT.agent : TEXT.check}</span>
          </td>
          <td className="muted">
            {row.role === "agent" && agent !== undefined ? (
              <AgentChip agent={agent} className="ins-agent">
                {cli !== undefined && <span className="muted mono">{CLI_SHORT[cli]}</span>}
              </AgentChip>
            ) : (
              <span className="ins-agent">
                <AgentDotMark dot="neutral" />
                {TEXT.tokama}
              </span>
            )}
          </td>
          <td className="num mono muted">{row.processes}</td>
          <td className="num mono">{cpu(row.cpuPercent)}</td>
          <td className="num mono">{formatBytes(row.memoryBytes)}</td>
        </tr>
      ))}
    </>
  );
}
