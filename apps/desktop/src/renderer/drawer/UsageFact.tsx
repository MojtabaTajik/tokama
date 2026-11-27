// The fact after an item's time in its header: what the item used. On a plan it is the part of the
// weekly limit it took ("~1.2% of weekly limit"; with two tools, one fact each, never added);
// without a share, its tokens; with an API key, the real cost. Never an estimated dollar figure on a
// plan. Nothing for an item with no recorded calls.
import type { AiCliId, ItemUsage } from "@tokama/core";
import { formatCost, formatTokens, limitShare } from "../insights/usage-model.js";
import { cliName } from "../model.js";
import { BackendMark } from "../ui/agent.js";

/** The facts to show, in order; each names its tool only when there are several. */
export function usageFacts(usage: ItemUsage): readonly { readonly text: string; readonly cliId?: AiCliId }[] {
  if (usage.costUsd !== undefined) return [{ text: formatCost(usage.costUsd, usage.costEstimated) }];
  const shares = usage.shares ?? [];
  if (shares.length === 1) return [{ text: `${limitShare(shares[0]!.sharePercent)} of weekly limit` }];
  if (shares.length > 1) return shares.map((share) => ({ text: `${limitShare(share.sharePercent)} of ${cliName(share.cliId)} weekly limit`, cliId: share.cliId }));
  return usage.tokens > 0 ? [{ text: `${formatTokens(usage.tokens)} tokens` }] : [];
}

export function UsageFact({ usage }: { readonly usage: ItemUsage | undefined }) {
  if (usage === undefined) return null;
  return (
    <>
      {usageFacts(usage).map((fact) => (
        <span key={fact.text} className="drawer-position mono usage-fact">
          {" · "}
          {fact.cliId !== undefined && <BackendMark cliId={fact.cliId} />} {fact.text}
        </span>
      ))}
    </>
  );
}
