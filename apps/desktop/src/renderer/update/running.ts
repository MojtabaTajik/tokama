// The items that block an update. The engine counts an item when it runs, or when a Finish action
// runs on it; this is the same rule, so the chip and the engine agree. Items waiting for the user do not count.
import type { ItemRecord, TemplateSummary } from "@tokama/core";
import type { RunningItem } from "./UpdateChip.js";

export const runsNow = (item: Pick<ItemRecord, "state" | "finish">): boolean => item.state === "running" || item.finish?.running !== undefined;

export function runningItems(items: readonly ItemRecord[], templates: readonly Pick<TemplateSummary, "id" | "name">[] | undefined): RunningItem[] {
  return items.filter(runsNow).map((item) => ({ id: item.id, title: item.title, template: templates?.find((template) => template.id === item.templateId)?.name ?? item.templateId }));
}
