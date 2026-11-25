// The scope's usage by model (estimated cost, share of the priced cost, tokens) and by repo
// (a bar for the share of tokens, tokens, estimated cost), side by side. Work outside the
// configured repos is one "other folders" row.
import type { UsageReport } from "@tokama/core";
import { AI_CLIS } from "../model.js";
import { formatTokens, formatUsd } from "./usage-model.js";

const TEXT = {
  byModel: "By model",
  byRepo: "By repo",
  byCost: (days: number) => `last ${days} days · by cost`,
  byTokens: (days: number) => `last ${days} days · by tokens`,
  model: "Model",
  repo: "Repo",
  cost: "≈ Cost",
  share: "Share",
  shareOfTokens: "Share of tokens",
  tokens: "Tokens",
  other: "other folders",
  empty: "No agent calls in this range.",
  noShare: "–",
} as const;

const cliName = (cliId: string) => AI_CLIS.find((cli) => cli.id === cliId)?.name ?? cliId;

/** Each repo's share of the repos' tokens, as a whole percent. */
export function repoShares(repos: NonNullable<UsageReport["repos"]>): number[] {
  const total = repos.reduce((sum, repo) => sum + repo.tokens, 0);
  return repos.map((repo) => (total === 0 ? 0 : Math.round((repo.tokens / total) * 100)));
}

export function UsageTables({ report }: { readonly report: UsageReport }) {
  const models = report.models ?? [];
  const repos = report.repos ?? [];
  const shares = repoShares(repos);
  return (
    <div className="ins-section ins-tables">
      <section className="ins-breakdown" aria-labelledby="ins-model-title">
        <header className="ins-breakdown-head">
          <h2 id="ins-model-title" className="ins-h2">
            {TEXT.byModel}
          </h2>
          <span className="muted">{TEXT.byCost(report.range)}</span>
        </header>
        <div className="ins-grid-table" role="table" aria-label={TEXT.byModel} data-kind="model">
          <div role="row" className="ins-grid-row ins-grid-header">
            <span role="columnheader">{TEXT.model}</span>
            <span role="columnheader">{TEXT.cost}</span>
            <span role="columnheader">{TEXT.share}</span>
            <span role="columnheader">{TEXT.tokens}</span>
          </div>
          {models.map((row) => (
            <div role="row" className="ins-grid-row" key={`${row.cliId}-${row.model}`}>
              <span role="cell" className="ins-model">
                <span className="mono ins-model-name">{row.model}</span>
                <span className="muted ellipsis">{cliName(row.cliId)}</span>
              </span>
              <span role="cell" className="mono">
                {formatUsd(row.costUsd)}
              </span>
              <span role="cell" className="mono ins-dim">
                {row.sharePercent === null ? TEXT.noShare : `${Math.round(row.sharePercent)}%`}
              </span>
              <span role="cell" className="mono ins-dim">
                {formatTokens(row.tokens)}
              </span>
            </div>
          ))}
        </div>
        {models.length === 0 && <p className="muted ins-empty">{TEXT.empty}</p>}
      </section>
      <section className="ins-breakdown" aria-labelledby="ins-repo-title">
        <header className="ins-breakdown-head">
          <h2 id="ins-repo-title" className="ins-h2">
            {TEXT.byRepo}
          </h2>
          <span className="muted">{TEXT.byTokens(report.range)}</span>
        </header>
        <div className="ins-grid-table" role="table" aria-label={TEXT.byRepo} data-kind="repo">
          <div role="row" className="ins-grid-row ins-grid-header">
            <span role="columnheader">{TEXT.repo}</span>
            <span role="columnheader" aria-label={TEXT.shareOfTokens} />
            <span role="columnheader">{TEXT.tokens}</span>
            <span role="columnheader">{TEXT.cost}</span>
          </div>
          {repos.map((row, index) => (
            <div role="row" className="ins-grid-row" key={row.repoId ?? "other"}>
              <span role="cell" className="mono ellipsis ins-repo" data-other={row.repoId === null || undefined}>
                {row.repoId ?? TEXT.other}
              </span>
              <span role="cell" className="ins-repo-bar" aria-label={`${shares[index]}% of tokens`}>
                <span className="ins-repo-fill" style={{ width: `${shares[index]}%` }} />
              </span>
              <span role="cell" className="mono">
                {formatTokens(row.tokens)}
              </span>
              <span role="cell" className="mono ins-dim">
                {formatUsd(row.costUsd)}
              </span>
            </div>
          ))}
        </div>
        {repos.length === 0 && <p className="muted ins-empty">{TEXT.empty}</p>}
      </section>
    </div>
  );
}
