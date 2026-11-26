// The sidebar has one chip slot. Several things may want it (an update that is ready to install,
// the "Updated to" notice after one); one chip shows at a time, the highest priority first.
import type { ReactNode } from "react";

export interface SidebarChipCandidate {
  readonly key: "update" | "updated";
  readonly priority: number;
  readonly node: ReactNode;
}

/** A ready update wins over the "Updated to" notice: one asks for an action, the other only tells. */
export const CHIP_PRIORITY = { updated: 1, update: 2 } as const;

/** The candidate with the highest priority; of equal ones, the first. */
export function pickChip(candidates: readonly SidebarChipCandidate[]): SidebarChipCandidate | undefined {
  let best: SidebarChipCandidate | undefined;
  for (const candidate of candidates) if (best === undefined || candidate.priority > best.priority) best = candidate;
  return best;
}
