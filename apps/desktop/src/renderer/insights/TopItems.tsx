// The items with the most tokens in the range: workflow, agents (identity dot, name and CLI),
// tokens, agent time and estimated cost. Filtered with the chart. A title opens the item drawer, which says so when the
// item is gone.
import type { Setup, UsageReport } from "@tokama/core";
import { stepAgent } from "../drawer/describe.js";
import { TemplateIcon } from "../shell/TemplateIcon.js";
import { formatDuration } from "../format/duration.js";
import { formatCost, formatTokens, templateFor, totalOf, workflowName } from "./usage-model.js";
import { Button } from "../ui/Button.js";
import { AgentChip } from "../ui/agent.js";


const TEXT = {
  title: "Top items",
  empty: "No agent calls in this range.",
  item: "Item",
  workflow: "Workflow",
  agents: "Agents",
  tokens: "Tokens",
  time: "Time",
  cost: "≈ Cost",
  local: "local · $0",
} as const;

export interface TopItemsProps {
  readonly report: UsageReport;
  readonly setup: Setup | undefined;
  readonly filter: string | undefined;
  readonly note: string;
  readonly onOpen: (itemId: string) => void;
}

export function TopItems({ report, setup, filter, note, onOpen }: TopItemsProps) {
  const rows = report.items.filter((item) => filter === undefined || item.templateId === filter).slice(0, 20);
  return (
    <section className="ins-section" aria-labelledby="ins-items-title">
      <header className="ins-section-head">
        <h2 id="ins-items-title" className="ins-h2">
          {TEXT.title}
        </h2>
        <span className="muted">{note}</span>
      </header>
      {rows.length === 0 ? (
        <p className="muted">{TEXT.empty}</p>
      ) : (
        <table className="ins-table">
          <thead>
            <tr>
              <th scope="col">{TEXT.item}</th>
              <th scope="col">{TEXT.workflow}</th>
              <th scope="col">{TEXT.agents}</th>
              <th scope="col" className="num">
                {TEXT.tokens}
              </th>
              <th scope="col" className="num">
                {TEXT.time}
              </th>
              <th scope="col" className="num">
                {TEXT.cost}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((item) => {
              const template = templateFor(item.templateId, setup);
              return (
                <tr key={item.itemId}>
                  <td className="ins-item">
                    <Button variant="quiet" onClick={() => onOpen(item.itemId)}>
                      {item.title}
                    </Button>
                  </td>
                  <td>
                    <span className="ins-wf">
                      <TemplateIcon icon={template?.icon} color={template?.color} />
                      {workflowName(item.templateId, setup)}
                    </span>
                  </td>
                  <td>
                    <span className="ins-agents">
                      {item.agents.map((agent) => {
                        const known = stepAgent({ agentId: agent.agentId, data: "none" }, setup?.agents ?? []);
                        return (
                          <AgentChip key={agent.agentId} agent={{ ...known, cliId: agent.cliId }} className="ins-agent" />
                        );
                      })}
                    </span>
                  </td>
                  <td className="num mono">{formatTokens(totalOf(item.tokens))}</td>
                  <td className="num mono">{formatDuration(item.durationMs, "coarse")}</td>
                  <td className="num mono" data-muted={item.local || undefined}>
                    {item.local ? TEXT.local : formatCost(item.costUsd)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
