// Warnings: a template that loads and runs, but does something the engineer may not expect.
import type { TemplateRecord } from "../../kernel/schemas/index.js";
import type { TemplateProblem } from "./validate.js";

/** A warning with its line, as the screens show it: "Line 14: ...". */
export const lineWarning = (warning: TemplateProblem): string => `Line ${warning.line}: ${warning.message}`;

/**
 * A step after the last `checks pass` step can change files nothing checks. The item commits only
 * the checked tree, so the run loop asks before committing when such a step changed it. Reviewer
 * steps never edit, so they are left out.
 */
export function templateWarnings(record: TemplateRecord): string[] {
  const last = record.steps.findLastIndex((step) => step.doneWhen === "checks pass");
  if (last === -1) return [];
  return record.steps
    .slice(last + 1)
    .filter((step) => step.doneWhen !== "reviewer approves")
    .map((step) => `Step ${step.name} comes after the last checks and runs none of its own: if it changes files, Tokama asks before committing, as only checked work is committed.`);
}
