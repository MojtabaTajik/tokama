// The machine query: the readings of this computer and of the processes Tokama started, taken
// only while a client asks (the monitor in core owns the sampling loop).
import { type ItemGroup, type ItemStore, openAttempt } from "@tokama/core";

/**
 * The process groups of the items that run on this host: those of the open attempt. A check that
 * ended stays in the attempt's record; it has no live process, so it drops out of the readings.
 */
export function runningGroups(items: ItemStore): ItemGroup[] {
  const groups: ItemGroup[] = [];
  for (const item of items.list()) {
    if (item.deleted || item.outcome !== undefined) continue;
    for (const proc of openAttempt(item)?.attempt.processes ?? []) {
      if (proc.hostId !== items.hostId || proc.pgid === undefined) continue;
      groups.push({ itemId: item.id, title: item.title, role: proc.role, pgid: proc.pgid });
    }
  }
  return groups;
}
