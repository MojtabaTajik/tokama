// Picking the base branch in a repo dialog: open the list, type, and press Enter on the active row.
import type { Locator } from "playwright-core";

export const baseBranchButton = (dialog: Locator): Locator => dialog.getByRole("button", { name: /^Base branch/ });
export const branchSearch = (dialog: Locator): Locator => dialog.getByRole("combobox", { name: "Search branches or type a name" });

export async function chooseBranch(dialog: Locator, text: string): Promise<void> {
  await baseBranchButton(dialog).click();
  await branchSearch(dialog).fill(text);
  await branchSearch(dialog).press("Enter");
}
