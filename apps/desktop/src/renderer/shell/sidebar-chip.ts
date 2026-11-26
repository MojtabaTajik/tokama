// The sidebar's one chip slot, at its foot (see Sidebar's `chips` prop). Anything that wants the
// slot hands the sidebar a candidate: an `id`, a `priority` and the `node` to show, which is a
// `ui/Chip` or any element of one chip. One chip shows at a time, the highest priority first, so a
// third kind of chip needs only a new id and a priority here. Each shows only while it has a
// candidate: the app builds none while there is nothing to say.
import type { ReactNode } from "react";

export interface SidebarChipCandidate {
  /** Names the chip: the slot remounts the node when another chip takes it. */
  readonly id: string;
  readonly priority: number;
  readonly node: ReactNode;
}

/** A ready update wins over the "Updated to" notice: one asks for an action, the other only tells. */
export const CHIP_PRIORITY = { update: 20, updatedTo: 10 } as const;

/** The candidate with the highest priority; of equal ones, the first. */
export function pickChip(candidates: readonly SidebarChipCandidate[]): SidebarChipCandidate | undefined {
  let best: SidebarChipCandidate | undefined;
  for (const candidate of candidates) if (best === undefined || candidate.priority > best.priority) best = candidate;
  return best;
}
